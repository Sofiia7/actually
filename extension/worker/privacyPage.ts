/**
 * Renders the privacy policy as a standalone HTML page.
 *
 * The Chrome Web Store requires a live URL that shows the policy, and the
 * document only existed as `docs/privacy-policy.md` inside a private repo -
 * nothing a reviewer or a user could open. Serving it from the Worker keeps
 * ONE source of truth: the markdown is imported as a text module at build
 * time (see the [[rules]] block in wrangler.toml), so the published page
 * cannot drift from the file the repo reviews.
 *
 * The converter deliberately handles only what that document uses - h1/h2/h3,
 * paragraphs, bullet lists, tables, bold and inline code - and is tested
 * against the real file rather than against invented samples. A general
 * markdown library would be far more code than the page is worth, and a
 * partial one that silently mangles a clause is worse than no page at all:
 * this is a legal document, so anything it cannot render must be visible
 * rather than quietly dropped.
 */

/** HTML-escape. Runs before any tag is inserted, never after. */
function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Inline spans: `code` first, then **bold**, over already-escaped text. */
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

const isTableRow = (l: string) => l.trimStart().startsWith('|')
/** The |---|---| separator under a table header carries no content. */
const isTableDivider = (l: string) => /^\s*\|[\s:|-]+\|\s*$/.test(l)

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

export function markdownToHtml(md: string): string {
  const out: string[] = []
  const lines = md.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '' || line.trim() === '---') {
      i++
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min(heading[1].length, 6)
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      i++
      continue
    }

    if (isTableRow(line)) {
      const rows: string[][] = []
      while (i < lines.length && isTableRow(lines[i])) {
        if (!isTableDivider(lines[i])) rows.push(tableCells(lines[i]))
        i++
      }
      if (rows.length > 0) {
        const [head, ...body] = rows
        out.push('<table><thead><tr>')
        out.push(head.map((c) => `<th>${inline(c)}</th>`).join(''))
        out.push('</tr></thead><tbody>')
        for (const r of body) {
          out.push('<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>')
        }
        out.push('</tbody></table>')
      }
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      out.push('<ul>')
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        // Wrapped continuation lines belong to the bullet above them, not to
        // a paragraph of their own.
        let text = lines[i].replace(/^\s*[-*]\s+/, '')
        i++
        while (i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) {
          text += ' ' + lines[i].trim()
          i++
        }
        out.push(`<li>${inline(text)}</li>`)
      }
      out.push('</ul>')
      continue
    }

    // Paragraph: consume until a blank line or the start of another block.
    let para = line.trim()
    i++
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !isTableRow(lines[i]) &&
      lines[i].trim() !== '---'
    ) {
      para += ' ' + lines[i].trim()
      i++
    }
    out.push(`<p>${inline(para)}</p>`)
  }
  return out.join('\n')
}

/** Full page. Self-contained: no external CSS, fonts or scripts. */
export function renderPrivacyPage(md: string, title = 'Actually - Privacy Policy'): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.6; max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 4rem;
    color: #1a2033; background: #fff;
  }
  h1 { font-size: 1.9rem; margin: 0 0 1rem; }
  h2 { font-size: 1.3rem; margin: 2.2rem 0 .6rem; }
  h3 { font-size: 1.05rem; margin: 1.6rem 0 .4rem; }
  p, li { font-size: .97rem; }
  ul { padding-left: 1.3rem; }
  li { margin: .3rem 0; }
  code { background: rgba(20,30,55,.07); padding: .1em .35em; border-radius: 3px; font-size: .88em; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: .9rem; display: block; overflow-x: auto; }
  th, td { border: 1px solid rgba(20,30,55,.18); padding: .45rem .6rem; text-align: left; vertical-align: top; }
  th { background: rgba(20,30,55,.05); }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e9f2; background: #14161d; }
    code { background: rgba(255,255,255,.1); }
    th, td { border-color: rgba(255,255,255,.18); }
    th { background: rgba(255,255,255,.06); }
  }
</style>
</head>
<body>
${markdownToHtml(md)}
</body>
</html>`
}
