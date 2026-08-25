/**
 * End-to-end wallet connect, with no human and no money.
 *
 *   npm run e2e:wallet
 *
 * The wallet half of every previous test was a person with a phone, so
 * "connect and sign" was only ever verified by asking the user to try again,
 * and a failure produced a screenshot rather than a stack. This runs the other
 * half automatically: a WalletConnect client in Node that pairs with the
 * extension, approves the session, and answers eth_signTypedData_v4 with a
 * throwaway key. The extension is the real packaged dist/ in a real browser.
 *
 * What it proves when it passes: the extension can propose a session, a wallet
 * can approve it, the CLOB-auth signature is requested and answered over the
 * relay, and credentials come back - the exact sequence that has been failing.
 *
 * Local tool, not CI:
 *   - it talks to the live WalletConnect relay and the live CLOB;
 *   - connect is geo-gated through the Worker, and CI runners sit in a blocked
 *     country;
 *   - it derives a CLOB API key for a random throwaway address, which is what
 *     any first connect does, but is still a real call to Polymarket.
 *
 * Exit 0 = the whole path worked. 1 = it did not, with the stage named.
 */
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { SignClient } from '@walletconnect/sign-client'
import { Wallet } from 'ethers'

const DIST = resolve('dist')
const CHANNEL = process.argv.includes('--channel')
  ? process.argv[process.argv.indexOf('--channel') + 1]
  : 'msedge'
const HEADED = process.argv.includes('--headed')

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  console.error(`  ✗ ${m}`)
  failures++
}

if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('No dist/manifest.json - run `npm run build` first.')
  process.exit(2)
}

const env = readFileSync('.env.local', 'utf8')
const projectId = env.match(/^VITE_WC_PROJECT_ID=(.+)$/m)?.[1]?.trim()
if (!projectId) {
  console.error('VITE_WC_PROJECT_ID missing from extension/.env.local')
  process.exit(2)
}

// A fresh key each run: this is a counterparty, not an account. It never holds
// funds and never signs anything but the CLOB auth message.
const signer = Wallet.createRandom()
const ADDRESS = signer.address

const profile = mkdtempSync(join(tmpdir(), 'actually-wallet-e2e-'))
let context
let walletClient

const deadline = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)),
  ])

try {
  console.log(`E2E wallet on dist/ (${HEADED ? 'headed' : 'headless'} ${CHANNEL}), counterparty ${ADDRESS}`)

  context = await chromium.launchPersistentContext(profile, {
    channel: CHANNEL,
    headless: !HEADED,
    viewport: { width: 420, height: 660 },
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  })

  let sw = context.serviceWorkers()[0]
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 })
  const extensionId = new URL(sw.url()).host
  ok(`extension up (${extensionId})`)

  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`)
  await page.waitForSelector('#root > *', { timeout: 15_000 })
  ok('popup mounted')

  // --- the extension proposes ------------------------------------------
  const started = await page.evaluate(() =>
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'OS_START_CONNECT' }),
  )
  if (started?.type !== 'OS_CONNECT_STARTED') {
    bad(`connect did not start: ${JSON.stringify(started)}`)
    throw new Error('no session id')
  }
  const sessionId = started.sessionId
  ok('connect started')

  const poll = () =>
    page.evaluate(
      (id) => chrome.runtime.sendMessage({ target: 'offscreen', type: 'OS_POLL_CONNECT', sessionId: id }),
      sessionId,
    )

  const waitFor = async (predicate, what, ms) => {
    const started = Date.now()
    for (;;) {
      const state = await poll()
      if (state?.stage === 'error') throw new Error(`extension reported: ${state.error}`)
      if (predicate(state)) return state
      if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`)
      await page.waitForTimeout(400)
    }
  }

  const withUri = await waitFor((s) => Boolean(s?.uri), 'the pairing URI', 30_000)
  ok('pairing URI produced')

  // --- the wallet answers ----------------------------------------------
  walletClient = await SignClient.init({
    projectId,
    metadata: {
      name: 'Actually test counterparty',
      description: 'Automated wallet for e2e-wallet.mjs',
      url: 'https://example.com',
      icons: [],
    },
  })

  walletClient.on('session_proposal', async (proposal) => {
    try {
      await walletClient.approve({
        id: proposal.id,
        namespaces: {
          eip155: {
            accounts: [`eip155:137:${ADDRESS}`],
            methods: ['eth_signTypedData_v4', 'eth_signTypedData', 'personal_sign'],
            events: ['chainChanged', 'accountsChanged'],
          },
        },
      })
      ok('wallet approved the session')
    } catch (err) {
      bad(`wallet could not approve: ${err.message}`)
    }
  })

  let signatures = 0
  walletClient.on('session_request', async (event) => {
    const { topic, params, id } = event
    const method = params?.request?.method
    try {
      if (!String(method).startsWith('eth_signTypedData')) {
        throw new Error(`unexpected method ${method}`)
      }
      const typed = JSON.parse(params.request.params[1])
      const types = { ...typed.types }
      delete types.EIP712Domain
      const signature = await signer.signTypedData(typed.domain, types, typed.message)
      await walletClient.respond({ topic, response: { id, jsonrpc: '2.0', result: signature } })
      signatures++
      ok(`wallet signed ${method} (${signatures})`)
    } catch (err) {
      bad(`wallet could not sign: ${err.message}`)
      await walletClient
        .respond({ topic, response: { id, jsonrpc: '2.0', error: { code: 5000, message: err.message } } })
        .catch(() => {})
    }
  })

  await deadline(walletClient.core.pairing.pair({ uri: withUri.uri }), 30_000, 'pairing')
  ok('wallet paired')

  // --- the extension finishes -------------------------------------------
  const done = await waitFor((s) => s?.stage === 'done', 'the connect to complete', 180_000)
  if (!done.wallet?.address) {
    bad('connect finished without a wallet address')
  } else if (done.wallet.address.toLowerCase() !== ADDRESS.toLowerCase()) {
    bad(`connected the wrong account: ${done.wallet.address} instead of ${ADDRESS}`)
  } else {
    ok(`connected as ${done.wallet.address}`)
  }
  if (done.wallet?.creds?.key) ok('CLOB credentials derived')
  else bad('no CLOB credentials came back')
  if (signatures === 0) bad('the wallet was never asked to sign anything')

  // --- the same thing again, across a dead relay socket ------------------
  // The reported failure was not a first connect: it was coming back after a
  // day, finding the wallet unusable, disconnecting and reconnecting, and then
  // approving a signature that never arrived anywhere. A day of idling kills
  // the relay WebSocket, so that is what this reproduces - drop the network
  // under the socket, restore it, and connect again without a reload.
  if (failures === 0) {
    const signedBefore = signatures
    // Drop the stored CLOB credentials so the reconnect has to ask the wallet
    // to sign again. Without this the second connect reuses what is on disk,
    // never touches the relay for a signature, and proves nothing about the
    // socket that was just killed.
    await page.evaluate(async () => {
      const data = await chrome.storage.local.get('settings')
      const settings = data.settings ?? {}
      delete settings.clobApiKey
      delete settings.clobApiSecret
      delete settings.clobApiPassphrase
      await chrome.storage.local.set({ settings })
    })
    ok('stored credentials cleared, so the reconnect must sign again')

    await context.setOffline(true)
    await page.waitForTimeout(3000)
    await context.setOffline(false)
    ok('relay socket dropped and network restored')

    const second = await page.evaluate(() =>
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'OS_START_CONNECT' }),
    )
    if (second?.type !== 'OS_CONNECT_STARTED') {
      bad(`second connect did not start: ${JSON.stringify(second)}`)
    } else {
      const pollSecond = () =>
        page.evaluate(
          (id) => chrome.runtime.sendMessage({ target: 'offscreen', type: 'OS_POLL_CONNECT', sessionId: id }),
          second.sessionId,
        )
      const waitSecond = async (predicate, what, ms) => {
        const startedAt = Date.now()
        for (;;) {
          const state = await pollSecond()
          if (state?.stage === 'error') throw new Error(`extension reported: ${state.error}`)
          if (predicate(state)) return state
          if (Date.now() - startedAt > ms) throw new Error(`timed out waiting for ${what}`)
          await page.waitForTimeout(400)
        }
      }
      const uri2 = await waitSecond((s) => Boolean(s?.uri), 'the second pairing URI', 45_000)
      await deadline(walletClient.core.pairing.pair({ uri: uri2.uri }), 45_000, 'the second pairing')
      const done2 = await waitSecond((s) => s?.stage === 'done', 'the second connect', 180_000)
      if (done2.wallet?.address) ok('reconnected across a dropped relay socket')
      else bad('second connect finished without a wallet')
      if (signatures > signedBefore) ok('signed again over the restored relay socket')
      else bad('the reconnect never asked the wallet to sign, so the relay was not exercised')
    }
  }
} catch (err) {
  bad(err.message)
} finally {
  try {
    await walletClient?.core?.relayer?.transportClose?.()
  } catch {
    /* nothing to close */
  }
  await context?.close()
  rmSync(profile, { recursive: true, force: true })
}

console.log(failures ? `\nE2E WALLET FAILED (${failures} issue${failures > 1 ? 's' : ''})` : '\nE2E WALLET PASSED')
process.exit(failures ? 1 : 0)
