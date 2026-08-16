import { describe, expect, it, vi, beforeEach } from 'vitest'

const { wcRequestMock } = vi.hoisted(() => ({ wcRequestMock: vi.fn(async () => '0xsig') }))
vi.mock('./wallet', () => ({ wcRequest: wcRequestMock }))

const { executeMock, waitMock, getTransactionMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  waitMock: vi.fn(),
  getTransactionMock: vi.fn(),
}))
vi.mock('@polymarket/builder-relayer-client', () => ({
  RelayClient: class {
    execute = executeMock
  },
  RelayerTxType: { SAFE: 'SAFE' },
}))

import { makeWcProvider, redeemPosition } from './redeem'
import type { Position } from '../shared/types'

const resolved: Position = {
  tokenId: 'tok',
  conditionId: '0x1111111111111111111111111111111111111111111111111111111111111111',
  size: 129.17,
  avgPrice: 0.015,
  curPrice: 1,
  currentValue: 129.17,
  cashPnl: 127,
  percentPnl: 6000,
  outcome: 'Yes',
  title: 'Will Google have the best AI model?',
  slug: 'google-ai',
  redeemable: true,
  outcomeIndex: 0,
  negativeRisk: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  // The real wait() (pollUntilState) resolves the transaction ONLY on
  // STATE_MINED/STATE_CONFIRMED — and resolves UNDEFINED both for an on-chain
  // failure and for a poll timeout. The mocks mirror that contract.
  waitMock.mockResolvedValue({ state: 'STATE_MINED', transactionID: '0xtx1234567890' })
  getTransactionMock.mockResolvedValue([{ state: 'STATE_MINED', transactionID: '0xtx1234567890' }])
  executeMock.mockResolvedValue({
    state: 'STATE_NEW',
    transactionID: '0xtx1234567890',
    wait: waitMock,
    getTransaction: getTransactionMock,
  })
})

describe('makeWcProvider — only signing goes to the wallet', () => {
  it('answers account and chain locally without waking the wallet', async () => {
    const p = makeWcProvider('topic-1', '0xabc')
    expect(await p.request({ method: 'eth_accounts' })).toEqual(['0xabc'])
    expect(await p.request({ method: 'eth_chainId' })).toBe('0x89') // 137
    expect(wcRequestMock).not.toHaveBeenCalled()
  })

  it('forwards a signature request over the WalletConnect session', async () => {
    const p = makeWcProvider('topic-1', '0xabc')
    expect(await p.request({ method: 'personal_sign', params: ['0xdeadbeef', '0xabc'] })).toBe('0xsig')
    expect(wcRequestMock).toHaveBeenCalledWith('topic-1', 'personal_sign', ['0xdeadbeef', '0xabc'])
  })

  it('refuses chain reads outright rather than letting them hang', async () => {
    // The relayer reads through its OWN client. Anything reaching here is a
    // mistake, and a WalletConnect session would reject it as outside the
    // granted namespace anyway — fail where the cause is visible.
    const p = makeWcProvider('topic-1', '0xabc')
    await expect(p.request({ method: 'eth_estimateGas' })).rejects.toThrow(
      'wc_provider_unsupported_method:eth_estimateGas',
    )
    await expect(p.request({ method: 'eth_sendTransaction' })).rejects.toThrow(
      'wc_provider_unsupported_method:eth_sendTransaction',
    )
  })
})

describe('redeemPosition', () => {
  it('refuses a market Polymarket has not marked redeemable', async () => {
    const r = await redeemPosition({
      topic: 't', address: '0x00000000000000000000000000000000000000ab', conditionId: '0x1111111111111111111111111111111111111111111111111111111111111111',
      positions: [{ ...resolved, redeemable: false }],
    })
    expect(r).toEqual({ ok: false, error: 'not_yet_redeemable' })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('refuses a conditionId that is not held', async () => {
    const r = await redeemPosition({
      topic: 't', address: '0x00000000000000000000000000000000000000ab', conditionId: '0x2222222222222222222222222222222222222222222222222222222222222222', positions: [resolved],
    })
    expect(r).toEqual({ ok: false, error: 'position_not_found' })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('submits one encoded call and reports the mined transaction', async () => {
    const r = await redeemPosition({
      topic: 't', address: '0x00000000000000000000000000000000000000ab', conditionId: '0x1111111111111111111111111111111111111111111111111111111111111111', positions: [resolved],
    })
    expect(r).toEqual({ ok: true, transactionId: '0xtx1234567890' })
    expect(executeMock).toHaveBeenCalledOnce()
    const [txs, label] = executeMock.mock.calls[0]
    expect(txs).toHaveLength(1)
    expect(label).toBe('redeem_position')
    // The base CTF contract for a regular market, with a real calldata payload.
    expect(txs[0].to).toBe('0x4D97DCd97eC945f40cF65F87097ACe5EA0476045')
    expect(txs[0].data.startsWith('0x')).toBe(true)
    expect(txs[0].value).toBe('0')
  })

  it('routes a neg-risk market to the NegRiskAdapter instead', async () => {
    await redeemPosition({
      topic: 't', address: '0x00000000000000000000000000000000000000ab', conditionId: '0x1111111111111111111111111111111111111111111111111111111111111111',
      positions: [{ ...resolved, negativeRisk: true }],
    })
    expect(executeMock.mock.calls[0][0][0].to).toBe('0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296')
  })

  it('waits for a terminal state rather than reporting the relayer accepting it', async () => {
    await redeemPosition({ topic: 't', address: '0x00000000000000000000000000000000000000ab', conditionId: '0x1111111111111111111111111111111111111111111111111111111111111111', positions: [resolved] })
    expect(waitMock).toHaveBeenCalledOnce()
  })

  it('reports a relayer failure as a failure, not a success', async () => {
    waitMock.mockResolvedValue({ state: 'STATE_FAILED', transactionID: '0xbad' })
    const r = await redeemPosition({ topic: 't', address: '0x00000000000000000000000000000000000000ab', conditionId: '0x1111111111111111111111111111111111111111111111111111111111111111', positions: [resolved] })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('relayer_state:STATE_FAILED')
    expect(r.transactionId).toBe('0xbad')
  })

  it('never throws when the relayer or the wallet rejects', async () => {
    executeMock.mockRejectedValue(new Error('User rejected the request'))
    const r = await redeemPosition({ topic: 't', address: '0x00000000000000000000000000000000000000ab', conditionId: '0x1111111111111111111111111111111111111111111111111111111111111111', positions: [resolved] })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('User rejected')
  })

  // wait() resolving UNDEFINED is how the real SDK reports both an on-chain
  // failure and a poll timeout. Reading it as success (via a fallback to the
  // submission-time state) once turned every failed redeem into a green
  // "Redeemed" toast — these pin the honest behavior.
  const argsBase = {
    topic: 't',
    address: '0x00000000000000000000000000000000000000ab',
    conditionId: '0x1111111111111111111111111111111111111111111111111111111111111111',
    positions: [resolved],
  }

  it('reports an on-chain failure (wait() → undefined, status shows STATE_FAILED) as a failure', async () => {
    waitMock.mockResolvedValue(undefined)
    getTransactionMock.mockResolvedValue([{ state: 'STATE_FAILED', transactionID: '0xtx1234567890' }])
    const r = await redeemPosition(argsBase)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('relayer_state:STATE_FAILED')
    expect(r.transactionId).toBe('0xtx1234567890')
  })

  it('reports a poll timeout as unknown — never as success, never as a definite failure', async () => {
    waitMock.mockResolvedValue(undefined)
    getTransactionMock.mockResolvedValue([{ state: 'STATE_EXECUTED', transactionID: '0xtx1234567890' }])
    const r = await redeemPosition(argsBase)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('redeem_status_unknown:poll_timeout')
    expect(r.transactionId).toBe('0xtx1234567890')
  })

  it('keeps the transactionId when polling itself errors after a successful submission', async () => {
    waitMock.mockRejectedValue(new Error('ECONNRESET'))
    const r = await redeemPosition(argsBase)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('redeem_status_unknown:ECONNRESET')
    expect(r.transactionId).toBe('0xtx1234567890')
  })

  it('still reports unknown when even the follow-up status read fails', async () => {
    waitMock.mockResolvedValue(undefined)
    getTransactionMock.mockRejectedValue(new Error('boom'))
    const r = await redeemPosition(argsBase)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('redeem_status_unknown:poll_timeout')
    expect(r.transactionId).toBe('0xtx1234567890')
  })
})
