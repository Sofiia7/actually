import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArticleData } from '../shared/types'
import {
  _resetTranslatorCache,
  languageName,
  resolveSourceLanguage,
  translateArticle,
  translationNotice,
  type TranslatorApi,
} from './translate'

beforeEach(() => {
  _resetTranslatorCache()
})

function article(over: Partial<ArticleData> = {}): ArticleData {
  return {
    headline: 'Trump threatened China with new tariffs',
    bodyText: 'The president said the measure would take effect next month.',
    url: 'https://example.com/a',
    domain: 'example.com',
    ...over,
  }
}

const RU = article({
  headline: 'Трамп пригрозил Китаю новыми пошлинами',
  bodyText: 'Президент заявил, что мера вступит в силу в следующем месяце.',
  pageLang: 'ru',
})

/** Translator stub: uppercases, so a translated field is visibly different. */
function fakeTranslator(over: Partial<TranslatorApi> = {}): TranslatorApi {
  return {
    availability: async () => 'available',
    create: async () => ({ translate: async (t: string) => `EN(${t})` }),
    ...over,
  }
}

describe('resolveSourceLanguage', () => {
  it('reads the page lang attribute, stripping the region subtag', async () => {
    expect(await resolveSourceLanguage(article({ pageLang: 'ru-RU' }), null)).toBe('ru')
  })

  it('asks the detector when the page declares no language', async () => {
    const detector = { detect: vi.fn(async () => 'de') }
    expect(await resolveSourceLanguage(article({ pageLang: '' }), detector)).toBe('de')
    expect(detector.detect).toHaveBeenCalled()
  })

  it('falls back to Cyrillic script when there is no lang and no detector', async () => {
    expect(await resolveSourceLanguage(article({ headline: 'Трамп и Китай', pageLang: '' }), null)).toBe('ru')
  })

  it('treats an unmarked Latin page as English', async () => {
    expect(await resolveSourceLanguage(article({ pageLang: '' }), null)).toBe('en')
  })

  it('trusts a Cyrillic headline over a lang attribute claiming English', async () => {
    expect(await resolveSourceLanguage(article({ headline: 'Трамп и Китай', pageLang: 'en' }), null)).toBe('ru')
  })

  it('survives a detector that throws', async () => {
    const detector = { detect: async () => { throw new Error('nope') } }
    expect(await resolveSourceLanguage(article({ pageLang: '' }), detector)).toBe('en')
  })
})

describe('translateArticle', () => {
  it('leaves an English page alone without touching the translator', async () => {
    const create = vi.fn()
    const out = await translateArticle(article(), { translator: fakeTranslator({ create }) })
    expect(out.kind).toBe('not_needed')
    expect(create).not.toHaveBeenCalled()
  })

  it('replaces headline and body with the translation on a Russian page', async () => {
    const out = await translateArticle(RU, { translator: fakeTranslator() })
    expect(out).toEqual({
      kind: 'translated',
      language: 'ru',
      article: {
        ...RU,
        headline: `EN(${RU.headline})`,
        bodyText: `EN(${RU.bodyText})`,
      },
    })
  })

  it('asks for the detected language as the source, not a hardcoded one', async () => {
    const create = vi.fn(async () => ({ translate: async (t: string) => t }))
    await translateArticle(article({ headline: 'Trump droht China mit Zöllen', pageLang: 'de' }), {
      translator: fakeTranslator({ create }),
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ sourceLanguage: 'de', targetLanguage: 'en' }),
      expect.any(Function),
    )
  })

  it('reports an unsupported browser when there is no Translator API', async () => {
    const out = await translateArticle(RU, { translator: null })
    expect(out).toEqual({ kind: 'unsupported_browser', language: 'ru' })
  })

  it('reports an unsupported pair when the browser cannot do this language', async () => {
    const out = await translateArticle(RU, {
      translator: fakeTranslator({ availability: async () => 'unavailable' }),
    })
    expect(out).toEqual({ kind: 'unsupported_pair', language: 'ru' })
  })

  it('announces the one-time download before creating the translator', async () => {
    const order: string[] = []
    const out = await translateArticle(RU, {
      translator: fakeTranslator({
        availability: async () => 'downloadable',
        create: async () => {
          order.push('create')
          return { translate: async (t: string) => t }
        },
      }),
      onDownloadStart: () => order.push('download-start'),
    })
    expect(order).toEqual(['download-start', 'create'])
    expect(out.kind).toBe('translated')
  })

  it('tells the download announcement which language is being fetched', async () => {
    const onDownloadStart = vi.fn()
    await translateArticle(RU, {
      translator: fakeTranslator({ availability: async () => 'downloading' }),
      onDownloadStart,
    })
    expect(onDownloadStart).toHaveBeenCalledWith('ru')
  })

  it('does not announce a download when the pack is already available', async () => {
    const onDownloadStart = vi.fn()
    await translateArticle(RU, { translator: fakeTranslator(), onDownloadStart })
    expect(onDownloadStart).not.toHaveBeenCalled()
  })

  it('reports failure when the translator cannot be created', async () => {
    const out = await translateArticle(RU, {
      translator: fakeTranslator({ create: async () => { throw new Error('no user activation') } }),
    })
    expect(out).toEqual({ kind: 'failed', language: 'ru', error: 'no user activation' })
  })

  it('reports failure when translating throws', async () => {
    const out = await translateArticle(RU, {
      translator: fakeTranslator({
        create: async () => ({ translate: async () => { throw new Error('model crashed') } }),
      }),
    })
    expect(out).toEqual({ kind: 'failed', language: 'ru', error: 'model crashed' })
  })

  // Observed in a real Chromium build: `Translator` exists on the global, but
  // `availability()` never settles. Without a bound the popup waits forever on
  // a promise that will not resolve, and the user sees a spinner instead of an
  // answer — strictly worse than being told the page could not be translated.
  it('gives up when the browser never answers whether it can translate', async () => {
    const out = await translateArticle(RU, {
      translator: fakeTranslator({ availability: () => new Promise<never>(() => {}) }),
      timeoutMs: 5,
    })
    expect(out).toEqual({ kind: 'failed', language: 'ru', error: 'timed out checking the translator' })
  })

  it('gives up when translating itself hangs', async () => {
    const out = await translateArticle(RU, {
      translator: fakeTranslator({
        create: async () => ({ translate: () => new Promise<never>(() => {}) }),
      }),
      timeoutMs: 5,
    })
    expect(out).toEqual({ kind: 'failed', language: 'ru', error: 'timed out translating' })
  })

  it('gives the language-pack download its own, longer deadline', async () => {
    // A create() that outlives the short per-call timeout still succeeds: the
    // first run on a language downloads a pack, which is legitimately slow.
    const out = await translateArticle(RU, {
      translator: fakeTranslator({
        availability: async () => 'downloadable',
        create: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ translate: async (t: string) => `EN(${t})` }), 20),
          ),
      }),
      timeoutMs: 5,
      createIdleMs: 1000,
    })
    expect(out.kind).toBe('translated')
  })

  // A pack big enough to be worth downloading is big enough to outlast any
  // fixed deadline on a slow connection. What distinguishes a slow download
  // from a dead one is whether the bytes are still moving, so that is what
  // the deadline watches.
  it('keeps waiting as long as the download keeps moving', async () => {
    const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const out = await translateArticle(RU, {
      translator: fakeTranslator({
        availability: async () => 'downloadable',
        create: async (_pair, onProgress) => {
          for (const fraction of [0.3, 0.6, 0.9]) {
            await tick(15)
            onProgress?.(fraction)
          }
          await tick(15)
          return { translate: async (t: string) => `EN(${t})` }
        },
      }),
      createIdleMs: 40,
    })
    expect(out.kind).toBe('translated')
  })

  it('gives up on a download that stops moving', async () => {
    const out = await translateArticle(RU, {
      translator: fakeTranslator({
        availability: async () => 'downloadable',
        create: (_pair, onProgress) =>
          new Promise<never>(() => {
            onProgress?.(0.3)
          }),
      }),
      createIdleMs: 30,
    })
    expect(out).toEqual({ kind: 'failed', language: 'ru', error: 'timed out preparing the translator' })
  })

  // The language pack is tens of megabytes and Chrome gives no UI of its own.
  // Without a number moving on screen, a legitimate download is indisputable
  // from a hang, and the user is left staring at a still dot.
  it('reports download progress as it arrives', async () => {
    const seen: number[] = []
    await translateArticle(RU, {
      translator: fakeTranslator({
        availability: async () => 'downloadable',
        create: async (_pair, onProgress) => {
          onProgress?.(0.25)
          onProgress?.(1)
          return { translate: async (t: string) => t }
        },
      }),
      onDownloadProgress: (_lang, fraction) => seen.push(fraction),
    })
    expect(seen).toEqual([0.25, 1])
  })

  // Chrome fires a single 100% progress event even when the pack is already on
  // disk and nothing is being fetched. Passing that through paints
  // "downloading… 100%" over a check where no download happened at all.
  it('stays quiet about progress when there was nothing to download', async () => {
    const onDownloadProgress = vi.fn()
    await translateArticle(RU, {
      translator: fakeTranslator({
        availability: async () => 'available',
        create: async (_pair, onProgress) => {
          onProgress?.(1)
          return { translate: async (t: string) => t }
        },
      }),
      onDownloadProgress,
    })
    expect(onDownloadProgress).not.toHaveBeenCalled()
  })

  it('reuses one translator per language instead of building it per check', async () => {
    const create = vi.fn(async () => ({ translate: async (t: string) => t }))
    const deps = { translator: fakeTranslator({ create }) }
    await translateArticle(RU, deps)
    await translateArticle(RU, deps)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('does not cache a translator that failed to build', async () => {
    let attempts = 0
    const deps = {
      translator: fakeTranslator({
        create: async () => {
          attempts++
          if (attempts === 1) throw new Error('transient')
          return { translate: async (t: string) => `EN(${t})` }
        },
      }),
    }
    const first = await translateArticle(RU, deps)
    const second = await translateArticle(RU, deps)
    expect(first.kind).toBe('failed')
    expect(second.kind).toBe('translated')
  })

  it('skips the body call when the page had no body text', async () => {
    const translate = vi.fn(async (t: string) => `EN(${t})`)
    const out = await translateArticle(article({ ...RU, bodyText: '' }), {
      translator: fakeTranslator({ create: async () => ({ translate }) }),
    })
    expect(translate).toHaveBeenCalledTimes(1)
    expect(out.kind === 'translated' && out.article.bodyText).toBe('')
  })
})

describe('languageName', () => {
  it('turns a BCP-47 code into an English language name', () => {
    expect(languageName('de')).toBe('German')
    expect(languageName('ru')).toBe('Russian')
  })

  it('falls back to the raw code when it is not a known language', () => {
    expect(languageName('zz')).toBe('zz')
  })
})

describe('translationNotice', () => {
  it('says nothing when no translation was needed', () => {
    expect(translationNotice({ kind: 'not_needed' })).toBeNull()
  })

  it('tells the user the match ran on a translation', () => {
    const notice = translationNotice({ kind: 'translated', language: 'ru', article: RU })
    expect(notice).toEqual({ tone: 'info', text: 'Translated from Russian before matching.' })
  })

  it('names the language and what the browser is missing', () => {
    const notice = translationNotice({ kind: 'unsupported_browser', language: 'de' })
    expect(notice?.tone).toBe('warn')
    expect(notice?.text).toContain('German')
    expect(notice?.text).toContain('Chrome 138')
    expect(notice?.text).toContain('original text')
  })

  it('says the pair is missing when the browser has a translator but not this language', () => {
    const notice = translationNotice({ kind: 'unsupported_pair', language: 'de' })
    expect(notice?.tone).toBe('warn')
    expect(notice?.text).toContain('German')
    expect(notice?.text).not.toContain('Chrome 138')
  })

  it('admits a translation failure instead of blaming the market list', () => {
    const notice = translationNotice({ kind: 'failed', language: 'ru', error: 'boom' })
    expect(notice?.tone).toBe('warn')
    expect(notice?.text).toContain('Russian')
  })
})
