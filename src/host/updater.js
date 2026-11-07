// Self-update: verified file replacement from a release manifest, with rollback.
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { safeRemoveTree } from './util.js'

/** Files a release carries, relative to the package root. */
export const RELEASE_ENTRIES = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'src', 'vendor', 'README.md', 'LICENSE', 'AGENTS.md']

/** Compare dotted versions; returns -1, 0 or 1. */
export function compareVersions(left, right) {
  const parse = value => String(value ?? '').split(/[.+-]/).map(part => (/^\d+$/.test(part) ? Number(part) : part))
  const a = parse(left)
  const b = parse(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function safeRelative(value) {
  const text = String(value ?? '')
  if (text === '' || text.startsWith('/') || text.startsWith('\\') || /^[a-zA-Z]:/.test(text) || text.split(/[\\/]/).includes('..')) {
    throw new Error(`library: unsafe release path "${text}"`)
  }
  return text.replaceAll('\\', '/')
}

/** Walk package files listed by RELEASE_ENTRIES. */
export function packageFiles(packageDir) {
  const files = []
  for (const entry of RELEASE_ENTRIES) {
    const full = path.join(packageDir, entry)
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
          else if (child.isFile()) files.push({ path: rel, full: path.join(dir, child.name), size: fs.statSync(path.join(dir, child.name)).size })
        }
      }
      walk(full, entry)
    } else {
      files.push({ path: entry, full, size: stat.size })
    }
  }
  return files
}

/** Parse and validate a release manifest. */
export function parseManifest(value, manifestURL) {
  if (!value || typeof value !== 'object') throw new Error('library: release manifest must be an object')
  const version = String(value.version ?? '')
  if (!/^\d+\.\d+\.\d+([.+-][\w.+-]+)?$/.test(version)) throw new Error('library: release manifest has no valid version')
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 400) {
    throw new Error('library: release manifest files must be a non-empty list of at most 400 entries')
  }
  const base = typeof value.base === 'string' ? value.base : ''
  if (base !== '' && !/^(\.\/)?[\w./-]+$/.test(base)) throw new Error('library: release manifest base must be relative')
  const baseURL = new URL(base, manifestURL)
  const files = value.files.map((file) => {
    const rel = safeRelative(file?.path)
    const size = Number(file?.size)
    const hash = String(file?.sha256 ?? '').toLowerCase()
    if (!Number.isInteger(size) || size <= 0) throw new Error(`library: release file ${rel} has no valid size`)
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`library: release file ${rel} has no valid sha256`)
    return { path: rel, size, sha256: hash, url: new URL(rel.split('/').map(encodeURIComponent).join('/'), baseURL).href }
  })
  for (const required of ['package.json', 'index.js', 'client.js']) {
    if (!files.some(file => file.path === required)) throw new Error(`library: release manifest is missing ${required}`)
  }
  return { version, notes: String(value.notes ?? ''), publishedAt: Number(value.publishedAt ?? 0), files }
}

/** Verified, rollback-capable self-update. */
export class PluginUpdater {
  /**
   * @param {object} options
   * @param {string} options.packageDir - installed package root.
   * @param {string} options.dataDir - plugin data directory for staging and backups.
   * @param {string} options.currentVersion
   * @param {() => string} options.feedUrl - manifest URL supplier (empty disables updates).
   * @param {object} [options.logger]
   */
  constructor({ packageDir, dataDir, currentVersion, feedUrl, logger = console }) {
    this.packageDir = packageDir
    this.dataDir = dataDir
    this.currentVersion = currentVersion
    this.feedUrl = feedUrl
    this.logger = logger
    this.state = { phase: 'idle', checkedAt: 0, latest: undefined, available: false, applying: false, error: undefined, lastApplied: undefined }
    this.loadState()
  }

  statePath() {
    return path.join(this.dataDir, 'updates.json')
  }

  loadState() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.statePath(), 'utf8'))
      if (saved && typeof saved === 'object') this.state = { ...this.state, ...saved, applying: false, phase: saved.phase === 'installing' ? 'error' : saved.phase }
    } catch {
      // No history yet.
    }
  }

  saveState() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(this.statePath(), `${JSON.stringify(this.state, null, 2)}\n`)
    } catch (error) {
      this.logger.warn?.(`library: could not save update state: ${error?.message ?? error}`)
    }
  }

  status() {
    return {
      current: this.currentVersion,
      phase: this.state.phase,
      checkedAt: this.state.checkedAt,
      latest: this.state.latest,
      available: this.state.available,
      notes: this.state.notes,
      publishedAt: this.state.publishedAt,
      applying: this.state.applying,
      error: this.state.error,
      lastApplied: this.state.lastApplied,
      feed: this.feedUrl() !== '',
    }
  }

  /** Fetch and validate the manifest; records availability. */
  async check() {
    const url = this.feedUrl()
    if (url === '') return { ...this.status(), available: false, reason: 'no-feed' }
    const response = await fetch(url, { headers: { 'user-agent': 'dsh-library/updater' }, signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`library: update feed answered HTTP ${response.status}`)
    const manifest = parseManifest(await response.json(), url)
    const available = compareVersions(manifest.version, this.currentVersion) > 0
    this.state.checkedAt = Date.now()
    this.state.latest = manifest.version
    this.state.available = available
    this.state.notes = manifest.notes
    this.state.publishedAt = manifest.publishedAt
    this.state.manifest = manifest
    this.state.phase = 'idle'
    this.state.error = undefined
    this.saveState()
    return this.status()
  }

  /** Download, verify and install the latest release. A restart activates it. */
  async apply() {
    if (this.state.applying) throw new Error('library: an update is already being installed')
    if (!this.state.manifest || this.state.available !== true) await this.check()
    const manifest = this.state.manifest
    if (!manifest || compareVersions(manifest.version, this.currentVersion) <= 0) {
      return { ...this.status(), applied: false, reason: 'up-to-date' }
    }
    this.state.applying = true
    this.state.phase = 'installing'
    this.state.error = undefined
    this.saveState()
    const stage = path.join(this.dataDir, 'updates', `stage-${manifest.version}`)
    const backup = path.join(this.dataDir, 'updates', `rollback-${Date.now()}`)
    try {
      safeRemoveTree(stage)
      fs.mkdirSync(stage, { recursive: true })
      for (const file of manifest.files) {
        const response = await fetch(file.url, { headers: { 'user-agent': 'dsh-library/updater' }, signal: AbortSignal.timeout(300_000) })
        if (!response.ok) throw new Error(`library: could not download ${file.path} (HTTP ${response.status})`)
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.byteLength !== file.size) throw new Error(`library: ${file.path} size mismatch`)
        if (sha256(buffer) !== file.sha256) throw new Error(`library: ${file.path} failed its SHA-256 check`)
        const target = path.join(stage, ...file.path.split('/'))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, buffer)
      }
      // Staged package must declare the manifest's version.
      const stagedPackage = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'))
      if (stagedPackage.version !== manifest.version) throw new Error('library: staged package version does not match the manifest')
      // Back up every file that will be replaced, then swap them in.
      const current = packageFiles(this.packageDir)
      fs.mkdirSync(backup, { recursive: true })
      for (const file of current) {
        const target = path.join(backup, ...file.path.split('/'))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        await fsp.copyFile(file.full, target)
      }
      for (const file of manifest.files) {
        const source = path.join(stage, ...file.path.split('/'))
        const target = path.join(this.packageDir, ...file.path.split('/'))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const temporary = `${target}.dsh-new`
        fs.copyFileSync(source, temporary)
        fs.renameSync(temporary, target)
      }
      this.state.phase = 'installed'
      this.state.applying = false
      this.state.lastApplied = { version: manifest.version, at: Date.now() }
      this.state.available = false
      this.saveState()
      return { ...this.status(), applied: true, restartRequired: true }
    } catch (error) {
      this.state.phase = 'error'
      this.state.applying = false
      this.state.error = String(error?.message ?? error)
      this.saveState()
      try {
        if (fs.existsSync(backup)) {
          for (const file of packageFiles(backup)) {
            const target = path.join(this.packageDir, ...file.path.split('/'))
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.copyFileSync(file.full, target)
          }
          this.state.phase = 'rolled-back'
          this.saveState()
        }
      } catch (rollbackError) {
        this.logger.error?.(`library: update rollback failed: ${rollbackError?.message ?? rollbackError}`)
      }
      throw error
    } finally {
      this.state.applying = false
    }
  }
}
