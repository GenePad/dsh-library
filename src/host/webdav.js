// Zotero-compatible WebDAV file-storage client and sync engine.
import fs from 'node:fs'
import path from 'node:path'
import { readAttachmentRows } from './read.js'
import { directoryMtime, md5, unzipInto, walkFiles, zipDirectory } from './storage.js'
import { sqlNow } from './util.js'

/** WebDAV request failure with the Zotero-facing reason. */
class WebDavError extends Error {
  constructor(message, code = 'library/webdav') {
    super(message)
    this.code = code
  }
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
    <D:getcontentlength/>
    <D:getlastmodified/>
  </D:prop>
</D:propfind>`

/** Parse a multistatus response into {href, lastModified} entries. */
export function parseMultistatus(xml) {
  const entries = []
  const chunks = String(xml ?? '').split(/<(?:[a-z0-9]+:)?response[\s>]/i).slice(1)
  for (const chunk of chunks) {
    const href = /<(?:[a-z0-9]+:)?href[^>]*>([\s\S]*?)<\//i.exec(chunk)?.[1]
    if (!href) continue
    const modified = /<(?:[a-z0-9]+:)?getlastmodified[^>]*>([\s\S]*?)<\//i.exec(chunk)?.[1]
    entries.push({
      href: decodeURIComponent(href.trim()),
      lastModified: modified ? Date.parse(modified) : NaN,
    })
  }
  return entries
}

/** Parse a port of a Zotero WebDAV URL and credentials. */
export class WebDavClient {
  /**
   * @param {object} options
   * @param {string} options.url - server URL, e.g. https://dav.example.com/remote.php/dav/files/user
   * @param {string} [options.username]
   * @param {string} [options.password]
   */
  constructor({ url, username = '', password = '' }) {
    let base
    try {
      base = new URL(String(url).trim())
    } catch {
      throw new WebDavError('WebDAV URL is not a valid URL', 'library/invalid')
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new WebDavError('WebDAV URL must use http or https', 'library/invalid')
    this.base = base
    this.username = username
    this.password = password
  }

  /** The configured base URL with a trailing slash. */
  baseURL() {
    const href = this.base.href
    return href.endsWith('/') ? href : `${href}/`
  }

  /** Zotero's storage directory under the configured root. */
  zoteroURL() {
    return new URL('zotero/', this.baseURL()).href
  }

  authHeaders() {
    if (this.username === '' && this.password === '') return {}
    return { authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}` }
  }

  async request(method, url, { body, headers = {}, ok = [200, 201, 204, 207, 404], timeout = 60_000 } = {}) {
    const response = await fetch(url, {
      method,
      headers: { ...this.authHeaders(), ...headers },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(timeout),
    }).catch((error) => {
      throw new WebDavError(`Could not reach the WebDAV server: ${error?.message ?? error}`)
    })
    if (response.status === 401) throw new WebDavError('WebDAV login was refused (401). Check the user name, password and URL.', 'library/webdav-auth')
    if (response.status === 403) throw new WebDavError('WebDAV permission denied (403) for this path.', 'library/webdav-auth')
    if (!ok.includes(response.status)) throw new WebDavError(`WebDAV ${method} ${url} answered HTTP ${response.status}`)
    return response
  }

  /** List `.zip` attachment files with their remote modification times. */
  async list() {
    const response = await this.request('PROPFIND', this.zoteroURL(), {
      body: PROPFIND_BODY,
      headers: { depth: '1', 'content-type': 'text/xml; charset=utf-8' },
      ok: [207, 404],
    })
    if (response.status === 404) throw new WebDavError('The WebDAV "zotero" folder does not exist. Run the connection check to see the setup instructions.', 'library/webdav-missing')
    const xml = await response.text()
    const map = new Map()
    for (const entry of parseMultistatus(xml)) {
      const name = entry.href.split('/').filter(Boolean).at(-1) ?? ''
      const match = /^([23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8})\.zip$/.exec(name)
      if (!match) continue
      map.set(match[1], entry)
    }
    return map
  }

  /** Verify a Zotero-compatible WebDAV setup, mirroring Zotero's own checks. */
  async verify() {
    const root = this.zoteroURL()
    const options = await this.request('OPTIONS', root, { ok: [200, 204, 404] })
    if (!options.headers.get('dav')) throw new WebDavError('This server does not advertise WebDAV (no DAV header).', 'library/webdav-not-dav')
    const propfind = await this.request('PROPFIND', root, {
      body: PROPFIND_BODY,
      headers: { depth: '0', 'content-type': 'text/xml; charset=utf-8' },
      ok: [207, 404],
    })
    if (propfind.status === 404) {
      const parent = await this.request('PROPFIND', this.baseURL(), {
        body: PROPFIND_BODY,
        headers: { depth: '0', 'content-type': 'text/xml; charset=utf-8' },
        ok: [207, 404],
      })
      if (parent.status === 207) throw new WebDavError('The server is reachable, but it has no "zotero" folder under this URL. Create it and try again.', 'library/webdav-missing')
      throw new WebDavError('The WebDAV URL itself was not found. Check the URL.', 'library/webdav-missing')
    }
    const missing = await this.request('GET', `${root}nonexistent.prop`, { ok: [200, 404] })
    if (missing.status !== 404) throw new WebDavError('The server returns content for missing files; Zotero-compatible sync needs 404s.', 'library/webdav-bad')
    const testURL = `${root}zotero-test-file.prop`
    await this.request('PUT', testURL, { body: ' ', headers: { 'content-type': 'text/plain' }, ok: [200, 201, 204] })
    const echo = await this.request('GET', testURL, { ok: [200, 404] })
    if (echo.status !== 200) throw new WebDavError('The test file was uploaded but could not be read back.', 'library/webdav-bad')
    await this.request('DELETE', testURL, { ok: [200, 204, 404] })
    return { ok: true, url: root }
  }

  /** Upload one attachment zip, replacing any stale .prop marker first. */
  async upload(key, zipBytes) {
    const root = this.zoteroURL()
    await this.request('DELETE', `${root}${key}.prop`, { ok: [200, 204, 404] })
    await this.request('PUT', `${root}${key}.zip`, {
      body: zipBytes,
      headers: { 'content-type': 'application/zip' },
      timeout: 300_000,
    })
  }

  /** Download one attachment zip. */
  async download(key) {
    const response = await this.request('GET', `${this.zoteroURL()}${key}.zip`, { ok: [200, 404], timeout: 300_000 })
    if (response.status === 404) return undefined
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Remove one remote attachment zip (and its .prop marker). */
  async remove(key) {
    const root = this.zoteroURL()
    await this.request('DELETE', `${root}${key}.zip`, { ok: [200, 204, 404] })
    await this.request('DELETE', `${root}${key}.prop`, { ok: [200, 204, 404] })
  }
}

/**
 * Run one bidirectional storage sync against WebDAV.
 * @param {object} options
 * @param {import('./db.js').ZoteroDb} options.db
 * @param {string} options.storageDir
 * @param {WebDavClient} options.client
 * @param {object} [options.logger]
 * @returns {Promise<{uploaded:number, downloaded:number, conflicts:number, failed:number, details:object[]}>}
 */
export async function syncStorage({ db, storageDir, client, logger = console }) {
  const attachments = readAttachmentRows(db).filter(row => row.linkMode === 0 || row.linkMode === 1)
  const remote = await client.list()
  const details = []
  let uploaded = 0
  let downloaded = 0
  let conflicts = 0
  let failed = 0

  for (const attachment of attachments) {
    const dir = path.join(storageDir, attachment.key)
    const localFiles = walkFiles(dir)
    const exists = localFiles.length > 0
    const remoteEntry = remote.get(attachment.key)
    const localMtime = exists ? Math.max(...localFiles.map(file => {
      try {
        return Math.round(fs.statSync(file.full).mtimeMs)
      } catch {
        return 0
      }
    })) : 0
    const syncedAt = Number(attachment.storageModTime ?? 0)
    const localChanged = exists && (attachment.syncState === 0 || attachment.syncState === 4 || localMtime > syncedAt + 1500)
    const remoteChanged = remoteEntry !== undefined && (!Number.isFinite(remoteEntry.lastModified) || remoteEntry.lastModified > syncedAt + 1500)

    try {
      if (!exists && remoteEntry) {
        const zip = await client.download(attachment.key)
        if (zip === undefined) continue
        unzipInto(zip, dir)
        db.run(
          'UPDATE itemAttachments SET syncState = 2, storageModTime = ?, storageHash = ? WHERE itemID = ?',
          Date.now(), md5(zip), attachment.itemID,
        )
        downloaded += 1
        details.push({ key: attachment.key, action: 'downloaded' })
      } else if (localChanged && remoteChanged) {
        db.run('UPDATE itemAttachments SET syncState = 3 WHERE itemID = ?', attachment.itemID)
        conflicts += 1
        details.push({
          key: attachment.key,
          action: 'conflict',
          localChanged,
          remoteChanged,
          exists,
          hasRemote: remoteEntry !== undefined,
          syncedAt,
          localMtime,
        })
      } else if (localChanged) {
        const zip = zipDirectory(dir)
        await client.upload(attachment.key, zip)
        db.run(
          'UPDATE itemAttachments SET syncState = 2, storageModTime = ?, storageHash = ? WHERE itemID = ?',
          Date.now(), md5(zip), attachment.itemID,
        )
        uploaded += 1
        details.push({ key: attachment.key, action: 'uploaded' })
      } else if (remoteChanged) {
        const zip = await client.download(attachment.key)
        if (zip === undefined) continue
        unzipInto(zip, dir)
        db.run(
          'UPDATE itemAttachments SET syncState = 2, storageModTime = ?, storageHash = ? WHERE itemID = ?',
          Date.now(), md5(zip), attachment.itemID,
        )
        downloaded += 1
        details.push({ key: attachment.key, action: 'downloaded' })
      }
    } catch (error) {
      failed += 1
      details.push({ key: attachment.key, action: 'failed', error: String(error?.message ?? error) })
      logger.warn?.(`library: storage sync failed for ${attachment.key}: ${error?.message ?? error}`)
    }
  }

  // Remote deletions recorded by Zotero's storageDeleteLog.
  const deletions = db.all('SELECT libraryID, key FROM storageDeleteLog')
  for (const deletion of deletions) {
    try {
      await client.remove(deletion.key)
      db.run('DELETE FROM storageDeleteLog WHERE libraryID = ? AND key = ?', deletion.libraryID, deletion.key)
    } catch (error) {
      failed += 1
      logger.warn?.(`library: remote delete failed for ${deletion.key}: ${error?.message ?? error}`)
    }
  }

  // Remember the pass locally so the UI can show when sync last ran.
  try {
    db.run("REPLACE INTO settings (setting, key, value) VALUES ('dshLibrary', 'lastSync', ?)", sqlNow())
  } catch {
    // settings is best-effort metadata.
  }

  return { uploaded, downloaded, conflicts, failed, details }
}
