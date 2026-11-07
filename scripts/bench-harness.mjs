// Shared harness for the viewer benchmarks: stages the REAL client.js (the
// pdf.js viewer needs no engine bundles — it runs main-thread; see
// scripts/reader-e2e.mjs), serves it from a local HTTP server, and drives the
// open-a-PDF flow in real Edge.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

export const PLUGIN = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const mockDataJs = JSON.stringify({
  state: { available: true, dataDir: 'C:/Zotero', dbPath: '', storageDir: '', source: 'default', mode: 'zotero', schemaVersion: 125, counts: { items: 1, attachments: 1, annotations: 0, collections: 0, tags: 0, trash: 0 }, settings: { mode: 'zotero', zoteroDataDir: '', webdav: { url: '', username: '', hasPassword: false }, autoSync: false, updateFeed: '', translate: { model: '', effort: 'off' } }, sync: { running: false, last: null }, revision: 1, version: '0.7.0' },
  collections: { collections: [], unfiled: 0, trash: 0, tags: [] },
  items: { total: 1, offset: 0, limit: 100, items: [{ key: 'AAAAAAAA', itemType: 'journalArticle', title: 'A test paper', date: '2024', year: 2024, doi: '', creators: 'Zhang', creatorList: [], publicationTitle: '', publisher: '', tags: [], firstCreator: 'Zhang', hasAttachment: true, dateAdded: '2026-01-01 00:00:00', dateModified: '2026-01-01 00:00:00' }] },
  item: { key: 'AAAAAAAA', itemType: 'journalArticle', title: 'A test paper', dateAdded: '', dateModified: '', version: 0, synced: false, deleted: false, fields: [{ field: 'title', value: 'A test paper' }], creators: [], tags: [], collections: [], attachments: [{ key: 'CCCCCCCC', title: 'sample.pdf', rawPath: 'storage:sample.pdf', linkMode: 0, contentType: 'application/pdf', syncState: 2, size: 1, target: { kind: 'file', path: 'C:/tmp/sample.pdf' } }], notes: [], annotations: [] },
  annotations: { annotations: [] },
})

/**
 * Boot a benchmark page over one PDF sample.
 * @returns {{browser:object, page:object, close:async ()=>void}}
 */
export async function bootBench(samplePath, { dirName = 'dsh-library-bench', viewport = { width: 1400, height: 1000 } } = {}) {
  const DIR = path.join(process.env.TEMP ?? '/tmp', dirName)
  fs.rmSync(DIR, { recursive: true, force: true })
  fs.mkdirSync(DIR, { recursive: true })
  for (const [from, to] of [
    [path.join(PLUGIN, 'client.js'), 'client.js'],
    [path.join(PLUGIN, 'node_modules/react/umd/react.production.min.js'), 'react.js'],
    [path.join(PLUGIN, 'node_modules/react-dom/umd/react-dom.production.min.js'), 'react-dom.js'],
    [samplePath, 'sample.pdf'],
  ]) {
    fs.copyFileSync(from, path.join(DIR, to))
  }

  const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>BENCH</title><style>html,body,#app{height:100%}body{margin:0;font-family:system-ui}</style></head><body><div id="app"></div>
<script src="./react.js"></script>
<script src="./react-dom.js"></script>
<script>
window.__MOCK__ = ${mockDataJs}
window.__perf = { marks: [], longTasks: [], maxLongTask: 0 }
;(function () {
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__perf.longTasks.push(Math.round(entry.duration))
        window.__perf.maxLongTask = Math.max(window.__perf.maxLongTask, Math.round(entry.duration))
      }
    }).observe({ entryTypes: ['longtask'] })
  } catch { /* longtask unsupported */ }
})()
window.__mark = (name) => { window.__perf.marks.push({ name, t: Math.round(performance.now()) }) }
const realFetch = window.fetch.bind(window)
window.fetch = async (url, options) => {
  const target = String(url)
  if (target.includes('api/library/file')) {
    window.__mark('file-fetched')
    const bytes = new Uint8Array(await (await realFetch('./sample.pdf')).arrayBuffer())
    window.__mark('bytes-ready')
    return {
      ok: true,
      headers: { get: name => ({ 'content-type': 'application/pdf', 'x-library-attachment-key': 'CCCCCCCC', 'x-library-parent-key': 'AAAAAAAA', 'x-library-title': 'sample.pdf' }[name] ?? null) },
      arrayBuffer: async () => bytes.buffer,
    }
  }
  if (target.includes('api/library')) {
    const body = JSON.parse(options.body)
    const mock = window.__MOCK__
    const map = {
      state: mock.state, collections: mock.collections, items: mock.items, item: mock.item,
      'annotations-list': mock.annotations, ping: { revision: 1 },
      'chat-open': { sessionId: 's1' }, 'chat-page': { sessionId: 's1', running: false, messages: [] },
      'chat-send': { sessionId: 's1' }, 'chat-context': { saved: true },
    }
    return { ok: true, json: async () => ({ ok: true, value: map[body.endpoint] ?? {} }) }
  }
  return realFetch(url, options)
}
window.__pluginFactory = null
window.__ModuleLoader__ = { load(value) { window.__pluginFactory = value.factory } }
const jsx = (type, props, key) => {
  const { children, ...rest } = props ?? {}
  return React.createElement(type, { ...rest, key: key ?? undefined }, children)
}
window.__require = (specifier) => {
  if (specifier === 'react') return React
  if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: React.Fragment }
  if (specifier === 'react-dom') return ReactDOM
  if (specifier === 'react-dom/client') return { createRoot: (el) => ({ render: (node) => ReactDOM.createRoot(el).render(node), unmount: () => {} }) }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    return { Button: React.forwardRef((props, ref) => React.createElement('button', { ref, type: 'button', ...props })) }
  }
  throw new Error('unexpected require ' + specifier)
}
</script>
<script src="./client.js"></script>
<script>
const mounted = new Map()
const listeners = new Set()
let panelSnapshot = { activePanelId: null }
const ctx = {
  layout: {
    panelInfo: { getSnapshot: () => panelSnapshot, subscribe: l => { listeners.add(l); return () => listeners.delete(l) } },
    selectPanel(id) { mounted.set('active', id); panelSnapshot = { activePanelId: id }; for (const l of listeners) l() },
    toggleSidebar() {},
  },
  effect(fn) { return fn() },
  inject(_deps, cb) { cb({}); return () => {} },
  slots: { inject(_n, cb) { cb(); return () => {} }, register(o, c) { mounted.set(o.name === 'main' ? 'main:library' : o.name, c); return () => {} } },
}
window.__pluginFactory(window.__require).apply(ctx)
const Page = mounted.get('main:library')
ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(Page, {
  layout: ctx.layout,
  openNativeSession: () => {},
  retainSession: () => ({ release() {} }),
  SessionProvider: p => React.createElement('div', null, p.children),
  renderSlot: (k, o) => React.createElement('div', { 'data-slot': k }, 'conversation'),
}))
</script></body></html>`
  fs.writeFileSync(path.join(DIR, 'index.html'), HTML)

  const server = http.createServer((request, response) => {
    const url = request.url === '/' ? '/index.html' : request.url
    try {
      const data = fs.readFileSync(path.join(DIR, decodeURIComponent(url.split('?')[0])))
      response.writeHead(200, { 'content-type': url.endsWith('.js') ? 'text/javascript' : 'text/html' })
      response.end(data)
    } catch {
      response.writeHead(404); response.end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--disable-gpu'] })
  const page = await browser.newPage({ viewport })
  page.on('pageerror', error => console.error('[pageerror]', String(error).slice(0, 300)))
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.lib-itemrow', { timeout: 20_000 })
  await page.click('.lib-itemrow')
  await page.waitForSelector('button:has-text("打开 PDF")', { timeout: 10_000 })

  const close = async () => {
    await browser.close()
    server.close()
  }
  return { page, close }
}

/** Wait until page N (1-based) has painted: canvas sized and skeleton gone. */
export async function waitPainted(page, pageNumber, timeout = 60_000) {
  await page.waitForFunction((n) => {
    const el = document.querySelector(`.lib-pdf-page[data-page="${n}"]`)
    if (!el) return false
    const canvas = el.querySelector('canvas')
    return Boolean(canvas && canvas.width > 1 && !el.querySelector('.lib-pdf-skel'))
  }, pageNumber, { timeout })
}
