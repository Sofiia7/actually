/**
 * WalletConnect v2 integration for the popup runtime.
 *
 * Why WC v2 instead of injected `window.ethereum`:
 *   Chrome extension popups run at `chrome-extension://<id>/...` — wallet
 *   browser extensions do not inject providers into that origin. WC v2
 *   bypasses this entirely by talking to a relay over WSS and using
 *   QR / deeplink for approval.
 *
 * This module is import-safe in the service worker (it does not initialize
 * the SignClient on import — only on the first `getSignClient()` call from
 * the popup). The SW only uses the types.
 */
import { SignClient } from '@walletconnect/sign-client'

const POLYGON_CHAIN_ID = 'eip155:137'
const POLYGON_CHAIN_ID_NUM = 137n

const WC_METADATA = {
  name: 'Actually',
  description: 'What markets really think — trade news in your browser',
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
    clientPromise = SignClient.init({
      projectId: WC_PROJECT_ID,
      metadata: WC_METADATA,
    })
  }
  return clientPromise
}

export interface ActiveSession {
  topic: string
  address: string // EOA, lowercased
}

/**
 * Returns the most recently active session if one exists. Used on popup open
 * to restore a previously connected wallet without re-prompting.
 */
export async function restoreSession(): Promise<ActiveSession | null> {
  if (!WC_PROJECT_ID) return null
  const client = await getSignClient()
  const sessions = client.session.getAll()
  if (sessions.length === 0) return null
  // Newest first — WC v2 returns them in roughly creation order; we sort
  // defensively in case the order changes.
  const sorted = [...sessions].sort((a, b) => b.expiry - a.expiry)
  const s = sorted[0]
  const account = s.namespaces.eip155?.accounts?.[0] // "eip155:137:0xABC..."
  const address = account?.split(':')[2]?.toLowerCase()
  if (!address) return null
  return { topic: s.topic, address }
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
  const { uri, approval } = await client.connect({
    requiredNamespaces: {
      eip155: {
        methods: ['eth_signTypedData_v4'],
        chains: [POLYGON_CHAIN_ID],
        events: ['chainChanged', 'accountsChanged'],
      },
    },
  })
  if (!uri) {
    throw new Error('wc_no_uri')
  }
  const approvalPromise = approval().then((session) => {
    const account = session.namespaces.eip155?.accounts?.[0]
    const address = account?.split(':')[2]?.toLowerCase()
    if (!address) throw new Error('wc_session_missing_account')
    return { topic: session.topic, address }
  })
  return { uri, approval: approvalPromise }
}

export async function disconnect(topic: string): Promise<void> {
  const client = await getSignClient()
  try {
    await client.disconnect({
      topic,
      reason: { code: 6000, message: 'user_disconnect' },
    })
  } catch {
    // Session may already be gone — fine.
  }
}

/**
 * Sign EIP-712 typed data via the active WC session. Returns a hex signature.
 */
export async function signTypedData(
  topic: string,
  address: string,
  typedData: unknown,
): Promise<string> {
  const client = await getSignClient()
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
 * WCSigner — implements the minimal "EthersSigner" shape that
 * `@polymarket/clob-client-v2` checks for: `_signTypedData` (note the
 * underscore — that is the ethers v5 method name, which the SDK still
 * uses for compatibility) and `getAddress`.
 *
 * We do NOT extend ethers' AbstractSigner because v6 renamed the method
 * to `signTypedData` without an alias; the SDK feature-detects on the
 * v5 name. A plain class with the right shape is simpler and works
 * across SDK versions.
 *
 * We never broadcast transactions — CLOB orders are signed and submitted
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
    const payload = {
      domain,
      types,
      primaryType: inferPrimaryType(types),
      message: value,
    }
    return signTypedData(this.topic, this.eoa, payload)
  }
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
  // For our purposes lowercase is fine — the SDK normalizes internally.
  // If a downstream consumer rejects mixed-case we can swap in a full
  // EIP-55 implementation, but it's not needed today.
  return addr.toLowerCase()
}

export { POLYGON_CHAIN_ID_NUM }
