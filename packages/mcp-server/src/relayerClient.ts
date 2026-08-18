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
import { BuilderConfig } from '@polymarket/builder-signing-sdk'
import type { EncodedRedeemTx } from '@actually/core'
import { assertValidPrivateKeyShape } from './validatePrivateKey'
import {
  BUILDER_API_KEY,
  BUILDER_API_PASSPHRASE,
  BUILDER_API_SECRET,
  builderCredsConfigured,
} from './config'

const RELAYER_URL = 'https://relayer-v2.polymarket.com/'
const POLYGON_CHAIN_ID = 137
/** Cap on wait(): the SDK's own budget is 100 polls x 2s, which reads as a
 * hang to any caller. Past this we report an unconfirmed outcome. */
const REDEEM_WAIT_TIMEOUT_MS = 45_000

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
      // Builder auth: the relayer refuses POST /submit without it (401
      // "invalid authorization"), so a client built without credentials can
      // only ever fail — after the transaction has been signed. See config.ts.
      const builderConfig = builderCredsConfigured()
        ? new BuilderConfig({
            localBuilderCreds: {
              key: BUILDER_API_KEY!,
              secret: BUILDER_API_SECRET!,
              passphrase: BUILDER_API_PASSPHRASE!,
            },
          })
        : undefined
      client = new RelayClient(RELAYER_URL, POLYGON_CHAIN_ID, wallet, builderConfig, RelayerTxType.SAFE)
    }
    return client
  }

  return async function submit(tx: EncodedRedeemTx): Promise<RelayerSubmitResult> {
    // Refuse before the wallet signs: the relayer SDK builds and SIGNS the
    // Safe transaction before it posts, so without credentials the operator
    // pays a signature for a request that is already guaranteed to 401.
    if (!builderCredsConfigured()) {
      return {
        success: false,
        error:
          'builder_creds_missing: redeeming needs builder API credentials. Create them at ' +
          'polymarket.com -> Settings -> Builders -> "+ Create New" and set ' +
          'POLYMARKET_BUILDER_API_KEY / _SECRET / _PASSPHRASE. Nothing was submitted.',
      }
    }
    try {
      const submitted = await getClient().execute([tx], 'redeem_position')
      // execute() resolves once the relayer ACCEPTS the transaction (state
      // STATE_NEW), not once it's mined — wait() polls until a terminal
      // on-chain state so redeem_position reports a definitive outcome
      // instead of "we submitted something, who knows".
      //
      // wait() (pollUntilState) returns the transaction ONLY for
      // STATE_MINED/STATE_CONFIRMED, and returns UNDEFINED for BOTH an
      // on-chain failure and a poll timeout. Falling back to
      // `submitted.state` — the state at submission, always STATE_NEW —
      // therefore reported every failed redeem as a success. Never read
      // undefined as success.
      let mined: Awaited<ReturnType<typeof submitted.wait>>
      try {
        mined = await Promise.race([
          submitted.wait(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('wait_timeout')), REDEEM_WAIT_TIMEOUT_MS),
          ),
        ])
      } catch (err) {
        // Submission succeeded; only the status poll failed. Keep the id.
        return {
          success: false,
          transactionId: submitted.transactionID,
          error: `redeem_status_unknown:${err instanceof Error ? err.message : String(err)}`,
        }
      }
      if (!mined) {
        let lastState: string | undefined
        try {
          lastState = (await submitted.getTransaction())[0]?.state
        } catch {
          // leave unknown
        }
        if (lastState === 'STATE_FAILED' || lastState === 'STATE_INVALID') {
          return { success: false, transactionId: submitted.transactionID, error: `relayer_state:${lastState}` }
        }
        return { success: false, transactionId: submitted.transactionID, error: 'redeem_status_unknown:poll_timeout' }
      }
      if (mined.state === 'STATE_FAILED' || mined.state === 'STATE_INVALID') {
        return { success: false, transactionId: mined.transactionID, error: `relayer_state:${mined.state}` }
      }
      return { success: true, transactionId: mined.transactionID ?? submitted.transactionID }
    } catch (err) {
      const raw = String(err instanceof Error ? err.message : err)
      // The relayer requires builder auth headers on POST /submit and answers
      // an unauthenticated call with 401 "invalid authorization" (verified
      // against the live endpoint 2026-08-17). We construct RelayClient with
      // no builderConfig, so this is the expected outcome until builder API
      // credentials exist — say so instead of leaking a raw JSON blob.
      if (/invalid authorization/i.test(raw) || /(^|[^0-9])401([^0-9]|$)/.test(raw)) {
        return {
          success: false,
          error:
            "relayer_unauthorized: Polymarket's relayer rejected the request (401). " +
            'In-app redeem needs builder API credentials this server does not have; ' +
            'claim the payout on polymarket.com instead. Nothing was redeemed.',
        }
      }
      return { success: false, error: raw }
    }
  }
}
