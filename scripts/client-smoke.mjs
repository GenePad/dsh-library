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

const collection = { id: 1, key: 'COLLAAAA', name: 'Cas-Screen', parentID: null, count: 0, totalCount: 2, children: [] }
const items = [
  {
    key: 'AAAAAAAA', itemType: 'journalArticle', title: 'A test paper about AAV capsids',
    date: '2024', year: 2024, doi: '10.1/test', creators: 'Zhang et al.',
    creatorList: [{ firstName: 'San', lastName: 'Zhang', fieldMode: 0 }],
    publicationTitle: 'Nature Reviews', publisher: '', tags: ['AAV'], firstCreator: 'Zhang',
    hasAttachment: true, dateAdded: '2026-01-01 00:00:00', dateModified: '2026-01-01 00:00:00',
  },
  {
    key: 'BBBBBBBB', itemType: 'book', title: 'Another item',
    date: '2020', year: 2020, doi: '', creators: 'Li', creatorList: [],
    publicationTitle: '', publisher: 'Springer', tags: [], firstCreator: 'Li',
    hasAttachment: false, dateAdded: '2026-01-01 00:00:00', dateModified: '2026-01-01 00:00:00',
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
globalThis.fetch = async (url, options) => {
  if (String(url).includes('api/library/file')) {
    // Binary reader route: headers + arrayBuffer, no JSON envelope.
    fileRouteHits += 1
    const bytes = Buffer.from(fs.readFileSync(path.join(PLUGIN, 'scripts', 'fixtures-smoke.pdf')))
    return {
      ok: true,
      headers: { get: name => ({ 'content-type': 'application/pdf', 'x-library-attachment-key': 'CCCCCCCC', 'x-library-parent-key': 'AAAAAAAA', 'x-library-title': 'sample.pdf' }[name] ?? null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
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
        settings: { mode: 'zotero', zoteroDataDir: '', webdav: { url: '', username: '', hasPassword: false }, autoSync: false, updateFeed: '' },
        sync: { running: false, last: null }, revision: 1, version: '0.2.0',
      }
      break
    case 'collections':
      value = { collections: [collection], unfiled: 0, trash: 0, tags: [{ name: 'AAV', count: 2 }] }
      break
    case 'items':
      value = { total: items.length, offset: 0, limit: 100, items }
      break
    case 'item':
      value = detail
      break
    case 'annotations-list':
      value = {
        annotations: [{
          key: 'DDDDDDDD', type: 1, color: '#ffd400', pageLabel: '2', text: 'highlighted words',
          comment: 'my comment', position: { pageIndex: 0, rects: [[10, 10, 100, 30]] }, parentKey: 'CCCCCCCC',
        }],
      }
      break
    case 'annotation-create':
      value = { key: 'EEEE1111' }
      break
    case 'ping':
      value = { revision: 1 }
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
      value = {
        parentKey: 'EEEEEEEE', attachmentKey: 'FFFFFFFF', fileName: 'mystery-paper.pdf',
        metadata: { source: 'none', confidence: 0, needsReview: true },
        needsMetadataHelp: true, textChars: 0, annotations: { extracted: 0, added: 0 },
      }
      break
    default:
      value = {}
  }
  return { ok: true, json: async () => ({ ok: true, value }) }
}

let registration
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
    return { Button, Checkbox, Input, SegmentedControl, SegmentedTabs, Switch, Tag }
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
    callback({ uiWorkspace: { openSession(id) { nativeOpens.push(id) } } })
    return () => {}
  },
  slots: {
    inject(_name, callback) {
      callback()
      return () => {}
    },
    register(options, component) {
      mounted.set(options.name === 'main' ? `main:${options.key}` : options.name, component)
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
assert.ok(afterSelect.includes('期刊论文'), 'detail type pill rendered')
assert.ok(afterSelect.includes('Zhang'), 'creator rendered')
assert.ok(afterSelect.includes('Nature'), 'field rendered')
assert.ok(afterSelect.includes('打开 PDF'), 'open button rendered')

// The column picker adds and removes list columns like Zotero's.
const colBtn = container.querySelector('.lib-colbtn')
assert.ok(colBtn, 'column picker button rendered')
await act(async () => {
  colBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
const journalItem = [...container.querySelectorAll('.lib-colitem')].find(node => node.textContent.includes('期刊/出版物'))
assert.ok(journalItem, 'journal column offered')
await act(async () => {
  journalItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
})
assert.ok([...container.querySelectorAll('.lib-table-head span, .lib-table-head button')].some(node => node.textContent.includes('期刊/出版物')), 'journal column shown')
assert.ok(container.querySelectorAll('.lib-itemrow')[0].textContent.includes('Nature Reviews'), 'journal value rendered in rows')

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

// Dock sends carry the context preamble; exercised end-to-end through the
// drag-in import → "fix metadata with the agent" flow.
const dropZone = container.querySelector('.lib-middle')
const file = new window.File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'mystery-paper.pdf', { type: 'application/pdf' })
await act(async () => {
  const drop = new window.MouseEvent('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } })
  dropZone.dispatchEvent(drop)
  await tick()
  await tick()
  await tick()
})
assert.ok(calls.includes('upload'), 'dropped file uploaded for import')
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

// The in-app viewer ("dsh 内建查看器"): "打开 PDF" opens a pdf.js viewer tab.
// jsdom cannot paint canvases, but pdf.js (main-thread mode via the bundled
// WorkerMessageHandler) parses the real fixture, so the page placeholder gets
// its true size and the toolbar reports the page count. Real painting is
// covered by scripts/reader-e2e.mjs in a real browser.
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
assert.ok(container.querySelector('.lib-pdf-page[data-page="1"] .lib-pdf-anno'), 'annotation overlay rendered from the mocked Zotero row')
assert.ok([...container.querySelectorAll('.lib-rdr-numpages')].some(node => node.textContent.includes('/ 1')), 'parsed document reports page count')

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
  const save = [...container.querySelectorAll('button')].find(node => node.textContent.includes('保存'))
  save.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
  await tick()
})
assert.ok(calls.includes('settings-set'), 'save posts the settings patch')
settingsRoot.unmount()

console.log('client-smoke: OK')
