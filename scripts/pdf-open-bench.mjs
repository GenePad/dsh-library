// Open-path benchmark (pdf.js viewer): the stages a user waits through when
// opening a paper — click → bytes → parse → first pixel → zoom re-render →
// far jump paint — plus main-thread long tasks.
import { bootBench, waitPainted } from './bench-harness.mjs'

const SAMPLE = process.argv[2] ?? 'C:\\Users\\moqiq\\Zotero\\storage\\23AXRUBB\\2019-Nature Communications-A genetically encoded probe for imaging nascent and mature HA-tagged proteins.pdf'

const { page, close } = await bootBench(SAMPLE, { dirName: 'dsh-zot-library-openbench' })
await page.evaluate('window.__mark("click")')
await page.click('button:has-text("打开 PDF")')

await page.waitForSelector('.lib-pdf-page[data-page="1"]', { timeout: 60_000 })
await page.waitForSelector('.lib-pdf-page[data-page="1"] canvas', { timeout: 60_000 })
await page.evaluate('window.__mark("canvas-mounted")')
await waitPainted(page, 1)
await page.evaluate('window.__mark("first-pixel")')

// Zoom once through the toolbar: the bitmap CSS-stretches instantly, then the
// engine re-rasterizes at the new scale.
await page.click('button[title="放大"]')
await page.waitForTimeout(120) // CSS stretch
await page.evaluate('window.__mark("zoom-css")')
await waitPainted(page, 1)
await page.evaluate('window.__mark("zoom-sharp")')

// Jump to the last page of the document.
const numPages = Number(await page.evaluate(`(document.querySelector('.lib-rdr-numpages')?.textContent ?? '/ 1').replace('/', '').trim()`))
if (numPages > 1) {
  await page.click('.lib-rdr-page-input')
  await page.fill('.lib-rdr-page-input', String(numPages))
  await page.evaluate('window.__mark("jump-sent")')
  await page.press('.lib-rdr-page-input', 'Enter')
  await waitPainted(page, numPages)
  await page.evaluate('window.__mark("jump-painted")')
}

const perf = await page.evaluate('window.__perf')
let previous = 0
console.log(`sample: ${numPages} pages`)
for (const mark of perf.marks) {
  console.log(`  ${mark.name.padEnd(14)} +${String(mark.t - previous).padStart(5)}ms  (t=${mark.t})`)
  previous = mark.t
}
console.log(`long tasks on main thread: ${perf.longTasks.length}, max ${perf.maxLongTask}ms`)

await close()
