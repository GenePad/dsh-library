// WebDAV smoke test: a local mock DAV server drives the Zotero storage protocol.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { ZoteroDb } from '../src/host/db.js'
import { createItem, createStoredAttachment } from '../src/host/write.js'
import { WebDavClient, syncStorage, parseMultistatus } from '../src/host/webdav.js'
import { unzipSync, zipSync } from '../vendor/deps.js'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zot-library-dav-'))
const sourceDb = path.join(process.env.USERPROFILE ?? os.homedir(), 'Zotero', 'zotero.sqlite')
if (!fs.existsSync(sourceDb)) {
  console.log('webdav-smoke: skipped (no Zotero database to clone)')
  process.exit(0)
}
const dataDir = path.join(tempRoot, 'zotero-data')
const storageDir = path.join(dataDir, 'storage')
fs.mkdirSync(storageDir, { recursive: true })
fs.copyFileSync(sourceDb, path.join(dataDir, 'zotero.sqlite'))

// --- mock WebDAV server -----------------------------------------------------
const files = new Map() // pathname -> {body: Buffer, mtime: number}
const USER = 'smoke'
const PASS = 'secret'
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const auth = req.headers.authorization ?? ''
  const expected = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`
  if (auth !== expected) {
    res.writeHead(401).end()
    return
  }
  const pathname = decodeURIComponent(url.pathname)
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    if (req.method === 'OPTIONS') {
      res.writeHead(200, { DAV: '1, 2', Allow: 'OPTIONS, GET, PUT, DELETE, PROPFIND' }).end()
      return
    }
    if (req.method === 'PROPFIND') {
      const depth = req.headers.depth ?? '0'
      const isDir = pathname.endsWith('/')
      if (isDir && ![...files.keys()].some(key => key.startsWith(pathname))) {
        res.writeHead(404).end()
        return
      }
      const entries = []
      const add = (href, mtime) => entries.push(`<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:getlastmodified>${new Date(mtime).toUTCString()}</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`)
      if (isDir) {
        add(pathname, Date.now())
        if (depth !== '0') {
          for (const [key, entry] of files) {
            if (key.startsWith(pathname)) add(key, entry.mtime)
          }
        }
      } else if (files.has(pathname)) {
        add(pathname, files.get(pathname).mtime)
      } else {
        res.writeHead(404).end()
        return
      }
      res.writeHead(207, { 'content-type': 'application/xml' }).end(
        `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${entries.join('')}</D:multistatus>`,
      )
      return
    }
    if (req.method === 'GET') {
      const entry = files.get(pathname)
      if (!entry) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/zip', 'last-modified': new Date(entry.mtime).toUTCString() }).end(entry.body)
      return
    }
    if (req.method === 'PUT') {
      files.set(pathname, { body, mtime: Date.now() })
      res.writeHead(201).end()
      return
    }
    if (req.method === 'DELETE') {
      const existed = files.delete(pathname)
      res.writeHead(existed ? 204 : 404).end()
      return
    }
    res.writeHead(405).end()
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const baseURL = `http://127.0.0.1:${port}/dav/`
// The zotero folder appears only after the client creates a test file under it;
// seed it so the verification path sees an existing directory.
files.set('/dav/zotero/', { body: Buffer.alloc(0), mtime: Date.now() })

const db = new ZoteroDb({ dbPath: path.join(dataDir, 'zotero.sqlite'), logger: console })
db.open()
db.storageDir = storageDir
const item = createItem(db, {
  itemType: 'journalArticle',
  fields: { title: 'WebDAV smoke paper', date: '2026' },
  creators: [{ firstName: 'Test', lastName: 'Author' }],
  tags: ['sync'],
})
const sourceFile = path.join(tempRoot, 'paper.pdf')
fs.writeFileSync(sourceFile, '%PDF-1.4 smoke')
const attachment = createStoredAttachment(db, { filePath: sourceFile, parentItemID: item.itemID }, { storageDir })

const client = new WebDavClient({ url: baseURL, username: USER, password: PASS })
const verified = await client.verify()
assert.equal(verified.ok, true)

// parseMultistatus copes with namespace prefixes and href encoding.
const parsed = parseMultistatus(`<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/dav/zotero/ABCDEFGH.zip</d:href><d:propstat><d:prop>
    <d:getlastmodified>Wed, 01 Jan 2025 00:00:00 GMT</d:getlastmodified>
  </d:prop></d:propstat></d:response>
</d:multistatus>`)
assert.equal(parsed.length, 1)
assert.ok(parsed[0].href.endsWith('ABCDEFGH.zip'))
assert.ok(Number.isFinite(parsed[0].lastModified))

// Upload the local attachment.
const first = await syncStorage({ db, storageDir, client, logger: console })
assert.equal(first.uploaded, 1, JSON.stringify(first))
assert.equal(first.failed, 0, JSON.stringify(first))
const remote = files.get(`/dav/zotero/${attachment.key}.zip`)
assert.ok(remote, 'remote zip exists')
const entries = unzipSync(new Uint8Array(remote.body))
assert.ok(Object.keys(entries).some(name => name.endsWith('paper.pdf')))
const uploadedRow = db.get('SELECT syncState, storageModTime, storageHash FROM itemAttachments WHERE itemID = ?', attachment.itemID)
assert.equal(uploadedRow.syncState, 2)
assert.match(uploadedRow.storageHash, /^[0-9a-f]{32}$/)

// A newer remote file downloads over an untouched local copy.
const remoteContent = zipSync({ 'remote.pdf': new Uint8Array(Buffer.from('%PDF remote')) })
files.set(`/dav/zotero/${attachment.key}.zip`, { body: Buffer.from(remoteContent), mtime: Date.now() + 60_000 })
const second = await syncStorage({ db, storageDir, client, logger: console })
assert.equal(second.downloaded, 1, JSON.stringify(second))
assert.ok(fs.existsSync(path.join(storageDir, attachment.key, 'remote.pdf')))

// Remote deletion through storageDeleteLog.
files.set('/dav/zotero/DEADBEEF.zip', { body: Buffer.from(zipSync({ 'x.txt': new Uint8Array([1]) })), mtime: Date.now() })
db.run("INSERT OR REPLACE INTO storageDeleteLog (libraryID, key, dateDeleted) VALUES (1, 'DEADBEEF', CURRENT_TIMESTAMP)")
const third = await syncStorage({ db, storageDir, client, logger: console })
assert.equal(third.failed, 0, JSON.stringify(third))
assert.equal(files.has('/dav/zotero/DEADBEEF.zip'), false, 'remote deletion applied')

// Wrong credentials are refused with a helpful code.
const badClient = new WebDavClient({ url: baseURL, username: USER, password: 'wrong' })
await assert.rejects(() => badClient.verify(), error => error.code === 'library/webdav-auth')

db.close()
server.close()
fs.rmSync(tempRoot, { recursive: true, force: true })
console.log('webdav-smoke: OK')
