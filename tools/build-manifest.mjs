// Generates feed/manifest.json for the plugin's self-update channel.
//
//   node tools/build-manifest.mjs [--notes "..."] [--min-supported 0.1.0]
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE_ENTRIES } from '../src/host/updater.js'

const PLUGIN = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MAX_FILE = 12 * 1024 * 1024

function walk(dir, prefix, rows) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, rel, rows)
    else if (entry.isFile()) rows.push(rowOf(rel, full))
  }
}

function rowOf(rel, full) {
  const buffer = fs.readFileSync(full)
  if (buffer.byteLength > MAX_FILE) throw new Error(`${rel} exceeds the 12MB release limit`)
  return {
    path: rel,
    size: buffer.byteLength,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))
const rows = []
for (const entry of RELEASE_ENTRIES) {
  const full = path.join(PLUGIN, entry)
  let stat
  try {
    stat = fs.statSync(full)
  } catch {
    continue
  }
  if (stat.isDirectory()) walk(full, entry, rows)
  else rows.push(rowOf(entry, full))
}
if (rows.length > 400) throw new Error('release carries more than 400 files')

const args = process.argv.slice(2)
const notesIndex = args.indexOf('--notes')
const notes = notesIndex === -1 ? '' : (args[notesIndex + 1] ?? '')
const minIndex = args.indexOf('--min-supported')
const manifest = {
  version: pkg.version,
  base: '../',
  publishedAt: Date.now(),
  notes,
  ...(minIndex === -1 ? {} : { minSupported: args[minIndex + 1] }),
  files: rows,
}
fs.mkdirSync(path.join(PLUGIN, 'feed'), { recursive: true })
fs.writeFileSync(path.join(PLUGIN, 'feed', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`feed/manifest.json written: ${rows.length} files, version ${pkg.version}`)
