// End-to-end viewer check: load the REAL client.js (unmocked viewer code) in a
// real browser with stubbed dsh platform modules, open a real PDF through the
// UI, then verify painting, zoom, fit-width and the page jump.
//
// The in-app viewer is pdf.js in main-thread mode (the viewer module registers
// pdfjs-dist's WorkerMessageHandler itself), so no engine bundles are staged —
// the harness only serves client.js and the sample PDF.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const PLUGIN = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIR = path.join(process.env.TEMP ?? '/tmp', 'dsh-zot-library-e2e')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const SAMPLE = process.argv[2] ?? 'C:\\Users\\moqiq\\Zotero\\storage\\23A9Q3N2\\Li 等 - 2024 - Rationally engineered novel AAV capsids for intra-.pdf'

fs.rmSync(DIR, { recursive: true, force: true })
fs.mkdirSync(DIR, { recursive: true })
fs.copyFileSync(path.join(PLUGIN, 'client.js'), path.join(DIR, 'client.js'))
fs.copyFileSync(path.join(PLUGIN, 'node_modules/react/umd/react.production.min.js'), path.join(DIR, 'react.js'))
fs.copyFileSync(path.join(PLUGIN, 'node_modules/react-dom/umd/react-dom.production.min.js'), path.join(DIR, 'react-dom.js'))
fs.copyFileSync(SAMPLE, path.join(DIR, 'sample.pdf'))

const fixtureBytes = fs.readFileSync(SAMPLE).toString('base64')
const mockDataJs = JSON.stringify({
  state: { available: true, dataDir: 'C:/Zotero', dbPath: '', storageDir: '', source: 'default', mode: 'zotero', schemaVersion: 125, counts: { items: 1, attachments: 1, annotations: 0, collections: 0, tags: 0, trash: 0 }, settings: { mode: 'zotero', zoteroDataDir: '', webdav: { url: '', username: '', hasPassword: false }, autoSync: false, updateFeed: '', translate: { thinking: false, auto: false, modelSource: 'follow', model: '' } }, sync: { running: false, last: null }, revision: 1, version: '0.8.0' },
  collections: { collections: [], unfiled: 0, trash: 0, tags: [] },
  items: { total: 1, offset: 0, limit: 100, items: [{ key: 'AAAAAAAA', itemType: 'journalArticle', title: 'A test paper', date: '2024', year: 2024, doi: '', creators: 'Zhang', creatorList: [], publicationTitle: '', publisher: '', tags: [], firstCreator: 'Zhang', hasAttachment: true, dateAdded: '2026-01-01 00:00:00', dateModified: '2026-01-01 00:00:00' }] },
  item: { key: 'AAAAAAAA', itemType: 'journalArticle', title: 'A test paper', dateAdded: '', dateModified: '', version: 0, synced: false, deleted: false, fields: [{ field: 'title', value: 'A test paper' }], creators: [], tags: [], collections: [], attachments: [{ key: 'CCCCCCCC', title: 'sample.pdf', rawPath: 'storage:sample.pdf', linkMode: 0, contentType: 'application/pdf', syncState: 2, size: 1, target: { kind: 'file', path: 'C:/tmp/sample.pdf' } }], notes: [], annotations: [] },
  schema: [{ itemType: 'journalArticle', fields: ['title', 'date'], fieldBases: {}, creatorTypes: [{ creatorType: 'author', primary: true }] }],
  annotations: { annotations: [{ key: 'ANNO0001', type: 1, color: '#ffd400', pageLabel: '1', text: 'sample highlight', comment: '', position: { pageIndex: 0, rects: [[57, 640, 540, 660]] }, parentKey: 'CCCCCCCC' }] },
})

const HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>E2E</title><style>
html, body, #app { height: 100%; }
body { margin: 0; font-family: system-ui; }
</style></head><body><div id="app"></div>
<script src="./react.js"></script>
<script src="./react-dom.js"></script>
<script>
window.__MOCK__ = ${mockDataJs}
window.__MOCK_CALLS = []
const realFetch = window.fetch.bind(window)
window.fetch = async (url, options) => {
  const target = String(url)
  if (target.includes('api/library/file')) {
    window.__FILE_HITS = (window.__FILE_HITS ?? 0) + 1
    const bytes = new Uint8Array(await (await realFetch('./sample.pdf')).arrayBuffer())
    return {
      ok: true,
      headers: { get: name => ({ 'content-type': 'application/pdf', 'x-library-attachment-key': 'CCCCCCCC', 'x-library-parent-key': 'AAAAAAAA', 'x-library-title': 'sample.pdf' }[name] ?? null) },
      arrayBuffer: async () => bytes.buffer,
    }
  }
  if (target.includes('api/library/translate')) {
    // Streaming translate route: NDJSON events, one per line.
    window.__MOCK_CALLS.push('translate-stream')
    window.__MOCK_TRANSLATE_TEXT = (JSON.parse(options.body ?? '{}').text) ?? ''
    const lines = [
      { type: 'thinking', text: '理解句意。' },
      { type: 'answer', text: '示例译文' },
      { type: 'answer', text: '（流式输出）。' },
      { type: 'done' },
    ]
    const encoder = new TextEncoder()
    let cursor = 0
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (cursor >= lines.length) return { done: true, value: undefined }
            const value = encoder.encode(\`\${JSON.stringify(lines[cursor])}\n\`)
            cursor += 1
            return { done: false, value }
          },
        }),
      },
    }
  }
  if (target.includes('api/library')) {
    const body = JSON.parse(options.body)
    window.__MOCK_CALLS.push(body.endpoint)
    const mock = window.__MOCK__
    if (body.endpoint === 'settings-set') {
      // Host semantics: merge the patch into settings and answer with the
      // saved settings (the client replays them through settings-saved).
      const patch = body.payload?.patch ?? {}
      mock.state.settings = { ...mock.state.settings, ...patch }
      return { ok: true, json: async () => ({ ok: true, value: JSON.parse(JSON.stringify(mock.state.settings)) }) }
    }
    if (body.endpoint === 'annotation-create') {
      // Echo the created annotation back so overlays carry the real selection
      // geometry (the hit-split probe below tests the created row).
      const row = { key: 'ANNEW' + mock.annotations.annotations.length, parentKey: 'CCCCCCCC', ...(body.payload?.annotation ?? {}) }
      mock.annotations.annotations.push(row)
      window.__MOCK_LAST_NOTE = body.payload?.annotation ?? null
      return { ok: true, json: async () => ({ ok: true, value: { key: row.key } }) }
    }
    const map = {
      state: mock.state, collections: mock.collections, items: mock.items, item: mock.item,
      annotations: mock.annotations, 'annotations-list': mock.annotations,
      ping: { revision: 1 }, 'chat-open': { sessionId: 's1' }, 'chat-page': { sessionId: 's1', running: false, messages: [] },
      'chat-send': { sessionId: 's1' }, 'chat-context': { saved: true },
      upload: { parentKey: 'AAAAAAAA', attachmentKey: 'CCCCCCCC', needsMetadataHelp: false },
    }
    const value = map[body.endpoint] ?? {}
    if (body.endpoint === 'annotations-list') { window.__MOCK_LIST_LEN = (value.annotations ?? []).length; (window.__MOCK_SEQ ??= []).push('list:' + window.__MOCK_LIST_LEN) } else (window.__MOCK_SEQ ??= []).push(body.endpoint)
    // Fresh copies per call: the real host answers with JSON text, so the
    // client never sees the same array/object identity twice.
    return { ok: true, json: async () => ({ ok: true, value: JSON.parse(JSON.stringify(value)) }) }
  }
  return realFetch(url, options)
}
window.__pluginFactory = null
window.__ModuleLoader__ = { load(value) { window.__pluginFactory = value.factory } }
// jsx-runtime shim over the UMD React (dev-only harness).
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
    const ProductIcon = () => null
    return {
      Button: React.forwardRef((props, ref) => React.createElement('button', { ref, type: 'button', ...props })),
      // Host product icons render through dsh's document sprite, absent in
      // this standalone harness — placeholders keep the buttons clickable.
      // The Menu stub renders its anchor so the toolbar keeps its controls.
      Menu: ({ anchor }) => React.createElement('span', null, anchor),
      IconAppsAddOutlineRegular: ProductIcon,
      IconChevronDownOutlineRegular: ProductIcon,
      IconCompareSplitOutlineRegular: ProductIcon,
      IconRightUpOutlineRegular: ProductIcon,
    }
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
let libraryRoot = ReactDOM.createRoot(document.getElementById('app'))
const renderLibrary = () => libraryRoot.render(React.createElement(Page, {
  layout: ctx.layout,
  openNativeSession: () => {},
  retainSession: () => ({ release() {} }),
  SessionProvider: p => React.createElement('div', null, p.children),
  renderSlot: (k, o) => React.createElement('div', { 'data-slot': k }, 'conversation'),
}))
renderLibrary()
// 面板切换 = 整个文库面板卸载重挂：测试用它验证文档热缓存（免重新解析）。
// 卸载后的 root 不能再 render（React #409），重挂必须新建 root。
window.__remountLibrary = async () => {
  libraryRoot.unmount()
  await new Promise(resolve => setTimeout(resolve, 80))
  const host = document.getElementById('app')
  const fresh = document.createElement('div')
  host.replaceChildren(fresh)
  libraryRoot = ReactDOM.createRoot(fresh)
  renderLibrary()
}
</script></body></html>`
fs.writeFileSync(path.join(DIR, 'index.html'), HTML)

const server = http.createServer((request, response) => {
  const url = request.url === '/' ? '/index.html' : request.url
  try {
    const data = fs.readFileSync(path.join(DIR, decodeURIComponent(url.split('?')[0])))
    response.writeHead(200, { 'content-type': url.endsWith('.js') ? 'text/javascript' : 'text/html' })
    response.end(data)
  } catch {
    response.writeHead(404)
    response.end()
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--disable-gpu'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
const errors = []
page.on('pageerror', error => errors.push(String(error?.stack ?? error).slice(0, 600)))
page.on('console', message => {
  if (message.type() === 'error') {
    errors.push(`console.${message.type()}: ${message.text().slice(0, 400)}`)
  }
})
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().includes('favicon')) {
    errors.push(`HTTP ${response.status()} ${response.url().slice(-120)}`)
  }
})

/** Paint proof: the placeholder skeleton is gone and the canvas holds a
 * bitmap; ink counts non-white sampled pixels (near-zero for blank pages). */
const paintProbe = '(() => {\n'
  + '  const page = document.querySelector(\'.lib-pdf-page[data-page="1"]\')\n'
  + '  const canvas = page?.querySelector("canvas")\n'
  + '  if (!canvas || !canvas.width) return { painted: false, canvasSize: null, ink: 0 }\n'
  + '  const ctx = canvas.getContext("2d")\n'
  + '  let ink = 0\n'
  + '  const step = Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / 60))\n'
  + '  for (let y = 0; y < canvas.height; y += step) {\n'
  + '    for (let x = 0; x < canvas.width; x += step) {\n'
  + '      const d = ctx.getImageData(x, y, 1, 1).data\n'
  + '      if (d[0] < 240 || d[1] < 240 || d[2] < 240) ink += 1\n'
  + '    }\n'
  + '  }\n'
  + '  return { painted: !page.querySelector(".lib-pdf-skel") && canvas.width > 0, canvasSize: canvas.width + "x" + canvas.height, ink }\n'
  + '})()'

try {
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.lib-itemrow', { timeout: 20_000 })
  await page.click('.lib-itemrow')
  await page.waitForSelector('button:has-text("打开 PDF")', { timeout: 10_000 })
  await page.click('button:has-text("打开 PDF")')
  try {
    await page.waitForSelector('.lib-pdf-page[data-page="1"]', { timeout: 30_000, state: 'attached' })
  } catch (failure) {
    console.error('viewer did not mount; page errors:', errors.slice(0, 8).join('\n-----\n'))
    console.error('viewer html:', await page.evaluate(() => document.querySelector('.lib-reader')?.innerHTML?.slice(0, 400) ?? 'NONE'))
    console.error('toast:', await page.evaluate(() => document.querySelector('.lib-toast')?.textContent ?? null))
    throw failure
  }
  // pdf.js parses on the main thread; the first visible page paints within a
  // few hundred milliseconds for typical samples.
  let paint = { painted: false }
  for (let i = 0; i < 30 && !paint.painted; i += 1) {
    await page.waitForTimeout(300)
    paint = await page.evaluate(paintProbe)
  }
  console.log('paint:', JSON.stringify(paint))
  if (!paint.painted) throw new Error('page 1 canvas never received real pixels')

  const layout = await page.evaluate(`(() => {
    const pick = (selector) => {
      const el = document.querySelector(selector)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height) }
    }
    return {
      viewer: pick('.lib-reader'),
      page1: pick('.lib-pdf-page[data-page="1"]'),
      numpages: document.querySelector('.lib-rdr-numpages')?.textContent ?? null,
    }
  })()`)
  console.log('layout:', JSON.stringify(layout))
  if (!layout.numpages || !layout.numpages.trim().startsWith('/')) throw new Error('page count missing from the toolbar')

  // Zoom in: the page box widens and the canvas re-renders at a higher
  // resolution (bitmap grows, not just CSS stretch).
  const boxBefore = await page.evaluate('document.querySelector(".lib-pdf-page[data-page=\\"1\\"]").getBoundingClientRect().width')
  const bitmapBefore = await page.evaluate('document.querySelector(".lib-pdf-page[data-page=\\"1\\"] canvas").width')
  await page.click('button[title="放大"]')
  let bitmapAfter = 0
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(250)
    bitmapAfter = await page.evaluate('document.querySelector(".lib-pdf-page[data-page=\\"1\\"] canvas")?.width ?? 0')
    if (bitmapAfter > bitmapBefore * 1.03) break
  }
  const boxAfter = await page.evaluate('document.querySelector(".lib-pdf-page[data-page=\\"1\\"]").getBoundingClientRect().width')
  console.log('zoom: box', Math.round(boxBefore), '→', Math.round(boxAfter), '| canvas bitmap', bitmapBefore, '→', bitmapAfter)
  const zoomOk = boxAfter > boxBefore * 1.03 && bitmapAfter > bitmapBefore * 1.03

  // Fit width returns the page box to the scroll column width.
  await page.click('button[title="缩放到页宽"]')
  await page.waitForTimeout(400)
  const fitState = await page.evaluate('(() => {\n'
    + '  const scroll = document.querySelector(".lib-pdf-scroll")\n'
    + '  const box = document.querySelector(".lib-pdf-page[data-page=\\"1\\"]").getBoundingClientRect()\n'
    + '  return { box: box.width, available: scroll.clientWidth - 18 }\n'
  + '})()')
  console.log('fit:', JSON.stringify(fitState))
  const fitOk = Math.abs(fitState.box - fitState.available) < 6

  // Zoomed OUT below fit width the page column centers horizontally (it used
  // to hug the left edge), then 适应宽度 restores the fit zoom.
  await page.click('button[title="缩小"]')
  await page.waitForTimeout(500)
  const centering = await page.evaluate('(() => {\n'
    + '  const scroll = document.querySelector(".lib-pdf-scroll")\n'
    + '  const sc = scroll.getBoundingClientRect()\n'
    + '  const box = document.querySelector(".lib-pdf-page[data-page=\\"1\\"]").getBoundingClientRect()\n'
    + '  const pad = 9\n'
    + '  return { leftGap: Math.round((box.left - sc.left) - pad), rightGap: Math.round((sc.right - box.right) - pad) }\n'
  + '})()')
  console.log('centering (zoomed out):', JSON.stringify(centering))
  const centerOk = Math.abs(centering.leftGap - centering.rightGap) <= 3 && centering.leftGap > 4
  await page.click('button[title="缩放到页宽"]')
  await page.waitForTimeout(400)

  // The page-number input jumps (only meaningful for multi-page samples).
  const numPages = Number((layout.numpages ?? '/ 1').replace('/', '').trim())
  let jumpOk = numPages < 2
  let jumpNote = 'single-page sample, jump skipped'
  if (numPages >= 2) {
    await page.click('.lib-rdr-page-input')
    await page.fill('.lib-rdr-page-input', '2')
    await page.press('.lib-rdr-page-input', 'Enter')
    await page.waitForTimeout(900)
    const afterJump = await page.evaluate('(() => ({\n'
      + '  currentPageLabel: document.querySelector(".lib-rdr-page-input")?.value,\n'
      + '  page2Visible: (() => { const el = document.querySelector(\'.lib-pdf-page[data-page="2"]\'); if (!el) return false; const r = el.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0 })(),\n'
    + '}))()')
    console.log('jump:', JSON.stringify(afterJump))
    jumpOk = afterJump.currentPageLabel === '2' && afterJump.page2Visible
    jumpNote = JSON.stringify(afterJump)
  }

  // Selection → popup → highlight: the text layer selects, the popup offers
  // highlight/underline/note/copy, and creating one stores a Zotero annotation
  // row (mocked) and renders the overlay from its PDF-space rects. The jump
  // test left the view on page 2 — scroll back so page 1 is on screen. A
  // text-less fixture (near-blank page) skips this section; the real-paper
  // run always exercises it.
  await page.evaluate('document.querySelector(".lib-pdf-scroll").scrollTop = 0')
  await page.waitForTimeout(500)
  const selectableSpans = await page.evaluate('[...document.querySelectorAll(".lib-pdf-page[data-page=\\"1\\"] .lib-pdf-text span")].filter(s => (s.textContent || "").trim().length > 4).length')
  if (selectableSpans >= 2) {
    const selected = await page.evaluate(`(() => {
      const spans = [...document.querySelectorAll('.lib-pdf-page[data-page="1"] .lib-pdf-text span')]
      const usable = spans.filter(span => (span.textContent ?? '').trim().length > 4).slice(0, 2)
      const range = document.createRange()
      range.setStart(usable[0].firstChild, 0)
      range.setEnd(usable[1].firstChild, Math.min(8, usable[1].firstChild.textContent.length))
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      const release = usable[1].getBoundingClientRect()
      const mouseup = new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: release.left + release.width / 2, clientY: release.top + release.height / 2 })
      document.querySelector('.lib-pdf-scroll').dispatchEvent(mouseup)
      return true
    })()`)
    if (!selected) throw new Error('text layer spans were not selectable')
    await page.waitForSelector('.lib-sel-popup', { timeout: 5000 })
    // The popup must anchor near the mouse release point and stay inside the
    // viewer (cross-column / upward selections never push it off-screen).
    const popupBounds = await page.evaluate('(() => {\n'
      + '  const popup = document.querySelector(".lib-sel-popup").getBoundingClientRect()\n'
      + '  const root = document.querySelector(".lib-pdf-root").getBoundingClientRect()\n'
      + '  return { inside: popup.left >= root.left && popup.right <= root.right && popup.top >= root.top && popup.bottom <= root.bottom }\n'
    + '})()')
    if (!popupBounds.inside) throw new Error(`selection popup left the viewer bounds (${JSON.stringify(popupBounds)})`)
    // The uniform selection overlay replaces the native (invisible) ::selection:
    // one flat light blue per page, identical day and night.
    await page.waitForSelector('.lib-pdf-page[data-page="1"] .lib-pdf-sel path', { timeout: 5000 })
    const selOverlay = await page.evaluate('(() => {\n'
      + '  const path = document.querySelector(".lib-pdf-page[data-page=\\"1\\"] .lib-pdf-sel path")\n'
      + '  return { fill: getComputedStyle(path).fill, d: (path.getAttribute("d") ?? "").length }\n'
    + '})()')
    console.log('selection overlay:', JSON.stringify(selOverlay))
    if (!/rgba\(91,\s*157,\s*255,\s*0\.35\)/.test(selOverlay.fill)) throw new Error(`selection overlay is not the unified light blue (${selOverlay.fill})`)
    if (selOverlay.d < 10) throw new Error('selection overlay path carries no geometry')
    await page.click('.lib-sel-popup button[title^="高亮"]')
    await page.waitForTimeout(600)
    const calls = await page.evaluate('window.__MOCK_CALLS')
    const overlay = await page.evaluate('document.querySelectorAll(".lib-pdf-annos g[data-anno-key]").length')
    const selCleared = await page.evaluate('document.querySelector(".lib-pdf-sel path") === null')
    console.log('selection: popup → highlight →', JSON.stringify({ createCalled: calls.includes('annotation-create'), overlays: overlay, selCleared }))
    if (!calls.includes('annotation-create')) throw new Error('highlight selection did not create an annotation')
    if (overlay < 1) throw new Error('annotation overlay never rendered')
    if (!selCleared) throw new Error('selection overlay did not clear after the annotation was created')

    // Interaction split: over the highlight's upper part the text layer
    // (I-beam) must be hit-testable; the bottom strip catches the mouse.
    // Probe the CREATED overlay — its rects come from the real selection, so
    // a span sits inside at least one of its rects. Link hotspots legitimately
    // cover some text (pointer cursor there), so probe a span that no link
    // covers; the small fixture is link-dense and skips.
    const hitSplit = await page.evaluate('(() => {\n'
      + '  const spans = [...document.querySelectorAll(\'.lib-pdf-page[data-page="1"] .lib-pdf-text span\')]\n'
      + '  const anno = document.querySelector(\'.lib-pdf-annos g[data-anno-key="ANNEW1"]\')\n'
      + '  const stripEl = document.querySelector(\'.lib-pdf-anno-hit[data-anno-key="ANNEW1"]\')\n'
      + '  if (!anno || !stripEl) return { verdict: "no-overlay" }\n'
      + '  const r = anno.getBoundingClientRect()\n'
      + '  const overLink = (x, y) => { const el = document.elementFromPoint(x, y); return String(el?.className || "").includes("lib-pdf-link") }\n'
      + '  const probe = spans.find(s => { const b = s.getBoundingClientRect(); const cx = b.left + b.width / 2; const cy = b.top + b.height / 2; return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom && !overLink(cx, cy) })\n'
      + '  if (!probe) return { verdict: "link-covered" }\n'
      + '  const b = probe.getBoundingClientRect()\n'
      + '  const strip = stripEl.getBoundingClientRect()\n'
      + '  // Upper: near the span top — well above the strip, must reach the text\n'
      + '  // layer (I-beam). Lower: the strip center — must catch the mouse.\n'
      + '  const probeX = Math.min(b.left + b.width / 2, window.innerWidth - 30)\n'
      + '  const upperY = Math.max(r.top + 2, b.top + Math.min(4, b.height * 0.25))\n'
      + '  const upper = document.elementFromPoint(probeX, upperY)\n'
      + '  const lower = document.elementFromPoint(Math.min(strip.left + strip.width / 2, window.innerWidth - 30), strip.top + strip.height / 2)\n'
      + '  const verdict = upper === probe && String(lower?.className || "").includes("lib-pdf-anno-hit") ? "split" : "wrong:" + String(upper?.tagName) + "/" + String(lower?.className || "")\n'
      + '  return { verdict }\n'
    + '})()')
    console.log('overlay hit split:', JSON.stringify(hitSplit))
    if (hitSplit.verdict.startsWith('wrong:')) throw new Error(`overlay hit zones do not match the visual split (${JSON.stringify(hitSplit)})`)
    if (hitSplit.verdict === 'none' || hitSplit.verdict === 'no-span' || hitSplit.verdict === 'no-overlay') throw new Error(`no probeable overlay (${JSON.stringify(hitSplit)})`)

    // 译：浮窗内流式翻译。思考块在正文开始后立刻折叠；「添加到备注」把译文
    // 写成笔记批注并关闭浮窗。
    await page.evaluate(`(() => {
      const spans = [...document.querySelectorAll('.lib-pdf-page[data-page="1"] .lib-pdf-text span')]
      const usable = spans.filter(span => (span.textContent ?? '').trim().length > 4).slice(0, 2)
      const range = document.createRange()
      range.setStart(usable[0].firstChild, 0)
      range.setEnd(usable[1].firstChild, Math.min(8, usable[1].firstChild.textContent.length))
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      const release = usable[1].getBoundingClientRect()
      document.querySelector('.lib-pdf-scroll').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: release.left + release.width / 2, clientY: release.top + release.height / 2 }))
      return true
    })()`)
    await page.waitForSelector('.lib-sel-popup', { timeout: 5000 })
    await page.click('.lib-sel-popup button[title="AI 翻译选中文字"]')
    await page.waitForSelector('.lib-sel-trans-text', { timeout: 5000 })
    const translateText = await page.evaluate('document.querySelector(".lib-sel-trans-text").textContent')
    if (!translateText.includes('流式输出')) throw new Error(`translate answer did not stream (${translateText})`)
    const popupKept = await page.evaluate('(() => ({ actions: document.querySelector(".lib-sel-popup .lib-sel-actions") !== null, colors: document.querySelector(".lib-sel-popup .lib-sel-colors") !== null }))()')
    if (!popupKept.actions || !popupKept.colors) throw new Error(`translate block must stack below the buttons/colors inside the popup (${JSON.stringify(popupKept)})`)
    const translateSent = await page.evaluate('window.__MOCK_TRANSLATE_TEXT')
    if (translateSent.trim() === '') throw new Error('the selected text did not reach the translate route')
    await page.waitForSelector('.lib-sel-trans-think', { timeout: 5000 })
    const thinkCollapsed = await page.evaluate('document.querySelector(".lib-sel-trans-think-body") === null')
    if (!thinkCollapsed) throw new Error('thinking block did not collapse once the answer started')
    // 「自动」拨杆：翻译面板头部直接开关划词自动翻译；mock 宿主合并 translate
    // 段后经 settings-saved 回环，拨杆与设置页是同一份设置。
    const switchProbe = '(() => {\n'
      + '  const sw = document.querySelector(".lib-sel-trans .lib-mini-switch")\n'
      + '  return sw ? { role: sw.getAttribute("role"), checked: sw.getAttribute("aria-checked") } : null\n'
    + '})()'
    const switchBefore = await page.evaluate(switchProbe)
    if (!switchBefore || switchBefore.role !== 'switch' || switchBefore.checked !== 'false') {
      throw new Error(`auto-translate switch missing or wrong state (${JSON.stringify(switchBefore)})`)
    }
    await page.click('.lib-sel-trans .lib-mini-switch')
    await page.waitForTimeout(400)
    const switchAfter = await page.evaluate(switchProbe)
    const autoPatch = await page.evaluate('window.__MOCK__.state.settings.translate')
    if (switchAfter.checked !== 'true' || autoPatch?.auto !== true) {
      throw new Error(`auto switch did not persist translate.auto=true (${JSON.stringify({ switchAfter, autoPatch })})`)
    }
    await page.click('.lib-sel-trans .lib-mini-switch')
    await page.waitForTimeout(400)
    const switchReset = await page.evaluate(switchProbe)
    if (switchReset.checked !== 'false') throw new Error('auto switch did not toggle back off')
    await page.click('.lib-sel-trans-add')
    await page.waitForTimeout(500)
    const lastNote = await page.evaluate('window.__MOCK_LAST_NOTE')
    const translateClosed = await page.evaluate('document.querySelector(".lib-sel-trans") === null')
    if (!lastNote || lastNote.type !== 5 || !String(lastNote.comment ?? '').includes('流式输出')) {
      throw new Error(`translate-to-note underline annotation missing (${JSON.stringify(lastNote)})`)
    }
    if (!translateClosed) throw new Error('popup did not close after adding the translation to notes')
    console.log('translate popup: streamed, thinking collapsed, note added')

    // Full-text find: open the bar, query a frequent word taken from the
    // document's own text layer (works for any sample), navigate with 下一处.
    const findWord = await page.evaluate('(() => {\n'
      + '  const counts = new Map()\n'
      + '  for (const span of document.querySelectorAll(".lib-pdf-text span")) {\n'
      + '    for (const word of (span.textContent || "").toLowerCase().match(/[a-z]{5,}/g) ?? []) counts.set(word, (counts.get(word) ?? 0) + 1)\n'
      + '  }\n'
      + '  let best = ""\n'
      + '  let bestCount = 0\n'
      + '  for (const [word, count] of counts) if (count > bestCount) { best = word; bestCount = count }\n'
      + '  return bestCount > 3 ? best : ""\n'
    + '})()')
    if (findWord !== '') {
      const activeMarkVisible = () => page.evaluate('(() => {\n'
        + '  const el = document.querySelector(".lib-pdf-mark.active")\n'
        + '  if (!el) return false\n'
        + '  const r = el.getBoundingClientRect()\n'
        + '  return r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0\n'
      + '})()')
      await page.click('button[title="在文档中查找"]')
      await page.fill('.lib-rdr-findbar input', findWord)
      let findStatus = ''
      for (let i = 0; i < 20; i += 1) {
        await page.waitForTimeout(250)
        findStatus = await page.textContent('.lib-rdr-find-status')
        if (/\d+\s*\/\s*\d+/.test(findStatus)) break
      }
      await page.waitForTimeout(400)
      console.log('find status:', findStatus, `(word: ${findWord})`)
      if (!/\d+\s*\/\s*\d+/.test(findStatus)) throw new Error(`find found nothing (${findStatus})`)
      if (!(await activeMarkVisible())) throw new Error('the first match was not scrolled into view')
      await page.click('.lib-rdr-findbar button[title="下一处"]')
      await page.waitForTimeout(500)
      const findStatusAfter = await page.textContent('.lib-rdr-find-status')
      if (findStatusAfter === findStatus) throw new Error('find navigation did not advance')
      if (!(await activeMarkVisible())) throw new Error('the active match was not scrolled into view')
      await page.click('.lib-rdr-findbar button[title="关闭查找"]')
    }
  } else {
    console.log('selection/find: skipped (fixture has no selectable text)')
  }

  // Hyperlinks: web links ask the host to open the system browser (mocked —
  // recorded, never executed), internal dests jump within the pane. The real
  // sample usually carries both on page 1; skip gracefully when it doesn't.
  await page.evaluate('document.querySelector(".lib-pdf-scroll").scrollTop = 0')
  await page.waitForTimeout(700)
  const linkCounts = await page.evaluate('(() => ({\n'
    + '  internal: document.querySelectorAll(\'.lib-pdf-link[data-external="0"]\').length,\n'
    + '  external: document.querySelectorAll(\'.lib-pdf-link[data-external="1"]\').length\n'
  + '}))()')
  console.log('links:', JSON.stringify(linkCounts))
  let linkJumpOk = true
  let linkJumpNote = 'no internal links on page 1'
  let linkOpenOk = true
  let linkOpenNote = 'no web links on page 1'
  if (linkCounts.internal > 0) {
    const before = await page.evaluate('(() => ({ page: document.querySelector(".lib-rdr-page-input")?.value, top: document.querySelector(".lib-pdf-scroll").scrollTop }))()')
    // Footnote markers often link within the same page; walk a few links until
    // one demonstrably moves the pane (most papers cite figures/references
    // on other pages from page 1).
    const internalLinks = await page.$$('.lib-pdf-link[data-external="0"]')
    for (let i = 0; i < Math.min(internalLinks.length, 15); i += 1) {
      await internalLinks[i].click()
      await page.waitForTimeout(500)
      const after = await page.evaluate('(() => ({ page: document.querySelector(".lib-rdr-page-input")?.value, top: document.querySelector(".lib-pdf-scroll").scrollTop }))()')
      if (after.page !== before.page || after.top !== before.top) {
        linkJumpNote = `link #${i + 1} jumped (page ${before.page} → ${after.page})`
        break
      }
      if (i === Math.min(internalLinks.length, 15) - 1) {
        linkJumpOk = false
        linkJumpNote = 'no internal link moved the pane'
      }
    }
    console.log('internal link jump:', linkJumpNote)
  }
  if (linkCounts.external > 0) {
    await page.click('.lib-pdf-link[data-external="1"]')
    await page.waitForTimeout(400)
    const mockCalls = await page.evaluate('window.__MOCK_CALLS')
    if (!mockCalls.includes('open-url')) throw new Error('web link click did not request open-url')
    linkOpenOk = true
    linkOpenNote = 'open-url requested'
  }
  if (linkCounts.internal + linkCounts.external > 0) {
    // Link hotspots sit above the text layer (like pdf.js); dragging from
    // inside one must still select the underlying text — the browser anchors
    // the selection at the nearest caret and our overlay repaints it.
    // The jump walk may have scrolled away, so bring page 1 back into view.
    await page.evaluate('document.querySelector(".lib-pdf-scroll").scrollTop = 0')
    await page.waitForTimeout(600)
    const linkBox = await page.evaluate('(() => { const el = document.querySelector(".lib-pdf-link"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width } })()')
    if (linkBox) {
      await page.mouse.move(linkBox.x, linkBox.y)
      await page.mouse.down()
      // A fixed, comfortably-long drag: superscript-sized hotspots would fall
      // below the click threshold otherwise (and just trigger the link).
      await page.mouse.move(linkBox.x + 120, linkBox.y + 2, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(400)
      const dragSel = await page.evaluate('(() => { const s = window.getSelection(); return { len: String(s).length, overlay: document.querySelectorAll(".lib-pdf-sel path").length } })()')
      console.log('drag across link:', JSON.stringify(dragSel))
      if (dragSel.len < 2 || dragSel.overlay < 1) throw new Error('dragging across a link did not select text')
      await page.evaluate('window.getSelection()?.removeAllRanges()')
      await page.waitForTimeout(200)
    }
  }
  // Back to page 1 so the rotate test below keeps operating on page 1.
  await page.fill('.lib-rdr-page-input', '1')
  await page.press('.lib-rdr-page-input', 'Enter')
  await page.waitForTimeout(700)

  // Rotate the CURRENT page: portrait → landscape → back (box aspect swaps).
  const boxShape = () => page.evaluate('(() => { const r = document.querySelector(".lib-pdf-page[data-page=\\"1\\"]").getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })()')
  const portrait = await boxShape()
  await page.click('button[title="顺时针旋转当前页"]')
  await page.waitForTimeout(700)
  const landscape = await boxShape()
  await page.click('button[title="逆时针旋转当前页"]')
  await page.waitForTimeout(700)
  const restored = await boxShape()
  console.log('rotate:', JSON.stringify({ portrait, landscape, restored }))
  const rotateOk = landscape.w > landscape.h && portrait.h > portrait.w
    && Math.abs(restored.h - portrait.h) <= 2 && Math.abs(restored.w - portrait.w) <= 2
  if (!rotateOk) throw new Error('page rotation did not swap the page box aspect')

  // Split view: two stacked panes over the same document. Pane state is local
  // (scrolling one must not move the other); the annotation overlay is shared
  // and renders in both panes. The new pane starts from the CURRENT page, and
  // the direction (横向上下 / 纵向左右) can be switched while staying mounted.
  await page.fill('.lib-rdr-page-input', '2')
  await page.press('.lib-rdr-page-input', 'Enter')
  await page.waitForTimeout(500)
  await page.click('button[title^="分屏阅读"]')
  await page.waitForSelector('.lib-pdf-divider', { timeout: 5000 })
  // Let pane 0 settle through the fit-width relayout before sampling anchors.
  await page.waitForTimeout(700)
  const splitState = await page.evaluate('(() => ({\n'
    + '  panes: document.querySelectorAll(".lib-rdr-pane").length,\n'
    + '  toolbars: document.querySelectorAll(".lib-rdr-toolbar").length,\n'
    + '  pageBoxes: document.querySelectorAll(\'.lib-pdf-page[data-page="2"]\').length,\n'
    + '  pages: [...document.querySelectorAll(".lib-rdr-page-input")].map(i => i.value),\n'
    + '  axisH: Boolean(document.querySelector(".lib-pdf-split.axis-h")),\n'
    + '  annoGroups: document.querySelectorAll(".lib-pdf-annos g[data-anno-key]").length,\n'
    + '  scrolls: [...document.querySelectorAll(".lib-pdf-scroll")].map(s => Math.round(s.scrollTop))\n'
  + '}))()')
  console.log('split:', JSON.stringify(splitState))
  const splitOk = splitState.panes === 2 && splitState.toolbars === 2 && splitState.pageBoxes === 2
    && splitState.annoGroups >= 2 && splitState.axisH === true
    && splitState.pages.length === 2 && splitState.pages.every(p => p === '2')
  let splitScrollOk = false
  let splitMirrorOk = false
  if (splitOk) {
    // Scroll only the bottom pane to its end; the top pane must stay put.
    await page.evaluate('(() => { const s = [...document.querySelectorAll(".lib-pdf-scroll")]; s[1].scrollTop = s[1].scrollHeight })()')
    await page.waitForTimeout(700)
    const after = await page.evaluate('(() => { const s = [...document.querySelectorAll(".lib-pdf-scroll")]; return { top: Math.round(s[0].scrollTop), bottom: Math.round(s[1].scrollTop) } })()')
    console.log('split scroll independence:', JSON.stringify(after))
    splitScrollOk = after.bottom > 10 && Math.abs(after.top - splitState.scrolls[0]) < 2
    // Axis switch keeps both panes alive and flips the container direction.
    await page.click('button:has-text("横向")')
    await page.waitForTimeout(400)
    const axisV = await page.evaluate('(() => ({\n'
      + '  axisV: Boolean(document.querySelector(".lib-pdf-split.axis-v")),\n'
      + '  panes: document.querySelectorAll(".lib-rdr-pane").length,\n'
      + '  stored: localStorage.getItem("dsh-zot-library:reader-split")\n'
    + '}))()')
    console.log('axis switch:', JSON.stringify(axisV))
    if (!axisV.axisV || axisV.panes !== 2 || axisV.stored !== 'v') { console.error('axis switch FAILED'); process.exit(1) }
    await page.click('button:has-text("纵向")')
    await page.waitForTimeout(400)
    // 分屏第二屏必须复刻第一屏的视口位置（滚动锚），而不只是同一个页号：
    // 退出分屏后滚到文档中部（页中间）再进分屏，两屏 scrollTop 与 35% 线
    // 所在页都要一致。
    await page.click('button[title="退出分屏"]')
    await page.waitForTimeout(400)
    await page.evaluate('(() => { const s = document.querySelector(".lib-pdf-scroll"); s.scrollTop = s.scrollHeight * 0.4 })()')
    await page.waitForTimeout(700)
    const donorScroll = await page.evaluate('Math.round(document.querySelector(".lib-pdf-scroll").scrollTop)')
    await page.click('button[title^="分屏阅读"]')
    await page.waitForSelector('.lib-pdf-divider', { timeout: 5000 })
    await page.waitForTimeout(900)
    const mirror = await page.evaluate('(() => [...document.querySelectorAll(".lib-rdr-pane")].map(p => {\n'
      + '  const scroll = p.querySelector(".lib-pdf-scroll")\n'
      + '  const line = scroll.getBoundingClientRect().top + scroll.clientHeight * 0.35\n'
      + '  let shown = null\n'
      + '  for (const box of p.querySelectorAll(".lib-pdf-page")) {\n'
      + '    const r = box.getBoundingClientRect()\n'
      + '    if (line >= r.top && line < r.bottom) shown = box.dataset.page\n'
      + '  }\n'
      + '  return { scrollTop: Math.round(scroll.scrollTop), shown }\n'
      + '}))()')
    console.log('split mirror:', JSON.stringify({ donorScroll, mirror }))
    splitMirrorOk = mirror.length === 2
      && Math.abs(mirror[0].scrollTop - donorScroll) <= 6
      && Math.abs(mirror[1].scrollTop - mirror[0].scrollTop) <= 6
      && mirror[0].shown !== null && mirror[0].shown === mirror[1].shown
  }
  await page.click('button[title="退出分屏"]')
  await page.waitForTimeout(400)
  const panesAfterExit = await page.evaluate('document.querySelectorAll(".lib-rdr-pane").length')

  // 保温切换：切到文献列表再切回，查看器组件原样保留（同一 canvas 节点），
  // 滚动位置与页码不动，也从不出现「正在解析」。
  await page.evaluate('(() => {\n'
    + '  window.__cv = document.querySelector(".lib-pdf-page canvas")\n'
    + '  window.__scrollBefore = Math.round(document.querySelector(".lib-pdf-scroll").scrollTop)\n'
    + '  window.__pageBefore = document.querySelector(".lib-rdr-page-input").value\n'
  + '})()')
  await page.click('.lib-midcol .lib-tab:has-text("文献列表")')
  await page.waitForTimeout(400)
  const hiddenWhileList = await page.evaluate('(() => { const el = document.querySelector(".lib-reader"); return el ? getComputedStyle(el).display === "none" : false })()')
  await page.click('.lib-midcol .lib-tab:not(:has-text("文献列表"))')
  await page.waitForTimeout(400)
  const warmSwitch = await page.evaluate('(() => ({\n'
    + '  sameCanvas: document.querySelector(".lib-pdf-page canvas") === window.__cv,\n'
    + '  sameScroll: Math.round(document.querySelector(".lib-pdf-scroll").scrollTop) === window.__scrollBefore,\n'
    + '  samePage: document.querySelector(".lib-rdr-page-input").value === window.__pageBefore,\n'
    + '  parsing: Boolean(document.querySelector(".lib-pv-status"))\n'
  + '}))()')
  console.log('warm tab switch:', JSON.stringify({ hiddenWhileList, ...warmSwitch }))
  const warmOk = hiddenWhileList && warmSwitch.sameCanvas && warmSwitch.sameScroll && warmSwitch.samePage
    && !warmSwitch.parsing

  // 面板切换（卸载重挂）：文档热缓存让重挂免解析——秒级回到带位图的同一页，
  // 字节热缓存保证 file 路由零重取。
  const fileHitsBeforeRemount = await page.evaluate('window.__FILE_HITS ?? 0')
  const remountStartedAt = Date.now()
  await page.evaluate('window.__remountLibrary()')
  let remount = null
  for (let i = 0; i < 24; i += 1) {
    await page.waitForTimeout(100)
    remount = await page.evaluate('(() => ({\n'
      + '  page: document.querySelector(".lib-rdr-page-input")?.value ?? "",\n'
      + '  parsing: Boolean(document.querySelector(".lib-pv-status")),\n'
      + '  painted: (() => { const c = document.querySelector(".lib-pdf-page canvas"); return Boolean(c && c.width > 0) })(),\n'
      + '  fileHits: window.__FILE_HITS ?? 0\n'
    + '}))()')
    if (remount.page !== '' && remount.painted && !remount.parsing) break
  }
  remount = { ...remount, elapsedMs: Date.now() - remountStartedAt }
  console.log('panel remount:', JSON.stringify(remount))
  const remountOk = remount && remount.page !== '' && remount.page === await page.evaluate('window.__pageBefore')
    && remount.painted && !remount.parsing && remount.fileHits === fileHitsBeforeRemount
    && remount.elapsedMs < 1500

  console.log('page errors:', errors.slice(0, 4).join('\n=====\n') || '(none)')
  if (!zoomOk) { console.error('zoom FAILED'); process.exit(1) }
  if (!fitOk) { console.error('fit width FAILED'); process.exit(1) }
  if (!centerOk) { console.error('zoomed-out centering FAILED'); process.exit(1) }
  if (!jumpOk) { console.error(`page jump FAILED (${jumpNote})`); process.exit(1) }
  if (!linkJumpOk) { console.error(`internal link jump FAILED (${linkJumpNote})`); process.exit(1) }
  if (!linkOpenOk) { console.error(`web link open FAILED (${linkOpenNote})`); process.exit(1) }
  if (!splitOk) { console.error('split view FAILED'); process.exit(1) }
  if (!splitScrollOk) { console.error('split scroll independence FAILED'); process.exit(1) }
  if (!splitMirrorOk) { console.error('split pane did not mirror the donor pane position FAILED'); process.exit(1) }
  if (panesAfterExit !== 1) { console.error('exiting split FAILED'); process.exit(1) }
  if (!warmOk) { console.error('warm tab switch FAILED'); process.exit(1) }
  if (!remountOk) { console.error('panel remount (doc hot cache) FAILED'); process.exit(1) }
  console.log(`reader e2e: OK (links: ${linkJumpNote}; ${linkOpenNote})`)
} finally {
  await browser.close()
  server.close()
}
