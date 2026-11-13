// Host-half smoke test: mounts the plugin against a temporary copy of a real
// zotero.sqlite and drives the API channel, tools, import pipeline and chat.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { safeRemoveTree } from '../src/host/util.js'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zot-library-smoke-'))
process.env.DSH_HOME = path.join(tempRoot, 'dsh-home')
// Every "open" lands in this JSONL file instead of spawning a real browser /
// Explorer (open.js reads the env at import time — set it before index.js).
const openSinkPath = path.join(tempRoot, 'open-sink.jsonl')
process.env.DSH_LIBRARY_OPEN_SINK = openSinkPath
fs.writeFileSync(openSinkPath, '')
const dataDir = path.join(process.env.DSH_HOME, 'library', 'zotero-data')
const storageDir = path.join(dataDir, 'storage')
fs.mkdirSync(storageDir, { recursive: true })

const realDb = path.join(process.env.USERPROFILE ?? os.homedir(), 'Zotero', 'zotero.sqlite')
const hasRealLibrary = fs.existsSync(realDb)
if (hasRealLibrary) fs.copyFileSync(realDb, path.join(dataDir, 'zotero.sqlite'))

// --- fake Zotero client (local HTTP server) ----------------------------------
// One swappable handler answers /connector/ping for every phase below. Started
// before the plugin import so the runtime reads the DSH_LIBRARY_ZOTERO_* env
// (ports, launch sink, launch wait) when zotero-client.js loads.
let fakeZoteroHandler = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, processorName: 'Word', active: false, styles: 0 }))
}
const fakeZotero = createServer((req, res) => fakeZoteroHandler(req, res))
const fakeZoteroPort = await new Promise((resolve, reject) => {
  fakeZotero.once('error', reject)
  fakeZotero.listen(0, '127.0.0.1', () => resolve(fakeZotero.address().port))
})
process.env.DSH_LIBRARY_ZOTERO_PORTS = String(fakeZoteroPort)
process.env.DSH_LIBRARY_ZOTERO_LAUNCH_WAIT_MS = '900'
const launchSinkPath = path.join(tempRoot, 'zotero-launch-sink.jsonl')
process.env.DSH_LIBRARY_ZOTERO_LAUNCH_SINK = launchSinkPath
// 断连恢复的 5 秒定时器调快，用例用轮询断言自动重连。
process.env.DSH_LIBRARY_RECONNECT_MS = '120'
fs.writeFileSync(launchSinkPath, '')

const { apply, name, version } = await import('../index.js')
const { chatGuidance } = await import('../src/host/chat.js')
assert.equal(name, 'library')
assert.match(version, /^\d+\.\d+\.\d+$/)

// --- mock cordis context ----------------------------------------------------
const routes = []
const toolDefs = new Map()
const disposers = []
const prompts = []
const createdSessions = []
const archivedSessions = []
let sessionCounter = 0
const llmCalls = []
let running = false
const agent = {
  get status() { return running ? 'running' : 'idle' },
  session: { seq: 10 },
  followup() {},
  steer() {},
  cancel() { running = false },
}
const mockCtx = {
  logger: { info() {}, warn() {}, error() {} },
  get() { return undefined },
  // Fake dsh plugin manager: update endpoints drive it through the adapter in
  // src/host/updater.js; tests re-point pluginManagerBehavior per case.
  pluginManager: null,
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  inject(_deps, callback) {
    // Optional service bridges (llm / agentDefaultModel) resolve through this
    // map; unknown services stay undefined so the plugin degrades gracefully.
    const services = {
      llm: {
        async prepareCall(config, signal, configure) {
          const controls = configure?.({}, { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }) ?? {}
          llmCalls.push({ ...config, ...controls })
          return {
            config: { provider: config.provider, model: config.model, maxTokens: config.maxTokens, ...controls },
            async *stream(options) {
              assert.equal(options.messages.length, 1, 'translate sends exactly one user message')
              assert.equal(options.messages[0].role, 'user')
              assert.equal(options.messages[0].content[0].text, 'The sample text.')
              assert.ok(options.system.includes('翻译'), 'system prompt travels')
              yield { type: 'reasoning-delta', index: 0, text: '思考过程。' }
              yield { type: 'text-delta', index: 1, text: '这是' }
              yield { type: 'text-delta', index: 1, text: '译文。' }
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }
        },
        listProviders() { return [{ id: 'deepseek', name: 'DeepSeek' }] },
        async listModels(provider) {
          assert.equal(provider, 'deepseek')
          return [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }]
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    }
    const scoped = {
      ...mockCtx,
      ...Object.fromEntries(_deps.map(dep => [dep, services[dep]])),
      tools: { register(definition) { toolDefs.set(definition.name, definition); return () => toolDefs.delete(definition.name) } },
      effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
    }
    callback(scoped)
    return { dispose() {} }
  },
  connection: { fetch: { register(route) { routes.push(route); return () => {} } } },
  sessionController: {
    async create({ workspaceId }) { sessionCounter += 1; createdSessions.push(workspaceId); return { sessionId: `session-${sessionCounter}` } },
    async resolveAgent() { return { agent } },
    async prompt(request) { prompts.push(request); running = true; return {} },
    async page() {
      return {
        hasMore: false,
        records: [
          { event: { type: 'user/message', seq: 1, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text: '总结这篇文献' }] } } },
          { event: { type: 'assistant/message', seq: 2, time: Date.now(), data: { turn: 1, message: { content: [{ type: 'text', text: '好的，正在阅读。' }] } } } },
          { event: { type: 'tool/call', seq: 3, time: Date.now(), data: { turn: 1, step: 1, callId: 'c1', name: 'library_read', arguments: '{"key":"AAAAAAAA"}' } } },
          { event: { type: 'tool/result', seq: 4, time: Date.now(), data: { turn: 1, step: 1, message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: '文本检索结果' }] } } } },
        ],
      }
    },
  },
  sessionTitle: { async rename() {} },
  workspaceRegistry: {
    async resolveByPath() { return { id: 'ws-smoke' } },
    async create() { return { id: 'ws-smoke' } },
    get() { return undefined },
    async archiveSession(id) { archivedSessions.push(id) },
  },
}

// 插件更新 = dsh 插件管理器适配器：用例通过换 handler 模拟 listed/拒绝/成功/
// 失败，并断言传给 listVersions/updateBundle 的实参。
let pluginManagerBehavior = () => ({ status: 'refused', problem: 'not-found', reason: 'not found', attempts: [{ registry: 'https://registry.npmjs.org/' }] })
const pluginManagerCalls = []
mockCtx.pluginManager = {
  async listVersions(nameArg, options) {
    pluginManagerCalls.push(['listVersions', nameArg, options])
    return pluginManagerBehavior('listVersions')
  },
  async updateBundle(nameArg, versionArg, options) {
    pluginManagerCalls.push(['updateBundle', nameArg, versionArg, options])
    return pluginManagerBehavior('updateBundle')
  },
}

apply(mockCtx, { zoteroDataDir: dataDir })

assert.equal(routes.length, 3, 'API + binary PDF + translate routes registered')
assert.equal(routes[0].path, '/api/library')
assert.deepEqual(routes[0].methods, ['POST'])
assert.equal(routes[1].path, '/api/library/file')
assert.deepEqual(routes[1].methods, ['GET'])
assert.equal(routes[2].path, '/api/library/translate')
assert.deepEqual(routes[2].methods, ['POST'])
assert.deepEqual([...toolDefs.keys()].sort(), [
  'library_add', 'library_annotations', 'library_attach', 'library_cite', 'library_cite_styles',
  'library_collection', 'library_collections', 'library_import', 'library_item', 'library_lookup',
  'library_note', 'library_open', 'library_read', 'library_search', 'library_status', 'library_sync',
  'library_trash', 'library_update', 'library_word_apply', 'library_word_busy', 'library_word_cite',
  'library_word_list', 'library_word_read', 'library_word_report', 'library_word_search', 'library_word_write',
  'library_zotero_kill',
])

const call = async (endpoint, payload) => {
  const request = new Request('http://localhost/api/library', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  })
  const response = await routes[0].fetch(request)
  assert.equal(response.status, 200)
  return await response.json()
}

// Tool schemas must be wire-safe standard JSON Schema (no inline required).
const SCHEMA_KEYWORDS = new Set(['type', 'properties', 'required', 'items', 'additionalProperties', 'enum', 'const', 'description', 'title', 'minimum', 'maximum'])
const walkSchema = (node, where) => {
  if (node === null || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties') {
      for (const [prop, child] of Object.entries(value)) walkSchema(child, `${where}.${prop}`)
      continue
    }
    assert.ok(SCHEMA_KEYWORDS.has(key), `unsupported schema keyword "${key}" at ${where}`)
    if (key === 'required') assert.ok(Array.isArray(value), `required must be an array at ${where}`)
    if (key === 'items') walkSchema(value, `${where}[]`)
  }
}
for (const [toolName, definition] of toolDefs) {
  assert.ok(definition.description.length > 20, `${toolName} needs a description`)
  assert.ok(typeof definition.execute === 'function', `${toolName} needs execute`)
  walkSchema(definition.parameters, toolName)
  assert.equal(typeof definition.output.schema, 'object')
  assert.equal(typeof definition.output.render, 'function')
}

const status = await call('status-test').catch(() => undefined) // unknown endpoint answers an envelope
void status
const unknown = await call('nope', {})
assert.equal(unknown.ok, false)
assert.equal(unknown.error.code, 'library/not-found')

if (hasRealLibrary) {
  // Regression: every tool output must be lossless JSON (no undefined /
  // BigInt properties). The harness rejects the whole call otherwise with
  // "returned invalid output: value is not lossless JSON" — which once broke
  // every library_search call on items without a date field.
  const scanLossless = (value, where) => {
    assert.ok(value !== undefined, `undefined at ${where}`)
    if (value === null || typeof value !== 'object') {
      assert.ok(typeof value !== 'function' && typeof value !== 'symbol' && typeof value !== 'bigint', `non-JSON value at ${where}`)
      return
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => scanLossless(entry, `${where}[${index}]`))
      return
    }
    for (const [name, entry] of Object.entries(value)) scanLossless(entry, `${where}.${name}`)
  }
  const probed = await toolDefs.get('library_search').execute({ query: 'a', limit: 5 })
  scanLossless(probed, 'library_search')
  const statusTool = await toolDefs.get('library_status').execute({})
  scanLossless(statusTool, 'library_status')

  const state = await call('state', {})
  assert.equal(state.ok, true)
  assert.equal(state.value.available, true)
  assert.ok(state.value.counts.items > 100, 'real library has items')
  assert.ok(state.value.counts.collections > 0)
  assert.ok(state.value.schemaVersion > 100)

  // Another writer holding the database: Zotero 10 runs WAL, so readers pass
  // (availability stays true) and only writes run into SQLITE_BUSY after the
  // 4 s busy timeout — the library comes back by itself once the lock clears.
  {
    const { DatabaseSync } = await import('node:sqlite')
    const locker = new DatabaseSync(path.join(dataDir, 'zotero.sqlite'))
    locker.exec('PRAGMA busy_timeout = 0')
    locker.exec('BEGIN EXCLUSIVE')
    try {
      const duringLock = await call('state', {})
      assert.equal(duringLock.ok, true)
      assert.equal(duringLock.value.available, true, 'WAL: reads pass while another writer holds the db')
      const busyWrite = await call('create', {
        itemType: 'document',
        fields: { title: 'written while another writer holds the db' },
        creators: [],
        tags: [],
      })
      assert.equal(busyWrite.ok, false, JSON.stringify(busyWrite))
      assert.match(busyWrite.error.message, /database is locked|busy/i, `write reports the busy error (got ${busyWrite.error.code}: ${busyWrite.error.message})`)
    } finally {
      locker.exec('ROLLBACK')
      locker.close()
    }
    const recovered = await call('state', {})
    assert.equal(recovered.value.available, true, 'library recovers once the lock is released')
    const ping = await call('ping', {})
    assert.equal(ping.value.available, true, 'ping reports recovery')
  }

  const tree = await call('collections', {})
  assert.ok(tree.value.collections.length > 0)

  const list = await call('items', { limit: 5 })
  assert.equal(list.value.items.length, 5)
  const first = list.value.items[0]

  const searched = await call('items', { query: 'AAV', limit: 20 })
  assert.equal(searched.ok, true, JSON.stringify(searched))
  assert.ok(Array.isArray(searched.value.items))
  const tagName = tree.value.tags?.[0]?.name
  if (tagName) {
    const byTag = await call('items', { tag: tagName, limit: 10 })
    assert.ok(byTag.value.items.every(item => item.key))
  }
  const unfiled = await call('items', { unfiled: true, limit: 10 })
  assert.equal(unfiled.ok, true, JSON.stringify(unfiled))
  const detail = await call('item', { key: first.key })
  assert.equal(detail.value.key, first.key)

  // Create → update → tags → trash → restore → delete.
  const created = await call('create', {
    itemType: 'journalArticle',
    fields: { title: 'dsh-zot-library smoke item', date: '2026', DOI: '10.0000/smoke', pages: '1-10' },
    creators: [{ firstName: 'San', lastName: 'Zhang', creatorType: 'author' }],
    tags: ['smoke'],
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  const key = created.value.key
  const createdDetail = await call('item', { key })
  assert.equal(createdDetail.value.title, 'dsh-zot-library smoke item')
  assert.equal(createdDetail.value.creators[0].lastName, 'Zhang')
  assert.deepEqual(createdDetail.value.tags.map(tag => tag.name), ['smoke'])

  // Item-type schema (the item pane's type menu / field list) + Zotero's type
  // change: fields transfer across base mappings, the rest are dropped after a
  // confirm round trip (plan → apply).
  const schemaTypes = await call('schema', {})
  assert.equal(schemaTypes.ok, true, JSON.stringify(schemaTypes))
  assert.ok(schemaTypes.value.some(type => type.itemType === 'journalArticle'
    && type.creatorTypes.some(creator => creator.creatorType === 'author')), 'item-type shapes served from the bundled schema')
  const plan = await call('change-type', { key, itemType: 'book' })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  assert.ok(Array.isArray(plan.value.dropped) && Array.isArray(plan.value.transferred), `type change returns a plan (${JSON.stringify(plan.value)})`)
  assert.ok(plan.value.dropped.includes('pages'), 'journal-only fields are listed for the confirm dialog')
  const applied = await call('change-type', { key, itemType: 'book', confirm: true })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  const bookDetail = await call('item', { key })
  assert.equal(bookDetail.value.itemType, 'book', 'type row switched to book')
  assert.ok(!bookDetail.value.fields.some(field => field.field === 'pages'), 'dropped fields removed on type change')
  assert.ok(bookDetail.value.fields.some(field => field.field === 'DOI' && field.value === '10.0000/smoke'), 'fields valid for both types survive')
  assert.ok(bookDetail.value.fields.some(field => field.field === 'title' && field.value === 'dsh-zot-library smoke item'), 'title survived the type change')
  await call('change-type', { key, itemType: 'journalArticle', confirm: true })

  // Notes and web-link attachments (Zotero's 添加笔记 / 添加网页链接).
  const noteCreated = await call('note-create', { parentKey: key, text: '第一段\n第二段' })
  assert.equal(noteCreated.ok, true, JSON.stringify(noteCreated))
  const withNote = await call('item', { key })
  assert.equal(withNote.value.notes.length, 1, 'child note created under the item')
  const noteUpdated = await call('note-update', { key: withNote.value.notes[0].key, text: '改过的笔记' })
  assert.equal(noteUpdated.ok, true, 'note body updated')
  const noteUrl = await call('attachment-url', { parentKey: key, url: 'https://example.com/paper' })
  assert.equal(noteUrl.ok, true, JSON.stringify(noteUrl))
  const urlDetail = await call('item', { key })
  assert.equal(urlDetail.value.attachments.length, 1, 'web-link attachment listed under the parent')
  assert.equal(urlDetail.value.attachments[0].linkMode, 3, 'web link stored as linkMode 3')
  const badUrl = await call('attachment-url', { parentKey: key, url: 'javascript:alert(1)' })
  assert.equal(badUrl.ok, false, 'non-http(s) web links rejected')

  // Agent capability trio: 主动入库（lookup）/ 主动挂附件 / 主动分类.
  const lookupMiss = await toolDefs.get('library_lookup').execute({ identifier: 'not-an-identifier' })
  assert.deepEqual(lookupMiss, { found: false, identifier: 'not-an-identifier' }, 'identifier miss reported without throwing')
  const lookupQuery = await toolDefs.get('library_lookup').execute({ query: 'zoterotestquery' })
  assert.ok(lookupQuery && Array.isArray(lookupQuery.candidates), 'title query answers with a candidate list (possibly empty offline)')
  const attachedUrl = await toolDefs.get('library_attach').execute({ key, url: 'https://example.com/tool-link' })
  assert.equal(attachedUrl.kind, 'url', 'library_attach links a web page')
  const made = await toolDefs.get('library_collection').execute({ action: 'create', name: 'Tool 分类' })
  assert.ok(Number.isInteger(made.collectionID), 'library_collection creates a collection')
  await toolDefs.get('library_collection').execute({ action: 'rename', id: made.collectionID, name: 'Tool 分类 2' })
  const trashedCol = await toolDefs.get('library_collection').execute({ action: 'trash', id: made.collectionID })
  assert.equal(trashedCol.changed, 1, 'library_collection trashes a collection')

  // library_note: the agent can create and edit note bodies (notes live in
  // itemNotes, outside the field map library_update covers).
  const noteToolMade = await toolDefs.get('library_note').execute({ parentKey: key, text: 'AI 写的笔记\n第二段' })
  assert.ok(/^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(noteToolMade?.key ?? ''), 'library_note creates a child note')
  const noteToolUpdated = await toolDefs.get('library_note').execute({ action: 'update', key: noteToolMade.key, text: 'AI 改过的笔记' })
  assert.equal(noteToolUpdated.updated, true, 'library_note replaces the note body')
  const noteToolRead = await call('item', { key })
  assert.ok(
    (noteToolRead.value.notes ?? []).some(entry => entry.key === noteToolMade.key && String(entry.html).includes('AI 改过的笔记')),
    'the edited note body is readable through the item endpoint',
  )

  const updated = await call('update', { key, patch: { fields: { abstractNote: 'abstract text' } } })
  assert.equal(updated.ok, true, JSON.stringify(updated))
  const updatedDetail = await call('item', { key })
  assert.ok(updatedDetail.value.fields.some(field => field.field === 'abstractNote' && field.value === 'abstract text'))

  const trashed = await call('trash', { keys: [key] })
  assert.equal(trashed.value.changed, 1)
  const trashList = await call('items', { trash: true, limit: 500 })
  assert.ok(trashList.value.items.some(item => item.key === key))
  const restored = await call('trash', { keys: [key], restore: true })
  assert.equal(restored.value.changed, 1)
  const deleted = await call('delete', { keys: [key] })
  assert.equal(deleted.ok, false, 'live items cannot be deleted forever')
  await call('trash', { keys: [key] })
  const deletedForever = await call('delete', { keys: [key] })
  assert.equal(deletedForever.value.deleted, 1)

  const collection = await call('collection-create', { name: 'Smoke 分类' })
  assert.equal(collection.ok, true, JSON.stringify(collection))
  const renamed = await call('collection-rename', { id: collection.value.collectionID, name: 'Smoke 分类 2' })
  assert.equal(renamed.ok, true)
  const treeAfter = await call('collections', {})
  const flat = JSON.stringify(treeAfter.value)
  assert.ok(flat.includes('Smoke 分类 2'))
  await call('collection-trash', { id: collection.value.collectionID })

  // Import a real PDF from the user's storage (read-only source).
  const sourceStorage = path.join(path.dirname(realDb), 'storage')
  let samplePdf
  try {
    const folder = fs.readdirSync(sourceStorage).find(entry => fs.readdirSync(path.join(sourceStorage, entry)).some(name => name.toLowerCase().endsWith('.pdf')))
    if (folder) samplePdf = path.join(sourceStorage, folder, fs.readdirSync(path.join(sourceStorage, folder)).find(name => name.toLowerCase().endsWith('.pdf')))
  } catch {
    samplePdf = undefined
  }
  if (samplePdf) {
    const imported = await call('import', { path: samplePdf, lookup: false })
    assert.equal(imported.ok, true, JSON.stringify(imported))
    assert.ok(imported.value.attachmentKey)
    assert.ok(imported.value.textChars > 100, 'PDF text extracted')
    // Without metadata the import stays a standalone attachment, as in Zotero;
    // with metadata the caller gets a parent item key.
    const readKey = imported.value.parentKey ?? imported.value.attachmentKey
    const attachmentDetail = await call('item', { key: readKey })
    const stored = attachmentDetail.value.attachment
      ? attachmentDetail.value.attachment.target.path
      : attachmentDetail.value.attachments[0].target.path
    assert.ok(fs.existsSync(stored), 'attachment copied into the temporary storage')
    assert.ok(fs.existsSync(path.join(path.dirname(stored), '.zotero-ft-cache')), 'fulltext cache written')

    const readTool = toolDefs.get('library_read')
    const read = await readTool.execute({ key: readKey, maxChars: 2000 })
    assert.ok(read.text.length > 100)
    assert.equal(read.totalChars, imported.value.textChars)

    const searchTool = toolDefs.get('library_search')
    const found = await searchTool.execute({ query: path.basename(samplePdf).slice(0, 12) })
    assert.ok(Array.isArray(found.items))

    const annotationsTool = toolDefs.get('library_annotations')
    const annotations = await annotationsTool.execute({ key: readKey })
    assert.ok(Array.isArray(annotations.annotations))

    // Explicit metadata creates a metadata-complete parent item in one import.
    const withMeta = await call('import', {
      path: samplePdf,
      lookup: false,
      metadata: {
        itemType: 'journalArticle',
        fields: { title: 'dsh-zot-library imported parent', date: '2025', DOI: '10.0000/import' },
        creators: [{ firstName: 'Meta', lastName: 'Data', creatorType: 'author' }],
        tags: ['imported'],
      },
    })
    assert.equal(withMeta.ok, true, JSON.stringify(withMeta))
    assert.ok(withMeta.value.parentKey, 'parent item created from metadata')
    const parentDetail = await call('item', { key: withMeta.value.parentKey })
    assert.equal(parentDetail.value.title, 'dsh-zot-library imported parent')
    assert.equal(parentDetail.value.attachments.length, 1)

    // List rows carry their children so the item tree can expand a parent into
    // attachments/notes (Zotero's tree expansion).
    const expandedList = await call('items', { query: 'dsh-zot-library imported parent' })
    const parentRow = expandedList.value.items.find(item => item.key === withMeta.value.parentKey)
    assert.ok(Array.isArray(parentRow?.children)
      && parentRow.children.some(child => child.kind === 'attachment' && child.key === parentDetail.value.attachments[0].key),
    'list rows carry expandable attachment children')

    // Two-phase drag import (Zotero-style): the staged attachment exists at
    // once, then finalize attaches it under a parent built from metadata.
    const staged = await call('import', { path: samplePdf, deferMetadata: true })
    assert.equal(staged.ok, true, JSON.stringify(staged))
    assert.equal(staged.value.staged, true, 'staged import reports the two-phase shape')
    assert.ok(staged.value.attachmentKey && staged.value.parentKey === null, 'staged import creates a standalone attachment')
    const stagedList = await call('items', { query: staged.value.fileName, limit: 500 })
    assert.ok(stagedList.value.items.some(item => item.key === staged.value.attachmentKey), 'the staged attachment row appears in the list at once (filename searchable)')
    const finished = await call('import-finalize', {
      attachmentKey: staged.value.attachmentKey,
      metadata: {
        itemType: 'journalArticle',
        fields: { title: 'dsh-zot-library staged parent', date: '2024' },
        creators: [{ lastName: 'Stage', firstName: 'Two', creatorType: 'author' }],
      },
    })
    assert.equal(finished.ok, true, JSON.stringify(finished))
    assert.ok(finished.value.parentKey === withMeta.value.parentKey ? false : Boolean(finished.value.parentKey), 'finalize reports the new parent key')
    const stagedParent = await call('item', { key: finished.value.parentKey })
    assert.equal(stagedParent.value.title, 'dsh-zot-library staged parent')
    assert.ok(stagedParent.value.attachments.some(entry => entry.key === staged.value.attachmentKey), 'finalize reparents the staged attachment')

    // Staged import without metadata stays standalone and asks for help.
    const stagedPlain = await call('import', { path: samplePdf, deferMetadata: true })
    const finishedPlain = await call('import-finalize', { attachmentKey: stagedPlain.value.attachmentKey, lookup: false })
    assert.equal(finishedPlain.ok, true, JSON.stringify(finishedPlain))
    assert.equal(finishedPlain.value.parentKey, null, 'no metadata keeps the attachment standalone')
    assert.equal(finishedPlain.value.needsMetadataHelp, true, 'the browser gets the AI-fix hint')

    // A standalone attachment given a new type through library_update is
    // promoted under a fresh typed parent — never rewritten in place, which
    // would strand its itemAttachments row / fulltext index / storage folder
    // on an item that stopped being an attachment (real-world data loss).
    const stagedPromo = await call('import', { path: samplePdf, deferMetadata: true })
    const promoted = await toolDefs.get('library_update').execute({
      key: stagedPromo.value.attachmentKey,
      itemType: 'report',
      fields: { title: 'promoted standalone parent', reportNumber: 'R-1' },
      creators: [{ lastName: 'Prom', firstName: 'Oted', creatorType: 'author' }],
      tags: ['promoted'],
    })
    assert.ok(promoted && promoted.parentKey, `library_update reports the created parent key (${JSON.stringify(promoted)})`)
    const promotedParent = await call('item', { key: promoted.parentKey })
    assert.equal(promotedParent.value.itemType, 'report', 'the created parent carries the new type')
    assert.ok(promotedParent.value.fields.some(field => field.field === 'reportNumber' && field.value === 'R-1'), 'fields land on the parent')
    assert.ok(promotedParent.value.creators.some(creator => creator.lastName === 'Prom'), 'creators land on the parent')
    assert.deepEqual(promotedParent.value.tags.map(tag => tag.name), ['promoted'], 'tags land on the parent')
    assert.ok(promotedParent.value.attachments.some(entry => entry.key === stagedPromo.value.attachmentKey), 'the attachment hangs under the promoted parent')
    const promotedChild = await call('item', { key: stagedPromo.value.attachmentKey })
    assert.equal(promotedChild.value.itemType, 'attachment', 'the attachment row stays an attachment')
    assert.ok(fs.existsSync(promotedChild.value.attachment.target.path), 'the storage file keeps its original key folder')
    const promotedParentAgain = await toolDefs.get('library_update').execute({ key: promoted.parentKey, fields: { extra: 'later edits go to the parent' } })
    assert.ok(!promotedParentAgain.parentKey, 'plain field updates report no parent key')
    const refetchedParent = await call('item', { key: promoted.parentKey })
    assert.ok(refetchedParent.value.fields.some(field => field.field === 'extra' && field.value === 'later edits go to the parent'), 'parent accepts follow-up edits under its own key')
    const childRefused = await call('update', { key: promotedParent.value.attachments[0].key, patch: { itemType: 'book' } })
    assert.equal(childRefused.ok, false, 'child attachments cannot change type')
    const noteRefused = await call('update', { key: withNote.value.notes[0].key, patch: { itemType: 'book' } })
    assert.equal(noteRefused.ok, false, 'notes cannot change type')

    // change-type on a standalone attachment promotes the same way (plan lists
    // nothing to drop; apply creates the typed parent from the file name).
    const stagedPlain2 = await call('import', { path: samplePdf, deferMetadata: true })
    const promotedPlan = await call('change-type', { key: stagedPlain2.value.attachmentKey, itemType: 'thesis' })
    assert.equal(promotedPlan.ok, true, JSON.stringify(promotedPlan))
    assert.deepEqual(promotedPlan.value.dropped, [], 'the promotion plan drops no fields')
    const promotedByChangeType = await call('change-type', { key: stagedPlain2.value.attachmentKey, itemType: 'thesis', confirm: true })
    assert.equal(promotedByChangeType.ok, true, JSON.stringify(promotedByChangeType))
    assert.ok(promotedByChangeType.value.key && promotedByChangeType.value.key !== stagedPlain2.value.attachmentKey, 'change-type reports the new parent key')
    const thesisParent = await call('item', { key: promotedByChangeType.value.key })
    assert.equal(thesisParent.value.itemType, 'thesis', 'change-type created the typed parent')
    assert.equal(thesisParent.value.title, path.basename(samplePdf).replace(/\.[^.]+$/, ''), 'the parent title falls back to the file name')
    assert.ok(thesisParent.value.attachments.some(entry => entry.key === stagedPlain2.value.attachmentKey), 'change-type reparented the attachment')

    // Generic list columns: any visible field can be fetched per row, and
    // notes count rides along for the 笔记 column.
    const columnList = await call('items', { columns: ['extra', 'pages', 'numNotes'] })
    assert.equal(columnList.ok, true, JSON.stringify(columnList))
    const stagedRow = columnList.value.items.find(item => item.key === finished.value.parentKey)
    assert.ok(stagedRow && typeof stagedRow.numNotes === 'number', 'rows carry the note count')
    assert.ok(typeof stagedRow.fields === 'object', 'rows carry the requested-field map')

    // Sorting by any visible field (the client's field:* sort keys).
    await call('update', { key: finished.value.parentKey, patch: { fields: { extra: 'aaa' } } })
    await call('update', { key: withMeta.value.parentKey, patch: { fields: { extra: 'bbb' } } })
    const sortedUp = await call('items', { sort: 'field:extra', desc: false, limit: 500 })
    const sortedKeys = sortedUp.value.items.map(item => item.key)
    assert.ok(sortedKeys.indexOf(finished.value.parentKey) < sortedKeys.indexOf(withMeta.value.parentKey), 'field:extra sorts ascending')
    const sortedDown = await call('items', { sort: 'field:extra', desc: true, limit: 500 })
    const downKeys = sortedDown.value.items.map(item => item.key)
    assert.ok(downKeys.indexOf(withMeta.value.parentKey) < downKeys.indexOf(finished.value.parentKey), 'field:extra sorts descending')

    // Context-menu write ops: duplicate / merge / create parent / detach.
    const duplicate = await call('duplicate', { key: withMeta.value.parentKey })
    assert.equal(duplicate.ok, true, JSON.stringify(duplicate))
    const duplicateDetail = await call('item', { key: duplicate.value.key })
    assert.equal(duplicateDetail.value.title, 'dsh-zot-library imported parent', 'duplicate copies the fields')
    assert.equal(duplicateDetail.value.attachments.length, 1, 'duplicate copies child attachments')
    // Child rows carry no target (trap 10) — resolve through the child's own detail.
    const duplicateChild = await call('item', { key: duplicateDetail.value.attachments[0].key })
    assert.ok(fs.existsSync(duplicateChild.value.attachment.target.path), 'duplicate copied the stored file')

    const mergeMaster = await call('create', { itemType: 'journalArticle', fields: { title: 'merge master' } })
    const mergeTarget = await call('create', {
      itemType: 'journalArticle',
      fields: { title: 'merge source', extra: 'merged-extra' },
      creators: [{ lastName: 'Merge', firstName: 'Source', creatorType: 'author' }],
    })
    const merged = await call('merge', { keys: [mergeMaster.value.key, mergeTarget.value.key] })
    assert.equal(merged.ok, true, JSON.stringify(merged))
    const mergedDetail = await call('item', { key: mergeMaster.value.key })
    assert.ok(mergedDetail.value.fields.some(field => field.field === 'extra' && field.value === 'merged-extra'), 'merge fills missing fields from the source')
    assert.ok(mergedDetail.value.creators.some(creator => creator.lastName === 'Merge'), 'merge takes creators when the master has none')
    const mergeTrash = await call('items', { trash: true, limit: 500 })
    assert.ok(mergeTrash.value.items.some(item => item.key === mergeTarget.value.key), 'the merged-away item ends up in the trash')

    const createdParent = await call('create-parent', { key: finishedPlain.value.attachmentKey })
    assert.equal(createdParent.ok, true, JSON.stringify(createdParent))
    assert.ok(createdParent.value.parentKey, 'create-parent attaches a standalone attachment')
    const detach = await call('detach-attachment', { key: finishedPlain.value.attachmentKey })
    assert.equal(detach.ok, true, JSON.stringify(detach))
    const detachedDetail = await call('item', { key: finishedPlain.value.attachmentKey })
    assert.ok(detachedDetail.value.attachments === undefined || detachedDetail.value.attachments.length === 0, 'detached attachment has no parent list')
    assert.ok(detachedDetail.value.attachment, 'the attachment is standalone again')

    // 从批注创建笔记: create an annotation, then a note from it.
    const annoCreated = await call('annotation-create', {
      attachmentKey: finishedPlain.value.attachmentKey,
      annotation: { type: 1, text: 'annotated sentence', comment: 'my thought', color: '#ffd400', pageIndex: 0, rects: [[10, 10, 100, 30]] },
    })
    assert.equal(annoCreated.ok, true, JSON.stringify(annoCreated))
    const annoNote = await call('note-from-annotations', { key: finishedPlain.value.attachmentKey })
    assert.equal(annoNote.ok, true, JSON.stringify(annoNote))
    const annoNoteDetail = await call('item', { key: finishedPlain.value.attachmentKey })
    assert.equal(annoNoteDetail.value.notes.length, 1, 'the annotation note hangs under the attachment')
    assert.ok(annoNoteDetail.value.notes[0].html.includes('annotated sentence'), 'the note quotes the annotation text')
    const annoNoteEmpty = await call('note-from-annotations', { key: duplicate.value.key })
    assert.equal(annoNoteEmpty.ok, false, 'items without annotations refuse the note')

    // 重新获取元数据: re-recognize an item that already has metadata. The
    // explicit draft stands in for the online lookup here (own item, so the
    // later cite assertions keep seeing the import's metadata); fetched
    // values win while untouched fields survive the merge.
    const refetchHost = await call('create', {
      itemType: 'journalArticle',
      fields: { title: 'refetch origin', DOI: '10.0000/keep', extra: 'mine' },
      creators: [{ firstName: 'Old', lastName: 'Author', creatorType: 'author' }],
    })
    const refetch = await call('recognize-item', {
      key: refetchHost.value.key,
      metadata: {
        itemType: 'journalArticle',
        fields: { title: 'refetch result', pages: '3-9' },
        creators: [{ firstName: 'Re', lastName: 'Fetch', creatorType: 'author' }],
      },
    })
    assert.equal(refetch.ok, true, JSON.stringify(refetch))
    assert.equal(refetch.value.updated, true, 'refetch reports success')
    const refetched = await call('item', { key: refetchHost.value.key })
    assert.equal(refetched.value.title, 'refetch result', 'the fetched title overwrites')
    assert.ok(refetched.value.fields.some(field => field.field === 'pages' && field.value === '3-9'), 'the fetched field is added')
    assert.ok(refetched.value.fields.some(field => field.field === 'DOI' && field.value === '10.0000/keep'), 'untouched fields survive the merge')
    assert.ok(refetched.value.fields.some(field => field.field === 'extra' && field.value === 'mine'), "the user's own fields survive the merge")
    assert.ok(refetched.value.creators.some(creator => creator.lastName === 'Fetch'), 'creators are refreshed from the fetch')
    const refetchStandalone = await call('recognize-item', { key: finishedPlain.value.attachmentKey })
    assert.equal(refetchStandalone.ok, false, 'standalone attachments belong to import-finalize')

    // Regression for double-click open: a parent item's PDF child must resolve
    // to a real path (delete the file so the open fails gracefully instead of
    // spawning a reader during the test).
    const childAttachment = parentDetail.value.attachments[0]
    const childDetail = await call('item', { key: childAttachment.key })
    const childPath = childDetail.value.attachment.target.path

    // Binary PDF route: streams the stored fixture bytes with PDF headers
    // (before the unlink below).
    const fileRoute = routes[1]
    const fileRequest = new Request(`http://localhost/api/library/file?key=${childAttachment.key}`, { method: 'GET' })
    const fileResponse = await fileRoute.fetch(fileRequest)
    assert.equal(fileResponse.status, 200, 'binary route streams the stored PDF')
    assert.equal(fileResponse.headers.get('content-type'), 'application/pdf')
    assert.equal(fileResponse.headers.get('x-library-attachment-key'), childAttachment.key)
    const fileBytes = Buffer.from(await fileResponse.arrayBuffer())
    assert.ok(fileBytes.equals(fs.readFileSync(childPath)), 'binary route bytes match the stored file')

    // 打开方式 (open-with control): the association query answers a shape-safe
    // app list for the attachment's file type (real registry on Windows), and
    // launching refuses ids outside that list — no spawn ever happens. Runs
    // before the unlink below: the query needs the file on disk.
    const openApps = await call('open-apps', { key: childAttachment.key })
    assert.equal(openApps.ok, true, `open-apps answered (${openApps.error?.message ?? ''})`)
    assert.ok(Array.isArray(openApps.value.apps), 'open-apps returns the application list')
    for (const app of openApps.value.apps) {
      assert.equal(typeof app.id, 'string', 'every application carries an id')
      assert.equal(typeof app.name, 'string', 'every application carries a name')
    }
    const openWithUnknown = await call('open-with', { key: childAttachment.key, application: 'totally.not.registered' })
    assert.equal(openWithUnknown.ok, false, 'open-with refuses ids outside the association list')

    fs.unlinkSync(childPath)
    const openMissing = await call('open', { key: withMeta.value.parentKey })
    assert.equal(openMissing.ok, false, 'opening a missing file reports an error')
    assert.match(openMissing.error.message, /附件文件不存在/, `resolved path reported: ${openMissing.error.message}`)
    assert.ok(openMissing.error.message.includes('.pdf'), 'the PDF child path was resolved')
    // Regression: the reader's 打开方式 icon calls `open` with the ATTACHMENT
    // key (a top-level attachment). The self row carries no `key` field — the
    // old openRecord fed it into path.join and crashed with ERR_INVALID_ARG_TYPE
    // ("the path argument must be of type string, received undefined").
    const openSelfMissing = await call('open', { key: childAttachment.key })
    assert.equal(openSelfMissing.ok, false, 'opening by attachment key resolves the self path')
    assert.ok(openSelfMissing.error.message.includes('.pdf'), `self path resolved instead of a path-argument crash: ${openSelfMissing.error.message}`)

    // open-url (viewer hyperlinks): only http(s) may reach the OS shell, and
    // only well-formed URLs — rejections happen before any spawn.
    const badScheme = await call('open-url', { url: 'javascript:alert(1)' })
    assert.equal(badScheme.ok, false, 'non-http(s) links are rejected')
    const malformed = await call('open-url', { url: 'not a url' })
    assert.equal(malformed.ok, false, 'malformed links are rejected')

    // Records without a file open their web address instead (double-click on a
    // DOI-only journal article): url field wins over DOI, pasted doi.org /
    // doi: prefixes are stripped, and the binary route reports
    // {code:'library/open-url', url} so the client opens the browser. The sink
    // (DSH_LIBRARY_OPEN_SINK) proves exactly what would have been opened.
    const sinkLines = () => fs.readFileSync(openSinkPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    const clearSink = () => fs.writeFileSync(openSinkPath, '')

    const doiOnly = await call('create', { itemType: 'journalArticle', fields: { title: 'doi only record', DOI: 'https://doi.org/10.2222/link-only' } })
    assert.equal(doiOnly.ok, true, JSON.stringify(doiOnly))
    clearSink()
    const openDoiOnly = await call('open', { key: doiOnly.value.key })
    assert.equal(openDoiOnly.ok, true, `doi-only record opens in the browser (${openDoiOnly.error?.message ?? ''})`)
    assert.deepEqual(sinkLines(), [{ kind: 'open', target: 'https://doi.org/10.2222/link-only' }], 'the DOI resolves through doi.org (prefix stripped)')
    const doiRoute = await routes[1].fetch(new Request(`http://localhost/api/library/file?key=${doiOnly.value.key}`, { method: 'GET' }))
    assert.equal(doiRoute.status, 404, 'the binary route has no file for a doi-only record')
    const doiRouteBody = await doiRoute.json()
    assert.equal(doiRouteBody.error?.code, 'library/open-url', 'the route reports the browser-open signal')
    assert.equal(doiRouteBody.error?.url, 'https://doi.org/10.2222/link-only', 'the route carries the web address')

    const urlFirst = await call('create', { itemType: 'journalArticle', fields: { title: 'url first', DOI: '10.2222/doi', url: 'https://example.org/landing' } })
    clearSink()
    assert.equal((await call('open', { key: urlFirst.value.key })).ok, true, 'records with a url field open the url')
    assert.deepEqual(sinkLines(), [{ kind: 'open', target: 'https://example.org/landing' }], 'the url field wins over the DOI')

    // Web-link child attachment (linkMode 3): the record has no file, so open
    // follows the link and the binary route reports it the same way.
    const webLink = await call('attachment-url', { parentKey: urlFirst.value.key, url: 'https://example.org/weblink', title: 'landing page' })
    assert.equal(webLink.ok, true, JSON.stringify(webLink))
    clearSink()
    assert.equal((await call('open', { key: urlFirst.value.key })).ok, true, 'a web-link child opens in the browser')
    assert.deepEqual(sinkLines(), [{ kind: 'open', target: 'https://example.org/weblink' }], 'the link attachment url is what opens')
    const linkRoute = await routes[1].fetch(new Request(`http://localhost/api/library/file?key=${webLink.value.key}`, { method: 'GET' }))
    assert.equal((await linkRoute.json()).error?.code, 'library/open-url', 'web-link attachments report the browser-open signal too')

    // Nothing openable at all: the old clear error, and no spawn.
    const bareItem = await call('create', { itemType: 'document', fields: { title: 'bare record' } })
    clearSink()
    const openBare = await call('open', { key: bareItem.value.key })
    assert.equal(openBare.ok, false, 'records without address and attachment still report an error')
    assert.match(openBare.error.message, /没有可打开的附件/, `clear error text (${openBare.error.message})`)
    assert.equal(sinkLines().length, 0, 'no spawn happened for the bare record')

    // 重新获取元数据 on a record with nothing to read: the lookup now runs
    // against the record's own identifiers (DOI here), and the abstract is
    // topped up from OpenAlex when Crossref ships none. fetch is stubbed so
    // the chain is deterministic offline.
    const recognizeTarget = await call('create', {
      itemType: 'journalArticle',
      fields: { title: 'stub target', DOI: '10.5555/no-abs', extra: 'user note' },
    })
    const realFetch = globalThis.fetch
    const hits = []
    const jsonResponse = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    globalThis.fetch = async (input) => {
      const url = String(input)
      hits.push(url)
      if (url.includes('api.crossref.org')) {
        return jsonResponse({ message: { DOI: '10.5555/no-abs', title: ['Crossref record without abstract'], type: 'journal-article', issued: { 'date-parts': [[2024, 5]] }, author: [{ family: 'Roe', given: 'Jane' }] } })
      }
      if (url.includes('api.openalex.org')) {
        return jsonResponse({ abstract_inverted_index: { Reconstructed: [0], abstract: [1], via: [2], OpenAlex: [3] } })
      }
      return new Response(`unexpected fetch: ${url}`, { status: 404 })
    }
    try {
      const recognizeOnline = await call('recognize-item', { key: recognizeTarget.value.key })
      assert.equal(recognizeOnline.ok, true, JSON.stringify(recognizeOnline))
      assert.equal(recognizeOnline.value.updated, true, 'attachment-less recognize fetches from the record DOI')
      const crossrefHits = hits.filter(url => url.includes('api.crossref.org')).length
      const openAlexHits = hits.filter(url => url.includes('api.openalex.org')).length
      assert.equal(crossrefHits, 1, 'exactly one Crossref call')
      assert.equal(openAlexHits, 1, 'OpenAlex is consulted exactly once for the missing abstract')
      const recognized = await call('item', { key: recognizeTarget.value.key })
      assert.equal(recognized.value.title, 'Crossref record without abstract', 'fetched title wins')
      assert.ok(recognized.value.fields.some(field => field.field === 'abstractNote' && field.value === 'Reconstructed abstract via OpenAlex'), 'the abstract is reconstructed from OpenAlex')
      assert.ok(recognized.value.fields.some(field => field.field === 'extra' && field.value === 'user note'), "the user's own fields survive")

      // Parsing helpers behind the abstract fallbacks (pure, no network).
      const { abstractFromInvertedIndex, abstractFromPubmedXml } = await import('../src/host/metadata.js')
      assert.equal(abstractFromInvertedIndex({ Hello: [0], World: [1], again: [2] }), 'Hello World again', 'inverted index rebuilds in position order')
      assert.equal(abstractFromInvertedIndex({ spaced: [0, 3], out: [1, 2] }), 'spaced out out spaced', 'gaps and repeats keep their slots')
      assert.equal(abstractFromInvertedIndex({}), '', 'an empty index yields no abstract')
      const pubmedXml = '<PubmedArticle><MedlineCitation><Article><Abstract>'
        + '<AbstractText Label="BACKGROUND">About <i>something</i>.</AbstractText>'
        + '<AbstractText>Methods were used.</AbstractText>'
        + '</Abstract></Article></MedlineCitation></PubmedArticle>'
      assert.equal(abstractFromPubmedXml(pubmedXml), 'BACKGROUND: About something. Methods were used.', 'PubMed sections keep labels, inner markup is stripped')
    } finally {
      globalThis.fetch = realFetch
    }

    // needsMetadataHelp flags a lookup that produced nothing usable.
    assert.equal(imported.value.needsMetadataHelp, true, 'lookup:false import asks for agent help')
    assert.equal(withMeta.value.needsMetadataHelp, false, 'explicit metadata does not ask for help')

    // library_read search locates text instead of reading sequentially.
    const readSearch = await toolDefs.get('library_read').execute({ key: readKey, search: 'the' })
    assert.ok(Array.isArray(readSearch.matches) && readSearch.matches.length > 0, 'search matches returned')
    assert.ok(Number.isInteger(readSearch.matches[0].offset))

    // Citation export endpoints.
    const citeJson = await call('cite-json', { keys: [withMeta.value.parentKey] })
    assert.equal(citeJson.ok, true, JSON.stringify(citeJson))
    assert.equal(citeJson.value.items.length, 1)
    assert.equal(citeJson.value.items[0].type, 'article-journal')


    // Built-in reader annotation round trip: create → list → update → delete.
    // The child PDF file itself was unlinked above; annotations are DB rows
    // and work regardless.
    const createdAnnotation = await call('annotation-create', {
      attachmentKey: childAttachment.key,
      annotation: {
        type: 1, color: '#2ea8e5', text: 'selected sentence', comment: '',
        position: { pageIndex: 0, rects: [[72, 700, 300, 712]], pageHeight: 792 }, pageLabel: '1',
      },
    })
    assert.equal(createdAnnotation.ok, true, JSON.stringify(createdAnnotation))
    const readerAnnotations = await call('annotations-list', { key: childAttachment.key })
    assert.equal(readerAnnotations.ok, true, JSON.stringify(readerAnnotations))
    assert.ok(readerAnnotations.value.annotations.some(entry => entry.key === createdAnnotation.value.key && entry.position?.pageIndex === 0), 'created annotation listed with parsed position')
    const updatedAnnotation = await call('annotation-update', { key: createdAnnotation.value.key, patch: { color: '#ff6666', comment: 'looks wrong' } })
    assert.equal(updatedAnnotation.ok, true, JSON.stringify(updatedAnnotation))
    const afterUpdate = await call('annotations-list', { key: childAttachment.key })
    const updatedEntry = afterUpdate.value.annotations.find(entry => entry.key === createdAnnotation.value.key)
    assert.equal(updatedEntry.color, '#ff6666', 'annotation color updated')
    assert.equal(updatedEntry.comment, 'looks wrong', 'annotation comment updated')
    const removedAnnotation = await call('annotation-delete', { key: createdAnnotation.value.key })
    assert.equal(removedAnnotation.ok, true, JSON.stringify(removedAnnotation))
    const afterDelete = await call('annotations-list', { key: childAttachment.key })
    assert.ok(!afterDelete.value.annotations.some(entry => entry.key === createdAnnotation.value.key), 'deleted annotation removed')

    // chat-context lets the viewer refresh the guidance without a chat-send.
    const contextSaved = await call('chat-context', { context: { mode: 'reader', itemKey: readKey, itemTitle: 'A test paper' } })
    assert.equal(contextSaved.ok, true, JSON.stringify(contextSaved))

    assert.equal(citeJson.value.items[0].title, 'dsh-zot-library imported parent')
    assert.equal(citeJson.value.items[0].DOI, '10.0000/import')
    assert.deepEqual(citeJson.value.items[0].author, [{ family: 'Data', given: 'Meta' }])
    const citeBib = await call('cite-bibtex', { keys: [withMeta.value.parentKey] })
    assert.equal(citeBib.ok, true, JSON.stringify(citeBib))
    assert.match(citeBib.value.text, /@article\{data2025,/)
    assert.ok(citeBib.value.text.includes('10.0000/import'))
    const citeTool = toolDefs.get('library_cite')
    const toolBib = await citeTool.execute({ query: 'dsh-zot-library imported parent', format: 'bibtex' })
    assert.ok(toolBib.text.includes('dsh-zot-library imported parent') || toolBib.entries >= 0)
  }
}

// Chat: session creation, prompt delivery, transcript normalization.
const opened = await call('chat-open', {})
assert.equal(opened.ok, true, JSON.stringify(opened))
assert.equal(opened.value.sessionId, 'session-1')
assert.ok(createdSessions.length >= 1)

// Dock binding: an article open in the reader keeps ONE bound conversation —
// created on first open, reused after, re-bound by 新对话 (fresh); plain list
// opens stay unbound and start new conversations.
const boundOpen = await call('chat-open', { bindKey: 'BBBBBBBB', title: 'A test paper' })
assert.equal(boundOpen.value.bound, true, 'reader open is bound to the article')
assert.equal(boundOpen.value.created, true, 'first open of an article creates its bound conversation')
const boundAgain = await call('chat-open', { bindKey: 'BBBBBBBB' })
assert.equal(boundAgain.value.created, false, 'reopening the article reuses its bound conversation')
const rebound = await call('chat-open', { bindKey: 'BBBBBBBB', fresh: true })
assert.equal(rebound.value.created, true, '新对话 rebinds the article to a new session')
// Regression: a plain open (the AI-task hand-off, no bindKey) must NEVER
// continue the reader-bound session — the list dock gets a NEW conversation,
// the bound session is left unarchived and still resolves for the article.
const plainAfterBind = await call('chat-open', {})
assert.equal(plainAfterBind.value.created, true, 'a plain open after a reader bind starts a NEW conversation')
assert.notEqual(plainAfterBind.value.sessionId, rebound.value.sessionId, 'the plain open did not land in the bound session')
assert.ok(!archivedSessions.includes(rebound.value.sessionId), 'the bound session was not archived by the list open')
const boundResumed = await call('chat-open', { bindKey: 'BBBBBBBB' })
assert.equal(boundResumed.value.sessionId, rebound.value.sessionId, 'the article still resumes its own bound conversation')
const listOpen = await call('chat-open', { fresh: true })
assert.equal(listOpen.value.bound, false, 'list-view open is unbound')
// No dock open ever archives: old conversations stay in the workspace —
// neither the list sessions nor the reader binding above are ever removed.
const listOpenAgain = await call('chat-open', { fresh: true })
assert.notEqual(listOpenAgain.value.sessionId, listOpen.value.sessionId, 'list fresh open creates a new conversation')
assert.deepEqual(archivedSessions, [], 'no conversation is archived by any dock open')
const page = await call('chat-page', { maxMessages: 50 })
assert.equal(page.ok, true)
const roles = page.value.messages.map(message => message.role)
assert.deepEqual(roles, ['user', 'assistant', 'tool'])
assert.equal(page.value.messages[2].status, 'done')
const sent = await call('chat-send', { text: '帮我总结这篇文献' })
assert.equal(sent.ok, true, JSON.stringify(sent))
assert.equal(prompts.length, 1)
assert.equal(prompts[0].content[0].text, '帮我总结这篇文献')
assert.equal(prompts[0].mode, 'queue')
// Dock sends carry NO preamble in the user message — the guidance lives in the
// session's system prompt via chatGuidance(); the dock user must not see it.
const sentWithItem = await call('chat-send', {
  text: '这篇讲了什么',
  context: { mode: 'item', itemKey: 'AAAAAAAA', itemTitle: 'A test paper' },
})
assert.equal(sentWithItem.ok, true, JSON.stringify(sentWithItem))
assert.equal(prompts.length, 2)
assert.equal(prompts[1].content[0].text, '这篇讲了什么', 'message stays clean, no preamble')
const sentWithList = await call('chat-send', { text: '找综述', context: { mode: 'list' } })
assert.equal(sentWithList.ok, true)
assert.equal(prompts[2].content[0].text, '找综述', 'list send stays clean')
// The system-prompt guidance text (chatGuidance) covers every mode.
const guidanceItem = chatGuidance({ mode: 'item', itemKey: 'AAAAAAAA', itemTitle: 'A test paper' })
assert.ok(guidanceItem.includes('《A test paper》'), 'item guidance names the paper')
assert.ok(guidanceItem.includes('不要一上来就阅读全文'), 'abstract-first guidance present')
assert.ok(!guidanceItem.includes('这篇讲了什么'), 'guidance never contains the user message')
// Regression: an item merely selected in the list must NOT claim the question
// is about that paper — the user may be asking to find one.
const guidanceSelection = chatGuidance({ mode: 'list', itemKey: 'AAAAAAAA', itemTitle: 'A test paper' })
assert.ok(guidanceSelection.includes('文库列表界面'), 'selection keeps list mode')
assert.ok(guidanceSelection.includes('不要默认问题与选中的文献相关'), 'selected item treated as weak hint')
assert.ok(guidanceSelection.includes('关键词变体'), 'retry-variant search guidance present')
const guidanceReader = chatGuidance({ mode: 'reader', itemKey: 'BBBBBBBB', itemTitle: 'A test paper' })
assert.ok(guidanceReader.includes('内置阅读器'), 'reader guidance names the reader')
assert.ok(guidanceReader.includes('library_search'), 'reader mode still allows finding other papers')
assert.equal(chatGuidance(undefined).includes('文库列表界面'), true, 'missing context falls back to neutral list guidance')
const stopped = await call('chat-stop', {})
assert.equal(stopped.ok, true)

// Settings, sync status, updates.
const settings = await call('settings-set', {
  patch: { webdav: { url: 'https://dav.example.com/me', username: 'smoke', password: 'secret' } },
})
assert.equal(settings.ok, true)
assert.equal(settings.value.webdav.hasPassword, true)
assert.equal(settings.value.webdav.password, undefined)
const syncStatus = await call('sync-status', {})
assert.equal(syncStatus.ok, true)
// 插件更新走 dsh 插件管理器：status 报当前版本与 manager=dsh；check 把
// listed/refused 译成可操作的中文；apply 透传 updateBundle 结果。
const updateStatus = await call('update-status', {})
assert.equal(updateStatus.ok, true)
assert.equal(updateStatus.value.manager, 'dsh')
assert.equal(updateStatus.value.current, version)
assert.equal(updateStatus.value.available, undefined, 'no check has run yet')
// 拒绝（npm 源上还没有这个包）：reason 翻成中文。
pluginManagerBehavior = () => ({ status: 'refused', problem: 'not-found', reason: 'registry answered 404', attempts: [{ registry: 'https://registry.npmjs.org/' }] })
const refusedCheck = await call('update-check', {})
assert.equal(refusedCheck.ok, true)
assert.equal(refusedCheck.value.available, false)
assert.ok(refusedCheck.value.reason.includes('npm 源上还没有'), `refusal is translated (${refusedCheck.value.reason})`)
// listed：有新版本（registry 字段原样带出，供界面展示安装源）。
pluginManagerBehavior = () => ({ status: 'listed', installed: version, versions: [{ version: '9.9.9', tags: [] }], registry: 'https://registry.npmmirror.com/', attempts: [], omitted: 1 })
const listedCheck = await call('update-check', {})
assert.equal(listedCheck.ok, true)
assert.equal(listedCheck.value.available, true)
assert.equal(listedCheck.value.latest, '9.9.9')
assert.equal(listedCheck.value.registry, 'https://registry.npmmirror.com/')
assert.equal(pluginManagerCalls.at(-1)[0], 'listVersions')
assert.equal(pluginManagerCalls.at(-1)[1], 'dsh-zot-library')
// apply 不带版本 = 用最近一次检查的最新版；成功透传 from/to/application。
pluginManagerBehavior = () => ({ from: version, to: '9.9.9', step: 'install', result: { changed: true, application: 'applied', stage: 'install' } })
const appliedUpdate = await call('update-apply', {})
assert.equal(appliedUpdate.ok, true, JSON.stringify(appliedUpdate))
assert.equal(appliedUpdate.value.applied, true)
assert.equal(appliedUpdate.value.to, '9.9.9')
assert.equal(appliedUpdate.value.restartRequired, false)
assert.equal(pluginManagerCalls.at(-1)[0], 'updateBundle')
assert.equal(pluginManagerCalls.at(-1)[2], '9.9.9', 'apply falls back to the last checked latest')
assert.deepEqual(pluginManagerCalls.at(-1)[3], {}, 'updateBundle gets no explicit registry (dsh owns the mirror plan)')
// 指定版本 + 无 HMR（application=restart-required）。
pluginManagerBehavior = () => ({ from: version, to: '9.9.9', step: 'install', result: { changed: true, application: 'restart-required', restartReason: 'no-hmr', stage: 'install' } })
const restartUpdate = await call('update-apply', { version: '9.9.9' })
assert.equal(restartUpdate.ok, true)
assert.equal(restartUpdate.value.restartRequired, true)
assert.equal(pluginManagerCalls.at(-1)[2], '9.9.9', 'explicit version wins')
// 失败：错误信封带中文与稳定 code。
pluginManagerBehavior = () => ({ from: version, to: '9.9.9', step: 'install', result: { changed: false, application: 'failed', stage: 'install', error: { code: 'operation-error', diagnostic: 'pnpm exploded' } } })
const failedUpdate = await call('update-apply', { version: '9.9.9' })
assert.equal(failedUpdate.ok, false)
assert.equal(failedUpdate.error.code, 'library/update-failed')
assert.ok(failedUpdate.error.message.includes('更新到 9.9.9 失败'), failedUpdate.error.message)
assert.ok(failedUpdate.error.message.includes('pnpm exploded'), 'engine diagnostic travels')
// 没有 pluginManager 服务（老 dsh）：status manager=none，check 报可操作中文。
const savedManager = mockCtx.pluginManager
delete mockCtx.pluginManager
const noManagerStatus = await call('update-status', {})
assert.equal(noManagerStatus.value.manager, 'none')
const noManagerCheck = await call('update-check', {})
assert.equal(noManagerCheck.ok, false)
assert.equal(noManagerCheck.error.code, 'library/no-plugin-manager')
assert.ok(noManagerCheck.error.message.includes('插件管理器'), noManagerCheck.error.message)
mockCtx.pluginManager = savedManager
pluginManagerBehavior = () => ({ status: 'refused', problem: 'not-found', reason: 'not found', attempts: [] })

// Standalone library: switching away from Zotero creates a fresh schema-130
// database under $DSH_HOME/library/data that the same engine can write.
const standaloneState = await call('setup', { mode: 'standalone' })
assert.equal(standaloneState.ok, true, JSON.stringify(standaloneState))
assert.equal(standaloneState.value.available, true)
assert.equal(standaloneState.value.source, 'standalone')
assert.equal(standaloneState.value.schemaVersion, 130)
assert.equal(standaloneState.value.counts.items, 0)
const standaloneItem = await call('create', {
  itemType: 'journalArticle',
  fields: { title: 'standalone smoke', date: '2026-03', DOI: '10.0000/standalone', publicationTitle: 'Standalone Journal' },
  creators: [{ firstName: 'Ai', lastName: 'Bot', creatorType: 'author' }],
  tags: ['solo'],
})
assert.equal(standaloneItem.ok, true, JSON.stringify(standaloneItem))
const standaloneList = await call('items', { query: 'standalone' })
assert.equal(standaloneList.value.items.length, 1)
assert.equal(standaloneList.value.items[0].publicationTitle, 'Standalone Journal')
assert.deepEqual(standaloneList.value.items[0].tags, ['solo'])
const standaloneCite = await call('cite-bibtex', { keys: [standaloneItem.value.key] })
assert.match(standaloneCite.value.text, /@article\{bot2026,/)
const standaloneJson = await call('cite-json', { keys: [standaloneItem.value.key] })
assert.equal(standaloneJson.value.items[0]['container-title'], 'Standalone Journal')
// Switching back to Zotero keeps working (explicit config override).
const backToZotero = await call('setup', { mode: 'zotero' })
assert.equal(backToZotero.ok, true, JSON.stringify(backToZotero))
if (hasRealLibrary) {
  assert.equal(backToZotero.value.available, true)
  assert.equal(backToZotero.value.source, 'override')
}

// CI（以及任何没有真库的机器）没有真实 zotero.sqlite：用 standalone 种子在
// 原位造一个完整的 schema-130 库 —— 断库防护、同步分派与 schema 守卫/修复
// 用例照常跑（真库机器跳过，用的本来就是临时副本）。
if (!fs.existsSync(path.join(dataDir, 'zotero.sqlite'))) {
  const { createStandaloneLibrary } = await import('../src/host/standalone.js')
  createStandaloneLibrary(dataDir, mockCtx.logger)
}

// --- Zotero 客户端同步（zotero 模式 = 唤起 + 置前，用户点同步） ---------------
// 上面的假 Zotero 客户端按阶段重编程；启动/置前都记进 sink，绝不 spawn 真
// zotero.exe、不跑 PowerShell。GET /connector/ping 回 "Zotero is running" 文本
// = 真 Zotero，JSON 且带 processorName = 自家 office 服务（必须被探测跳过）。
const launchSinkLines = () => fs.readFileSync(launchSinkPath, 'utf8').trim().split('\n').filter(line => line !== '')
const launchSinkCount = (kind) => launchSinkLines().filter(line => line.includes(`"${kind}"`)).length
// 自动重连靠宿主的 120ms 定时器（RECONNECT_MS 已调快）；轮询 ping 直到恢复。
const waitForAvailable = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const probe = await call('ping', {})
    if (probe.value.available === true) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}
const officePing = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, processorName: 'Word', active: false, styles: 0 }))
}
const zoteroPing = (req, res) => {
  // Zotero stamps every connector response with X-Zotero-Version; GET answers
  // the plain text "Zotero is running", POST returns connector prefs.
  const isGet = req.method === 'GET'
  res.writeHead(200, { 'content-type': isGet ? 'text/html' : 'application/json', 'x-zotero-version': '7.0.10-smoke' })
  if (isGet) {
    res.end('Zotero is running')
    return
  }
  res.end(JSON.stringify({ prefs: {} }))
}

// ① 混淆防护：只有 office 形状的 ping 应答 → 探测跳过；手动同步启动 Zotero
//    （sink 记 launch + focus），等待期处理器切成真 Zotero → launched。
//    断库防护：分派前宿主已释放数据库连接，Zotero 才拿得到文件锁。
fakeZoteroHandler = officePing
setTimeout(() => { fakeZoteroHandler = zoteroPing }, 300)
const launched = await call('zotero-sync-run', {})
assert.equal(launched.ok, true, JSON.stringify(launched))
assert.equal(launched.value.kind, 'launched', `office-shaped ping is skipped, launch-wait finds Zotero: ${launched.value.kind}`)
assert.equal(launched.value.version, '7.0.10-smoke', 'version comes off the X-Zotero-Version header')
assert.ok(launched.value.message.includes('同步'), 'the hand-off message tells the user what to click')
assert.equal(launchSinkCount('launch-zotero'), 1, 'exactly one launch recorded')
assert.equal(launchSinkCount('focus-zotero'), 1, 'the window focus is requested once')
const afterHandoff = await call('state', {})
assert.equal(afterHandoff.value.available, false, 'the hand-off disconnects the database for Zotero')
assert.equal(afterHandoff.value.detached?.reason, 'sync', JSON.stringify(afterHandoff.value))
assert.equal(afterHandoff.value.error?.code, 'library/db-detached')

// ② 已在运行：直接置前，不再启动（多一次 focus，无 launch）。
const focused = await call('zotero-sync-run', {})
assert.equal(focused.value.kind, 'focused', JSON.stringify(focused))
assert.equal(focused.value.port, fakeZoteroPort)
assert.equal(focused.value.version, '7.0.10-smoke')
assert.equal(launchSinkCount('launch-zotero'), 1, 'no extra launch when Zotero is already running')
assert.equal(launchSinkCount('focus-zotero'), 2, 'the running client is focused directly')

// ③ status 形状：running/port/version/last。
const syncState = await call('zotero-sync-status', {})
assert.equal(syncState.value.running, true)
assert.equal(syncState.value.port, fakeZoteroPort)
assert.equal(syncState.value.version, '7.0.10-smoke')
assert.equal(syncState.value.last.kind, 'focused')

// ④ 找不到 Zotero：启动失败 → not-installed，且不请求置前；这次断开是白断的，
//    宿主立即把连接拿回来（绕过「Zotero 启动宽限」，因为根本没有东西要启动）。
process.env.DSH_LIBRARY_ZOTERO_LAUNCH_FAIL = '1'
fakeZoteroHandler = officePing
const missing = await call('zotero-sync-run', {})
delete process.env.DSH_LIBRARY_ZOTERO_LAUNCH_FAIL
assert.equal(missing.value.kind, 'not-installed', JSON.stringify(missing))
assert.equal(launchSinkCount('launch-zotero'), 2, 'the failed launch is still recorded')
assert.equal(launchSinkCount('focus-zotero'), 2, 'no focus request without a client')
const restored = await call('state', {})
assert.equal(restored.value.available, true, 'not-installed restores the connection right away')

// ⑤ library_sync 工具在 zotero 模式下走同一条分派链。
fakeZoteroHandler = zoteroPing
const syncTool = await toolDefs.get('library_sync').execute({})
assert.equal(syncTool.kind, 'focused', JSON.stringify(syncTool))

// ⑥ 断库防护回环：同步分派后文库处于 detached —— 连接已关闭（测试进程能拿
//    到独占锁，这正是 Zotero 能启动的前提）、所有端点拒绝；Zotero「仍在运行」
//    时手动重连被探测挡住；「退出」后宿主定时器自动重连恢复。
const detachedState = await call('state', {})
assert.equal(detachedState.value.available, false)
assert.equal(detachedState.value.detached?.reason, 'sync', JSON.stringify(detachedState.value))
assert.equal(detachedState.value.error?.code, 'library/db-detached')
const deniedItems = await call('items', { limit: 5 })
assert.equal(deniedItems.ok, false)
assert.equal(deniedItems.error.code, 'library/db-detached', 'every endpoint refuses while detached')
{
  const { DatabaseSync } = await import('node:sqlite')
  const locker = new DatabaseSync(path.join(dataDir, 'zotero.sqlite'))
  locker.exec('PRAGMA busy_timeout = 800')
  locker.exec('BEGIN EXCLUSIVE')
  locker.exec('ROLLBACK')
  locker.close()
}
const blocked = await call('db-reconnect', {})
assert.equal(blocked.value.reconnected, false, JSON.stringify(blocked.value))
assert.equal(blocked.value.reason, 'zotero-running', 'the probe keeps the reconnect from racing a running Zotero')
assert.equal(blocked.value.state.available, false)
// 最后手段：结束 Zotero 进程（sink 记账，绝不真杀 / 不跑 PowerShell）。Zotero
// 「仍在运行」时查杀后的重连照样被探测挡住；等「退出」再由定时器恢复。
const killed = await call('zotero-kill', {})
assert.equal(killed.value.killed, 1, JSON.stringify(killed.value))
assert.equal(killed.value.state.available, false, 'the probe still blocks the reconnect while Zotero runs')
assert.equal(launchSinkCount('kill-zotero'), 1, 'the kill is recorded in sink mode')
const killTool = await toolDefs.get('library_zotero_kill').execute({})
assert.deepEqual(killTool, { killed: 1, available: false }, 'library_zotero_kill rides the same path')
assert.equal(launchSinkCount('kill-zotero'), 2, 'one sink line per kill')
fakeZoteroHandler = officePing
assert.ok(await waitForAvailable(), 'the host timer reconnects once Zotero exits')
const recoveredItems = await call('items', { limit: 5 })
assert.equal(recoveredItems.ok, true, JSON.stringify(recoveredItems))

// ⑦ 数据库防护（另一半）：打开文库时 Zotero 正独占数据库（Zotero 10 = WAL +
//    locking_mode EXCLUSIVE，新连接第一次读就 busy）→ 转入「Zotero 正在运行」
//    断连面板；Zotero 退出后自动恢复。测试连接要先拿到独占锁，所以先借一次
//    同步分派把我们的连接关掉。
fakeZoteroHandler = zoteroPing
const refocus = await call('zotero-sync-run', {})
assert.equal(refocus.value.kind, 'focused', JSON.stringify(refocus.value))
{
  const { DatabaseSync } = await import('node:sqlite')
  const zotero = new DatabaseSync(path.join(dataDir, 'zotero.sqlite'))
  zotero.exec('PRAGMA locking_mode = EXCLUSIVE')
  zotero.exec('CREATE TABLE IF NOT EXISTS dsh_lock_probe(x)')
  zotero.exec('INSERT INTO dsh_lock_probe VALUES (1)') // 写下第一笔，独占锁即到手并保持
  fakeZoteroHandler = officePing
  // 模拟「打开文库」：清掉 detached 状态重开 → 撞上独占锁 → busy → locked 断连。
  await call('setup', { mode: 'zotero' })
  const locked = await call('state', {})
  assert.equal(locked.value.available, false, JSON.stringify(locked.value))
  assert.equal(locked.value.detached?.reason, 'locked', `open under a running Zotero detaches: ${JSON.stringify(locked.value)}`)
  const deniedCollections = await call('collections', {})
  assert.equal(deniedCollections.error?.code, 'library/db-detached', 'endpoints refuse while Zotero holds the db')
  zotero.close() // = 用户退出 Zotero，独占锁释放
}
assert.ok(await waitForAvailable(), 'the library auto-recovers once Zotero exits')
const finalState = await call('state', {})
assert.equal(finalState.value.available, true, 'the library is usable again without restarting dsh')

// --- schema 不匹配 → 更新/一键修复 --------------------------------------------
// 临时副本的 userdata schema 手工抬到 999：guard 报 schema-too-new（带版本号），
// 一键修复自检核心表/列通过后以兼容模式接受（settings 持久化，重启仍生效）。
// CI 用的种子库已在同步段之前原位创建（见上）。
{
  const { DatabaseSync } = await import('node:sqlite')
  const bumpSchema = new DatabaseSync(path.join(dataDir, 'zotero.sqlite'))
  bumpSchema.exec('PRAGMA busy_timeout = 4000')
  bumpSchema.exec("UPDATE version SET version = 999 WHERE schema = 'userdata'")
  bumpSchema.close()
}
await call('setup', { mode: 'zotero' }) // 关闭缓存连接，让 guard 重新读到新版本号
const broken = await call('state', {})
assert.equal(broken.ok, true)
assert.equal(broken.value.available, false)
assert.equal(broken.value.error.code, 'library/schema-too-new', `got ${broken.value.error.code}: ${broken.value.error.message}`)
assert.equal(broken.value.error.schemaVersion, 999, 'the error carries the actual schema version')
assert.equal(broken.value.error.supported, 131, 'the error carries the supported ceiling')
const repaired = await call('schema-repair', {})
assert.equal(repaired.ok, true, JSON.stringify(repaired))
assert.equal(repaired.value.available, true, `repair accepts the additive schema: ${JSON.stringify(repaired.value.error ?? {})}`)
const afterRepair = await call('state', {})
assert.equal(afterRepair.value.available, true, 'the accepted schema keeps the library usable')

// 自检不过（tags.name 被改名 = 结构性变化）→ 明确拒绝，绝不带病工作。
{
  const { DatabaseSync } = await import('node:sqlite')
  const breakColumn = new DatabaseSync(path.join(dataDir, 'zotero.sqlite'))
  breakColumn.exec('PRAGMA busy_timeout = 4000')
  breakColumn.exec('ALTER TABLE tags RENAME COLUMN name TO name2')
  breakColumn.close()
}
await call('setup', { mode: 'zotero' })
const refused = await call('schema-repair', {})
assert.equal(refused.ok, false, JSON.stringify(refused))
assert.equal(refused.error.code, 'library/schema-incompatible')
assert.ok(refused.error.message.includes('tags'), 'the refusal names the offending table')
// 列恢复后修复再次成功（acceptedSchema 已在 settings 里）。
{
  const { DatabaseSync } = await import('node:sqlite')
  const fixColumn = new DatabaseSync(path.join(dataDir, 'zotero.sqlite'))
  fixColumn.exec('PRAGMA busy_timeout = 4000')
  fixColumn.exec('ALTER TABLE tags RENAME COLUMN name2 TO name')
  fixColumn.close()
}
await call('setup', { mode: 'zotero' })
const recovered = await call('schema-repair', {})
assert.equal(recovered.ok, true, JSON.stringify(recovered))
assert.equal(recovered.value.available, true)

// --- reader translation ------------------------------------------------------
const translateModels = await call('translate-models', {})
assert.equal(translateModels.ok, true, JSON.stringify(translateModels))
assert.equal(translateModels.value.current.provider, 'deepseek')
assert.ok(translateModels.value.models.some(model => model.id === 'deepseek/deepseek-chat'), 'configured models listed for the settings dropdown')

const translateCall = async (payload) => routes[2].fetch(new Request('http://localhost/api/library/translate', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
}))
const empty = await translateCall({ text: '   ' })
assert.equal(empty.status, 400, 'empty selections are rejected pre-flight')
assert.equal((await empty.json()).error.code, 'library/invalid')

const streamed = await translateCall({ text: 'The sample text.' })
assert.equal(streamed.status, 200)
assert.match(streamed.headers.get('content-type') ?? '', /x-ndjson/)
const events = []
{
  const reader = streamed.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line !== '') events.push(JSON.parse(line))
    }
  }
}
assert.deepEqual(events.map(event => event.type), ['thinking', 'answer', 'answer', 'done'], 'thinking → answer → done event order')
assert.equal(events[2].text, '译文。', 'deltas stream through verbatim')
// Thinking defaults off → the 'off' effort is selected against the model's
// declared capabilities, and the route follows dsh's current model.
assert.equal(llmCalls.length, 1)
assert.equal(llmCalls[0].provider, 'deepseek')
assert.equal(llmCalls[0].model, 'deepseek-chat')
assert.equal(llmCalls[0].reasoningEffort, 'off')

// Every effect must expose a disposer; disposing must not throw.
for (const dispose of disposers.reverse()) dispose()

// The fake Zotero client shuts down with the rest (fetch keep-alive sockets
// would otherwise hold the process open).
fakeZotero.closeAllConnections?.()
await new Promise(resolve => fakeZotero.close(() => resolve()))

safeRemoveTree(tempRoot)
console.log('host-smoke: OK')
