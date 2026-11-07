// Page-flip benchmark (pdf.js viewer): jump page by page and measure
// jump→painted for every visited page — the "how long until the page I flipped
// to is readable" metric. Long documents sample every Nth page to keep the
// run bounded; --back walks backwards over the same pages instead (painted
// canvases are kept, so nearby pages must return instantly).
import { bootBench, waitPainted } from './bench-harness.mjs'

const argv = process.argv.slice(2)
const SAMPLE = argv.find(arg => !arg.startsWith('--')) ?? 'C:\\Users\\moqiq\\Zotero\\storage\\23AXRUBB\\2019-Nature Communications-A genetically encoded probe for imaging nascent and mature HA-tagged proteins.pdf'
const BACKWARDS = argv.includes('--back')

const { page, close } = await bootBench(SAMPLE, { dirName: 'dsh-library-pagesbench' })
await page.click('button:has-text("打开 PDF")')
await page.waitForSelector('.lib-pdf-page[data-page="1"]', { timeout: 60_000 })
await waitPainted(page, 1)

const numPages = Number(await page.evaluate(`(document.querySelector('.lib-rdr-numpages')?.textContent ?? '/ 1').replace('/', '').trim()`))
const step = Math.max(1, Math.ceil(numPages / 40))
const targets = []
for (let n = 1 + step; n <= numPages; n += step) targets.push(n)
if (targets[targets.length - 1] !== numPages) targets.push(numPages)
if (BACKWARDS) targets.reverse()

const times = []
for (const target of targets) {
  await page.click('.lib-rdr-page-input')
  await page.fill('.lib-rdr-page-input', String(target))
  const started = Date.now()
  await page.press('.lib-rdr-page-input', 'Enter')
  await waitPainted(page, target, 120_000)
  times.push({ page: target, ms: Date.now() - started })
}

const sorted = [...times].sort((a, b) => b.ms - a.ms)
const total = times.reduce((sum, entry) => sum + entry.ms, 0)
console.log(`${BACKWARDS ? 'backward' : 'forward'} flips over ${times.length} pages (doc ${numPages}p, step ${step}):`)
console.log(`  total ${total}ms, avg ${Math.round(total / times.length)}ms, median ${times.sort((a, b) => a.ms - b.ms)[Math.floor(times.length / 2)].ms}ms`)
console.log(`  slowest: ${sorted.slice(0, 5).map(entry => `${entry.page}p=${entry.ms}ms`).join(' ')}`)

await close()
