// Host-half smoke test: mounts the plugin against a temporary copy of a real
// zotero.sqlite and drives the API channel, tools, import pipeline and chat.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { safeRemoveTree } from '../src/host/util.js'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-library-smoke-'))
process.env.DSH_HOME = path.join(tempRoot, 'dsh-home')
const dataDir = path.join(process.env.DSH_HOME, 'library', 'zotero-data')
const storageDir = path.join(dataDir, 'storage')
fs.mkdirSync(storageDir, { recursive: true })

const realDb = path.join(process.env.USERPROFILE ?? os.homedir(), 'Zotero', 'zotero.sqlite')
const hasRealLibrary = fs.existsSync(realDb)
if (hasRealLibrary) fs.copyFileSync(realDb, path.join(dataDir, 'zotero.sqlite'))

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
    async create({ workspaceId }) { createdSessions.push(workspaceId); return { sessionId: 'session-smoke' } },
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
    async archiveSession() {},
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
  'library_add', 'library_annotations', 'library_attach', 'library_cite', 'library_collection',
  'library_collections', 'library_import', 'library_item', 'library_lookup', 'library_open',
  'library_read', 'library_search', 'library_status', 'library_sync', 'library_trash', 'library_update',
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

  // A running Zotero holds the rollback-journal lock: state must explain the
  // lock with its own error code (the UI auto-recovers on poll) and the
  // library must come back by itself once the lock is released.
  {
    const { DatabaseSync } = await import('node:sqlite')
    const locker = new DatabaseSync(path.join(dataDir, 'zotero.sqlite'))
    locker.exec('BEGIN EXCLUSIVE')
    try {
      const locked = await call('state', {})
      assert.equal(locked.ok, true)
      assert.equal(locked.value.available, false, 'locked library reports unavailable')
      assert.equal(locked.value.error.code, 'library/db-locked', `locked code (got ${locked.value.error.code}: ${locked.value.error.message})`)
      const ping = await call('ping', {})
      assert.equal(ping.value.available, false, 'ping reports availability')
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
    fields: { title: 'dsh-library smoke item', date: '2026', DOI: '10.0000/smoke', pages: '1-10' },
    creators: [{ firstName: 'San', lastName: 'Zhang', creatorType: 'author' }],
    tags: ['smoke'],
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  const key = created.value.key
  const createdDetail = await call('item', { key })
  assert.equal(createdDetail.value.title, 'dsh-library smoke item')
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
  assert.ok(bookDetail.value.fields.some(field => field.field === 'title' && field.value === 'dsh-library smoke item'), 'title survived the type change')
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
        fields: { title: 'dsh-library imported parent', date: '2025', DOI: '10.0000/import' },
        creators: [{ firstName: 'Meta', lastName: 'Data', creatorType: 'author' }],
        tags: ['imported'],
      },
    })
    assert.equal(withMeta.ok, true, JSON.stringify(withMeta))
    assert.ok(withMeta.value.parentKey, 'parent item created from metadata')
    const parentDetail = await call('item', { key: withMeta.value.parentKey })
    assert.equal(parentDetail.value.title, 'dsh-library imported parent')
    assert.equal(parentDetail.value.attachments.length, 1)

    // List rows carry their children so the item tree can expand a parent into
    // attachments/notes (Zotero's tree expansion).
    const expandedList = await call('items', { query: 'dsh-library imported parent' })
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
        fields: { title: 'dsh-library staged parent', date: '2024' },
        creators: [{ lastName: 'Stage', firstName: 'Two', creatorType: 'author' }],
      },
    })
    assert.equal(finished.ok, true, JSON.stringify(finished))
    assert.ok(finished.value.parentKey === withMeta.value.parentKey ? false : Boolean(finished.value.parentKey), 'finalize reports the new parent key')
    const stagedParent = await call('item', { key: finished.value.parentKey })
    assert.equal(stagedParent.value.title, 'dsh-library staged parent')
    assert.ok(stagedParent.value.attachments.some(entry => entry.key === staged.value.attachmentKey), 'finalize reparents the staged attachment')

    // Staged import without metadata stays standalone and asks for help.
    const stagedPlain = await call('import', { path: samplePdf, deferMetadata: true })
    const finishedPlain = await call('import-finalize', { attachmentKey: stagedPlain.value.attachmentKey, lookup: false })
    assert.equal(finishedPlain.ok, true, JSON.stringify(finishedPlain))
    assert.equal(finishedPlain.value.parentKey, null, 'no metadata keeps the attachment standalone')
    assert.equal(finishedPlain.value.needsMetadataHelp, true, 'the browser gets the AI-fix hint')

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
    assert.equal(duplicateDetail.value.title, 'dsh-library imported parent', 'duplicate copies the fields')
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

    // needsMetadataHelp flags a lookup that produced nothing usable.
    assert.equal(imported.value.needsMetadataHelp, true, 'lookup:false import asks for agent help')
    assert.equal(withMeta.value.needsMetadataHelp, false, 'explicit metadata does not ask for help')

    // library_read search locates text instead of reading sequentially.
    const readSearch = await toolDefs.get('library_read').execute({ key: readKey, search: 'the' })
    assert.ok(Array.isArray(readSearch.matches) && readSearch.matches.length > 0, 'search matches returned')
    assert.ok(Number.isInteger(readSearch.matches[0].offset))

    // Citation export endpoints (also the future Office add-in interface).
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

    assert.equal(citeJson.value.items[0].title, 'dsh-library imported parent')
    assert.equal(citeJson.value.items[0].DOI, '10.0000/import')
    assert.deepEqual(citeJson.value.items[0].author, [{ family: 'Data', given: 'Meta' }])
    const citeBib = await call('cite-bibtex', { keys: [withMeta.value.parentKey] })
    assert.equal(citeBib.ok, true, JSON.stringify(citeBib))
    assert.match(citeBib.value.text, /@article\{data2025,/)
    assert.ok(citeBib.value.text.includes('10.0000/import'))
    const citeTool = toolDefs.get('library_cite')
    const toolBib = await citeTool.execute({ query: 'dsh-library imported parent', format: 'bibtex' })
    assert.ok(toolBib.text.includes('dsh-library imported parent') || toolBib.entries >= 0)
  }
}

// Chat: session creation, prompt delivery, transcript normalization.
const opened = await call('chat-open', {})
assert.equal(opened.ok, true, JSON.stringify(opened))
assert.equal(opened.value.sessionId, 'session-smoke')
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
const listOpen = await call('chat-open', { fresh: true })
assert.equal(listOpen.value.bound, false, 'list-view open is unbound')
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
const updateStatus = await call('update-status', {})
assert.equal(updateStatus.ok, true)
assert.equal(updateStatus.value.feed, false)

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

safeRemoveTree(tempRoot)
console.log('host-smoke: OK')
