// REAL tool-layer e2e: assemble a standalone office host on port 23119 and
// call the actual createTools() definitions (library_word_*) against a REAL
// running Word. This exercises everything the debug endpoints skip: argument
// validation, error wording, mask session semantics, exec context wiring.
//
//   1. Disable the dsh-zot-library bundle (frees port 23119).
//   2. Start Word with a blank document ("文档1").
//   3. node scripts/word-tools-e2e.mjs
//   4. Re-enable the bundle afterwards.
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStandaloneLibrary } from '../src/host/standalone.js'
import { ZoteroDb } from '../src/host/db.js'
import { createItem } from '../src/host/write.js'
import { createStyleStore } from '../src/host/office/csl-styles.js'
import { createItemProvider } from '../src/host/office/items.js'
import { createDialogManager } from '../src/host/office/dialogs.js'
import { createIntegration } from '../src/host/office/commands.js'
import { createOfficeServer } from '../src/host/office/server.js'
import { createAiTasks } from '../src/host/office/ai-tasks.js'
import { createWordAgent } from '../src/host/office/word-agent.js'
import { createTools } from '../src/host/tools.js'
import { safeRemoveTree } from '../src/host/util.js'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const packageDir = path.resolve(here, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-word-tools-e2e-'))
const dataDir = path.join(tempRoot, 'data')
const home = path.join(tempRoot, 'home')
fs.mkdirSync(home, { recursive: true })
const quiet = { info() {}, warn() {}, error() {} }
const logger = process.env.DSH_E2E_DEBUG ? console : quiet

const built = createStandaloneLibrary(dataDir, logger)
const db = new ZoteroDb({ dbPath: built.dbPath, logger })
db.open()
const created = [
  createItem(db, { itemType: 'journalArticle', fields: { title: 'Tool E2E Citation One', date: '2021', publicationTitle: 'Journal of E2E' }, creators: [{ firstName: 'Lei', lastName: 'Wang', creatorType: 'author' }] }),
  createItem(db, { itemType: 'journalArticle', fields: { title: 'Tool E2E Citation Two', date: '2022', publicationTitle: 'Journal of E2E' }, creators: [{ firstName: 'Mei', lastName: 'Zhang', creatorType: 'author' }] }),
]
const keys = created.map(row => row.key)

const styles = createStyleStore({ logger, packageDir, home })
const items = createItemProvider({ withDb: fn => fn(db) })
const dialogs = createDialogManager({ styles, items, logger, home })
const ai = createAiTasks({ chat: { open: async () => ({}), send: async () => ({}) }, focus: () => {}, logger })
let agentCancels = 0
const wordAgent = createWordAgent({ onStop: () => { agentCancels += 1 }, logger })
const integration = createIntegration({ styles, items, dialogs, ai, logger, version: 'e2e' })
const server = createOfficeServer({ integration, dialogs, styles, ai, wordAgent, logger, version: 'e2e' })
dialogs.setBaseUrl(() => server.baseUrl())
const started = await server.start(0)
assert.equal(started.running, true, `e2e server starts on ${started.port}`)
console.log(`host on port ${server.port}`)

const tools = createTools({
  getDb: () => db,
  paths: { storageDir: path.join(dataDir, 'storage'), dataDir },
  getSettings: () => ({}),
  wordAi: () => ai,
  wordAgent: () => wordAgent,
  wordReport: () => null,
  citeStyles: () => styles,
  logger,
})
const byName = new Map(tools.map(tool => [tool.name, tool]))
const call = async (name, args) => {
  const tool = byName.get(name)
  const controller = new AbortController()
  const exec = { agent: { cancel: () => { agentCancels += 100 } }, signal: controller.signal }
  try {
    const value = await tool.execute(args, exec)
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

const results = []
const check = (label, outcome, ok) => {
  const detail = ok ? JSON.stringify(outcome?.value ?? null) : String(outcome?.error ?? 'no error text')
  results.push({ label, ok, detail: detail.slice(0, 220) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ' :: ' + detail}`)
}

// --- wait for the Word pump heartbeat ------------------------------------
let docs = []
for (let i = 0; i < 20 && docs.length === 0; i += 1) {
  await new Promise(resolve => setTimeout(resolve, 1500))
  docs = wordAgent.liveInstances().flatMap(instance => instance.docs)
}
assert.ok(docs.length > 0, 'Word pump heartbeat arrived (open Word with a blank doc first)')
const blankDoc = docs.find(doc => !doc.includes('\\') && !doc.includes('/')) ?? docs[0]
console.log('target doc:', blankDoc)

// --- 1. library_word_list --------------------------------------------------
{
  const r = await call('library_word_list', {})
  check('word_list', r, r.ok && Array.isArray(r.value.docs) && r.value.docs.some(d => d.docId === blankDoc))
}

// --- 2. library_word_write (append) ----------------------------------------
{
  const r = await call('library_word_write', { docId: blankDoc, mode: 'append', text: '工具层端到端测试段落：AAV 衣壳工程在基因治疗中的地位日益重要。' })
  check('word_write append', r, r.ok === true)
}

// --- 3. validation refusals -------------------------------------------------
{
  const empty = await call('library_word_write', { docId: blankDoc, text: '   ' })
  check('word_write rejects blank text', empty, empty.ok === false)
  const missing = await call('library_word_read', {})
  check('word_read requires docId', missing, missing.ok === false)
  const unknown = await call('library_word_read', { docId: 'C:/not-open.docx' })
  check('word_read rejects unopened doc', unknown, unknown.ok === false && /没有在 Word 中打开/.test(unknown.error))
}

// --- 4. library_word_read ----------------------------------------------------
{
  const r = await call('library_word_read', { docId: blankDoc, para: 1, paras: 3 })
  check('word_read paras', r, r.ok && r.value.paras.length >= 1 && Number.isInteger(r.value.paras[0].n))
  const page = await call('library_word_read', { docId: blankDoc, page: 1, maxChars: 600 })
  check('word_read page', page, page.ok === true)
}

// --- 5. library_word_search ---------------------------------------------------
{
  const r = await call('library_word_search', { docId: blankDoc, query: '衣壳' })
  check('word_search hit', r, r.ok && r.value.docs[0].count >= 1)
}

// --- 6. mask held across read/write (session semantics) ----------------------
{
  // NOTE: wordOp already opened the mask during the write above — that IS the
  // session semantics. begin just confirms it is held.
  const begin = await call('library_word_busy', { docId: blankDoc, action: 'begin', text: '工具层测试：正在连续操作文档' })
  check('busy begin (auto-opened by first op)', begin, begin.ok === true)
  const write = await call('library_word_write', { docId: blankDoc, mode: 'append', text: '遮罩保持下的第二段：验证会话级锁定的连续读写。' })
  check('write behind held mask', write, write.ok === true)
  const held = wordAgent.status().mask
  check('mask still held after op', { ok: true, value: held }, Boolean(held))
  const again = await call('library_word_busy', { docId: blankDoc, action: 'begin' })
  console.log('  [debug] busy begin again =>', JSON.stringify(again.value ?? again.error))
  check('busy begin reuses held mask', again, again.ok === true && again.value.held === true)
  const end = await call('library_word_busy', { docId: blankDoc, action: 'end' })
  check('busy end', end, end.ok === true)
}

// --- 7. library_word_cite (real fields) ---------------------------------------
{
  const read = await call('library_word_read', { docId: blankDoc, para: 2, paras: 1 })
  const anchor = read.ok ? read.value.paras[0].text : ''
  const r = await call('library_word_cite', {
    docId: blankDoc, para: 2,
    citations: [{ after: '地位日益重要', keys }],
  })
  check('word_cite inserts real fields', r, r.ok === true && r.value.inserted >= 1)
  const verify = await call('library_word_read', { docId: blankDoc, para: 2, paras: 1, maxChars: 4000 })
  const text = verify.ok ? verify.value.paras[0].text : ''
  check('citation visible in readback', { ok: true, value: { text } }, /Wang|Zhang/.test(text))
}

// --- 8. cite validation refusals ----------------------------------------------
{
  const badKey = await call('library_word_cite', { docId: blankDoc, para: 2, citations: [{ after: '地位日益重要', keys: ['ZZZZ9999'] }] })
  check('cite rejects unknown key', badKey, badKey.ok === false)
  const badAfter = await call('library_word_cite', { docId: blankDoc, para: 2, citations: [{ after: '这段文字不存在', keys }] })
  check('cite rejects missing anchor', badAfter, badAfter.ok === false)
}

const failed = results.filter(entry => !entry.ok)
server.stop()
db.close()
safeRemoveTree(tempRoot)
console.log(failed.length === 0 ? '\nword-tools-e2e: ALL PASS' : `\nword-tools-e2e: ${failed.length} FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
