// Browser-half smoke test: mounts the built client.js in jsdom with a fake
// dsh API and asserts the library page renders and reacts to interactions.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import * as React from 'react'
import * as ReactDOMClient from 'react-dom/client'
import * as JsxRuntime from 'react/jsx-runtime'

const PLUGIN = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(PLUGIN, 'client.js'), 'utf8')

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const { window } = dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.window = window
globalThis.document = window.document
globalThis.localStorage = window.localStorage
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) ?? (callback => setTimeout(callback, 0))
globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window) ?? clearTimeout
globalThis.FileReader = window.FileReader
// pdf.js (bundled inside the viewer) touches DOMMatrix at import time; jsdom
// has none, and the parse path only ever constructs the identity matrix.
class DOMMatrixStub {
  multiplySelf() { return this }
  preMultiplySelf() { return this }
  translate() { return this }
  scale() { return this }
  invertSelf() { return this }
  multiply() { return this }
  inverse() { return this }
}
globalThis.DOMMatrix = DOMMatrixStub
// jsdom has no Blob URL factory; parts of the client use one.
let blobUrlCount = 0
const blobUrls = []
window.URL.createObjectURL = () => `blob:mock-${blobUrlCount += 1}`
window.URL.revokeObjectURL = (url) => { const i = blobUrls.indexOf(url); if (i !== -1) blobUrls.splice(i, 1) }
globalThis.URL = window.URL
// The reveal effect scrolls a located row into view; count the calls instead
// of relying on jsdom layout.
let scrollIntoViewCalls = []
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() { scrollIntoViewCalls.push(this.getAttribute('data-key')) }

const collection = { id: 1, key: 'COLLAAAA', name: 'Cas-Screen', parentID: null, count: 0, totalCount: 2, children: [] }
const items = [
  {
    key: 'AAAAAAAA', itemType: 'journalArticle', title: 'A test paper about AAV capsids',
    date: '2024', year: 2024, doi: '10.1/test', creators: 'Zhang et al.',
    creatorList: [{ firstName: 'San', lastName: 'Zhang', fieldMode: 0 }],
    publicationTitle: 'Nature Reviews', publisher: '', tags: ['AAV'], firstCreator: 'Zhang',
    hasAttachment: true, numNotes: 0, fields: { publicationTitle: 'Nature Reviews', pages: '100-120', extra: 'note text' },
    dateAdded: '2026-01-01 00:00:00', dateModified: '2026-01-01 00:00:00',
    children: [
      { key: 'CCCCCCCC', kind: 'attachment', itemType: 'attachment', title: 'paper.pdf', contentType: 'application/pdf' },
    ],
  },
  {
    key: 'BBBBBBBB', itemType: 'book', title: 'Another item',
    date: '2020', year: 2020, doi: '', creators: 'Li', creatorList: [],
    publicationTitle: '', publisher: 'Springer', tags: [], firstCreator: 'Li',
    hasAttachment: false, numNotes: 0, fields: {},
    dateAdded: '2026-01-01 00:00:00', dateModified: '2026-01-01 00:00:00',
    children: [],
  },
]
// The item pane builds its field list from the bundled item-type schema the
// host serves through the `schema` endpoint.
const schemaTypes = [
  {
    itemType: 'journalArticle',
    fields: ['title', 'abstractNote', 'date', 'publicationTitle', 'volume', 'issue', 'pages', 'DOI', 'ISSN', 'url', 'language', 'shortTitle', 'extra'],
    fieldBases: {},
    creatorTypes: [{ creatorType: 'author', primary: true }, { creatorType: 'editor' }],
  },
  {
    itemType: 'book',
    fields: ['title', 'abstractNote', 'publisher', 'place', 'date', 'ISBN', 'url', 'extra'],
    fieldBases: {},
    creatorTypes: [{ creatorType: 'author', primary: true }, { creatorType: 'editor' }],
  },
]
const detail = {
  key: 'AAAAAAAA', itemType: 'journalArticle', title: 'A test paper about AAV capsids',
  dateAdded: '2026-01-01 00:00:00', dateModified: '2026-01-01 00:00:00', version: 0, synced: false, deleted: false,
  fields: [
    { field: 'title', value: 'A test paper about AAV capsids' },
    { field: 'date', value: '2024' },
    { field: 'publicationTitle', value: 'Nature' },
  ],
  creators: [{ firstName: 'San', lastName: 'Zhang', fieldMode: 0, creatorType: 'author', orderIndex: 0 }],
  tags: [{ name: 'AAV', type: 0 }],
  collections: [{ collectionID: 1, collectionName: 'Cas-Screen' }],
  attachments: [{
    key: 'CCCCCCCC', title: 'paper.pdf', rawPath: 'storage:paper.pdf', linkMode: 0,
    contentType: 'application/pdf', syncState: 2, size: 12345,
    target: { kind: 'file', path: 'C:/tmp/paper.pdf' },
  }],
  notes: [],
  annotations: [{
    key: 'DDDDDDDD', type: 1, color: '#ffd400', pageLabel: '2', text: 'highlighted words',
    comment: 'my comment', position: { pageIndex: 1, rects: [] }, parentKey: 'CCCCCCCC',
  }],
}
const chatMessages = [
  { role: 'user', text: '总结这篇文献', seq: 1, time: Date.now() },
  { role: 'assistant', text: '这是一段总结。', seq: 2, time: Date.now() },
]

const calls = []
const bodies = []
let fileRouteHits = 0
let translateStreamBodies = []
let translateEvents = []
// Mutable settings fixture: the 划词自动翻译 test flips translate.auto and
// replays the settings-saved event, so `state` must read it live.
const stateSettings = {
  mode: 'zotero', zoteroDataDir: '', webdav: { url: '', username: '', hasPassword: false }, autoSync: false,
  updateFeed: '', translate: { thinking: false, auto: false, modelSource: 'follow', model: '' },
}
globalThis.fetch = async (url, options) => {
  if (String(url).includes('api/library/file')) {
    // Binary reader route: headers + arrayBuffer, no JSON envelope.
    fileRouteHits += 1
    const bytes = Buffer.from(fs.readFileSync(path.join(PLUGIN, 'scripts', 'fixtures-smoke.pdf')))
    return {
      ok: true,
      headers: { get: name => ({ 'content-type': 'application/pdf', 'x-library-attachment-key': 'CCCCCCCC', 'x-library-parent-key': 'BBBBBBBB', 'x-library-title': 'sample.pdf' }[name] ?? null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  }
  if (String(url).includes('api/library/translate')) {
    // NDJSON streaming route: one JSON event per line, delivered in chunks.
    translateStreamBodies.push(JSON.parse(options.body))
    const lines = [...translateEvents]
    let cursor = 0
    const encoder = new TextEncoder()
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (cursor >= lines.length) return { done: true, value: undefined }
            const chunk = encoder.encode(`${JSON.stringify(lines[cursor])}\n`)
            cursor += 1
            return { done: false, value: chunk }
          },
        }),
      },
    }
  }
  const body = JSON.parse(options.body)
  calls.push(body.endpoint)
  bodies.push(body)
  let value
  switch (body.endpoint) {
    case 'state':
      value = {
        available: true, dataDir: 'C:/Zotero', dbPath: 'C:/Zotero/zotero.sqlite', storageDir: 'C:/Zotero/storage',
        source: 'default', mode: 'zotero', schemaVersion: 125,
        counts: { items: 2, attachments: 1, annotations: 1, collections: 1, tags: 1, trash: 0 },
        settings: { ...stateSettings, translate: { ...stateSettings.translate } },
        sync: { running: false, last: null }, revision: 1, version: '0.2.0',
      }
      break
    case 'collections':
      value = { collections: [collection], unfiled: 0, trash: 0, tags: [{ name: 'AAV', count: 2 }] }
      break
    case 'items':
      value = { total: items.length, offset: 0, limit: 100, items }
      break
    case 'schema':
      value = schemaTypes
      break
    case 'item':
      // The right pane follows the reader tab too: a PDF tab whose parent is
      // the book item loads that parent's detail.
      value = body.payload?.key === 'BBBBBBBB' ? { ...detail, key: 'BBBBBBBB', title: 'Another item' } : detail
      break
    case 'change-type':
      // Plan first (confirm:false), then apply. A field not valid for the
      // target type would be dropped after a confirm dialog.
      if (body.payload?.confirm === true) {
        value = { key: body.payload.key, itemType: body.payload.itemType, transferred: [], dropped: [] }
        break
      }
      value = { key: body.payload?.key, itemType: body.payload?.itemType, transferred: [], dropped: [] }
      break
    case 'create':
      value = { key: 'NEWITEM1' }
      break
    case 'lookup':
      value = [{
        itemType: 'journalArticle',
        fields: { title: 'Lookup result paper', date: '2024', DOI: '10.1/lookup' },
        creators: [{ lastName: 'Wang', firstName: 'Wu', creatorType: 'author' }],
        tags: [],
        source: 'crossref',
      }]
      break
    case 'note-create':
      value = { key: 'NOTEEEEE' }
      break
    case 'note-update':
      value = { key: body.payload?.key, updated: true }
      break
    case 'attachment-url':
      value = { key: 'URLATTAC' }
      break
    case 'annotations-list':
      value = {
        annotations: [
          {
            key: 'DDDDDDDD', type: 1, color: '#ffd400', pageLabel: '2', text: 'highlighted words',
            comment: 'my comment', position: { pageIndex: 0, rects: [[10, 10, 100, 30]] }, parentKey: 'CCCCCCCC',
          },
          {
            key: 'FFFF0000', type: 5, color: '#2ea8e5', pageLabel: '1', text: 'two-line underline',
            comment: '', position: { pageIndex: 0, rects: [[10, 40, 100, 60], [10, 70, 100, 90]] }, parentKey: 'CCCCCCCC',
          },
        ],
      }
      break
    case 'annotation-create':
      value = { key: 'EEEE1111' }
      break
    case 'open-apps':
      value = {
        apps: [
          { id: 'prog.edge', name: 'Microsoft Edge PDF Document', icon: null, default: false },
          { id: 'prog.sumatra', name: 'SumatraPDF', icon: 'data:image/png;base64,iVBORw0KGgo=', default: true },
        ],
      }
      break
    case 'ping':
      value = { revision: 1 }
      break
    case 'translate-models':
      value = {
        models: [
          { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', model: 'deepseek-chat' },
          { id: 'deepseek/deepseek-reasoner', name: 'DeepSeek Reasoner', provider: 'deepseek', model: 'deepseek-reasoner' },
        ],
        current: { provider: 'deepseek', model: 'deepseek-chat' },
      }
      break
    case 'chat-open':
      value = { sessionId: 'session-1' }
      break
    case 'chat-page':
      value = { sessionId: 'session-1', running: false, seq: 2, hasMore: false, messages: chatMessages }
      break
    case 'chat-send':
      value = { sessionId: 'session-1' }
      break
    case 'upload':
      // Zotero-style staged import: the attachment item exists immediately.
      if (body.payload?.deferMetadata === true) {
        items.push({
          key: 'GGGGGGGG', itemType: 'attachment', title: 'mystery-paper.pdf',
          date: '', year: null, doi: '', creators: '', creatorList: [], publicationTitle: '', publisher: '',
          tags: [], firstCreator: '', hasAttachment: false, numNotes: 0, fields: {},
          dateAdded: '2026-01-01 00:00:00', dateModified: '2026-01-01 00:00:00', children: [],
        })
        value = { staged: true, parentKey: null, attachmentKey: 'GGGGGGGG', fileName: 'mystery-paper.pdf', size: 4 }
        break
      }
      value = {
        parentKey: 'EEEEEEEE', attachmentKey: 'FFFFFFFF', fileName: 'mystery-paper.pdf',
        metadata: { source: 'none', confidence: 0, needsReview: true },
        needsMetadataHelp: true, textChars: 0, annotations: { extracted: 0, added: 0 },
      }
      break
    case 'import-finalize':
      value = {
        parentKey: null, attachmentKey: 'GGGGGGGG', fileName: 'mystery-paper.pdf',
        metadata: { source: 'none', confidence: 0, needsReview: true },
        needsMetadataHelp: true, textChars: 0, annotations: { extracted: 0, added: 0 },
      }
      break
    case 'duplicate':
      value = { key: 'DUPLICATE' }
      break
    case 'merge':
      value = { key: 'AAAAAAAA', merged: 1 }
      break
    case 'create-parent':
      value = { parentKey: 'NEWPARENT' }
      break
    case 'detach-attachment':
      value = { key: body.payload?.key, detached: true }
      break
    case 'note-from-annotations':
      value = { key: 'ANNONOTE', added: 1 }
      break
    default:
      value = {}
  }
  return { ok: true, json: async () => ({ ok: true, value }) }
}

let registration
const injectFns = new Map()
window.__ModuleLoader__ = { load(value) { registration = value } }
// eslint-disable-next-line no-eval
;(0, eval)(source)
assert.equal(registration?.id, 'dsh-library')
const clientModule = registration.factory((specifier) => {
  if (specifier === 'react') return React
  if (specifier === 'react/jsx-runtime') return JsxRuntime
  if (specifier === 'react-dom/client') return ReactDOMClient
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    // Plain stand-ins for the host's themed atoms (the real CSS-module styling
    // is irrelevant here; contracts are what the smoke exercises).
    const Button = React.forwardRef(function Button({ icon, className, children, ...rest }, ref) {
      return React.createElement('button', { ref, type: 'button', className, ...rest }, icon ?? null, children)
    })
    const Input = React.forwardRef(function Input({ className, ...rest }, ref) {
      return React.createElement('span', { className }, React.createElement('input', { ref, ...rest }))
    })
    const Checkbox = function Checkbox({ checked, onChange, label }) {
      return React.createElement('label', null,
        React.createElement('input', { type: 'checkbox', checked, onChange: event => onChange(event.target.checked) }), label)
    }
    const Switch = function Switch({ checked, onChange, label }) {
      return React.createElement('label', null,
        React.createElement('input', { type: 'checkbox', checked, onChange: event => onChange(event.target.checked) }), label)
    }
    const SegmentedControl = function SegmentedControl({ options, value, onChange }) {
      return React.createElement('span', null, options.map(option => React.createElement('button', {
        key: option.value, type: 'button', 'aria-pressed': option.value === value,
        onClick: () => onChange(option.value),
      }, option.label)))
    }
    const SegmentedTabs = function SegmentedTabs({ items, value, onChange }) {
      return React.createElement('span', null, items.map(item => React.createElement('button', {
        key: item.value, type: 'button', 'aria-selected': item.value === value,
        onClick: () => onChange(item.value),
      }, item.label)))
    }
    const Tag = function Tag({ children }) { return React.createElement('span', null, children) }
    // Host product icons render through the document sprite; the stub keeps
    // just a traceable placeholder (jsdom has no sprite). The Menu stub renders
    // its anchor plus plain buttons while open, enough to exercise selection.
    const ProductIcon = props => React.createElement('span', { 'data-icon-stub': props['data-icon'] ?? 'stub' })
    const Menu = function Menu({ anchor, items, onSelect, open }) {
      return React.createElement('span', null, anchor, open && Array.isArray(items)
        ? items.map(item => React.createElement('button', {
            key: item.id, type: 'button', 'data-menu-item': item.id,
            onClick: () => onSelect?.(item.id),
          }, item.label))
        : null)
    }
    return {
      Button, Checkbox, Input, Menu, SegmentedControl, SegmentedTabs, Switch, Tag,
      IconAppsAddOutlineRegular: ProductIcon, IconChevronDownOutlineRegular: ProductIcon,
      IconCompareSplitOutlineRegular: ProductIcon, IconRightUpOutlineRegular: ProductIcon,
    }
  }
  throw new Error(`unexpected require(${specifier})`)
})
assert.equal(clientModule.name, 'dsh-library')
assert.deepEqual(clientModule.inject, ['slots', 'layout'])

// --- mount with a mock ctx ------------------------------------------------
const mounted = new Map()
const listeners = new Set()
let panelSnapshot = { activePanelId: null }
const layout = {
  panelInfo: {
    getSnapshot: () => panelSnapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  },
  selectPanel(panelId) {
    mounted.set('active', panelId)
    panelSnapshot = { activePanelId: panelId }
    for (const listener of listeners) listener()
  },
}
const nativeOpens = []
const shortcutInvokes = []
const slotRenders = []
const retained = []
const released = []
const ctx = {
  layout,
  effect(fn) {
    const dispose = fn()
    return dispose
  },
  inject(_deps, callback) {
    callback({
      uiWorkspace: { openSession(id) { nativeOpens.push(id) } },
      // The gear button runs the shell's settings.open command in the registry
      // (desktop gestures arrive over the native bridge, not DOM events).
      shortcuts: { registry: { invoke: (id, _context) => shortcutInvokes.push(id) } },
    })
    return () => {}
  },
  slots: {
    inject(_name, callback) {
      callback()
      return () => {}
    },
    register(options, component) {
      mounted.set(options.name === 'main' ? `main:${options.key}` : options.name, component)
      // Keep the slot's inject() around: like the real slots framework, the
      // harness spreads its result into the component's props (this is how
      // layout/openSettings reach the page).
      injectFns.set(options.name === 'main' ? `main:${options.key}` : options.name, options.inject)
      return () => {}
    },
  },
}
clientModule.apply(ctx)
const Page = mounted.get('main:library')
const Footer = mounted.get('sidebar.footer.action')
assert.ok(Page && Footer, 'main panel and footer entry registered')
assert.ok(mounted.get('settings.section'), 'a 文库 page is registered into dsh\'s native settings')

const { act } = React
const container = document.getElementById('app')
const root = ReactDOMClient.createRoot(container)
const tick = () => new Promise(resolve => setTimeout(resolve, 30))

await act(async () => {
  root.render(React.createElement(React.Fragment, null,
    React.createElement(Page, {
      ...(injectFns.get('main:library')?.() ?? {}),
      layout,
      openNativeSession: id => nativeOpens.push(id),
      retainSession: (sessionId, signal) => {
        retained.push({ sessionId, signal })
        return { sessionId, release() { released.push(sessionId) } }
      },
      // Minimal stand-ins for the slots framework's SessionProvider + child share.
      SessionProvider: (props) => React.createElement('div', { 'data-slot': 'session-area' }, props.children),
      renderSlot: (key, owner) => {
        slotRenders.push({ key, owner })
        return React.createElement('div', { 'data-slot': key }, 'native-conversation')
      },
    }),
    React.createElement(Footer, { wide: true, layout }),
  ))
  await tick()
  await tick()
})

const text = container.textContent
assert.ok(text.includes('我的文库'), 'toolbar shows My Library')
assert.ok(text.includes('A test paper about AAV capsids'), 'item row rendered')
assert.ok(text.includes('Cas-Screen'), 'collection tree rendered')
assert.ok(text.includes('AAV'), 'tag rendered')
assert.ok(text.includes('文献助手'), 'assistant dock bar rendered')
assert.ok(text.includes('文库'), 'footer entry rendered')

// The toolbar gear opens dsh's native settings panel through the shell's own
// settings.open command.
const gear = container.querySelector('.lib-toolbar button[title="设置"]')
assert.ok(gear, 'toolbar gear button rendered')
await act(async () => {
  gear.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.ok(shortcutInvokes.includes('settings.open'), 'gear button invoked the settings.open command')

// Selecting an item loads its details into the right pane.
const row = [...container.querySelectorAll('.lib-itemrow')].find(node => node.textContent.includes('A test paper'))
assert.ok(row, 'item row element exists')
await act(async () => {
  row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
  await tick()
})
assert.ok(calls.includes('item'), 'detail requested')
const afterSelect = container.textContent
assert.ok(afterSelect.includes('期刊文章'), 'type pill + type menu rendered (Zotero zh-CN label)')
assert.ok(afterSelect.includes('条目类型'), 'the info section carries the item type menu row')
assert.ok(afterSelect.includes('其他'), 'the extra field row uses Zotero\'s zh-CN label 其他')
assert.ok(afterSelect.includes('摘要'), 'abstract is its own section')
// Creator rows are editable inputs now (Zotero's itemBox), so values live on
// the inputs rather than in text content.
assert.ok(
  [...container.querySelectorAll('.lib-creator-row .lib-creator-last')].some(input => input.value === 'Zhang'),
  'creator row rendered with an editable last-name field',
)
assert.ok([...container.querySelectorAll('.lib-creator-row .lib-creator-type')].some(node => node.value === 'author'), 'creator type select rendered')
assert.ok(afterSelect.includes('Nature'), 'field rendered')
assert.ok(afterSelect.includes('打开 PDF'), 'open button rendered')

// The info section lists every field the item type supports (empty ones
// included, Zotero's itemBox behaviour) with dateAdded/dateModified closed by
// read-only rows.
const fieldLabels = [...container.querySelectorAll('.lib-sectionpane[data-section="info"] .lib-field-label')].map(node => node.textContent)
assert.ok(fieldLabels.includes('标题') && fieldLabels.includes('页码') && fieldLabels.includes('其他'), 'all type fields offered (empty ones included, extra = 其他 like Zotero)')
assert.ok(fieldLabels.includes('添加日期') && fieldLabels.includes('修改日期'), 'read-only date rows close the info section')
// 短标题 = the user's own key-points marker: right under the title, with a
// hint explaining its purpose (the mock schema lists it late on purpose).
assert.ok(fieldLabels.indexOf('短标题') === fieldLabels.indexOf('标题') + 1, '短标题 sits right under the title in the info pane')
assert.ok(container.querySelector('.lib-sectionpane[data-section="info"]').textContent.includes('自己标记这篇文章需要关注的要点'), 'the short-title hint notes its key-points purpose')

// The type menu changes the item type: a Zotero-style change-type plan runs
// first (listing dropped fields), then the applied write re-renders.
const typeMenu = container.querySelector('.lib-type-menu')
assert.ok(typeMenu, 'type menu select rendered')
await act(async () => {
  typeMenu.value = 'book'
  typeMenu.dispatchEvent(new window.Event('change', { bubbles: true }))
  for (let i = 0; i < 4; i += 1) await tick()
})
const planCalls = bodies.filter(body => body.endpoint === 'change-type')
assert.ok(planCalls.length >= 2, 'type change planned then applied')
assert.equal(planCalls[0].payload.confirm, undefined, 'the first call is the dry-run plan')
assert.equal(planCalls[1].payload.confirm, true, 'the second call applies after the (empty) drop list')

// The right pane (文献信息) collapses to a rail and the layout is remembered.
const collapseBtn = container.querySelector('.lib-right-collapse')
assert.ok(collapseBtn, 'right-pane collapse button rendered')
await act(async () => {
  collapseBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.ok(container.querySelector('.lib-right-rail'), 'collapsed state renders the expand rail')
assert.ok(!container.querySelector('.lib-right-collapse'), 'details pane is gone while collapsed')
assert.ok(container.querySelector('.lib-main.lib-main-no-details'), 'grid reserves only the rail width')
assert.equal(localStorage.getItem('dsh-library:details-open'), '0', 'collapsed layout is remembered')
await act(async () => {
  container.querySelector('.lib-right-rail').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.ok(container.querySelector('.lib-right-collapse'), 'the rail expands the pane again')
assert.equal(localStorage.getItem('dsh-library:details-open'), '1', 'expanded layout is remembered again')

// Zotero's item tree: a parent with attachments expands into indented child
// rows (twisty column); children select/open like regular items.
const twisty = container.querySelector('.lib-itemrow .lib-twisty')
assert.ok(twisty, 'parent with children shows an expansion twisty')
await act(async () => {
  twisty.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
const childRow = container.querySelector('.lib-itemrow.lib-childrow')
assert.ok(childRow, 'expanded parent lists its child attachment row')
assert.ok(childRow.textContent.includes('paper.pdf'), 'child row shows the attachment name')
assert.ok(twisty.getAttribute('aria-expanded') === 'true', 'twisty reflects the expanded state')
await act(async () => {
  childRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.ok(calls.filter(endpoint => endpoint === 'item').length >= 2, 'child click loads its own detail')

// The column picker adds and removes list columns like Zotero's — the full
// Zotero set (extra/页码/…) is offered, and the header scrolls with the body.
const colBtn = container.querySelector('.lib-colbtn')
assert.ok(colBtn, 'column picker button rendered')
await act(async () => {
  colBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
const menuSections = [...container.querySelectorAll('.lib-colmenu-title')].map(node => node.textContent)
assert.ok(menuSections.some(text => text.includes('显示中的列')) && menuSections.some(text => text.includes('可添加的列')), 'column picker splits into checked/unchecked layers')
const firstMenuItem = container.querySelector('.lib-colmenu .lib-colitem')
assert.ok(firstMenuItem?.textContent.includes('短标题'), '短标题 leads the checked columns (= header order)')
assert.ok(firstMenuItem?.querySelector('input')?.checked === true, '短标题 checked by default')
const menuItems = [...container.querySelectorAll('.lib-colitem')].map(node => node.textContent.trim())
assert.ok(menuItems.some(text => text.includes('出版物')), 'publication column offered')
assert.ok(menuItems.some(text => text.includes('其他')), 'Zotero 其他 (extra) column offered')
assert.ok(menuItems.some(text => text.includes('页码')), 'pages column offered')
assert.ok(menuItems.some(text => text.includes('索书号')), 'callNumber column offered')
assert.ok(container.querySelector('.lib-colmenu-restore'), 'restore-default-columns action offered')
const extraItem = [...container.querySelectorAll('.lib-colitem')].find(node => node.textContent.includes('其他'))
await act(async () => {
  extraItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.ok([...container.querySelectorAll('.lib-table-head span, .lib-table-head button')].some(node => node.textContent.includes('其他')), 'extra column shown')
// Generic column values arrive through the host's requested-field payload.
assert.ok(container.querySelectorAll('.lib-itemrow')[0].textContent.includes('note text'), 'extra field value rendered in rows')
assert.ok(container.querySelector('.lib-items .lib-table-head'), 'header lives inside the scroll container (sticky + horizontal sync)')
// Column order is user-adjustable: dragging a header cell onto another moves it.
await act(async () => {
  colBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) // close
  await tick()
  colBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) // reopen
  await tick()
})
const pagesItem = [...container.querySelectorAll('.lib-colitem')].find(node => node.textContent.includes('页码'))
await act(async () => {
  pagesItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
const headerCells = () => [...container.querySelectorAll('.lib-table-head > button, .lib-table-head > span')]
  .filter(node => node.tagName === 'BUTTON' || node.getAttribute('draggable') === 'true')
const headerLabels = () => headerCells().map(node => node.textContent)
await act(async () => {
  const from = headerCells().find(node => node.textContent.includes('其他'))
  const to = headerCells().find(node => node.textContent.includes('年份'))
  from.dispatchEvent(Object.defineProperty(new window.MouseEvent('dragstart', { bubbles: true }), 'dataTransfer', { value: { setData() {}, effectAllowed: 'move' } }))
  to.dispatchEvent(Object.defineProperty(new window.MouseEvent('drop', { bubbles: true, cancelable: true }), 'dataTransfer', { value: { getData: () => 'extra' } }))
  await tick()
})
assert.ok(headerLabels().findIndex(text => text.includes('其他')) < headerLabels().findIndex(text => text.includes('年份')), 'dragging a header cell reorders the columns')
const columnsSaved = JSON.parse(localStorage.getItem('dsh-library:columns'))
assert.ok(columnsSaved.includes('extra') && columnsSaved.includes('pages'), 'visible columns persisted across sessions')
// Reordering inside the picker: drag 短标题 onto 创建者 in the checked layer.
await act(async () => {
  const from = [...container.querySelectorAll('.lib-colmenu .lib-colitem')].find(node => node.textContent.includes('短标题'))
  const to = [...container.querySelectorAll('.lib-colmenu .lib-colitem')].find(node => node.textContent.includes('创建者'))
  from.dispatchEvent(Object.defineProperty(new window.MouseEvent('dragstart', { bubbles: true }), 'dataTransfer', { value: { setData() {}, effectAllowed: 'move' } }))
  to.dispatchEvent(Object.defineProperty(new window.MouseEvent('drop', { bubbles: true, cancelable: true }), 'dataTransfer', { value: { getData: () => 'shortTitle' } }))
  await tick()
})
const orderAfterMenu = JSON.parse(localStorage.getItem('dsh-library:columns'))
assert.ok(orderAfterMenu.indexOf('shortTitle') > orderAfterMenu.indexOf('creator'), 'dragging inside the picker reorders the header order')
// Header and rows share the .lib-table width wrapper so their grid tracks
// resolve identically (alignment).
assert.ok(container.querySelector('.lib-items > .lib-table > .lib-table-head'), 'header and rows share the .lib-table width wrapper')
assert.ok(container.querySelector('.lib-table .lib-itemrow'), 'item rows render inside the shared-width table')
// Column widths are user-adjustable: dragging a cell's right edge persists a
// new width and drives both header and row grids; double-click resets it.
await act(async () => {
  const handle = container.querySelector('.lib-table-head button .lib-colresize')
  assert.ok(handle, 'width resize handle rendered in the header cells')
  handle.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 200 }))
  document.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 240 }))
  document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }))
  await tick()
})
const widthsSaved = JSON.parse(localStorage.getItem('dsh-library:column-widths'))
assert.ok(widthsSaved && Object.keys(widthsSaved).length > 0, 'dragging the edge persists a column width')
const savedWidth = Object.values(widthsSaved)[0]
assert.ok(container.querySelector('.lib-itemrow').style.gridTemplateColumns.includes(`${savedWidth}px`), 'the new width drives the row grid')
assert.ok(container.querySelector('.lib-table-head').style.gridTemplateColumns.includes(`${savedWidth}px`), 'the new width drives the header grid too')

// 新建条目 = Zotero's type menu: pick a type, an empty item is created and
// selected for editing in the item pane.
const createWrap = container.querySelector('.lib-newitem-wrap')
const createBtn = [...createWrap.querySelectorAll('button')].find(node => node.textContent.includes('新建条目'))
assert.ok(createBtn, '新建条目 toolbar button rendered')
await act(async () => {
  createBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
const typePop = container.querySelector('.lib-type-menu-pop')
assert.ok(typePop, 'type menu popover opened')
assert.ok(typePop.textContent.includes('期刊文章') && typePop.textContent.includes('图书'), 'the popover lists item types in zh-CN')
await act(async () => {
  [...typePop.querySelectorAll('button')].find(node => node.textContent.includes('图书')).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
  await tick()
})
const createBody = bodies.find(body => body.endpoint === 'create')
assert.ok(createBody && createBody.payload.itemType === 'book', 'picking a type creates an empty item of that type')

// The magic wand opens the Add-by-Identifier popover (multi-line input).
const wandBtn = [...container.querySelectorAll('.lib-newitem-wrap button')].find(node => node.title?.includes('标识符'))
assert.ok(wandBtn, '通过标识符添加 wand button rendered')
await act(async () => {
  wandBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.ok(container.querySelector('.lib-lookup-pop textarea'), 'identifier popover with textarea rendered')
await act(async () => {
  wandBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})

// The assistant bar opens a floating panel that embeds the NATIVE dsh
// conversation: a retained SessionReference bound through SessionProvider and
// the `library.chat.area` child slot (rendered by the shared Factory in dsh).
const chatBar = container.querySelector('.lib-chatdock-bar')
assert.ok(chatBar, 'assistant bar rendered')
assert.ok(container.querySelector('.lib-chatdock'), 'dock container rendered')
await act(async () => {
  chatBar.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
  await tick()
})
assert.ok(calls.includes('chat-open'), 'chat session opened')
assert.ok(container.querySelector('.lib-chatdock-panel'), 'open panel rendered')
const areaNode = container.querySelector('[data-slot="library.chat.area"]')
assert.ok(areaNode, 'embedded conversation area rendered (no self-drawn transcript)')
assert.ok(!container.textContent.includes('总结这篇文献'), 'no self-drawn chat transcript')
assert.ok(retained.some(entry => entry.sessionId === 'session-1'), 'session reference retained for the dock')
const sessionArea = container.querySelector('[data-slot="session-area"]')
assert.ok(sessionArea && sessionArea.contains(areaNode), 'conversation area lives inside the SessionProvider scope')
assert.ok(slotRenders.every(render => render.key === 'library.chat.area' && render.owner.sessionId === 'session-1'), 'child slot rendered with the dock session')

// The bar toggles: clicking again collapses the panel (and a third click
// reopens with a NEW conversation — the list-view semantics).
await act(async () => {
  container.querySelector('.lib-chatdock-bar').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.ok(!container.querySelector('.lib-chatdock-panel'), 'clicking the bar again collapses the dock')
assert.ok(container.querySelector('.lib-chatdock-bar'), 'the bar stays for reopening')
const chatOpensBefore = bodies.filter(body => body.endpoint === 'chat-open').length
await act(async () => {
  container.querySelector('.lib-chatdock-bar').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
  await tick()
})
assert.ok(bodies.filter(body => body.endpoint === 'chat-open').length > chatOpensBefore, 'reopening asks the host for a session')
assert.ok(bodies.filter(body => body.endpoint === 'chat-open').at(-1).payload.fresh === true, 'list-view open starts a NEW conversation')
assert.ok(container.querySelector('.lib-chatdock-panel'), 'the dock is open again')

// The dock header: 新对话 is an icon+text button, highlighted, and sits to the
// LEFT of the 在原生对话界面中打开 button.
const headActions = [...container.querySelectorAll('.lib-chatdock-head .lib-chatdock-actions > button')]
const newChatBtn = headActions.find(node => node.classList.contains('lib-newchat'))
const nativeBtn = headActions.find(node => node.title === '在原生对话界面中打开')
assert.ok(newChatBtn, '新对话 button rendered in the dock header')
assert.ok(newChatBtn.textContent.includes('新对话') && newChatBtn.querySelector('svg'), '新对话 carries icon AND text')
assert.ok(nativeBtn && headActions.indexOf(newChatBtn) < headActions.indexOf(nativeBtn), '新对话 sits left of the native-open button')
const sendsBefore = bodies.filter(body => body.endpoint === 'chat-open' && body.payload.fresh === true).length
await act(async () => {
  newChatBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
  await tick()
})
assert.ok(bodies.filter(body => body.endpoint === 'chat-open' && body.payload.fresh === true).length > sendsBefore, '新对话 starts a fresh session from the list view')

// Dock sends carry the context preamble; exercised end-to-end through the
// drag-in import → "fix metadata with the agent" flow.
const dropZone = container.querySelector('.lib-middle')
const file = new window.File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'mystery-paper.pdf', { type: 'application/pdf' })
await act(async () => {
  const drop = new window.MouseEvent('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } })
  dropZone.dispatchEvent(drop)
  for (let i = 0; i < 16; i += 1) await tick()
})
assert.ok(calls.includes('upload'), 'dropped file uploaded for import')
// Two-phase import: the staged attachment item shows up (and is located) at
// once; metadata resolution runs afterwards through import-finalize.
const uploadBody = bodies.filter(body => body.endpoint === 'upload').at(-1)
assert.ok(uploadBody?.payload?.deferMetadata === true, 'drag import stages the attachment item first')
const finalizeBody = bodies.find(body => body.endpoint === 'import-finalize')
assert.ok(finalizeBody?.payload?.attachmentKey === 'GGGGGGGG', 'metadata resolution runs as the second import phase')
const stagedRow = container.querySelector('[data-key="GGGGGGGG"]')
assert.ok(stagedRow, 'the staged attachment row renders right after the drop')
assert.ok(stagedRow.classList.contains('selected'), 'the staged row is auto-selected (located)')
assert.ok(scrollIntoViewCalls.includes('GGGGGGGG'), 'the located row is scrolled into view')
const fixButton = [...container.querySelectorAll('.lib-import-fix button')].find(node => node.textContent.includes('AI 补全'))
assert.ok(fixButton, 'agent metadata-fix button offered for the incomplete import')
await act(async () => {
  fixButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
  await tick()
})
const sentBody = [...bodies].reverse().find(body => body.endpoint === 'chat-send')
assert.ok(sentBody, 'chat-send issued')
assert.equal(sentBody.payload.context.mode, 'list', 'dock context travels with the task message')
assert.ok(sentBody.payload.text.includes('mystery-paper.pdf'), 'the task names the imported file')
assert.equal(nativeOpens.length, 0, 'sending keeps the conversation docked, no native jump')

console.log('MARK0 ctxmenu')

// Zotero's item context menu: right-click opens it on the row's selection and
// every entry funnels into a channel call.
const firstRow = container.querySelector('[data-key="AAAAAAAA"]')
assert.ok(firstRow, 'first item row carries its key')
await act(async () => {
  firstRow.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }))
  await tick()
})
const ctxMenu = container.querySelector('.lib-ctxmenu')
assert.ok(ctxMenu, 'right-click opens the item context menu')
const ctxLabels = [...ctxMenu.querySelectorAll('.lib-ctx-item > .lib-ctx-label')].map(node => node.textContent)
for (const label of ['打开附件', '新建条目笔记', '添加到分类', '创建条目副本', '复制 BibTeX 引用', '复制为 CSL JSON', '删除条目…']) {
  assert.ok(ctxLabels.some(text => text.includes(label)), `context menu offers ${label}`)
}
assert.ok(ctxMenu.textContent.includes('合并条目'), 'merge offered for regular items')
// Click the 添加到分类 entry to open its submenu, then add to Cas-Screen.
// (Assertions run outside act like everywhere else in this suite: React 18's
// async act flushes when the scope closes, not at inner awaits.)
await act(async () => {
  const entry = [...ctxMenu.querySelectorAll('.lib-ctx-item')].find(node => node.textContent.includes('添加到分类'))
  entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
const sub = container.querySelector('.lib-ctx-sub')
assert.ok(sub, 'collection submenu opens on click')
assert.ok(sub.textContent.includes('Cas-Screen'), 'submenu lists the collection')
await act(async () => {
  ;[...sub.querySelectorAll('.lib-ctx-item')].find(node => node.textContent.includes('Cas-Screen'))
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
const addCollBody = bodies.filter(body => body.endpoint === 'update').find(body => body.payload?.patch?.addCollections)
assert.ok(addCollBody?.payload?.patch?.addCollections[0] === 1, 'add-to-collection writes the membership')
// Trash through the menu (context menu closed by the previous action).
await act(async () => {
  firstRow.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }))
  await tick()
})
const trashEntry = [...container.querySelectorAll('.lib-ctxmenu .lib-ctx-item')].find(node => node.textContent.includes('删除条目'))
assert.ok(trashEntry, 'the context menu reopens for the selected row')
await act(async () => {
  trashEntry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
const trashBody = bodies.filter(body => body.endpoint === 'trash').at(-1)
assert.ok(trashBody?.payload?.keys?.includes('AAAAAAAA') && trashBody.payload.restore === false, 'menu 删除条目 moves the row to the trash')

console.log('MARK1 reselect')

// Re-select the paper row: the menu-driven trash cleared the selection, and
// the viewer test needs its attachment visible in the details pane again.
await act(async () => {
  container.querySelector('[data-key="AAAAAAAA"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  for (let i = 0; i < 4; i += 1) await tick()
})

// The in-app viewer ("dsh 内建查看器"): "打开 PDF" opens a pdf.js viewer tab.
// jsdom cannot paint canvases, but pdf.js (main-thread mode via the bundled
// WorkerMessageHandler) parses the real fixture, so the page placeholder gets
// its true size and the toolbar reports the page count. Real painting is
// covered by scripts/reader-e2e.mjs in a real browser.
console.log('MARK2 openpdf')

const openPdf = [...container.querySelectorAll('button')].find(node => node.textContent.includes('打开 PDF'))
assert.ok(openPdf, 'open PDF button rendered')
await act(async () => {
  openPdf.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  for (let i = 0; i < 6; i += 1) await tick()
})
assert.ok(fileRouteHits > 0, 'binary PDF route requested')
assert.ok(calls.includes('annotations-list'), 'the viewer loads the attachment annotation rows')
assert.ok(container.querySelector('.lib-reader'), 'viewer column rendered')
assert.ok(container.querySelector('.lib-pdf-root'), 'pdf.js viewer body rendered')
assert.ok(container.querySelector('.lib-pdf-page[data-page="1"]'), 'page placeholder laid out')
assert.ok(container.querySelector('.lib-pdf-annos g[data-anno-key="DDDDDDDD"]'), 'highlight overlay rendered from the mocked Zotero row (uniform SVG fills)')
// The right pane (文献信息) follows the reader tab: it now shows the article
// behind the open tab (its parent item), not the last list selection.
const itemCallsAfterOpen = bodies.filter(body => body.endpoint === 'item')
assert.ok(itemCallsAfterOpen.at(-1)?.payload?.key === 'BBBBBBBB', 'opening a reader tab loads the tab item into the right pane')
assert.ok(container.querySelector('.lib-right-wrap')?.textContent.includes('Another item'), 'the details pane shows the reader tab article')

// Multi-line hover: the outline covers EVERY line of the annotation (the old
// per-rect CSS :hover could only reach the single sibling under the mouse).
console.log('MARK3 annhover')

const twoLineStrip = container.querySelector('.lib-pdf-anno-hit[data-anno-key="FFFF0000"]')
assert.ok(twoLineStrip, 'two-line underline hit strip rendered')
await act(async () => {
  twoLineStrip.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
  await tick()
})
assert.equal(container.querySelectorAll('.lib-pdf-page[data-page="1"] .lib-pdf-annos rect').length, 2, 'hover outlines both lines of the two-line underline')
await act(async () => {
  twoLineStrip.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true }))
  await tick()
})
assert.equal(container.querySelectorAll('.lib-pdf-page[data-page="1"] .lib-pdf-annos rect').length, 0, 'leaving the strip clears the hover outline')
assert.ok([...container.querySelectorAll('.lib-rdr-numpages')].some(node => node.textContent.includes('/ 2')), 'parsed document reports page count')

// 打开方式: dsh-style split control — the left half shows the preferred
// application's icon and opens with it, the chevron opens the native Menu.
assert.ok(container.querySelector('.lib-rdr-openwith-main img'), 'preferred application icon rendered in the open-with control')
assert.ok(container.querySelector('.lib-rdr-openwith-chev'), 'the chevron offers the application menu')
await act(async () => {
  container.querySelector('.lib-rdr-openwith-chev').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
const appItem = container.querySelector('[data-menu-item]')
assert.ok(appItem, 'application menu items rendered through the dsh Menu')
const appId = appItem.getAttribute('data-menu-item')
await act(async () => {
  appItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  for (let i = 0; i < 3; i += 1) await tick()
})
const withBody = [...bodies].reverse().find(body => body.endpoint === 'open-with')
assert.ok(withBody && withBody.payload.application === appId, 'open-with carries the chosen application id')

// The icon half opens with the preferred program: it asks the host to open the
// ATTACHMENT key (regression — a self attachment's row has no `key` field, and
// the old open path crashed with "the path argument must be of type string").
await act(async () => {
  container.querySelector('.lib-rdr-openwith-main').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  for (let i = 0; i < 3; i += 1) await tick()
})
const openByAttachment = [...bodies].reverse().find(body => body.endpoint === 'open')
assert.ok(openByAttachment && openByAttachment.payload.key === 'CCCCCCCC', 'default-open asks the host to open the attachment key')

// Rotating the CURRENT page swaps that page box's aspect (portrait → landscape).
const page1Box = container.querySelector('.lib-pdf-page[data-page="1"]')
const widthBefore = Number.parseFloat(page1Box.style.width)
const heightBefore = Number.parseFloat(page1Box.style.height)
assert.ok(heightBefore > widthBefore, 'fixture page is portrait before rotation')
const rotateRight = [...container.querySelectorAll('.lib-rdr-btn')].find(node => node.title === '顺时针旋转当前页')
assert.ok(rotateRight, 'rotate button rendered')
await act(async () => {
  rotateRight.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
const page1Rotated = container.querySelector('.lib-pdf-page[data-page="1"]')
const widthAfter = Number.parseFloat(page1Rotated.style.width)
const heightAfter = Number.parseFloat(page1Rotated.style.height)
assert.ok(widthAfter > heightAfter, 'rotated page box swaps to landscape')

// Selection popup: stub a live selection over page 1, mouseup → popup with
// five equal action buttons and one compact row of highlight colors. 译 starts
// the streaming translation inside the popup; 添加到备注 turns the result
// into a note annotation (comment = translation).
const scrollColumn = container.querySelector('.lib-pdf-scroll')
const page1ForSelection = container.querySelector('.lib-pdf-page[data-page="1"]')
assert.ok(scrollColumn && page1ForSelection, 'reader ready for the selection popup test')
const realGetSelection = window.getSelection
// jsdom has no layout: give the anchor page a real box so the popup's rect
// filtering (which clips selection fragments to the page) accepts ours.
const realPageRect = page1ForSelection.getBoundingClientRect.bind(page1ForSelection)
page1ForSelection.getBoundingClientRect = () => ({ left: 0, top: 0, right: 660, bottom: 880, width: 660, height: 880 })
const fakeSelection = {
  isCollapsed: false,
  rangeCount: 1,
  toString: () => 'The sample paper reports capsid assembly.',
  getRangeAt: () => ({
    startContainer: page1ForSelection,
    startOffset: 0,
    getClientRects: () => [{ left: 20, top: 40, right: 220, bottom: 60 }],
  }),
  removeAllRanges: () => { fakeSelection.isCollapsed = true },
}
window.getSelection = () => fakeSelection
await act(async () => {
  scrollColumn.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 200, clientY: 60 }))
  await tick()
})
const popupEl = container.querySelector('.lib-sel-popup')
assert.ok(popupEl, 'selection popup rendered on mouseup with a live selection')
const actionButtons = [...popupEl.querySelectorAll('.lib-sel-btn')]
assert.equal(actionButtons.length, 5, '高亮/下划线/注/复制/译 buttons rendered')
assert.equal(actionButtons[2].textContent.trim(), '注', 'button order: 注 third')
assert.ok(actionButtons[3].querySelector('svg'), 'button order: 复制 fourth (icon button)')
assert.equal(actionButtons[4].textContent.trim(), '译', 'button order: 译 last')
assert.ok(actionButtons[0].querySelector('.lib-sel-dot'), 'highlight button carries the current color pip')
const colorRow = popupEl.querySelector('.lib-sel-colors')
assert.ok(colorRow, 'color row rendered')
assert.equal(colorRow.querySelectorAll('.lib-sel-color').length, 8, 'all eight colors offered in a single row')

// 色块独立：点击色块只改默认颜色，不立即高亮；随后的高亮用选中的颜色。
const createsBefore = bodies.filter(body => body.endpoint === 'annotation-create').length
const greenSwatch = [...colorRow.querySelectorAll('.lib-sel-color')].find(node => node.title.includes('绿色'))
assert.ok(greenSwatch, 'green swatch offered')
await act(async () => {
  greenSwatch.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.equal(bodies.filter(body => body.endpoint === 'annotation-create').length, createsBefore, 'picking a color only changes the default, no immediate highlight')
await act(async () => {
  actionButtons[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  for (let i = 0; i < 3; i += 1) await tick()
})
const pickedBody = [...bodies].reverse().find(body => body.endpoint === 'annotation-create')
assert.ok(pickedBody?.payload?.annotation?.color === '#5fb236', 'highlight uses the picked default color')
assert.ok(!container.querySelector('.lib-sel-popup'), 'popup closed after highlighting')

// 重新划词 → 「译」：流式面板叠在颜色行之下，完成后按下划线批注落库。
fakeSelection.isCollapsed = false
await act(async () => {
  scrollColumn.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 200, clientY: 60 }))
  await tick()
})
const popupAgain = container.querySelector('.lib-sel-popup')
assert.ok(popupAgain, 'popup reopens for the translate flow')
translateEvents = [
  { type: 'thinking', text: '先分析句子结构。' },
  { type: 'thinking', text: '再组织译文。' },
  { type: 'answer', text: '这是' },
  { type: 'answer', text: '流式译文。' },
  { type: 'done' },
]
const translateBtn = [...popupAgain.querySelectorAll('.lib-sel-btn')].find(node => node.textContent.includes('译'))
assert.ok(translateBtn, 'translate button rendered')
await act(async () => {
  translateBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  for (let i = 0; i < 8; i += 1) await tick()
})
assert.equal(translateStreamBodies.length, 1, 'one translate stream requested')
assert.equal(translateStreamBodies[0].text, 'The sample paper reports capsid assembly.', 'the selected text travels to the host')
assert.ok(container.querySelector('.lib-sel-trans'), 'translate block rendered inside the popup')
assert.ok(container.querySelector('.lib-sel-actions'), 'action buttons stay visible while translating')
assert.ok(container.querySelector('.lib-sel-colors'), 'color row stays visible while translating')
assert.ok(container.querySelector('.lib-sel-trans-text').textContent.includes('流式译文'), 'answer streamed into the popup')
assert.ok(container.querySelector('.lib-sel-trans-think'), 'thinking block rendered')
assert.ok(!container.querySelector('.lib-sel-trans-think-body'), 'thinking collapsed itself once the answer started')
assert.ok(container.querySelector('.lib-sel-trans-add'), '添加到备注 offered after completion')
await act(async () => {
  container.querySelector('.lib-sel-trans-add').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  for (let i = 0; i < 4; i += 1) await tick()
})
const noteBody = [...bodies].reverse().find(body => body.endpoint === 'annotation-create')
assert.ok(noteBody, 'adding to notes created an annotation')
assert.equal(noteBody.payload.annotation.type, 5, 'the translation lands as an underline annotation')
assert.ok(noteBody.payload.annotation.comment.includes('流式译文'), 'the comment carries the translation')
assert.ok(!container.querySelector('.lib-sel-trans'), 'popup closed after adding the note')

// 划词自动翻译：设置打开后（settings-saved 事件刷新 snapshot），浮窗一出现
// 翻译就开始，无需点「译」。
stateSettings.translate.auto = true
await act(async () => {
  window.dispatchEvent(new window.CustomEvent('dsh-library:settings-saved', {
    detail: { ...stateSettings, translate: { ...stateSettings.translate } },
  }))
  for (let i = 0; i < 4; i += 1) await tick()
})
fakeSelection.isCollapsed = false
translateEvents = [
  { type: 'answer', text: '自动译文。' },
  { type: 'done' },
]
await act(async () => {
  scrollColumn.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 210, clientY: 80 }))
  for (let i = 0; i < 8; i += 1) await tick()
})
assert.ok(container.querySelector('.lib-sel-trans'), 'auto translate starts with the popup (setting on)')
assert.equal(translateStreamBodies.length, 2, 'auto translate issued its own stream request without the 译 click')
assert.ok(container.querySelector('.lib-sel-trans-text').textContent.includes('自动译文'), 'auto translation streamed')
assert.ok(container.querySelector('.lib-sel-colors'), 'color row still offered above the auto translation')
// 点击别处 → 浮窗关闭，翻译随之中止。
fakeSelection.isCollapsed = true
await act(async () => {
  scrollColumn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.ok(!container.querySelector('.lib-sel-trans'), 'clicking elsewhere dismisses the popup and stops the translation')
window.getSelection = realGetSelection
page1ForSelection.getBoundingClientRect = realPageRect
stateSettings.translate.auto = false

// Hyperlinks: the fixture page 1 carries an internal GoTo link (→ page 2) and
// an external URI link. Internal jumps stay inside the pane; external links
// go through the host's open-url channel (mocked here — nothing really opens).
const internalLink = container.querySelector('.lib-pdf-link[data-external="0"]')
const externalLink = container.querySelector('.lib-pdf-link[data-external="1"]')
assert.ok(internalLink && externalLink, 'link hotspots rendered from the PDF annotations')
await act(async () => {
  internalLink.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  for (let i = 0; i < 4; i += 1) await tick()
})
const paneInput = container.querySelector('.lib-rdr-page-input')
assert.ok(paneInput, 'pane toolbar page input rendered')
assert.equal(paneInput.value, '2', 'internal link jumped within the pane (page 2)')
await act(async () => {
  externalLink.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  for (let i = 0; i < 4; i += 1) await tick()
})
assert.ok(calls.includes('open-url'), 'web link asked the host to open the system browser')

// The find bar opens below the toolbar (searching itself needs a real browser
// — jsdom cannot fire React input events, see 陷阱 11 — and is covered by the
// reader e2e).
const findButton = [...container.querySelectorAll('.lib-rdr-btn')].find(node => node.title === '在文档中查找')
assert.ok(findButton, 'find button rendered')
await act(async () => {
  findButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.ok(container.querySelector('.lib-rdr-findbar input'), 'find bar with input rendered')

// Split view: two stacked panes over the SAME document. The new pane starts
// from the FIRST pane's current page (page 2 after the link jump above), each
// pane keeps its own toolbar/scroll/zoom, and the annotation list is shared —
// overlays appear in both panes without a refetch.
const splitBtn = [...container.querySelectorAll('.lib-rdr-btn')].find(node => node.title === '分屏阅读（同一文档两屏独立查看）')
assert.ok(splitBtn, 'split toggle button rendered with a visible label')
assert.ok(splitBtn.textContent.includes('分屏'), 'split button carries text, not icon only')
await act(async () => {
  splitBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.equal(container.querySelectorAll('.lib-rdr-pane').length, 2, 'split view renders two panes')
assert.equal(container.querySelectorAll('.lib-rdr-toolbar').length, 2, 'each pane carries its own toolbar')
assert.equal(container.querySelectorAll('.lib-pdf-page[data-page="2"]').length, 2, 'both panes lay out the same document')
const splitInputs = [...container.querySelectorAll('.lib-rdr-page-input')]
assert.equal(splitInputs[1].value, '2', 'the new pane starts from the current page, not page 1')
assert.ok(container.querySelector('.lib-pdf-split.axis-h'), 'default split axis is 横向 (top/bottom)')
assert.ok(container.querySelector('.lib-pdf-divider'), 'a divider separates the panes')
assert.equal(container.querySelectorAll('.lib-pdf-annos g[data-anno-key="DDDDDDDD"]').length, 2, 'annotation overlay syncs into both panes')
// Axis switch: 横向（上下）↔ 纵向（左右），persisted for the next session.
const axisBtn = [...container.querySelectorAll('.lib-rdr-btn')].find(node => node.textContent === '横向')
assert.ok(axisBtn, 'direction toggle button rendered while split is on')
await act(async () => {
  axisBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.ok(container.querySelector('.lib-pdf-split.axis-v'), 'switching to 纵向 (left/right) flips the flex direction')
assert.equal(container.querySelectorAll('.lib-rdr-pane').length, 2, 'switching the axis keeps both panes mounted')
assert.equal(localStorage.getItem('dsh-library:reader-split'), 'v', 'split direction is remembered')
const axisBack = [...container.querySelectorAll('.lib-rdr-btn')].find(node => node.textContent === '纵向')
await act(async () => {
  axisBack.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.ok(container.querySelector('.lib-pdf-split.axis-h'), 'switching back restores 横向')
const exitSplit = [...container.querySelectorAll('.lib-rdr-btn')].find(node => node.title === '退出分屏')
assert.ok(exitSplit, 'the toggle offers exiting split view')
await act(async () => {
  exitSplit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.equal(container.querySelectorAll('.lib-rdr-pane').length, 1, 'exiting split restores one pane')
assert.ok(container.querySelector('.lib-rdr-openwith-main[aria-label="在系统默认阅读器中打开"]'), 'open-with (system reader) control still offered')

assert.ok(container.textContent.includes('文献列表'), 'list tab rendered')
assert.ok(container.querySelector('.lib-back-to-chat'), 'back-to-chat button shown while the sidebar is hidden')
assert.ok([...container.querySelectorAll('.lib-midcol .lib-tab')].some(node => node.textContent.includes('文献列表')), 'the tab strip lives inside the middle column and always offers the list tab')
assert.ok(container.querySelector('.lib-chatdock'), 'chat dock still visible in viewer mode')
const tabClose = container.querySelector('.lib-tab .lib-tab-close')
assert.ok(tabClose, 'tab close button rendered')
await act(async () => {
  tabClose.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.ok(!container.querySelector('.lib-pdf-root'), 'closing the tab restores the list')

// Toast = 可复制错误：无 WebDAV 时点同步弹出配置提示，正文可选中、一键复制。
const syncBtn = [...container.querySelectorAll('button')].find(node => node.textContent.includes('同步'))
assert.ok(syncBtn, 'sync button rendered')
await act(async () => {
  syncBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
const toastText = container.querySelector('.lib-toast .lib-toast-text')
assert.ok(toastText && toastText.textContent.includes('WebDAV'), 'sync without WebDAV shows the config notice')
const toastCopy = container.querySelector('.lib-toast .lib-toast-copy')
assert.ok(toastCopy, 'the toast offers a copy button')
await act(async () => {
  toastCopy.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.ok(container.querySelector('.lib-toast .lib-toast-copy')?.textContent.includes('已复制'), 'copy feedback flips the button label')
await act(async () => {
  const backBtn = container.querySelector('.lib-back-to-chat')
  if (backBtn) backBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.equal(mounted.get('active'), null, 'the left-pane button returns to the conversation')

// The footer entry toggles the main panel selection through ctx.layout.
const footerButton = container.querySelector('.lib-footer-entry')
await act(async () => {
  footerButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.equal(mounted.get('active'), 'library', 'the entry opens the library panel')
await act(async () => {
  footerButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.equal(mounted.get('active'), null, 'clicking the active entry returns to the conversation')

root.unmount()

// The 文库 settings page (rendered inside dsh's native settings modal) mounts
// standalone: tabbed rows over the mock channel, no crash, save flow wired.
const SettingsSection = mounted.get('settings.section')
assert.ok(SettingsSection, 'settings section component registered')
const settingsRoot = ReactDOMClient.createRoot(container)
await act(async () => {
  settingsRoot.render(React.createElement(SettingsSection, { close: () => {} }))
  await tick()
  await tick()
  await tick()
})
assert.ok(container.textContent.includes('数据来源'), 'settings tabs render')
assert.ok(container.textContent.includes('Zotero 数据目录'), 'source rows render')
assert.ok(calls.includes('state'), 'settings page fetched the library state')
await act(async () => {
  const pdfTab = [...container.querySelectorAll('button')].find(node => node.textContent.includes('PDF 与导出'))
  pdfTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.ok(container.textContent.includes('dsh 内建查看器'), 'pdfOpen segmented control renders on its tab')
await act(async () => {
  const aiTab = [...container.querySelectorAll('button')].find(node => node.textContent.includes('AI 翻译'))
  aiTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.ok(container.textContent.includes('翻译时开启思考'), 'translate thinking row renders')
assert.ok(container.textContent.includes('划词后自动翻译'), 'auto-translate switch row renders')
assert.ok(container.textContent.includes('跟随 dsh 当前模型'), 'model source segmented control renders')
assert.ok(calls.includes('translate-models'), 'model catalog fetched for the settings page')
await act(async () => {
  const save = [...container.querySelectorAll('button')].find(node => node.textContent.includes('保存'))
  save.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
  await tick()
})
assert.ok(calls.includes('settings-set'), 'save posts the settings patch')
const saveBody = [...bodies].reverse().find(body => body.endpoint === 'settings-set')
assert.ok(saveBody?.payload?.patch?.translate, 'the settings patch carries the translate section')
settingsRoot.unmount()

console.log('client-smoke: OK')
