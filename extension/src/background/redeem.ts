/**
 * Redeeming a resolved position.
 *
 * Unlike every other action in this extension, redeem is an ON-CHAIN call, not
 * a CLOB order — and it has to be made AS the user's Polymarket Safe, because
 * that is what holds the outcome tokens. A call from the raw EOA would not be
 * `msg.sender == Safe` and would redeem nothing. Polymarket's own relayer
 * submits the call as the Safe and pays the gas, which is why this needs no
 * POL in the user's wallet.
 *
 * The awkward part is the signer. `@polymarket/builder-abstract-signer`'s
 * factory accepts an ethers Wallet, an ethers JsonRpcSigner, or a viem
 * WalletClient — and a WalletConnect session is none of those. The mcp-server
 * has a private key and hands over an ethers Wallet; we have neither. So this
 * module builds the third option: a viem WalletClient over an EIP-1193
 * provider whose `request` is the WalletConnect session.
 *
 * That works because of what the Safe path actually asks the signer for. The
 * RelayClient builds its own public client for every read (it never reads
 * through ours), and the only signer methods it reaches for are `getAddress`
 * and — inside the Safe transaction builder — `signMessage` over the struct
 * hash. Both are things a WalletConnect session can serve, provided the wallet
 * granted `personal_sign`. Nothing here needs eth_sendTransaction, so the
 * narrow set of methods our session requests is enough.
 */
import { createWalletClient, custom } from 'viem'
import { polygon } from 'viem/chains'
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client'
import { buildRedeemTransaction, type EncodedRedeemTx } from '@actually/core'
import type { Position } from '../shared/types'
import { wcRequest } from './wallet'

const RELAYER_URL = 'https://relayer-v2.polymarket.com/'
const POLYGON_CHAIN_ID = 137

/** Methods the wallet must serve. Anything else is a read, and reads must not
 * be routed to the wallet — the RelayClient has its own RPC for those, and a
 * WalletConnect session would reject a method outside its granted namespace
 * anyway. Failing loudly here beats a confusing rejection from the relay. */
const WALLET_METHODS = new Set([
  'personal_sign',
  'eth_sign',
  'eth_signTypedData',
  'eth_signTypedData_v4',
  'eth_accounts',
  'eth_requestAccounts',
])

export interface RedeemResult {
  ok: boolean
  transactionId?: string
  error?: string
}

/**
 * An EIP-1193 provider backed by the live WalletConnect session, for viem to
 * wrap. Deliberately refuses anything that isn't a signing request, so a
 * future change that starts reading chain state through this path fails
 * immediately and visibly rather than hanging on a namespace rejection.
 */
export function makeWcProvider(topic: string, address: string) {
  return {
    async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
        return [address]
      }
      if (method === 'eth_chainId') {
        return `0x${POLYGON_CHAIN_ID.toString(16)}`
      }
      if (!WALLET_METHODS.has(method)) {
        throw new Error(`wc_provider_unsupported_method:${method}`)
      }
      return wcRequest(topic, method, params ?? [])
    },
  }
}

export interface RedeemArgs {
  topic: string
  /** The EOA that owns the Safe — the account that signs. */
  address: string
  conditionId: string
  /** Every position held for that conditionId (normally one). */
  positions: Position[]
}

export async function redeemPosition(args: RedeemArgs): Promise<RedeemResult> {
  const matching = args.positions.filter((p) => p.conditionId === args.conditionId)
  if (matching.length === 0) {
    return { ok: false, error: 'position_not_found' }
  }
  if (!matching.some((p) => p.redeemable)) {
    return { ok: false, error: 'not_yet_redeemable' }
  }

  let tx: EncodedRedeemTx
  try {
    tx = buildRedeemTransaction(
      args.conditionId,
      matching.map((p) => ({
        conditionId: p.conditionId,
        outcomeIndex: p.outcomeIndex,
        size: p.size,
        negativeRisk: p.negativeRisk,
      })),
    )
  } catch (err) {
    return { ok: false, error: `redeem_build_failed:${err instanceof Error ? err.message : String(err)}` }
  }

  try {
    const walletClient = createWalletClient({
      account: args.address as `0x${string}`,
      chain: polygon,
      transport: custom(makeWcProvider(args.topic, args.address)),
    })
    const client = new RelayClient(
      RELAYER_URL,
      POLYGON_CHAIN_ID,
      walletClient,
      undefined,
      RelayerTxType.SAFE,
    )
    const submitted = await client.execute([tx], 'redeem_position')
    // execute() resolves once the relayer ACCEPTS the transaction, not once
    // it is mined — wait() polls to a terminal on-chain state so this reports
    // a definitive outcome instead of "we submitted something".
    //
    // wait()'s contract (pollUntilState in the relayer client) is subtle and
    // was mishandled here once: it resolves with the transaction ONLY on
    // STATE_MINED/STATE_CONFIRMED, and resolves with UNDEFINED both when the
    // transaction hit STATE_FAILED and when polling timed out. Falling back to
    // `submitted.state` (the state at submission time, STATE_NEW) turned every
    // on-chain failure into a green "Redeemed" toast. undefined must never be
    // read as success.
    let mined: Awaited<ReturnType<typeof submitted.wait>>
    try {
      mined = await submitted.wait()
    } catch (err) {
      // The redeem was ACCEPTED — a poll hiccup after that does not mean it
      // failed. Report the outcome as unknown and keep the id so the user
      // (and the log) can still find the transaction.
      return {
        ok: false,
        transactionId: submitted.transactionID,
        error: `redeem_status_unknown:${err instanceof Error ? err.message : String(err)}`,
      }
    }
    if (!mined) {
      // Failed on-chain or timed out — one direct status read tells us which.
      let lastState: string | undefined
      try {
        lastState = (await submitted.getTransaction())[0]?.state
      } catch {
        // status stays unknown
      }
      if (lastState === 'STATE_FAILED' || lastState === 'STATE_INVALID') {
        return { ok: false, transactionId: submitted.transactionID, error: `relayer_state:${lastState}` }
      }
      return { ok: false, transactionId: submitted.transactionID, error: 'redeem_status_unknown:poll_timeout' }
    }
    // Belt and braces: today's wait() cannot resolve with a failed state (it
    // resolves undefined for those), but reading it as success if a future
    // SDK version starts returning the transaction would repeat the original
    // bug in the opposite direction.
    if (mined.state === 'STATE_FAILED' || mined.state === 'STATE_INVALID') {
      return { ok: false, transactionId: mined.transactionID ?? submitted.transactionID, error: `relayer_state:${mined.state}` }
    }
    return { ok: true, transactionId: mined.transactionID ?? submitted.transactionID }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}
