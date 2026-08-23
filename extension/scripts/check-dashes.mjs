/**
 * Fail the build on an em dash (U+2014) or en dash (U+2013) in anything we
 * write: UI strings, code, comments, docs, commit-adjacent markdown.
 *
 *   npm run lint:dashes
 *
 * Sofia's standing rule across every project, restated more than once after it
 * kept coming back: use a plain hyphen "-", never "-" or "-". A long dash is a
 * tell that a machine wrote the text, and it is not how she writes. This check
 * exists because the rule was violated repeatedly even while written down - a
 * grep is the only version of it that cannot be forgotten between sessions.
 *
 * One deliberate exception, listed below: the character class that splits
 * other people's page titles ("Iran War - Reuters"). Those dashes are input we
 * have to recognise, not prose we produce.
 *
 * Exit 0 = clean, 1 = dashes found.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep, resolve } from 'node:path'

const ROOT = resolve(process.argv[2] ?? '..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.wrangler', 'public', 'coverage'])
const SKIP_FILES = new Set(['package-lock.json'])
const EXT = /\.(ts|tsx|js|mjs|cjs|md|json|html|css|yml|yaml)$/
const ALLOWED = [
  // extension/src/background/extractor.ts: splits foreign page titles.
  { file: 'extension/src/background/extractor.ts', contains: 'document.title.split' },
]

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (EXT.test(name) && !SKIP_FILES.has(name)) yield full
  }
}

const DASH = new RegExp(String.fromCharCode(0x2014) + "|" + String.fromCharCode(0x2013) + "|" + String.raw`\u201[34]`)

const hits = []
for (const file of walk(ROOT)) {
  const rel = file.slice(ROOT.length + 1).split(sep).join('/')
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    // DASH is built from char codes on purpose: a literal long dash written
    // here would make this file its own first offender.
    if (!DASH.test(line)) return
    if (ALLOWED.some((a) => a.file === rel && line.includes(a.contains))) return
    hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`)
  })
}

if (hits.length > 0) {
  console.error(`Found ${hits.length} long dash${hits.length > 1 ? 'es' : ''}. Use a plain hyphen "-":\n`)
  for (const h of hits.slice(0, 40)) console.error(`  ${h}`)
  if (hits.length > 40) console.error(`  ... and ${hits.length - 40} more`)
  process.exit(1)
}

console.log('No long dashes. Hyphens only, as intended.')
