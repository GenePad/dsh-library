// Microsoft Word citation-integration smoke test.
//
// Starts the rewritten integration service against a temporary standalone
// library and drives it with a fake Word client that speaks the real Zotero
// HTTP integration protocol (execCommand -> respond loop -> Document.complete).
// Dialog pages are answered through the same API the browser pages use.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DSH_LIBRARY_OFFICE_NO_BROWSER = '1'
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-office-smoke-'))
const home = path.join(tempRoot, 'home')
const dataDir = path.join(tempRoot, 'zotero-data')
fs.mkdirSync(home, { recursive: true })

const { createStandaloneLibrary } = await import('../src/host/standalone.js')
const { ZoteroDb } = await import('../src/host/db.js')
const { createItem, createCollection, updateItem } = await import('../src/host/write.js')
const { createStyleStore } = await import('../src/host/office/csl-styles.js')
const { createItemProvider } = await import('../src/host/office/items.js')
const { createDialogManager } = await import('../src/host/office/dialogs.js')
const { createIntegration } = await import('../src/host/office/commands.js')
const { createOfficeServer } = await import('../src/host/office/server.js')
const { DocumentData } = await import('../src/host/office/document-data.js')
const { plainText } = await import('../src/host/office/csl-citeproc.js')
const { safeRemoveTree } = await import('../src/host/util.js')

const quiet = { info() {}, warn() {}, error() {} }
const logger = process.env.DSH_OFFICE_DEBUG
  ? { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.log('[warn]', ...a), error: (...a) => console.log('[error]', ...a) }
  : quiet
const built = createStandaloneLibrary(dataDir, logger)
const db = new ZoteroDb({ dbPath: built.dbPath, logger })
db.open()
const created = [
  createItem(db, { itemType: 'journalArticle', fields: { title: 'Citation Integration One', date: '2021', publicationTitle: 'Journal of Tests', DOI: '10.1000/one' }, creators: [{ firstName: 'Lei', lastName: 'Wang', creatorType: 'author' }] }),
  createItem(db, { itemType: 'journalArticle', fields: { title: 'Citation Integration Two', date: '2022', publicationTitle: 'Journal of Tests', DOI: '10.1000/two' }, creators: [{ firstName: 'Lei', lastName: 'Wang', creatorType: 'author' }] }),
  createItem(db, { itemType: 'journalArticle', fields: { title: 'Citation Integration Three', date: '2023', publicationTitle: 'Journal of Tests', DOI: '10.1000/three' }, creators: [{ firstName: 'Lei', lastName: 'Wang', creatorType: 'author' }] }),
]
const keys = created.map(row => row.key)
// Parent collection: 1 direct item + 1 item in its child. The tree badge must
// report the same number as the result list (2), not a raw sum of child counts.
const folder = createCollection(db, { name: '测试分类' })
const subfolder = createCollection(db, { name: '测试子分类', parentID: folder.collectionID })
updateItem(db, keys[0], { addCollections: [folder.collectionID] })
updateItem(db, keys[1], { addCollections: [subfolder.collectionID] })
// keys[2] stays unfiled.

const styles = createStyleStore({ logger, packageDir, home })
const items = createItemProvider({ withDb: fn => fn(db) })
const dialogs = createDialogManager({ styles, items, logger })
// Word AI tasks with a chat double: the dispatcher records what a task would
// send into a fresh 文献助手 conversation (no dsh ctx exists in the smoke).
const aiChatLog = []
let aiFocusCount = 0
const ai = (await import('../src/host/office/ai-tasks.js')).createAiTasks({
  chat: {
    open: async options => { aiChatLog.push({ kind: 'open', options }); return { sessionId: 'sess-word-task' } },
    send: async (text, context) => { aiChatLog.push({ kind: 'send', text, context }); return { sessionId: 'sess-word-task' } },
  },
  focus: () => { aiFocusCount += 1 },
  logger: quiet,
})
const integration = createIntegration({ styles, items, dialogs, ai, logger, version: '0.2.1' })
const server = createOfficeServer({ integration, dialogs, styles, ai, logger, version: '0.2.1' })
dialogs.setBaseUrl(() => server.baseUrl())
const started = await server.start(0)
assert.equal(started.running, true, 'integration server starts')
const base = server.baseUrl()

async function get(pathname) {
  // Node can drop an idle keep-alive socket between two polling requests
  // (ECONNRESET); retry GETs so the suite is not flaky near the end.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(base + pathname)
      assert.ok(response.ok, `GET ${pathname} -> ${response.status}`)
      return response.json()
    } catch (error) {
      if (attempt >= 2) throw error
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  }
}
async function post(pathname, body) {
  return fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-zotero-connector-api-version': '3' },
    body: JSON.stringify(body === undefined ? {} : body),
  })
}

/* ------------------------------------------------------------ fake Word --- */
class FakeWord {
  constructor() {
    this.fields = []
    this.docData = ''
    this.cursorFieldId = null
    this.alerts = []
    this.nextId = 1
    this.textWrites = []
    // AI write-back model: the body is one plain string, the captured
    // selection is {start, end, text} (what DshLibFields' live Range would
    // report), and citation fields appear as ‹F#› markers in the body.
    this.body = ''
    this.aiSel = null
    this.aiWorking = -1
  }

  aiSelect(text) {
    const start = this.body.indexOf(text)
    assert.ok(start >= 0, `aiSelect: selection not found in body: ${text.slice(0, 40)}`)
    this.aiSel = { start, end: start + text.length, text }
    return this.aiSel
  }

  fieldJSON(field) {
    return {
      id: field.id, code: field.code, text: field.text,
      noteIndex: field.noteIndex || 0, adjacent: false,
    }
  }

  getField(id) {
    return this.fields.find(field => field.id === String(id))
  }

  dispatch(command, args) {
    const a = args ?? []
    const docId = a[0]
    if (process.env.DSH_OFFICE_DEBUG === '2') {
      console.log('[word]', command, JSON.stringify(a.slice(1)).slice(0, 140))
    } else if (process.env.DSH_OFFICE_DEBUG && /^Field\.(delete|removeCode|setCode|setText)|^Document\.(insertField|setDocumentData)/.test(command)) {
      console.log('[word]', command, JSON.stringify(a.slice(1)).slice(0, 140))
    }
    switch (command) {
      case 'Application.getActiveDocument':
        return {
          documentID: docId, outputFormat: 'rtf', supportedNotes: ['footnotes', 'endnotes'],
          supportsImportExport: true, supportsTextInsertion: true,
          supportsCitationMerging: true, processorName: 'Word',
        }
      case 'Document.getDocumentData': return this.docData
      case 'Document.setDocumentData': this.docData = String(a[1] ?? ''); return null
      case 'Document.canInsertField': return true
      case 'Document.displayAlert': this.alerts.push(String(a[1] ?? '')); return 0
      case 'Document.activate': return null
      case 'Document.cleanup': return null
      case 'Document.complete': return null
      case 'Document.setBibliographyStyle': return null
      case 'Document.insertText': return null
      case 'Document.convert': return null
      case 'Document.convertPlaceholdersToFields': return []
      case 'Document.importDocument': return this.docData
      case 'Document.exportDocument': return null
      case 'Document.cursorInField': {
        const field = this.getField(this.cursorFieldId)
        return field ? this.fieldJSON(field) : null
      }
      case 'Document.insertField': {
        const field = {
          id: `F${this.nextId++}`, code: 'TEMP', text: '{Citation}',
          noteIndex: Number(a[2]) || 0,
        }
        this.fields.push(field)
        // Word leaves the caret immediately AFTER the freshly inserted field,
        // not inside it (Zotero's C++ insertField moves the selection too).
        this.cursorFieldId = null
        return this.fieldJSON(field)
      }
      case 'Document.getFields': return this.fields.map(field => this.fieldJSON(field))
      case 'Field.getCode': return this.getField(a[1])?.code ?? ''
      case 'Field.setCode': { const f = this.getField(a[1]); if (f) f.code = String(a[2] ?? ''); return null }
      case 'Field.getText': return this.getField(a[1])?.text ?? ''
      case 'Field.setText': {
        const f = this.getField(a[1])
        const payload = String(a[2] ?? '')
        this.textWrites.push({ payload, isRich: a[3] })
        // Word stores the field result as plain text even when it was written as RTF.
        if (f) f.text = a[3] ? plainText(payload) : payload
        return null
      }
      case 'Field.getNoteIndex': return this.getField(a[1])?.noteIndex ?? 0
      case 'Field.select': return null
      case 'Field.equals': return String(a[1]) === String(a[2])
      case 'Field.isAdjacentToNextField': return false
      case 'Field.delete': {
        const index = this.fields.findIndex(f => f.id === String(a[1]))
        if (index >= 0) this.fields.splice(index, 1)
        return null
      }
      case 'Field.removeCode': {
        const index = this.fields.findIndex(f => f.id === String(a[1]))
        if (index >= 0) this.fields.splice(index, 1) // unlink: the field becomes plain text
        return null
      }
      // ---- AI write-back commands (mirror of DshLibFields' CmdAi*) ----
      case 'Document.aiBegin': {
        const mode = String(a[1] ?? 'replace')
        const expected = String(a[2] ?? '')
        if (!this.aiSel) return { ok: false, error: 'aiBegin: no captured selection' }
        const norm = value => String(value).replace(/\s+/g, '')
        if (expected !== '' && norm(this.aiSel.text) !== norm(expected)) {
          return { ok: false, error: '选区内容已变化，写回已取消' }
        }
        const info = { ok: true, original: this.aiSel.text }
        if (mode === 'insert') {
          this.aiWorking = -1
        } else {
          this.body = this.body.slice(0, this.aiSel.start) + this.body.slice(this.aiSel.end)
          this.aiWorking = this.aiSel.start
        }
        return info
      }
      case 'Document.aiText': {
        const text = String(a[1] ?? '')
        this.body = this.body.slice(0, this.aiWorking) + text + this.body.slice(this.aiWorking)
        this.aiWorking += text.length
        return null
      }
      case 'Document.aiField': {
        const marker = this.insertMarkerAt(this.aiWorking)
        return this.fieldJSON(this.fields.find(field => marker.includes(field.id)))
      }
      case 'Document.aiFieldAt': {
        const pos = this.aiSel.start + (Number(a[1]) || 0)
        const marker = this.insertMarkerAt(pos)
        return this.fieldJSON(this.fields.find(field => marker.includes(field.id)))
      }
      case 'Document.aiEnd': {
        this.aiWorking = -1
        return null
      }
      default:
        throw new Error(`FakeWord: unhandled command ${command}`)
    }
  }

  insertMarkerAt(pos) {
    const field = { id: `F${this.nextId++}`, code: 'TEMP', text: '{Citation}', noteIndex: 0 }
    this.fields.push(field)
    const marker = `‹${field.id}›`
    this.body = this.body.slice(0, pos) + marker + this.body.slice(pos)
    return marker
  }

  async transact(command, docId = 'C:/docs/test.docx', extra = {}) {
    const first = await post('/connector/document/execCommand', { command, docId, ...extra })
    assert.equal(first.status, 200, `execCommand ${command} -> ${first.status}`)
    let reply = await first.json()
    let steps = 0
    while (reply.command !== 'Document.complete') {
      steps += 1
      assert.ok(steps < 500, `transaction ${command} did not terminate`)
      let result
      try {
        result = this.dispatch(reply.command, reply.arguments)
      } catch (error) {
        const failed = await post('/connector/document/respond', { error: 'Alert', message: error.message })
        reply = await failed.json()
        continue
      }
      const response = await post('/connector/document/respond', result)
      assert.equal(response.status, 200, `respond after ${reply.command} -> ${response.status}`)
      reply = await response.json()
    }
    return steps
  }
}

/* ---------------------------------------------------- dialog answering --- */
async function waitForDialog(type, timeout = 8000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    const { dialogs: list } = await get('/office/api/pending-dialogs')
    const found = list.find(entry => entry.type === type)
    if (found) return found
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(`dialog ${type} never appeared; pending=${JSON.stringify((await get('/office/api/pending-dialogs')).dialogs)}`)
}

async function answerDialog(type, value) {
  const dialog = await waitForDialog(type)
  const response = await post('/office/api/dialog-result', { id: dialog.id, value })
  const body = await response.json()
  assert.equal(body.ok, true, `answer ${type}`)
  return dialog
}

function citationValue(ids, extra = {}) {
  return {
    citation: {
      citationID: extra.citationID,
      properties: { noteIndex: 0 },
      citationItems: ids.map((id, index) => ({
        id, itemData: items.cslItem(id), uris: items.uriFor(id),
        ...(index === 0 && extra.locator ? { locator: extra.locator, label: 'page' } : {}),
        ...(index === 0 && extra.prefix ? { prefix: extra.prefix } : {}),
        ...(index === 0 && extra.suffix ? { suffix: extra.suffix } : {}),
      })),
    },
    unsorted: false,
    ...extra,
  }
}

/* --------------------------------------------------------------- tests --- */
const word = new FakeWord()
const ping = await get('/connector/ping')
assert.equal(ping.ok, true, 'connector ping')

// 1. First command on a new document asks for document preferences.
{
  const running = word.transact('setDocPrefs')
  const dialog = await waitForDialog('docPrefs')
  assert.equal(dialog.type, 'docPrefs')
  const state = await get('/office/api/state?id=' + dialog.id)
  assert.equal(state.io.primaryFieldType, 'Field', 'docPrefs exposes field types')
  const styleList = await get('/office/api/styles')
  assert.ok(styleList.styles.length >= 10, 'seed CSL styles are installed')
  await post('/office/api/dialog-result', {
    id: dialog.id,
    value: {
      style: 'http://www.zotero.org/styles/apa', locale: 'zh-CN',
      fieldType: 'Field', useEndnotes: 0, automaticJournalAbbreviations: false,
      delayCitationUpdates: false, dontAskDelayCitationUpdates: false,
    },
  })
  await running
  const data = new DocumentData(word.docData)
  assert.equal(data.style.styleID, 'http://www.zotero.org/styles/apa', 'doc prefs persist the style')
  assert.equal(data.prefs.fieldType, 'Field', 'doc prefs persist the field type')
  assert.equal(word.fields.length, 0, 'the document preferences command creates no fields')
}

// 2. Insert a citation (dialog + citeproc rendering).
{
  word.cursorFieldId = null
  const running = word.transact('addEditCitation')
  const dialog = await waitForDialog('citation')
  const state = await get('/office/api/state?id=' + dialog.id)
  assert.equal(state.type, 'citation')
  assert.ok(Array.isArray(state.io.citedItems), 'citation dialog receives cited items')
  const search = await get('/office/api/search?id=' + dialog.id + '&q=Citation&mode=citation')
  assert.ok(search.groups.some(group => group.items.length), 'citation search finds library items')
  const preview = await post('/office/api/preview?id=' + dialog.id, {
    citation: citationValue(keys).citation,
  })
  const previewBody = await preview.json()
  assert.ok(previewBody.html.includes('Wang') || previewBody.html.includes('2021'), 'live preview renders')
  await post('/office/api/dialog-result', {
    id: dialog.id, value: citationValue([keys[0], keys[1]], { locator: '10-15' }),
  })
  await running
  if (process.env.DSH_OFFICE_DEBUG) console.log('FIELDS AFTER INSERT', JSON.stringify(word.fields, null, 2), 'ALERTS', word.alerts)
  const citationFields = word.fields.filter(field => field.code.startsWith('ITEM CSL_CITATION'))
  assert.equal(citationFields.length, 1, 'one citation field was written')
  const code = JSON.parse(citationFields[0].code.slice('ITEM CSL_CITATION '.length))
  assert.equal(code.citationItems.length, 2, 'citation field holds both items')
  assert.equal(code.citationItems[0].locator, '10-15', 'locator is stored in the field code')
  assert.ok(code.citationItems[0].itemData?.title, 'CSL itemData is embedded for portability')
  assert.ok(citationFields[0].text.includes('Wang') || citationFields[0].text.includes('2021'),
    'citeproc rendered the citation text')

  // RTF regression: citeproc emits bare fragments ("(Wang ... 2021)"), while
  // Word's InsertFile only parses a file starting with "{\rtf" as RTF. The
  // VBA responder also reads isRich through ArgNum()/Val(), where a JSON
  // boolean "true" becomes 0 and the raw markup is written as plain text.
  const rtfWrites = word.textWrites.filter(write => write.payload.includes('\\'))
  assert.ok(rtfWrites.length > 0, 'citation was written through the rich-text path')
  assert.ok(rtfWrites.every(write => write.isRich === 1),
    'isRich is a number (1), never a JSON boolean the VBA Val() would drop')
  assert.ok(rtfWrites.every(write => write.payload.startsWith('{\\rtf ') && write.payload.endsWith('}')),
    'every RTF fragment was wrapped into a complete {\\rtf ...} document')
  assert.ok(!/\\uc\d|\\u-?\d+\{|\\rtf|\\i\{\}/.test(citationFields[0].text),
    'Word shows the rendered citation, not literal RTF control words')
  assert.ok(!word.alerts.some(text => text.includes('手工修改')),
    'inserting a citation does not claim the text was manually edited')
}

// 3. Insert a second citation, then edit it in place.
{
  word.cursorFieldId = null
  const running = word.transact('addCitation')
  const dialog = await waitForDialog('citation')
  await post('/office/api/dialog-result', { id: dialog.id, value: citationValue([keys[1]]) })
  await running
  assert.equal(word.fields.filter(f => f.code.startsWith('ITEM CSL_CITATION')).length, 2,
    'second citation inserted')

  const target = word.fields.filter(f => f.code.startsWith('ITEM CSL_CITATION'))[0]
  word.cursorFieldId = target.id
  const editing = word.transact('editCitation')
  const editDialog = await waitForDialog('citation')
  const state = await get('/office/api/state?id=' + editDialog.id)
  assert.equal(state.io.citation.citationItems.length, 2, 'editing loads the existing citation')
  assert.equal(state.io.disableDialogTypeSwitch, true, 'editing hides the dialog-type switch')
  await post('/office/api/dialog-result', {
    id: editDialog.id, value: citationValue([keys[0]], { prefix: '参见 ', suffix: '（综述）' }),
  })
  await editing
  const edited = JSON.parse(word.fields.find(f => f.id === target.id).code.slice('ITEM CSL_CITATION '.length))
  assert.equal(edited.citationItems.length, 1, 'edited citation replaced its items')
  assert.equal(edited.citationItems[0].prefix, '参见 ', 'prefix stored')
  // Auto refresh: the edited cluster's rendered text is rewritten in the same
  // transaction; the user must not have to press 刷新 after every edit.
  const editedText = word.fields.find(f => f.id === target.id).text
  assert.ok(editedText.includes('参见'), 'edited citation text is regenerated immediately')
  assert.ok(!word.alerts.some(text => text.includes('手工修改')),
    'editing a citation does not claim the text was manually edited')
}

// 4. Refresh: no new dialogs, citation text recomputed, no extra fields.
{
  word.cursorFieldId = null
  const before = word.fields.length
  await word.transact('refresh')
  assert.equal(word.fields.length, before, 'refresh does not add fields')
  assert.equal(word.alerts.length, 0, 'refresh does not prompt')
}

// 4b. Docs produced by the buggy build contain literal RTF markup. A refresh
// must repair them silently instead of asking whether the user edited them.
{
  const target = word.fields.find(field => field.code.startsWith('ITEM CSL_CITATION'))
  const beforeAlerts = word.alerts.length
  const code = JSON.parse(target.code.slice('ITEM CSL_CITATION '.length))
  const damaged = '{\\rtf (B\\uc0\\u252{}ning and Srivastava 2019)}'
  target.text = damaged
  code.properties = { ...(code.properties ?? {}), plainCitation: damaged, dontUpdate: false }
  target.code = 'ITEM CSL_CITATION ' + JSON.stringify(code)
  await word.transact('refresh')
  assert.ok(!word.alerts.slice(beforeAlerts).some(text => text.includes('手工修改')),
    'leftover RTF markup is repaired without a manual-edit prompt')
  const fixed = word.fields.find(field => field.id === target.id)
  assert.ok(fixed.text.length > 0, 'the repaired citation is not blank')
  assert.ok(!/\{\\rtf|\\uc\d|\\u-?\d+\{|\\i\{\}/.test(fixed.text),
    'the repaired citation contains no RTF control words')
}

// 5. Bibliography insertion (the ribbon's insert-only button), then explicit
// editing through the dedicated editBibliography command.
{
  const beforeAlerts = word.alerts.length
  await word.transact('addBibliography')
  const bib = word.fields.find(field => field.code.startsWith('BIBL '))
  assert.ok(bib, 'bibliography field created')
  assert.ok(bib.text.includes('Wang') || bib.text.includes('2021'), 'bibliography text rendered')
  assert.ok(!/\{\\rtf|\\uc\d|\\i\{\}/.test(bib.text),
    'the bibliography is rendered text, not a literal {\\rtf ...} string')
  assert.ok(!word.alerts.slice(beforeAlerts).some(text => text.includes('手工修改')),
    'inserting a bibliography does not claim a citation was manually edited')

  const running = word.transact('editBibliography')
  const dialog = await waitForDialog('bibliography')
  const state = await get('/office/api/state?id=' + dialog.id)
  assert.ok(state.io.entries.length >= 1, 'bibliography editor receives entries')
  await post('/office/api/dialog-result', {
    id: dialog.id,
    value: { customText: { [keys[0]]: '自定义参考文献文本' }, uncited: [], omitted: [] },
  })
  await running
  assert.ok(word.fields.find(field => field.code.startsWith('BIBL ')).text.includes('自定义参考文献文本'),
    'custom bibliography entry applied')
}

// 6. Style change through document preferences (force text regeneration).
{
  const running = word.transact('setDocPrefs')
  const dialog = await waitForDialog('docPrefs')
  await post('/office/api/dialog-result', {
    id: dialog.id,
    value: {
      style: 'http://www.zotero.org/styles/ieee', locale: 'en-US',
      fieldType: 'Field', useEndnotes: 0, automaticJournalAbbreviations: false,
      delayCitationUpdates: false, dontAskDelayCitationUpdates: false,
    },
  })
  await running
  const data = new DocumentData(word.docData)
  assert.equal(data.style.styleID, 'http://www.zotero.org/styles/ieee', 'style change persisted')
  assert.ok(/\[\d+\]/.test(word.fields.find(f => f.code.startsWith('ITEM CSL_CITATION')).text),
    'IEEE numeric citation regenerated')
}

// 7. Cancelling an insertion deletes the new field.
{
  word.cursorFieldId = null
  const before = word.fields.length
  const running = word.transact('addCitation')
  const dialog = await waitForDialog('citation')
  await post('/office/api/dialog-result', { id: dialog.id, cancel: true })
  await running
  assert.equal(word.fields.length, before, 'cancelled insertion leaves no new field')
}

// 7b. The remaining commands: explorer, notes, annotations, export.
{
  const exploring = word.transact('citationExplorer')
  const dialog = await waitForDialog('explorer')
  const state = await get('/office/api/state?id=' + dialog.id)
  assert.ok(Array.isArray(state.io.citations), 'explorer receives the document citations')
  await post('/office/api/dialog-result', { id: dialog.id, value: {} })
  await exploring

  const noting = word.transact('addNote')
  const noteDialog = await waitForDialog('citation')
  assert.equal((await get('/office/api/state?id=' + noteDialog.id)).io.isCitingNotes, true,
    'addNote switches the dialog into note mode')
  await post('/office/api/dialog-result', { id: noteDialog.id, value: citationValue([keys[0]]) })
  await noting

  const annotating = word.transact('addAnnotation')
  const annotationDialog = await waitForDialog('citation')
  assert.equal((await get('/office/api/state?id=' + annotationDialog.id)).io.isAddingAnnotations, true,
    'addAnnotation switches the dialog into annotation mode')
  await post('/office/api/dialog-result', { id: annotationDialog.id, value: citationValue([keys[1]]) })
  await annotating

  const beforeBibs = word.fields.filter(field => field.code.startsWith('BIBL ')).length
  const beforeAlerts = word.alerts.length
  await word.transact('addBibliography')
  assert.equal(word.fields.filter(field => field.code.startsWith('BIBL ')).length, beforeBibs,
    'addBibliography refuses to insert a second bibliography')
  assert.ok(word.alerts.slice(beforeAlerts).some(text => text.includes('已有参考文献表')),
    'addBibliography explains that the document already has a bibliography')

  const before = word.alerts.length
  await word.transact('exportDocument')
  assert.ok(word.alerts.slice(before).some(text => text.includes('转换为可在其他文字处理软件')),
    'exportDocument asks for confirmation')
}

// 8. removeCodes unlinks every field (after the confirmation alert).
{
  const before = word.fields.length
  await word.transact('removeCodes')
  assert.ok(word.alerts.some(text => text.includes('移除域代码')), 'removeCodes asks for confirmation')
  assert.equal(word.fields.length, 0, `all ${before} fields unlinked`)
}

// 9. Document data v3/v4 round-trip and legacy field-code normalisation.
{
  const v3 = new DocumentData('', '0.2.1')
  v3.sessionID = 'ABCDEFGH'
  v3.style = { styleID: 'http://www.zotero.org/styles/apa', locale: 'zh-CN', hasBibliography: true, bibliographyStyleHasBeenSet: true }
  v3.prefs = { fieldType: 'Field', noteType: 0, automaticJournalAbbreviations: true }
  const roundTrip = new DocumentData(v3.serialize(), '0.2.1')
  assert.equal(roundTrip.style.styleID, v3.style.styleID)
  assert.equal(roundTrip.prefs.automaticJournalAbbreviations, true)
  const v4 = new DocumentData(JSON.stringify({
    style: { styleID: 'http://www.zotero.org/styles/apa', locale: 'en-US', hasBibliography: true, bibliographyStyleHasBeenSet: true },
    prefs: { fieldType: 'ReferenceMark', noteType: 0 },
    sessionID: 'owl-sesh', zoteroVersion: '7.0', dataVersion: 4,
  }), '0.2.1')
  assert.equal(v4.dataVersion, 4, 'v4 JSON document data accepted')
  assert.equal(v4.prefs.fieldType, 'ReferenceMark')
  assert.match(v4.serialize(), /"dataVersion":4/, 'v4 round-trips as JSON')
  const legacy = new DocumentData('SESS:style:note:1:1:0', '0.2.1')
  assert.equal(legacy.dataVersion, 1, 'legacy colon document data parsed')
}

// 10. A second execCommand while one is in progress must be refused.
{
  const slow = word.transact('addCitation')
  await waitForDialog('citation')
  const conflict = await post('/connector/document/execCommand', { command: 'refresh', docId: 'C:/docs/test.docx' })
  assert.equal(conflict.status, 503, 'concurrent transaction returns 503')
  const dialog = (await get('/office/api/pending-dialogs')).dialogs[0]
  await post('/office/api/dialog-result', { id: dialog.id, cancel: true })
  await slow
}

// 11. Unknown commands are rejected without hanging the HTTP protocol.
{
  await word.transact('notARealCommand')
  assert.ok(word.alerts.some(text => text.includes('未知的集成命令')), 'unknown command shows an alert')
}

// 11b. The .dotm packaging: customUI must be a package-level relationship,
// and the installer must REJECT a template that has no VBA project (the exact
// failure that made the Ribbon tab invisible after a "successful" install).
{
  const { zipSync, unzipSync } = await import('../vendor/deps.js')
  const { injectCustomUI, inspectTemplate } = await import('../src/host/office/installer.js')
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const CUSTOMUI = '<customUI xmlns="http://schemas.microsoft.com/office/2006/01/customui"><ribbon><tabs><tab id="DshLibraryTab" label="文库引用"/></tabs></ribbon></customUI>'
  const VBA_REL = 'http://schemas.microsoft.com/office/2006/relationships/vbaProject'
  const CUI_REL = 'http://schemas.microsoft.com/office/2006/relationships/ui/extensibility'

  const shell = {
    '[Content_Types].xml': enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.template.macroEnabledTemplate.main+xml"/></Types>'),
    '_rels/.rels': enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': enc.encode('<w:document/>'),
    'word/_rels/document.xml.rels': enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'),
  }
  const emptyShell = path.join(tempRoot, 'empty-shell.dotm')
  const validTemplate = path.join(tempRoot, 'valid.dotm')
  fs.writeFileSync(emptyShell, zipSync(shell))
  injectCustomUI(emptyShell, CUSTOMUI)
  const parts = unzipSync(new Uint8Array(fs.readFileSync(emptyShell)))
  const rootRels = dec.decode(parts['_rels/.rels'])
  assert.ok(parts['customUI/customUI.xml'], 'customUI part injected')
  assert.ok(rootRels.includes(CUI_REL), 'package-level customUI relationship added')
  assert.ok(rootRels.includes('Target="customUI/customUI.xml"'), 'relationship target has no ../ prefix')
  assert.ok(!dec.decode(parts['word/_rels/document.xml.rels']).includes('ui/extensibility'),
    'document rels must NOT carry the customUI relationship')

  const broken = inspectTemplate(emptyShell)
  assert.equal(broken.ok, false, 'a template without vbaProject.bin is rejected')
  assert.ok(broken.problems.some(problem => problem.includes('VBA 工程')), 'diagnosis names the missing VBA project')

  // A template with a real VBA project (module names are UTF-16LE CFB entries).
  const names = Buffer.concat(['DshLibJson', 'DshLibCore', 'DshLibFields', 'DshLibRibbon']
    .map(name => Buffer.from(name, 'utf16le')))
  const vba = Buffer.alloc(30_000)
  names.copy(vba, 512)
  const complete = {
    ...shell,
    '[Content_Types].xml': enc.encode(dec.decode(shell['[Content_Types].xml'])
      .replace('</Types>', '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>')),
    '_rels/.rels': enc.encode(rootRels.replace('</Relationships>',
      `<Relationship Id="rId9" Type="${CUI_REL}" Target="customUI/customUI.xml"/></Relationships>`)),
    'word/_rels/document.xml.rels': enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + `<Relationship Id="rId1" Type="${VBA_REL}" Target="vbaProject.bin"/></Relationships>`),
    'word/vbaProject.bin': new Uint8Array(vba),
    'word/vbaData.xml': enc.encode('<wne:vbaSuppData/>'),
    'customUI/customUI.xml': enc.encode(CUSTOMUI),
  }
  fs.writeFileSync(validTemplate, zipSync(complete))
  const good = inspectTemplate(validTemplate)
  assert.equal(good.ok, true, `a complete template passes: ${good.problems.join('; ')}`)
  assert.equal(good.modules.length, 4, 'all four VBA modules detected')

  // The plugin MUST ship a prebuilt, Word-ready template (Zotero's model).
  // Installing then degenerates to a file copy: no COM, no AccessVBOM, no
  // dependency on Word being installed at install time.
  const shipped = path.join(packageDir, 'assets', 'word', 'DshLibrary.dotm')
  assert.ok(fs.existsSync(shipped), 'assets/word/DshLibrary.dotm ships with the plugin')
  const shippedReport = inspectTemplate(shipped)
  assert.equal(shippedReport.ok, true,
    `shipped template is a valid .dotm: ${shippedReport.problems.join('; ')}`)
  assert.equal(shippedReport.modules.length, 4, 'shipped template carries all four VBA modules')

  // Ribbon: Chinese command buttons, one "?" help button beside each, and
  // custom icons resolved through customUI/_rels/customUI.xml.rels.
  const shippedUI = fs.readFileSync(path.join(packageDir, 'assets', 'word', 'customUI.xml'), 'utf8')
  const tags = [...shippedUI.matchAll(/<button\b[^>]*\/>/g)].map(match => match[0])
  const commands = tags.filter(tag => /id="Dsh(?!Help)/.test(tag))
  const helps = tags.filter(tag => /id="DshHelp/.test(tag))
  assert.equal(commands.length, 9, 'Ribbon exposes nine command buttons (7 citation + 2 AI)')
  assert.equal(helps.length, 9, 'every command has a neighbouring "?" help button')
  assert.ok(!/id="Dsh(AddNote|AddAnnotation|HelpNote|HelpAnnotation)"/.test(shippedUI),
    'the misleading 插入笔记 / 插入注释 buttons are gone')
  assert.ok(!/笔记|注释/.test(shippedUI), 'Ribbon no longer advertises notes or annotations')
  const labels = commands.map(tag => /\blabel="([^"]+)"/.exec(tag)?.[1] ?? '')
  assert.ok(labels.every(label => /[\u4e00-\u9fff]/.test(label)),
    `every command button label is Chinese: ${labels.join(', ')}`)
  assert.ok(commands.every(tag => /image="dsh[A-Za-z]+"/.test(tag)
    && /screentip="[^"]+"/.test(tag) && /supertip="[^"]+"/.test(tag)),
    'every command button has an icon and hover help')
  assert.ok(/onLoad="DshLibRibbon\.DshLibRibbonOnLoad"/.test(shippedUI),
    'customUI captures the IRibbonUI handle for state invalidation')
  // Insert vs edit bibliography are separate buttons; insert greys out through
  // a local getEnabled probe once the document carries a bibliography.
  const bibButton = tags.find(tag => tag.includes('id="DshAddBibliography"'))
  assert.ok(bibButton?.includes('label="插入参考文献表"'),
    'bibliography button is labelled 插入参考文献表')
  assert.ok(bibButton?.includes('getEnabled="DshLibRibbon.DshLibRibbonGetInsertBibEnabled"'),
    'insert bibliography disables itself while a bibliography exists')
  assert.ok(tags.some(tag => tag.includes('id="DshEditBibliography"') && tag.includes('label="编辑参考文献表"')),
    'edit bibliography is its own button')
  assert.ok(!shippedUI.includes('添加/编辑参考文献'),
    'the old 添加/编辑参考文献 wording is gone from the Ribbon')
  assert.ok(tags.some(tag => tag.includes('id="DshCitationExplorer"') && tag.includes('label="查看引注"')),
    'the explorer button reads 查看引注')
  assert.ok(!shippedUI.includes('文档引注'),
    'the old 文档引注 wording is gone from the Ribbon')
  // The two AI buttons: enabled only while text is selected, and the edit one
  // carries the explicit （仅文本修改） qualifier.
  const aiCite = tags.find(tag => tag.includes('id="DshAiCitation"'))
  const aiEdit = tags.find(tag => tag.includes('id="DshAiEdit"'))
  assert.ok(aiCite?.includes('label="自动检索引文"'), 'the auto-citation button is labelled 自动检索引文')
  assert.ok(aiEdit?.includes('label="AI修改（仅文本修改）"'), 'the AI edit button carries 仅文本修改 in its label')
  for (const tag of [aiCite, aiEdit]) {
    assert.ok(tag.includes('getEnabled="DshLibRibbon.DshLibRibbonGetAiEnabled"'),
      'AI buttons gate on a live selection through getEnabled')
    assert.ok(/onAction="DshLibRibbon\.DshLibRibbon/.test(tag), 'AI buttons route to the DshLib callbacks')
  }
  assert.ok(!/Zotero/.test(shippedUI), 'help texts never mention Zotero')
  // Each small command and its "?" travel inside one horizontal box so Word
  // cannot wrap the pair onto different rows.
  assert.equal([...shippedUI.matchAll(/<box\b[^>]*boxStyle="horizontal"/g)].length, 4,
    'the four small commands are paired with their "?" in horizontal boxes')
  assert.ok(helps.every(tag => /image="dshHelp"/.test(tag)
    && /screentip="[^"]+"/.test(tag) && /supertip="[^"]+"/.test(tag)
    && /tag="[^"]+"/.test(tag)
    && /onAction="DshLibRibbon\.DshLibRibbonHelp"/.test(tag)),
    'help buttons carry their explanation in Tag and point at the VBA callback')

  const { ribbonImageIds } = await import('../src/host/office/installer.js')
  const iconIds = ribbonImageIds(shippedUI)
  assert.equal(iconIds.length, 10, 'ten distinct Ribbon icons are referenced')
  const iconsDir = path.join(packageDir, 'assets', 'word', 'icons')
  for (const id of iconIds) {
    assert.ok(fs.existsSync(path.join(iconsDir, `${id}.png`)), `icon ${id}.png ships with the plugin`)
  }
  const packed = unzipSync(new Uint8Array(fs.readFileSync(shipped)))
  assert.equal(dec.decode(packed['customUI/customUI.xml']).trim(), shippedUI.trim(),
    'prebuilt .dotm carries the current Chinese Ribbon XML')
  assert.equal(Object.keys(packed).filter(name => name.startsWith('customUI/images/')).length, 10,
    'all icon parts are packed into the template')
  assert.equal(shippedReport.images.length, 10, 'template self-check resolves every icon')
  assert.ok(dec.decode(packed['customUI/_rels/customUI.xml.rels']).includes('relationships/image'),
    'customUI image relationships are present')
  assert.ok(/Extension="png"/.test(dec.decode(packed['[Content_Types].xml'])),
    'png content type is declared')

  // injectCustomUI must rebuild the image relationships from the icon folder.
  const iconProbe = path.join(tempRoot, 'icon-probe.dotm')
  fs.writeFileSync(iconProbe, zipSync(shell))
  injectCustomUI(iconProbe,
    '<customUI><button id="DshProbe" image="dshHelp" label="?"/></customUI>', iconsDir)
  const iconParts = unzipSync(new Uint8Array(fs.readFileSync(iconProbe)))
  assert.ok(iconParts['customUI/images/dshHelp.png'], 'injectCustomUI packs the icon part')
  assert.ok(dec.decode(iconParts['customUI/_rels/customUI.xml.rels']).includes('Id="dshHelp"'),
    'injectCustomUI creates the image relationship')

  const { renderDialogPage } = await import('../src/host/office/pages.js')
  assert.ok(!/<b>B<\/b>|<i>I<\/i>|<u>U<\/u>/.test(renderDialogPage()),
    'bibliography formatting buttons are Chinese too')
}

// 11c. Standalone chromeless dialog window + page marker/syntax.
{
  const { findBrowser, buildWindowSpec, windowSize, dialogMarker, buildRaiseScript,
    raiseDialogWindow, seedDialogProfile } = await import('../src/host/office/window.js')
  const { renderDialogPage } = await import('../src/host/office/pages.js')
  const browser = findBrowser()
  assert.equal(browser === null || typeof browser === 'string', true, 'browser lookup is safe')
  const spec = buildWindowSpec({
    browser: browser || 'msedge.exe', url: 'http://127.0.0.1:23119/office/dialog/ABC12345',
    id: 'ABC12345', type: 'citation', profileDir: path.join(tempRoot, 'profile'),
  })
  assert.ok(spec.args.some(arg => arg.startsWith('--app=') && arg.includes('compact=1')),
    'app window URL enables compact layout')
  assert.ok(spec.args.includes('--window-size=720,560'), 'citation window is small')
  assert.ok(spec.args.some(arg => arg.startsWith('--user-data-dir=')), 'isolated browser profile')
  // Edge otherwise greets a fresh profile with "正在你的所有设备上同步你的浏览数据",
  // which users mistake for our plugin syncing their data.
  assert.ok(spec.args.includes('--no-first-run') && spec.args.includes('--bwsi')
    && spec.args.includes('--disable-sync') && spec.args.includes('--disable-first-run-experience'),
    'Edge first-run / implicit sign-in / sync are disabled')
  assert.ok(spec.args.some(arg => arg.startsWith('--disable-features=')
    && arg.includes('ImplicitSignIn') && arg.includes('msEdgeWelcomePage')),
  'Edge welcome/sign-in features are explicitly turned off')
  // Born under a maximised Word, the app window used to stay blank white
  // until a manual click: occlusion tracking pauses the renderer's
  // compositor and an external SetWindowPos raise does not clear that mark.
  assert.ok(spec.args.includes('--disable-backgrounding-occluded-windows')
    && spec.args.includes('--disable-renderer-backgrounding')
    && spec.args.includes('--disable-background-timer-throttling'),
    'renderer is never backgrounded/throttled (blank-until-click regression)')
  assert.ok(spec.args.some(arg => arg.startsWith('--disable-features=')
    && arg.includes('CalculateNativeWinOcclusion')),
  'native occlusion tracking is disabled so the external raise re-paints')
  const seededProfile = path.join(tempRoot, 'seeded-profile')
  seedDialogProfile(seededProfile)
  assert.ok(fs.existsSync(path.join(seededProfile, 'First Run')), 'profile carries the First Run sentinel')
  const seededPrefs = JSON.parse(fs.readFileSync(path.join(seededProfile, 'Default', 'Preferences'), 'utf8'))
  assert.equal(seededPrefs.signin.allowed, false, 'seeded profile opts out of sign-in')
  assert.equal(seededPrefs.sync.requested, false, 'seeded profile opts out of sync')
  assert.deepEqual(windowSize('docPrefs'), [700, 620])
  assert.equal(dialogMarker('ABC12345'), ' #ABC1', 'window title marker is short')
  // A maximised Word window used to hide the dialog completely: it must be
  // put into HWND_TOPMOST (and foreground) as soon as it appears.
  assert.equal(typeof raiseDialogWindow, 'function', 'dialog window can be raised')
  const raise = buildRaiseScript(dialogMarker('ABC12345'))
  assert.ok(raise.includes('new IntPtr(-1)') && raise.includes('SetWindowPos'),
    'raise script pins the window with HWND_TOPMOST')
  assert.ok(raise.includes('SetForegroundWindow') && raise.includes('BringWindowToTop')
    && raise.includes('AttachThreadInput') && raise.includes('SwitchToThisWindow'),
    'raise script also forces the dialog into the foreground')
  // Deterministic paint kicker: real-machine testing showed the raised dialog
  // can stay viewport-white (occlusion-paused renderer) until a real input
  // event; the script must deliver one on the caption bar after raising.
  assert.ok(raise.includes('Nudge') && raise.includes('mouse_event')
    && raise.includes('GetSystemMetrics'),
    'raise script ends with a caption-bar input nudge that repaints a white dialog')
  assert.ok(raise.includes('#ABC1') && raise.includes('Thread.Sleep') && raise.includes('for (int j'),
    'raise script finds the exact dialog, waits for its title and re-applies topmost')

  const html = renderDialogPage()
  assert.ok(html.includes('✓ 已选中') && !html.includes('✓ 已添加'),
    'citation results say 已选中, never 已添加')
  assert.ok(html.includes('本文中引用 ') && !html.includes('文档已引用 '),
    'citation count says 本文中引用, never 文档已引用')
  assert.ok(html.includes("api('raise')") && html.includes("classList.contains('compact')"),
    'the real --app page asks the host to raise its window once loaded')
  const scriptStart = html.indexOf('<script>') + 8
  const scriptEnd = html.lastIndexOf('</script>')
  assert.doesNotThrow(() => new Function(html.slice(scriptStart, scriptEnd)),
    'dialog page inline JS parses')
  assert.ok(html.includes('body.compact header'), 'compact stylesheet present')
  assert.ok(html.includes("document.title = S.title + ' #' + ID.slice(0, 4)"),
    'page title carries the marker the host closes by')
  assert.ok(html.includes("navigator.sendBeacon('/office/api/result?id="),
    'closing the window cancels the pending transaction')
}

// 12. The real browser dialog page: search -> bubble -> locator -> accept.
{
  const { JSDOM } = await import('jsdom')
  const { renderDialogPage } = await import('../src/host/office/pages.js')
  const pending = dialogs.open({
    type: 'citation',
    io: {
      citation: { citationItems: [], properties: {} },
      citedItems: [], sortable: true, isCitingNotes: false, isAddingAnnotations: false,
      disableDialogTypeSwitch: false,
      style: { styleID: 'http://www.zotero.org/styles/apa', class: 'in-text', locale: 'en-US' },
    },
    title: '添加/编辑引注',
  })
  const dialog = await waitForDialog('citation')
  const dom = new JSDOM(renderDialogPage(), {
    url: `${base}/office/dialog/${dialog.id}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (url, options) => fetch(new URL(String(url), base), options)
      window.close = () => {}
    },
  })
  const { document } = dom.window
  const tick = ms => new Promise(resolve => setTimeout(resolve, ms))
  await tick(250)
  const input = document.querySelector('#searchInput')
  assert.ok(input, 'citation dialog renders the bubble/search input')
  input.value = 'Citation'
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await tick(600)
  const rows = [...document.querySelectorAll('.result')]
  assert.ok(rows.length >= 2, `dialog search lists library items (${rows.length})`)
  rows[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await tick(250)
  assert.equal(document.querySelectorAll('.bubble').length, 1, 'clicking a result adds a bubble')
  // The Zotero "just added a bubble, type a page number" shortcut.
  input.value = '10-15'
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await tick(700)
  assert.ok(document.querySelector('.bubble').textContent.includes('10-15'), 'numeric locator attaches to the bubble')
  await tick(350)
  document.querySelector('#acceptBtn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  const answer = await pending
  assert.equal(answer.cancelled, false, 'dialog accepted')
  assert.equal(answer.citation.citationItems.length, 1, 'one citation item returned')
  assert.equal(answer.citation.citationItems[0].locator, '10-15', 'locator round-tripped through the page')
  dom.window.close()
}

// 13. 文献列表 (search only) vs 文献库 (collection tree) + 已选中 highlight.
{
  const pending = dialogs.open({
    type: 'citation',
    io: {
      citation: { citationItems: [], properties: {} },
      citedItems: [], sortable: true, isCitingNotes: false, isAddingAnnotations: false,
      disableDialogTypeSwitch: false,
      style: { styleID: 'http://www.zotero.org/styles/apa', class: 'in-text', locale: 'en-US' },
    },
    title: '文献列表 / 文献库',
  })
  const dialog = await waitForDialog('citation')
  const q = suffix => get(`/office/api/search?id=${dialog.id}${suffix}`)
  const raised = await get(`/office/api/raise?id=${dialog.id}`)
  assert.equal(raised.ok, true, 'the dialog can ask the host to raise/topmost its window')

  const tree = await get(`/office/api/collections?id=${dialog.id}`)
  const rootFolder = tree.collections.find(entry => entry.name === '测试分类')
  assert.ok(rootFolder, 'collections API returns the library collection tree')
  assert.ok(tree.unfiled >= 1, 'unfiled item count is reported')
  // The badge must be the DISTINCT count of this collection + descendants,
  // computed from the same rows the result list returns.
  assert.equal(rootFolder.itemCount, 2, 'parent badge counts direct + child items (deduplicated)')
  assert.equal(rootFolder.children[0]?.name, '测试子分类', 'child collection is in the tree')
  assert.equal(rootFolder.children[0]?.itemCount, 1, 'child badge counts its own item')

  const empty = await q('&q=&layout=list')
  assert.equal(empty.groups.length, 0, '文献列表 without a query is empty, not a duplicate of 文献库')
  assert.ok(empty.hint.includes('文献库'), 'empty 文献列表 points the user at 文献库')

  const searched = await q('&q=Citation&layout=list')
  assert.ok(searched.groups.length >= 1 && searched.groups.every(group => group.key === 'search'),
    '文献列表 contains only search matches')
  assert.ok(searched.groups[0].items.length >= 3, 'search returns all fixture items')

  const all = await q('&layout=library&collection=all')
  assert.ok(all.groups.length >= 1 && all.groups.every(group => group.key === 'collection'),
    '文献库 returns a collection group')
  assert.ok(all.groups[0].items.length >= 3, '全部文献 lists the library items')

  const inFolder = await q(`&layout=library&collection=${folder.collectionID}`)
  assert.equal(inFolder.groups[0].items.length, rootFolder.itemCount,
    'choosing a collection shows exactly as many items as its badge')
  assert.ok(inFolder.groups[0].items.some(entry => entry.id === keys[0]), 'direct item is listed')
  assert.ok(inFolder.groups[0].items.some(entry => entry.id === keys[1]), 'subcollection item is listed')
  assert.ok(inFolder.groups[0].label.includes('测试分类'), 'the group is labelled with the collection name')
  assert.ok(inFolder.groups[0].label.includes('（2 条）'), 'group label repeats the displayed count')

  const inSubfolder = await q(`&layout=library&collection=${subfolder.collectionID}`)
  assert.equal(inSubfolder.groups[0].items.length, rootFolder.children[0].itemCount,
    'child collection count matches its own list')

  const unfiled = await q('&layout=library&collection=unfiled')
  assert.ok(unfiled.groups[0].items.some(entry => entry.id === keys[2]), '未分类 lists unfiled items')

  // Real dialog page: 文献库 is the default tab; typing jumps to 文献列表.
  const { JSDOM } = await import('jsdom')
  const { renderDialogPage } = await import('../src/host/office/pages.js')
  const dom = new JSDOM(renderDialogPage(), {
    url: `${base}/office/dialog/${dialog.id}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (url, options) => fetch(new URL(String(url), base), options)
      window.close = () => {}
    },
  })
  const tick = ms => new Promise(resolve => setTimeout(resolve, ms))
  await tick(500)
  const doc = dom.window.document
  assert.ok(!doc.querySelector('#typeSwitch'), '笔记/注释 type switch is gone from the dialog')
  const libraryButton = doc.querySelector('#modeSwitch button[data-mode="library"]')
  const listButton = doc.querySelector('#modeSwitch button[data-mode="list"]')
  assert.ok(libraryButton?.classList.contains('active'), '文献库 is the default tab')
  assert.ok(!doc.querySelector('#collections').classList.contains('hidden'),
    '分类列表 is visible on open')
  assert.ok(doc.querySelectorAll('#collections .collection').length >= 4,
    '文献库 shows 分类列表 incl. the child collection')

  const search = doc.querySelector('#searchInput')
  search.value = 'Citation'
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await tick(700)
  assert.ok(listButton.classList.contains('active'), 'typing a query switches to 文献列表')
  assert.ok(doc.querySelector('#collections').classList.contains('hidden'), '分类列表 hides in 文献列表')
  assert.equal(search.value, 'Citation', 'the typed query is preserved')
  assert.ok(doc.querySelector('#results .group-title')?.textContent.includes('搜索结果'),
    '文献列表 shows the search results')

  libraryButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await tick(600)
  assert.ok(libraryButton.classList.contains('active'), '文献库 tab can be selected again')
  const rows = [...doc.querySelectorAll('#results .result')]
  assert.ok(rows.length >= 1, '文献库 lists the items of the selected category')
  rows[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await tick(600)
  assert.equal(doc.querySelectorAll('.bubble').length, 1, 'clicking a library item adds it to the citation')
  assert.ok(doc.querySelector('#results .result.chosen'), 'a selected item is specially highlighted')
  const chosenBadge = doc.querySelector('#results .result.chosen .badge.chosen')
  assert.ok(chosenBadge?.textContent.includes('已选中'), 'the highlight says 已选中, not 已添加')
  assert.ok(!/已添加/.test(doc.querySelector('#results').textContent),
    'the citation results never use the misleading 已添加 wording')
  assert.ok(!doc.body.textContent.includes('文档已引用'), 'citation count says 本文中引用, not 文档已引用')
  dom.window.close()
  await post('/office/api/dialog-result', { id: dialog.id, cancel: true })
  await pending
}

// 14. Word AI tasks: Word button → fresh assistant conversation → agent plan
//     → applyAiEdit write-back. Covers the multi-Word isolation (pid+docId),
//     the [[N]] marker model, insert-at-snippet mode, the auto refresh, and
//     every refusal path.
{
  const poll = (taskId, pid, docId) =>
    post('/office/api/ai-poll', { taskId, pid, docId }).then(response => response.json())
  const docA = 'C:/docs/paper-a.docx'
  const pidA = 4242
  const selectionA = 'CRISPR-Cas9 has revolutionized genome editing across biology.'
  const startA = await post('/office/api/ai-start', {
    kind: 'cite', docId: docA, pid: pidA, hwnd: 111, docName: 'paper-a.docx', text: selectionA,
  })
  assert.equal(startA.status, 200, `ai-start -> ${startA.status}`)
  const startBody = await startA.json()
  assert.equal(startBody.ok, true, `ai-start ok: ${startBody.error}`)
  const taskA = startBody.taskId
  assert.ok(/^AI[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{10}$/.test(taskA), 'taskId shape')
  assert.equal(startBody.sessionId, 'sess-word-task', 'the task reports its conversation')
  assert.equal(aiFocusCount, 1, 'starting a task focuses the dsh window')
  const opened = aiChatLog.find(entry => entry.kind === 'open')
  assert.equal(opened.options.fresh, true, 'every task opens a FRESH conversation')
  assert.equal(opened.options.title, 'Word 自动引文')
  const sent = aiChatLog.find(entry => entry.kind === 'send')
  assert.ok(sent.text.includes(taskA), 'the brief carries the taskId')
  assert.ok(sent.text.includes(selectionA), 'the brief carries the selected text')
  assert.ok(sent.text.includes('library_word_apply'), 'the brief teaches the write-back tool')
  assert.equal(sent.context?.mode, 'word', 'the conversation is flagged as a Word task context')

  // 14b. Poll states and plan validation. A rejected plan never consumes the
  // task, so a model that misformats once can simply retry.
  assert.equal((await poll(taskA, pidA, docA)).status, 'pending')
  assert.equal((await poll(taskA, 9999, docA)).status, 'mismatch', 'another pid cannot even poll the task')
  await assert.rejects(
    async () => ai.submit(taskA, { mode: 'replace', text: 'no markers here', citations: [{ id: 1, keys: [keys[0]] }] }),
    /占位标记/, 'replace without markers is refused')
  await assert.rejects(
    async () => ai.submit(taskA, { mode: 'replace', text: 'x [[1]]', citations: [{ id: 1, keys: ['NOTAKEY1'] }] }),
    /8 位/, 'invalid keys are refused')
  await assert.rejects(
    async () => ai.submit(taskA, { mode: 'insert', citations: [{ keys: [keys[0]], after: 'zzz-not-in-selection' }] }),
    /after 片段/, 'an unknown anchor snippet is refused')
  assert.equal((await poll(taskA, pidA, docA)).status, 'pending', 'rejected plans leave the task pending')

  // 14c. Full replace round trip on a SECOND document instance.
  const word2 = new FakeWord()
  word2.body = `Before. ${selectionA} After.`
  word2.aiSelect(selectionA)
  const prefs0 = word2.transact('setDocPrefs', docA)
  const prefsDialog = await waitForDialog('docPrefs')
  await post('/office/api/dialog-result', {
    id: prefsDialog.id,
    value: {
      style: 'http://www.zotero.org/styles/apa', locale: 'zh-CN', fieldType: 'Field',
      useEndnotes: 0, automaticJournalAbbreviations: false, delayCitationUpdates: false,
      dontAskDelayCitationUpdates: false,
    },
  })
  await prefs0
  word2.alerts.length = 0
  const fieldsBefore = word2.fields.length

  const applyA = ai.submit(taskA, {
    mode: 'replace',
    text: 'CRISPR-Cas9 has transformed genome editing[[1]], and base editing extends its reach[[2]].',
    citations: [
      { id: 1, keys: [keys[0]] },
      { id: 2, keys: [keys[1], keys[2]], locator: '5' },
    ],
  })
  assert.equal((await poll(taskA, pidA, docA)).status, 'ready')
  await word2.transact('applyAiEdit', docA, { taskId: taskA, pid: pidA })
  const appliedA = await applyA
  assert.equal(appliedA.ok, true, `applyA ok: ${appliedA.error}`)
  assert.equal(appliedA.inserted, 2)
  assert.ok(word2.body.startsWith('Before. CRISPR-Cas9 has transformed genome editing'),
    'the selection was replaced with the new text')
  assert.ok(word2.body.endsWith(' After.'), 'text outside the selection is untouched')
  assert.ok(!/\[\[\d\]\]/.test(word2.body), 'all [[N]] markers were consumed')
  const aiFields = word2.fields.slice(fieldsBefore).filter(field => field.code.startsWith('ITEM CSL_CITATION'))
  assert.equal(aiFields.length, 2, 'two citation fields were written')
  const cluster = JSON.parse(aiFields[1].code.slice('ITEM CSL_CITATION '.length))
  assert.deepEqual(cluster.citationItems.map(item => item.id), [keys[1], keys[2]], 'multi-item cluster order')
  assert.equal(cluster.citationItems[0].locator, '5', 'locator stored in the field code')
  assert.ok(aiFields.every(field => field.text !== '{Citation}' && /\d{4}/.test(field.text)),
    'the inline refresh re-rendered the AI citations')
  assert.equal((await poll(taskA, pidA, docA)).status, 'applied')
  await assert.rejects(
    async () => ai.submit(taskA, { mode: 'insert', citations: [{ keys: [keys[0]], after: 'genome editing' }] }),
    /写回一次|状态是/, 'a task can only be applied once')

  // 14d. AI 修改 (edit kind): the brief waits for the user, insert mode keeps
  // the original text and drops the citation right after the snippet.
  const selectionB = 'Base editing enables precise single-base changes in living cells.'
  const startB = await post('/office/api/ai-start', {
    kind: 'edit', docId: docA, pid: pidA, hwnd: 111, docName: 'paper-a.docx', text: selectionB,
  })
  const taskB = (await startB.json()).taskId
  const sentB = [...aiChatLog].reverse().find(entry => entry.kind === 'send')
  assert.ok(sentB.text.includes('仅文本修改'), 'the edit brief is marked text-only')
  assert.ok(sentB.text.includes('第一步'), 'the edit brief makes the agent wait for the user requirement')
  word2.body = `Intro. ${selectionB} Outro.`
  word2.aiSelect(selectionB)
  const bodyBefore = word2.body
  const applyB = ai.submit(taskB, {
    mode: 'insert',
    citations: [{ keys: [keys[0]], after: 'precise single-base changes' }],
  })
  await word2.transact('applyAiEdit', docA, { taskId: taskB, pid: pidA })
  const appliedB = await applyB
  assert.equal(appliedB.ok, true, `applyB ok: ${appliedB.error}`)
  assert.equal(appliedB.inserted, 1)
  assert.ok(word2.body.replace(/‹F\d+›/g, '') === bodyBefore,
    'insert mode keeps the original text verbatim (formatting-safe)')
  const anchor = word2.body.indexOf('precise single-base changes') + 'precise single-base changes'.length
  assert.ok(/^‹F\d+›/.test(word2.body.slice(anchor)), 'the citation landed right after the anchor snippet')

  // 14e. Multi-Word isolation: another Word PROCESS cannot claim the task.
  const selectionC = 'Prime editing further expands the editing scope.'
  const startC = await post('/office/api/ai-start', {
    kind: 'cite', docId: docA, pid: pidA, hwnd: 111, docName: 'paper-a.docx', text: selectionC,
  })
  const taskC = (await startC.json()).taskId
  word2.body = `Prefix ${selectionC} suffix`
  word2.aiSelect(selectionC)
  const applyC = ai.submit(taskC, {
    mode: 'replace',
    text: 'Prime editing expands scope[[1]].',
    citations: [{ id: 1, keys: [keys[0]] }],
  })
  await word2.transact('applyAiEdit', docA, { taskId: taskC, pid: 7777 })
  const failedC = await applyC
  assert.equal(failedC.ok, false, 'a foreign pid cannot apply the task')
  assert.ok(word2.alerts.some(text => text.includes('不匹配')), 'the refusal is surfaced in Word')

  // 14f. The document was edited after the task started: aiBegin refuses
  // without mutating anything.
  const selectionD = 'This passage will be edited while the agent works.'
  const startD = await post('/office/api/ai-start', {
    kind: 'cite', docId: docA, pid: pidA, hwnd: 111, docName: 'paper-a.docx', text: selectionD,
  })
  const taskD = (await startD.json()).taskId
  word2.body = `xx ${selectionD} yy`
  word2.aiSelect(selectionD)
  word2.aiSel.text = `${selectionD} (typed over)`   // the live Range now differs
  const applyD = ai.submit(taskD, {
    mode: 'replace',
    text: 'Rewritten passage[[1]].',
    citations: [{ id: 1, keys: [keys[0]] }],
  })
  await word2.transact('applyAiEdit', docA, { taskId: taskD, pid: pidA })
  const failedD = await applyD
  assert.equal(failedD.ok, false, 'a stale selection aborts the write-back')
  assert.ok(word2.alerts.some(text => text.includes('选区内容已变化')), 'the stale selection is explained in Word')
  assert.ok(word2.body.includes(selectionD), 'nothing was written to the document')

  // 14g. The Word side cancels (document closed): the waiting tool wakes up.
  const selectionE = 'A task whose document closes before the apply.'
  const startE = await post('/office/api/ai-start', {
    kind: 'cite', docId: docA, pid: pidA, hwnd: 111, docName: 'paper-a.docx', text: selectionE,
  })
  const taskE = (await startE.json()).taskId
  const applyE = ai.submit(taskE, {
    mode: 'replace',
    text: 'Whatever[[1]].',
    citations: [{ id: 1, keys: [keys[0]] }],
  })
  await post('/office/api/ai-cancel', { taskId: taskE, pid: pidA })
  const cancelled = await applyE
  assert.equal(cancelled.ok, false, 'cancel resolves the waiting tool')
  assert.equal((await poll(taskE, pidA, docA)).status, 'cancelled')
}

// 15. Word reports generated WITHOUT Word: real citation fields, a bibliography
//     field, chunked ZOTERO_PREF document data — and the integration engine
//     can refresh the generated document, proving it is a genuine Zotero doc.
{
  const { createReportGenerator } = await import('../src/host/office/report.js')
  const { unzipSync } = await import('../vendor/deps.js')
  const dec = new TextDecoder()
  const report = createReportGenerator({ styles, items, home, logger: quiet, version: '0.2.1' })

  const result = await report.generate({
    title: '血脑屏障 AAV 递送:测试报告',
    style: 'ieee',
    outline: [
      { heading: '背景' },
      {
        text: 'AAV 跨血脑屏障递送近年进展显著[[1]]，其中衣壳工程是核心手段[[2]]。',
        citations: [
          { id: 1, keys: [keys[0]] },
          { id: 2, keys: [keys[1], keys[2]], locator: '5' },
        ],
      },
      { heading: '展望', level: 2 },
      { text: 'This paragraph deliberately carries no citations.' },
    ],
    open: false,
  })
  assert.equal(result.citations, 2, 'two citation clusters were processed')
  assert.equal(result.bibliographyEntries, 3, 'the bibliography lists all three cited items')
  assert.equal(result.styleID, 'http://www.zotero.org/styles/ieee', 'short style names resolve')
  assert.ok(fs.existsSync(result.path), 'the .docx is written to the reports directory')
  assert.ok(path.dirname(result.path).endsWith('reports'), 'reports land in <home>/reports')

  const parts = unzipSync(new Uint8Array(fs.readFileSync(result.path)))
  const docXml = dec.decode(parts['word/document.xml'])
  const instrs = [...docXml.matchAll(/<w:instrText[^>]*>([^<]*)<\/w:instrText>/g)].map(match => match[1])
  const citeInstrs = instrs.filter(text => text.includes('ADDIN ZOTERO_ITEM CSL_CITATION'))
  const bibInstrs = instrs.filter(text => text.includes('ADDIN ZOTERO_BIBL'))
  assert.equal(citeInstrs.length, 2, 'two citation fields in the document')
  assert.equal(bibInstrs.length, 1, 'one bibliography field at the end')
  // Strip instrText blocks first: the embedded CSL JSON legitimately contains
  // "date-parts":[[2021]] arrays that would false-match a [[N]] marker scan.
  const visibleXml = docXml.replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, '')
  assert.ok(!/\[\[\d/.test(visibleXml), 'all [[N]] markers were consumed')
  assert.ok(docXml.includes('参考文献'), 'a bibliography heading precedes the field')
  // IEEE numeric style: the pre-rendered results are [1] / [2]-[3]-style labels.
  assert.ok(/\[1\]/.test(docXml) && /\[2\]/.test(docXml), 'ieee numeric citations pre-rendered')
  assert.ok(citeInstrs[0].includes(keys[0]), 'field code embeds the library key')

  // Document data: docProps/custom.xml chunks reassemble into valid v3 data.
  const custom = dec.decode(parts['docProps/custom.xml'])
  const chunkMap = new Map()
  for (const match of custom.matchAll(/name="ZOTERO_PREF_(\d+)"[^>]*><vt:lpstr>([\s\S]*?)<\/vt:lpstr>/g)) {
    chunkMap.set(Number(match[1]), match[2]
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'").replaceAll('&amp;', '&'))
  }
  const chunks = [...chunkMap.keys()].sort((a, b) => a - b).map(index => chunkMap.get(index))
  const joined = chunks.join('')
  assert.ok(chunks.length >= 1 && chunks.every(chunk => chunk.length <= 255), 'properties are ≤255-char chunks')
  const { DocumentData: ReportData } = await import('../src/host/office/document-data.js')
  const parsed = new ReportData(joined, '0.2.1')
  assert.equal(parsed.style.styleID, 'http://www.zotero.org/styles/ieee', 'stored style is ieee')
  assert.equal(parsed.prefs.fieldType, 'Field', 'stored field type is Field')
  assert.ok(parsed.sessionID, 'a session id is stored')

  // Round trip through the REAL engine: load the generated fields into the
  // fake Word, refresh, and the engine re-renders every citation + the
  // bibliography from the field codes alone.
  const word3 = new FakeWord()
  word3.docData = joined
  // Word decodes XML entities when parsing instrText, so the field code VBA
  // sees is the UNESCAPED instruction — mirror that here.
  const unwrap = instr => instr.trim().replace(/^ADDIN ZOTERO_/, '')
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&')
  const visible = value => value
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&')
  for (const instr of citeInstrs) {
    word3.fields.push({ id: `F${word3.nextId++}`, code: unwrap(instr), text: '{Citation}', noteIndex: 0 })
  }
  // The bibliography field result is whatever runs sit between its separate
  // and end markers — read it back out of the generated XML (an empty result
  // would trip the engine's empty-bibliography removal instead of refreshing).
  const bibAt = docXml.indexOf(bibInstrs[0])
  const bibTail = docXml.slice(bibAt)
  const bibEnd = bibTail.indexOf('w:fldCharType="end"')
  const bibResult = [...bibTail.slice(0, bibEnd).matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
    .map(match => visible(match[1])).join('')
  assert.ok(bibResult.includes('Wang'), 'the generated bibliography result text is populated')
  word3.fields.push({ id: `F${word3.nextId++}`, code: unwrap(bibInstrs[0]), text: bibResult, noteIndex: 0 })
  await word3.transact('refresh', 'C:/docs/report.docx')
  if (process.env.DSH_OFFICE_DEBUG) {
    console.log('REPORT-REFRESH fields', JSON.stringify(word3.fields, null, 1), 'alerts', word3.alerts)
  }
  const refreshedCites = word3.fields.filter(field => field.code.startsWith('ITEM CSL_CITATION'))
  const refreshedBib = word3.fields.find(field => field.code.startsWith('BIBL '))
  assert.equal(refreshedCites.length, 2, 'both citation fields survive a refresh')
  assert.ok(refreshedCites.every(field => /\[\d/.test(field.text)), 'refresh re-rendered numeric citations')
  assert.ok(refreshedBib && refreshedBib.text.includes('Wang'), 'refresh rebuilt the bibliography from field codes')
  assert.ok(!word3.alerts.some(text => /手工修改|损坏/.test(text)), 'no damaged-document alerts')

  // Validation refusals.
  await assert.rejects(
    async () => report.generate({
      title: 'x', open: false,
      outline: [{ text: 'a[[1]]', citations: [{ id: 1, keys: ['ZZZZ9999'] }] }],
    }), /不在文库/, 'unknown keys are refused')
  await assert.rejects(
    async () => report.generate({
      title: 'x', style: 'no-such-style-xyz', open: false, outline: [{ text: 'plain' }],
    }), /未找到引用样式/, 'unknown styles are refused with the installed list')
  await assert.rejects(
    async () => report.generate({ title: 'x', open: false, outline: [{ text: 'a[[9]]', citations: [] }] }),
    /没有 id=9/, 'dangling markers are refused')
}

server.stop()
db.close()
safeRemoveTree(tempRoot)
console.log('office-smoke: OK')
