import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { markdownToHtml, renderPrivacyPage } from './privacyPage'

/**
 * Tested against the REAL document, not invented samples. The point of this
 * renderer is that the published page and the file in the repo say the same
 * thing; a fixture that drifts from the real policy would hide exactly the
 * failure that matters.
 */
const POLICY = readFileSync(join(__dirname, '..', 'docs', 'privacy-policy.md'), 'utf8')

describe('markdownToHtml', () => {
  it('renders every construct the policy actually uses', () => {
    const html = markdownToHtml(POLICY)
    expect(html).toContain('<h1>')
    expect(html).toContain('<h2>')
    expect(html).toContain('<h3>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>')
    expect(html).toContain('<strong>')
    expect(html).toContain('<code>')
    expect(html).toContain('<p>')
  })

  it('leaves no raw markdown syntax in the output', () => {
    // A half-working converter is worse than none for a legal document: a
    // clause rendered as literal `**` or `|` reads as a broken page and
    // invites the reader to skip it.
    const html = markdownToHtml(POLICY)
    expect(html).not.toMatch(/\*\*/)
    expect(html).not.toMatch(/^#{1,6}\s/m)
    expect(html).not.toMatch(/^\s*\|/m)
    expect(html).not.toMatch(/`/)
  })

  it('drops nothing — every sentence of the source survives', () => {
    // The real risk is silent loss: a block the converter does not recognise
    // vanishing without a trace. Compare word counts rather than trusting
    // that the tags above imply completeness.
    const words = (s: string) => s.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length
    const sourceWords = words(POLICY.replace(/[#*`|>-]/g, ' '))
    expect(words(markdownToHtml(POLICY))).toBeGreaterThanOrEqual(Math.floor(sourceWords * 0.97))
  })

  it('keeps the load-bearing privacy claims intact', () => {
    const html = markdownToHtml(POLICY)
    expect(html).toContain('never leaves your device')
    expect(html).toMatch(/Search Polymarket when nothing matches/i)
  })

  it('escapes HTML so document text can never become markup', () => {
    const html = markdownToHtml('Angle < brackets > and "quotes" & ampersands')
    expect(html).toContain('&lt;')
    expect(html).toContain('&gt;')
    expect(html).toContain('&amp;')
    expect(html).not.toContain('<brackets')
  })

  it('escapes before inserting tags, so injected markup stays inert', () => {
    const html = markdownToHtml('- **<script>alert(1)</script>**')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('joins a wrapped bullet into one item instead of orphaning the tail', () => {
    const html = markdownToHtml('- first line\n  continues here\n- second')
    expect(html).toContain('<li>first line continues here</li>')
    expect(html).toContain('<li>second</li>')
  })

  it('skips the |---| divider rather than rendering it as a row', () => {
    const html = markdownToHtml('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(html).toContain('<th>A</th>')
    expect(html).toContain('<td>1</td>')
    expect(html).not.toContain('---')
  })
})

describe('renderPrivacyPage', () => {
  it('is a complete, self-contained page — no external CSS, fonts or scripts', () => {
    const page = renderPrivacyPage(POLICY)
    expect(page.startsWith('<!doctype html>')).toBe(true)
    expect(page).toContain('<title>')
    expect(page).toContain('viewport')
    expect(page).not.toMatch(/<link[^>]+href="https?:/)
    expect(page).not.toMatch(/<script/)
  })

  it('escapes the title too', () => {
    expect(renderPrivacyPage('# x', 'A & B')).toContain('<title>A &amp; B</title>')
  })
})
