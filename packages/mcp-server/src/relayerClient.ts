/**
 * Wiring for Polymarket's official relayer (@polymarket/builder-relayer-client).
 * Positions are held by the caller's Polymarket Safe, not their raw EOA, so a
 * plain on-chain call to CTF.redeemPositions from the EOA wouldn't be `msg.sender
 * == Safe` and would either revert or redeem nothing. The relayer submits the
 * call AS the Safe (Polymarket covers gas — no POL needed in the operator's
 * wallet, consistent with the rest of this server never touching gas).
 *
 * This package pins ethers v5 (`Wallet instanceof` check in
 * @polymarket/builder-abstract-signer) while the rest of this repo is on
 * ethers v6 — that mismatch is deliberately isolated to this one file. See
 * README's "Redeeming positions" section for the live-testing caveat: this
 * wiring has NOT been exercised against a real wallet/mainnet in development,
 * only verified against the published package's actual runtime exports and
 * source (RelayClient/createAbstractSigner instanceof check).
 */
import { Wallet } from '@ethersproject/wallet'
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client'
import type { EncodedRedeemTx } from '@actually/core'
import { assertValidPrivateKeyShape } from './validatePrivateKey'

const RELAYER_URL = 'https://relayer-v2.polymarket.com/'
const POLYGON_CHAIN_ID = 137

export interface RelayerSubmitResult {
  success: boolean
  transactionId?: string
  error?: string
}

/**
 * Submits one encoded contract call through the Safe relayer. Memoizes the
 * RelayClient per private key the same way tradingSession.ts memoizes CLOB
 * credentials, so repeated redeem_position calls in one session reuse the
 * same client instead of rebuilding it (and its internal viem publicClient)
 * every time.
 */
export function makeRelayerSubmit(privateKey: string): (tx: EncodedRedeemTx) => Promise<RelayerSubmitResult> {
  let client: RelayClient | null = null

  function getClient(): RelayClient {
    if (!client) {
      // Validate shape before ethers v5's Wallet ever sees the value — see
      // validatePrivateKey.ts for why this must happen here.
      assertValidPrivateKeyShape(privateKey)
      const wallet = new Wallet(privateKey)
      client = new RelayClient(RELAYER_URL, POLYGON_CHAIN_ID, wallet, undefined, RelayerTxType.SAFE)
    }
    return client
  }

  return async function submit(tx: EncodedRedeemTx): Promise<RelayerSubmitResult> {
    try {
      const submitted = await getClient().execute([tx], 'redeem_position')
      // execute() resolves once the relayer ACCEPTS the transaction (state
      // STATE_NEW), not once it's mined — wait() polls until a terminal
      // on-chain state so redeem_position reports a definitive outcome
      // instead of "we submitted something, who knows".
      const mined = await submitted.wait()
      const terminal = mined ?? { state: submitted.state, transactionID: submitted.transactionID }
      if (terminal.state === 'STATE_FAILED' || terminal.state === 'STATE_INVALID') {
        return { success: false, transactionId: terminal.transactionID, error: `relayer_state:${terminal.state}` }
      }
      return { success: true, transactionId: terminal.transactionID }
    } catch (err) {
      return { success: false, error: String(err instanceof Error ? err.message : err) }
    }
  }
}
