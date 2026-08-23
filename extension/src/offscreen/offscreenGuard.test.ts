import { describe, expect, it } from 'vitest'
import { isOffscreenDocument } from './context'

/**
 * The guard that stops every offscreen operation from running twice.
 *
 * offscreen.ts registers a global chrome.runtime.onMessage listener at import
 * time, and the bundler puts its entry chunk into the popup page and the
 * service worker as well (the popup statically imports background/* modules
 * that share this module's graph - dist/src/popup/index.html loads the same
 * offscreen chunk). `routeToOffscreen` forwards via chrome.runtime.sendMessage,
 * which broadcasts to every context except the sender, so with the listener
 * live in more than one context each request was handled more than once:
 * connect started twice, the wallet was asked to sign twice, and an order
 * could be submitted twice.
 */
describe('isOffscreenDocument', () => {
  it('is true only for the real offscreen document', () => {
    expect(isOffscreenDocument('/src/offscreen/offscreen.html')).toBe(true)
  })

  it('is false in the popup - the context that was silently doubling every op', () => {
    expect(isOffscreenDocument('/src/popup/index.html')).toBe(false)
  })

  it('is false in the service worker', () => {
    expect(isOffscreenDocument('/service-worker-loader.js')).toBe(false)
    expect(isOffscreenDocument('/assets/index.ts-BmYwFkRN.js')).toBe(false)
  })

  it('is not fooled by a lookalike path', () => {
    // Must match the directory too - a stray /offscreen.html at the root, or a
    // page merely named like it, is not our document.
    expect(isOffscreenDocument('/offscreen.html')).toBe(false)
    expect(isOffscreenDocument('/src/popup/not-offscreen.html')).toBe(false)
  })

  it('survives a context with no location at all', () => {
    expect(isOffscreenDocument(undefined)).toBe(false)
  })
})
