// PDF text and annotation extraction through the bundled pdf.js (unpdf).
import fs from 'node:fs'
import { extractText, getDocumentProxy } from '../../vendor/deps.js'

const ANNOTATION_TYPES = {
  Highlight: 1,
  Underline: 5,
  Squiggly: 1,
  StrikeOut: 1,
  Text: 2,
  FreeText: 6,
  Ink: 4,
  Stamp: 3,
}

/** Load a PDF document from disk. */
async function openPdf(filePath) {
  const data = new Uint8Array(fs.readFileSync(filePath))
  const doc = await getDocumentProxy(data)
  return { doc, data }
}

/** Full text of a PDF, pages merged, as Zotero's `.zotero-ft-cache` holds it. */
export async function extractPdfText(filePath) {
  const { doc } = await openPdf(filePath)
  const result = await extractText(doc, { mergePages: true })
  return String(result.text ?? '')
}

/** Per-page text of a PDF, for mapping full-text search hits to page numbers. */
export async function pdfPageTexts(filePath) {
  const { doc } = await openPdf(filePath)
  const pages = []
  for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex += 1) {
    const page = await doc.getPage(pageIndex + 1)
    const content = await page.getTextContent()
    pages.push(content.items.map(item => item.str ?? '').join(' ').replace(/\s+/g, ' ').trim())
  }
  return pages
}

/** Convert a pdf.js color array to "#rrggbb". */
function colorOf(annotation) {
  const color = annotation?.color
  if (!color) return '#ffd400'
  const channel = index => {
    const value = color[index]
    return Math.max(0, Math.min(255, Math.round(Number(value ?? 0) * 255)))
  }
  return `#${[channel(0), channel(1), channel(2)].map(value => value.toString(16).padStart(2, '0')).join('')}`
}

/** Bounding box of one pdf.js text item in PDF page coordinates. */
function itemBox(item, pageHeight) {
  const [a, b, c, d, e, f] = item.transform
  const width = Number(item.width ?? 0)
  const height = Math.abs(Number(d ?? 0)) || Number(item.height ?? 0)
  // Horizontal text: x runs along e, the baseline sits at f; box grows upward.
  const x1 = e
  const x2 = e + Math.hypot(a, b) * (width || 0)
  const y1 = f - Math.abs(height)
  const y2 = f
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]
}

function overlaps(a, b) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}

/** Selected text of a page region: pdf.js text items intersecting the rects. */
function textInRects(items, rects, pageHeight) {
  const picked = []
  for (const item of items) {
    if (typeof item.str !== 'string' || item.str.trim() === '') continue
    const box = itemBox(item, pageHeight)
    if (rects.some(rect => overlaps(box, rect))) picked.push(item.str)
  }
  return picked.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * Read annotations embedded in a PDF file.
 * @param {string} filePath
 * @returns {Promise<Array<{type:number,text:string,comment:string,color:string,pageLabel:string,pageIndex:number,rects:number[][],sortIndex:string,position:object}>>}
 */
export async function extractPdfAnnotations(filePath) {
  const { doc } = await openPdf(filePath)
  let pageLabels
  try {
    pageLabels = await doc.getPageLabels()
  } catch {
    pageLabels = undefined
  }
  const annotations = []
  for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex += 1) {
    const page = await doc.getPage(pageIndex + 1)
    const raw = await page.getAnnotations({ intent: 'display' })
    if (raw.length === 0) continue
    const viewBox = page.view
    const pageHeight = viewBox[3] - viewBox[1]
    let textItems
    const candidates = raw.filter(annotation => ANNOTATION_TYPES[annotation.subtype] !== undefined && Array.isArray(annotation.rect))
    if (candidates.length === 0) continue
    const needsText = candidates.some(annotation => annotation.subtype === 'Highlight' || annotation.subtype === 'Underline' || annotation.subtype === 'Squiggly' || annotation.subtype === 'StrikeOut')
    if (needsText) {
      try {
        const content = await page.getTextContent()
        textItems = content.items
      } catch {
        textItems = []
      }
    }
    for (const annotation of candidates) {
      const rect = annotation.rect.map(Number)
      const rects = [rect]
      const comment = String(annotation.contentsObj?.str ?? annotation.contents ?? '').trim()
      const type = ANNOTATION_TYPES[annotation.subtype]
      const text = textItems ? textInRects(textItems, rects, pageHeight) : ''
      const top = Math.max(0, pageHeight - rect[3])
      const sortIndex = [String(pageIndex).padStart(5, '0'), String(0).padStart(6, '0'), String(Math.floor(top)).padStart(5, '0')].join('|')
      annotations.push({
        type,
        text,
        comment,
        color: colorOf(annotation),
        pageLabel: String(pageLabels?.[pageIndex] ?? pageIndex + 1),
        pageIndex,
        rects,
        sortIndex,
        position: { pageIndex, rects },
        externalId: annotation.id ?? undefined,
      })
    }
  }
  return annotations
}

/** A stable signature used to pair embedded annotations with database rows. */
export function annotationSignature(annotation) {
  const rects = (annotation.position?.rects ?? annotation.rects ?? [])
    .map(rect => rect.map(value => Math.round(Number(value) * 2) / 2).join(','))
    .join(';')
  return `${annotation.type}|${annotation.pageIndex ?? annotation.position?.pageIndex}|${annotation.color}|${rects}`
}
