#!/usr/bin/env node
/**
 * Build the ZIP the Chrome Web Store will actually accept.
 *
 * Two things go wrong when dist/ is zipped by hand on Windows, and the store
 * only tells you about one of them:
 *
 *   1. `key` in the manifest. The upload is rejected outright with "key field
 *      is not allowed in manifest." The field is a development-only device: it
 *      pins the unpacked extension's ID so a server can allowlist a stable
 *      chrome-extension:// origin. It reserves nothing on the store's side -
 *      CWS generates its own key pair for a new item and assigns the ID from
 *      that, whatever the manifest says. The supported order is the reverse of
 *      what it looks like: upload without `key`, then copy the item's public
 *      key out of the dashboard's Package tab into manifest.json so the local
 *      unpacked build inherits the published ID.
 *      https://developer.chrome.com/docs/extensions/reference/manifest/key
 *
 *   2. Backslash path separators. Explorer's "Send to > Compressed folder" and
 *      PowerShell's Compress-Archive write entries as `assets\popup.js`. The
 *      ZIP spec says forward slashes, always. Some readers cope by treating
 *      the backslash as part of the filename, which quietly flattens the
 *      archive into one directory of oddly-named files.
 *
 * So dist/ keeps its `key` - the unpacked build still needs it - and the
 * stripping happens here, on the way into the archive, where it cannot drift
 * out of sync with what was tested.
 *
 * No dependencies: the ZIP writer below is ~70 lines and this repo's scripts/
 * are deliberately dependency-free.
 *
 * Usage: npm run package:cws   (from extension/)
 */
import { deflateRawSync } from 'node:zlib'
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(EXT_ROOT, 'dist')

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** DOS timestamps have two-second resolution and start at 1980. */
function dosStamp(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31)
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
  return { time, date }
}

/** entries: [{ name, data, mtime }] - `name` must already use forward slashes. */
function zip(entries) {
  const locals = []
  const central = []
  let offset = 0

  for (const { name, data, mtime } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const deflated = deflateRawSync(data, { level: 9 })
    // A tiny file can deflate larger than it started; store it raw instead.
    const useDeflate = deflated.length < data.length
    const body = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0
    const crc = crc32(data)
    const { time, date } = dosStamp(mtime)

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 filenames
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // no extra field
    nameBuf.copy(local, 30)
    locals.push(local, body)

    const cd = Buffer.alloc(46 + nameBuf.length)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30) // extra
    cd.writeUInt16LE(0, 32) // comment
    cd.writeUInt16LE(0, 34) // disk number
    cd.writeUInt16LE(0, 36) // internal attrs
    cd.writeUInt32LE(0, 38) // external attrs
    cd.writeUInt32LE(offset, 42)
    nameBuf.copy(cd, 46)
    central.push(cd)

    offset += local.length + body.length
  }

  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cdBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, cdBuf, end])
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else out.push({ full, mtime: st.mtime })
  }
  return out
}

if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('No dist/manifest.json - run `npm run build` first.')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'))
if (!manifest.version) {
  console.error('dist/manifest.json has no version.')
  process.exit(1)
}

const strippedKey = Boolean(manifest.key)
delete manifest.key
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8')

const entries = walk(DIST).map(({ full, mtime }) => {
  const name = relative(DIST, full).split(/[\\/]/).join('/')
  return {
    name,
    mtime,
    data: name === 'manifest.json' ? manifestBytes : readFileSync(full),
  }
})

const outPath = join(EXT_ROOT, `actually-v${manifest.version}.zip`)
const archive = zip(entries)
writeFileSync(outPath, archive)

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`
console.log(`packaged ${entries.length} files -> ${relative(EXT_ROOT, outPath)} (${mb(archive.length)})`)
console.log(`  manifest version ${manifest.version}`)
console.log(strippedKey ? '  stripped `key` from the manifest' : '  no `key` in the manifest (nothing to strip)')
console.log('  paths use forward slashes')
