// Generates feed/manifest.json for the plugin's self-update channel.
//
//   node tools/build-manifest.mjs [--notes "..."] [--min-supported 0.1.0]
//
// The update feed serves release files from the git repository itself
// (raw.githubusercontent.com, `base: '../'`), which always hands out the
// committed blob content. On a Windows checkout with core.autocrlf=true the
// working tree carries CRLF while the blobs are LF, so hashing working-tree
// files would publish a manifest whose sizes/sha256 match nothing and every
// client update dies at "size mismatch". Hash the blobs at HEAD instead, and
// refuse to run while any release file has uncommitted changes.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { RELEASE_ENTRIES } from '../src/host/updater.js'

const PLUGIN = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MAX_FILE = 12 * 1024 * 1024

/** Blob content at HEAD — byte-identical to what the raw feed serves. */
function blobOf(rel) {
  try {
    return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: PLUGIN, maxBuffer: 64 * 1024 * 1024 })
  } catch {
    throw new Error(`${rel} is not committed; the release feed serves git content, so every release file must be committed before the manifest is built`)
  }
}

function gitStatusPaths() {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: PLUGIN, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const paths = new Set()
  for (const line of out.split('\n')) {
    const match = line.match(/^.. (.+)$/)
    if (match) paths.add(match[1].replace(/^"(.*)"$/, '$1').replaceAll('\\', '/'))
  }
  return paths
}

const dirty = gitStatusPaths()
function assertCommitted(rel) {
  if (dirty.has(rel)) {
    throw new Error(`${rel} has uncommitted changes; the feed publishes committed git content — commit (or clean) it first, then rerun`)
  }
}

function rowOf(rel) {
  assertCommitted(rel)
  const buffer = blobOf(rel)
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
  assertCommitted(entry)
  const full = path.join(PLUGIN, entry)
  let stat
  try {
    stat = fs.statSync(full)
  } catch {
    continue
  }
  if (stat.isDirectory()) {
    const walk = (dir, prefix) => {
      for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = `${prefix}/${child.name}`
        if (child.isDirectory()) walk(path.join(dir, child.name), rel)
        else if (child.isFile()) rows.push(rowOf(rel))
      }
    }
    walk(full, entry)
  } else {
    rows.push(rowOf(entry))
  }
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
console.log(`feed/manifest.json written: ${rows.length} files (git blobs at HEAD), version ${pkg.version}`)
