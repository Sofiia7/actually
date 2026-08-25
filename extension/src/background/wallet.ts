/**
 * WalletConnect v2 integration for the popup runtime.
 *
 * Why WC v2 instead of injected `window.ethereum`:
 *   Chrome extension popups run at `chrome-extension://<id>/...` - wallet
 *   browser extensions do not inject providers into that origin. WC v2
 *   bypasses this entirely by talking to a relay over WSS and using
 *   QR / deeplink for approval.
 *
 * This module is import-safe in the service worker (it does not initialize
 * the SignClient on import - only on the first `getSignClient()` call from
 * the popup). The SW only uses the types.
 */
import { describeError } from '../shared/describeError'
import { SignClient } from '@walletconnect/sign-client'
import { logConnect } from './connectLog'

const POLYGON_CHAIN_ID = 'eip155:137'
const POLYGON_CHAIN_ID_NUM = 137n

const SIGN_METHOD = 'eth_signTypedData_v4'

/**
 * Stays an https URL on purpose.
 *
 * The SDK warns that this differs from the actual `chrome-extension://` page
 * URL and "can lead to issues", and setting it to the extension's own origin
 * does silence that. But wallets render their approval screen from this
 * metadata and expect an http(s) origin - several handle an unknown scheme by
 * showing a spinner and never producing an approval at all. A cosmetic console
 * warning is not worth a wallet that won't connect; the warning stays.
 */
const WC_METADATA = {
  name: 'Actually',
  description: 'What markets really think - trade news in your browser',
  url: 'https://actually.app',
  icons: ['https://actually.app/icon-128.png'],
}

/**
 * WC v2 project id, baked at build time via Vite. Required for production
 * connections; without it `SignClient.init` throws. Get one free at
 * https://cloud.walletconnect.com.
 */
const WC_PROJECT_ID: string =
  (import.meta.env.VITE_WC_PROJECT_ID as string | undefined) ?? ''

type WCSignClient = Awaited<ReturnType<typeof SignClient.init>>

let clientPromise: Promise<WCSignClient> | null = null

export async function getSignClient(): Promise<WCSignClient> {
  if (!WC_PROJECT_ID) {
    throw new Error('wc_project_id_missing')
  }
  if (!clientPromise) {
    // Drop the cached promise if init fails. Without this, one transient
    // failure (relay unreachable while the laptop's network comes back, or
    // the offscreen document being torn down mid-init) leaves a permanently
    // rejected promise in the module cache - and then EVERY later call, in
    // this document's whole lifetime, re-throws that same stale error. The
    // user sees a wallet that can never reconnect until Chrome recycles the
    // offscreen document.
    clientPromise = SignClient.init({
      projectId: WC_PROJECT_ID,
      metadata: WC_METADATA,
    }).catch((err) => {
      clientPromise = null
      void logConnect('signclient_init_failed', err)
      throw err
    })
  }
  return clientPromise
}

/** Test seam: forget the cached client so a case can supply its own. */
export function _resetSignClient(): void {
  clientPromise = null
}

/** How long a dropped relay socket gets to come back before we give up. */
const RELAY_OPEN_TIMEOUT_MS = 10_000

/**
 * Make sure the relay socket is up before sending anything over it.
 *
 * A WalletConnect session outlives its transport. Leave the extension alone
 * for a day and the session is still stored, still unexpired, still pointing
 * at a WebSocket that closed hours ago. `client.request` into that socket does
 * not fail - it produces nothing at all: the wallet never receives the
 * request, the user is never prompted, and the caller waits on a promise that
 * will never settle. That is indistinguishable, from the outside, from a user
 * who approved a signature and saw nothing happen.
 *
 * `connected` and `transportOpen()` are the relayer's own API for exactly
 * this, so this is a precondition being stated rather than a workaround.
 */
async function ensureRelayUp(client: WCSignClient, timeoutMs: number): Promise<void> {
  const relayer = (client as unknown as { core?: { relayer?: { connected: boolean; transportOpen: () => Promise<void> } } })
    .core?.relayer
  // A client shape without a relayer (older SDK, a stub) is not something to
  // fail on: the request path below is unchanged for it.
  if (!relayer || relayer.connected) return
  await logConnect('relay_reopening', 'socket was closed, reconnecting before the request')
  try {
    await withTimeout(relayer.transportOpen(), timeoutMs)
  } catch (err) {
    await logConnect('relay_unreachable', err)
    throw new Error(`wc_relay_unreachable:${describeError(err)}`)
  }
  await logConnect('relay_reopened')
}

export interface ActiveSession {
  topic: string
  address: string // EOA, lowercased
}

function sessionAddress(s: { namespaces: { eip155?: { accounts?: string[] } } }): string | undefined {
  const account = s.namespaces.eip155?.accounts?.[0] // "eip155:137:0xABC..."
  return account?.split(':')[2]?.toLowerCase()
}

/**
 * Look up the live WC session, preferring the exact topic the caller already
 * has stored.
 *
 * `preferredTopic` is the whole point of this function. Nothing prunes WC
 * sessions on the wallet's side, so a user who has connected more than once
 * has several live sessions at the same time. Picking "the one with the
 * furthest expiry" - as this used to, unconditionally - then returns an
 * arbitrary one of them, which the caller reads as "you're connected to a
 * different wallet now". Ask for our own topic first; fall back to
 * furthest-expiry only when the caller has no topic to ask for (a cold
 * lookup with nothing in storage).
 */
export async function restoreSession(preferredTopic?: string): Promise<ActiveSession | null> {
  if (!WC_PROJECT_ID) return null
  const client = await getSignClient()
  const sessions = client.session.getAll()
  if (sessions.length === 0) return null

  const preferred = preferredTopic ? sessions.find((s) => s.topic === preferredTopic) : undefined
  // Sorted defensively - WC v2 returns sessions in roughly creation order.
  const s = preferred ?? [...sessions].sort((a, b) => b.expiry - a.expiry)[0]
  const address = sessionAddress(s)
  if (!address) return null
  return { topic: s.topic, address }
}

/**
 * Disconnect every live session except `keepTopic`, and report how many were
 * dropped.
 *
 * Called right after a successful connect. Each connect leaves the previous
 * session live on the relay, and that pile-up is what made session lookup
 * ambiguous in the first place - one session in the store means there is
 * nothing to pick wrong. Best-effort per session: a relay that won't take the
 * teardown must not fail the connect the user just completed.
 */
const PRUNE_TIMEOUT_MS = 4000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

export async function pruneOtherSessions(keepTopic: string): Promise<number> {
  if (!WC_PROJECT_ID) return 0
  let dropped = 0
  try {
    const client = await getSignClient()
    const stale = client.session.getAll().filter((s) => s.topic !== keepTopic)
    // Time-boxed and concurrent. Each teardown is a relay round-trip to a peer
    // that is, by definition, most likely gone, so an unbounded `await` can
    // stall indefinitely - and doing them one after another multiplies that by
    // however many sessions have piled up.
    const results = await Promise.all(
      stale.map(async (s) => {
        try {
          await withTimeout(
            client.disconnect({
              topic: s.topic,
              reason: { code: 6000, message: 'superseded_by_new_session' },
            }),
            PRUNE_TIMEOUT_MS,
          )
          return true
        } catch {
          // Best-effort - see above. An un-torn-down session is harmless:
          // restoreSession() now looks its topic up by name rather than
          // guessing, and WC expires it on its own.
          return false
        }
      }),
    )
    dropped = results.filter(Boolean).length
  } catch {
    // Client unavailable - nothing to prune, and definitely not worth
    // failing the connect over.
  }
  return dropped
}

export interface ConnectStart {
  /** wc: URI for QR / deeplink */
  uri: string
  /** Resolves when the user approves in their wallet */
  approval: Promise<ActiveSession>
}

/**
 * Begin a connect attempt. The caller renders the returned `uri` as a QR
 * (and as an "Open in wallet" deeplink), and awaits `approval` for the
 * session.
 */
export async function startConnect(): Promise<ConnectStart> {
  const client = await getSignClient()
  // `requiredNamespaces` is deprecated - the SDK logs "requiredNamespaces are
  // deprecated and are automatically assigned to optionalNamespaces" and does
  // exactly that. So nothing we ask for is actually required any more: the
  // wallet is free to approve a session that grants neither Polygon nor
  // eth_signTypedData_v4, and the approval still succeeds. That is the split
  // that made this look like "I approved it and nothing happened" - the
  // session connects, and only the LATER signature request fails, because the
  // method it needs was never in the approved namespaces.
  //
  // Declared as optionalNamespaces directly (no deprecated field), with the
  // signing methods wallets actually recognise, so there is the best chance of
  // being granted what we need - and checked below, so a session that lacks it
  // fails immediately with something the user can act on.
  const eip155 = {
    methods: [SIGN_METHOD, 'eth_signTypedData', 'personal_sign'],
    chains: [POLYGON_CHAIN_ID],
    events: ['chainChanged', 'accountsChanged'],
  }
  // BOTH fields, deliberately, despite the deprecation warning on the first.
  // Dropping requiredNamespaces to silence that warning was a mistake: plenty
  // of wallets still build their approval screen from requiredNamespaces, and
  // a proposal carrying only optionalNamespaces gives them nothing to render -
  // they sit on a spinner and never produce an approval at all. The warning is
  // noise; interop is not. The post-approval check below is what actually
  // guarantees we got Polygon and the signing method, on any wallet.
  const { uri, approval } = await client.connect({
    requiredNamespaces: { eip155 },
    optionalNamespaces: { eip155 },
  })
  if (!uri) {
    throw new Error('wc_no_uri')
  }
  const approvalPromise = approval().then((session) => {
    const ns = session.namespaces.eip155
    const accounts = ns?.accounts ?? []
    // Prefer an account the wallet granted ON Polygon. Signing Polymarket's
    // EIP-712 payload (whose domain says chainId 137) through a session scoped
    // to another chain is what wallets reject with "provided chainId must
    // match the active chainId".
    void logConnect(
      'session_namespaces',
      `chains=[${accounts.map((a) => a.split(':').slice(0, 2).join(':')).join(' ')}] methods=[${(ns?.methods ?? []).join(' ')}]`,
    )
    const polygonAccount = accounts.find((a) => a.startsWith(`${POLYGON_CHAIN_ID}:`))
    if (!polygonAccount) {
      const granted = accounts.map((a) => a.split(':').slice(0, 2).join(':')).join(',')
      throw new Error(`wc_no_polygon_account:${granted || 'none'}`)
    }
    const address = polygonAccount.split(':')[2]?.toLowerCase()
    if (!address) throw new Error('wc_session_missing_account')
    if (!(ns?.methods ?? []).includes(SIGN_METHOD)) {
      throw new Error(`wc_method_not_granted:${SIGN_METHOD}`)
    }
    return { topic: session.topic, address }
  })
  return { uri, approval: approvalPromise }
}

export async function disconnect(topic: string): Promise<void> {
  try {
    const client = await getSignClient()
    await client.disconnect({
      topic,
      reason: { code: 6000, message: 'user_disconnect' },
    })
  } catch {
    // Session may already be gone, or the WC client couldn't even
    // initialize (relay unreachable, offline, corrupted WC storage) - either
    // way this must not throw: the caller's local storage wipe is what
    // actually matters for "did my creds get cleared", and must proceed
    // regardless of whether the relay-side teardown succeeded.
  }
}

/**
 * Drop the cached SignClient so the next `getSignClient()` call constructs a
 * fresh one. Used after a wipe that deletes WalletConnect's own IndexedDB
 * storage out from under an already-initialized client - without this, a
 * subsequent connect would keep using a client bound to now-deleted storage.
 */
export function resetSignClient(): void {
  clientPromise = null
}

/**
 * Send one raw JSON-RPC request over the active WC session.
 *
 * The generic form behind signTypedData, exposed so the redeem path can back
 * an EIP-1193 provider with this session (viem needs one to build a
 * WalletClient, which is the only signer shape Polymarket's relayer accepts
 * short of a private key). Only methods the wallet actually granted will be
 * accepted - the SDK validates each request against the approved namespaces.
 */
export async function wcRequest(
  topic: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  const client = await getSignClient()
  // Same reason as in signTypedData: the redeem path sends over this session
  // too, and a socket that closed while the extension sat idle swallows the
  // request without a word.
  await ensureRelayUp(client, RELAY_OPEN_TIMEOUT_MS)
  return client.request({
    topic,
    chainId: POLYGON_CHAIN_ID,
    request: { method, params },
  })
}

/**
 * Sign EIP-712 typed data via the active WC session. Returns a hex signature.
 */
export async function signTypedData(
  topic: string,
  address: string,
  typedData: unknown,
  opts: { relayTimeoutMs?: number } = {},
): Promise<string> {
  const client = await getSignClient()
  await ensureRelayUp(client, opts.relayTimeoutMs ?? RELAY_OPEN_TIMEOUT_MS)
  const sig = (await client.request({
    topic,
    chainId: POLYGON_CHAIN_ID,
    request: {
      method: 'eth_signTypedData_v4',
      params: [address, JSON.stringify(typedData)],
    },
  })) as string
  return sig
}

/**
 * WCSigner - implements the minimal "EthersSigner" shape that
 * `@polymarket/clob-client-v2` checks for: `_signTypedData` (note the
 * underscore - that is the ethers v5 method name, which the SDK still
 * uses for compatibility) and `getAddress`.
 *
 * We do NOT extend ethers' AbstractSigner because v6 renamed the method
 * to `signTypedData` without an alias; the SDK feature-detects on the
 * v5 name. A plain class with the right shape is simpler and works
 * across SDK versions.
 *
 * We never broadcast transactions - CLOB orders are signed and submitted
 * off-chain via the Relayer.
 */
export class WCSigner {
  constructor(
    public readonly topic: string,
    public readonly eoa: string,
  ) {}

  async getAddress(): Promise<string> {
    return checksum(this.eoa)
  }

  // eslint-disable-next-line @typescript-eslint/naming-convention
  async _signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    // clob-client-v2 deletes `types.EIP712Domain` before calling us - correct
    // for ethers signers, which reconstruct the domain type internally, but
    // a raw eth_signTypedData_v4 payload MUST include it per the EIP-712
    // schema. Without it, MetaMask/eth-sig-util substitute an EMPTY domain
    // type, hash an empty domain separator, and the signature can never
    // verify against the real CLOB/ClobAuth domain - every connect and order
    // sign fails. Rebuild it from whichever domain fields are actually
    // present, in the canonical EIP-712 order.
    const payload = {
      domain,
      types: { EIP712Domain: buildDomainType(domain), ...types },
      primaryType: inferPrimaryType(types),
      message: value,
    }
    return signTypedData(this.topic, this.eoa, payload)
  }
}

const EIP712_DOMAIN_FIELD_TYPES: ReadonlyArray<{ name: string; type: string }> = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
  { name: 'salt', type: 'bytes32' },
]

export function buildDomainType(domain: Record<string, unknown>): Array<{ name: string; type: string }> {
  return EIP712_DOMAIN_FIELD_TYPES.filter((f) => domain[f.name] !== undefined)
}

function inferPrimaryType(
  types: Record<string, Array<{ name: string; type: string }>>,
): string {
  // EIP-712 lists each type; the primary is the one not referenced as a
  // field type by any other. clob-client-v2 produces a single non-EIP712Domain
  // top-level type for orders, so we pick the first non-EIP712Domain entry.
  const keys = Object.keys(types).filter((k) => k !== 'EIP712Domain')
  return keys[0] ?? 'Order'
}

/**
 * Minimal EIP-55 checksum without pulling ethers. EOA addresses go in as
 * lowercase from WC; we normalize to checksum form for any consumer that
 * cares (the SDK accepts either).
 */
function checksum(addr: string): string {
  // For our purposes lowercase is fine - the SDK normalizes internally.
  // If a downstream consumer rejects mixed-case we can swap in a full
  // EIP-55 implementation, but it's not needed today.
  return addr.toLowerCase()
}

export { POLYGON_CHAIN_ID_NUM }
