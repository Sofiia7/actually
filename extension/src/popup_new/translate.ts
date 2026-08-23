/**
 * Translate a non-English article into English before matching.
 *
 * Every market question on Polymarket is written in English, and the local
 * embedding model (`Xenova/all-MiniLM-L12-v2`) only speaks English: its
 * vocabulary holds 86 Cyrillic tokens out of 30522, so a Russian headline
 * embeds to noise. Measured against the live thresholds, a Russian headline
 * scores 0.01-0.24 against the market it is actually about (floor is 0.35),
 * while the same headline translated scores 0.53-0.71 — comfortably
 * CONFIDENT. Translating the article is therefore worth far more than
 * swapping in a multilingual embedder, and costs nothing at runtime.
 *
 * The translation comes from Chrome's built-in Translator API (Chrome 138+,
 * desktop): local, free, no network, no new permission, no bundle growth.
 * Two constraints shape where this runs:
 *
 *   - `Translator.create()` needs transient user activation, and the API is
 *     unavailable in workers. Both are satisfied here and only here: the
 *     match pipeline is driven from the popup (see the service worker's
 *     `handled_in_popup` reply), which is a real document opened by a user
 *     click. This must NOT be moved into the offscreen document.
 *   - Not every browser has it. Anything short of a working translation
 *     degrades to checking the original text and telling the user why, which
 *     is the honest failure: "no market matched" and "your browser cannot
 *     read this page" are different answers and used to look identical.
 */
import type { ArticleData } from '../shared/types'

/** Chrome's four availability states for a language pair. */
export type TranslatorAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable'

export interface TranslatePair {
  sourceLanguage: string
  targetLanguage: string
}

export interface TranslatorHandle {
  translate(text: string): Promise<string>
}

/** The slice of Chrome's Translator API this module needs. Injected so the
 *  logic is testable without a browser. */
export interface TranslatorApi {
  availability(pair: TranslatePair): Promise<TranslatorAvailability>
  /** `onProgress` receives 0..1 while the language pack downloads. */
  create(pair: TranslatePair, onProgress?: (fraction: number) => void): Promise<TranslatorHandle>
}

/** The slice of Chrome's LanguageDetector API this module needs. */
export interface LanguageDetectorApi {
  detect(text: string): Promise<string | null>
}

export type TranslationOutcome =
  | { kind: 'not_needed' }
  | { kind: 'translated'; language: string; article: ArticleData }
  /** No Translator API in this browser at all (too old, or not Chrome). */
  | { kind: 'unsupported_browser'; language: string }
  /** API present, but it cannot do this language pair on this device. */
  | { kind: 'unsupported_pair'; language: string }
  | { kind: 'failed'; language: string; error: string }

export interface TranslateDeps {
  translator: TranslatorApi | null
  detector?: LanguageDetectorApi | null
  /** Called with the source language when a one-time language-pack download
   *  is about to start, so the UI can say so instead of looking frozen. */
  onDownloadStart?: (language: string) => void
  /** Download progress, 0..1, while that pack arrives. Chrome shows no UI of
   *  its own for it, and the pack is tens of megabytes: without a number on
   *  screen a working download is indistinguishable from a hang. */
  onDownloadProgress?: (language: string, fraction: number) => void
  /**
   * Deadline for the calls that should be instant (availability, translate).
   *
   * Not paranoia: a shipped Chromium build was observed exposing `Translator`
   * on the global while `availability()` never settled. An unbounded await
   * there hangs the popup on a spinner forever, which is a worse answer than
   * "could not translate this page".
   */
  timeoutMs?: number
  /**
   * How long `create()` may go WITHOUT progress before it is abandoned.
   *
   * Not a total deadline: the first use of a language downloads a pack big
   * enough to outlast any fixed number on a slow connection, and cutting a
   * healthy download off at two minutes is indistinguishable, from the user's
   * side, from the feature not working. What separates a slow download from a
   * dead one is whether the bytes are still moving.
   */
  createIdleMs?: number
}

const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_CREATE_IDLE_MS = 60_000

class TranslationTimeout extends Error {}

/**
 * One translator per language for the life of the popup.
 *
 * `create()` is not free even once the pack is on disk — it spins up a model
 * session — and the popup runs a check per click, so rebuilding it every time
 * charges the user for the same setup repeatedly. A failed build is evicted so
 * the next check retries rather than inheriting a dead promise.
 */
const translators = new Map<string, Promise<TranslatorHandle>>()

/** Test seam: drop cached translators between cases. */
export function _resetTranslatorCache(): void {
  translators.clear()
}

function getTranslator(
  api: TranslatorApi,
  pair: TranslatePair,
  onProgress: (fraction: number) => void,
): Promise<TranslatorHandle> {
  const key = `${pair.sourceLanguage}->${pair.targetLanguage}`
  const existing = translators.get(key)
  if (existing) return existing
  const created = api.create(pair, onProgress).catch((err: unknown) => {
    translators.delete(key)
    throw err
  })
  translators.set(key, created)
  return created
}

/**
 * Like `withTimeout`, but the clock restarts every time `bump()` is called.
 * `start` receives that bump so it can report "still alive" from a progress
 * callback.
 */
function withIdleTimeout<T>(
  start: (bump: () => void) => Promise<T>,
  idleMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    let settled = false
    const arm = () => {
      if (settled) return
      clearTimeout(timer)
      timer = setTimeout(() => reject(new TranslationTimeout(`timed out ${label}`)), idleMs)
    }
    arm()
    start(arm).then(
      (value) => {
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        settled = true
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TranslationTimeout(`timed out ${label}`)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

const CYRILLIC = /[Ѐ-ӿ]/

/** 'ru-RU' → 'ru'; anything that isn't a plausible language subtag → ''. */
function normalizeLang(raw: string | null | undefined): string {
  const base = (raw ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return /^[a-z]{2,3}$/.test(base) ? base : ''
}

/**
 * Which language the article is in.
 *
 * The page's own `<html lang>` is the cheapest and most reliable signal —
 * rbc.ru declares `ru`, spiegel.de declares `de` — so it wins, with one
 * exception: a page that claims English while its headline is in Cyrillic is
 * wrong about itself, and that combination is common enough on mirrors and
 * embeds to be worth overriding.
 */
export async function resolveSourceLanguage(
  article: ArticleData,
  detector: LanguageDetectorApi | null,
): Promise<string> {
  const cyrillic = CYRILLIC.test(article.headline)
  const declared = normalizeLang(article.pageLang)
  if (declared && !(declared === 'en' && cyrillic)) return declared

  if (detector) {
    try {
      const detected = normalizeLang(await detector.detect(`${article.headline} ${article.bodyText}`.trim()))
      if (detected) return detected
    } catch {
      /* detector is best-effort — fall through to the script heuristic */
    }
  }

  return cyrillic ? 'ru' : 'en'
}

export async function translateArticle(
  article: ArticleData,
  deps: TranslateDeps,
): Promise<TranslationOutcome> {
  const language = await resolveSourceLanguage(article, deps.detector ?? null)
  if (language === 'en') return { kind: 'not_needed' }
  if (!deps.translator) return { kind: 'unsupported_browser', language }

  const pair: TranslatePair = { sourceLanguage: language, targetLanguage: 'en' }
  const quick = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const idle = deps.createIdleMs ?? DEFAULT_CREATE_IDLE_MS
  try {
    const availability = await withTimeout(
      deps.translator.availability(pair),
      quick,
      'checking the translator',
    )
    if (availability === 'unavailable') return { kind: 'unsupported_pair', language }
    // 'downloadable' and 'downloading' both mean the user is about to wait on
    // a language pack that arrives once and is reused forever after.
    if (availability !== 'available') deps.onDownloadStart?.(language)

    const translator = await withIdleTimeout(
      (bump) =>
        getTranslator(deps.translator!, pair, (fraction) => {
          bump()
          deps.onDownloadProgress?.(language, fraction)
        }),
      idle,
      'preparing the translator',
    )
    const translate = (text: string) => withTimeout(translator.translate(text), quick, 'translating')
    const headline = await translate(article.headline)
    const bodyText = article.bodyText ? await translate(article.bodyText) : article.bodyText
    return { kind: 'translated', language, article: { ...article, headline, bodyText } }
  } catch (err) {
    return { kind: 'failed', language, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 'de' → 'German'. Falls back to the raw code for anything unrecognized. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

export interface TranslationNotice {
  tone: 'info' | 'warn'
  text: string
}

/**
 * One line above the result explaining what happened to the text before it
 * was matched. Shown every time it applies: it is not an offer to dismiss,
 * it is the reason the answer below it looks the way it does.
 */
export function translationNotice(outcome: TranslationOutcome): TranslationNotice | null {
  const name = 'language' in outcome ? languageName(outcome.language) : ''
  switch (outcome.kind) {
    case 'not_needed':
      return null
    case 'translated':
      return { tone: 'info', text: `Translated from ${name} before matching.` }
    case 'unsupported_browser':
      return {
        tone: 'warn',
        text:
          `This page is in ${name}. Actually matches English market questions, and this browser has no ` +
          'built-in translator: that needs Chrome 138 or newer on desktop. Checked the original text instead.',
      }
    case 'unsupported_pair':
      return {
        tone: 'warn',
        text: `Your browser cannot translate ${name} to English on this device. Checked the original text instead.`,
      }
    case 'failed':
      return {
        tone: 'warn',
        text: `Could not translate this page from ${name}, so the check ran on the original text.`,
      }
  }
}

// --- browser adapters -------------------------------------------------
// Thin shims over the real globals. Not unit-tested (there is nothing to
// test but the shape of an API we do not own); every decision above them is.

interface DownloadProgressEvent extends Event {
  loaded: number
}

interface ChromeTranslatorGlobal {
  availability(pair: TranslatePair): Promise<TranslatorAvailability>
  create(opts: TranslatePair & { monitor?: (m: EventTarget) => void }): Promise<TranslatorHandle>
}

interface ChromeDetectorGlobal {
  availability(): Promise<TranslatorAvailability>
  create(): Promise<{ detect(text: string): Promise<Array<{ detectedLanguage: string; confidence: number }>> }>
}

/** The page's Translator API, or null when this browser has none. */
export function browserTranslator(): TranslatorApi | null {
  const api = (globalThis as { Translator?: ChromeTranslatorGlobal }).Translator
  if (!api?.create || !api.availability) return null
  return {
    availability: (pair) => api.availability(pair),
    create: (pair, onProgress) =>
      api.create({
        ...pair,
        // Chrome reports the language-pack download here and nowhere else.
        monitor: (m) =>
          m.addEventListener('downloadprogress', (e) =>
            onProgress?.((e as DownloadProgressEvent).loaded),
          ),
      }),
  }
}

/** The page's LanguageDetector API, or null when this browser has none. */
export function browserDetector(): LanguageDetectorApi | null {
  const api = (globalThis as { LanguageDetector?: ChromeDetectorGlobal }).LanguageDetector
  if (!api?.create || !api.availability) return null
  return {
    async detect(text: string) {
      if ((await api.availability()) === 'unavailable') return null
      const detector = await api.create()
      const results = await detector.detect(text)
      return results?.[0]?.detectedLanguage ?? null
    },
  }
}
