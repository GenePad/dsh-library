// Generate a complete, citation-live Word report without Word running.
//
// The user asks the assistant ("生成最近的过血脑屏障AAV进展的报告") and the
// agent calls the library_word_report tool. The output is a genuine
// Zotero-compatible .docx built entirely in Node (fflate from vendor/deps.js):
//
//   - body text plus real citation FIELDS (` ADDIN ZOTERO_ITEM CSL_CITATION
//     {...} ` instrText with the pre-rendered cluster as the field result), so
//     the「文库引用」tab can refresh / edit / restyle them later;
//   - a ` ADDIN ZOTERO_BIBL {...} CSL_BIBLIOGRAPHY ` field at the end with the
//     rendered bibliography;
//   - document preferences chunked into ZOTERO_PREF_1..N custom document
//     properties (docProps/custom.xml), byte-compatible with the VBA PropSet
//     layout the integration reads back;
//   - citation text rendered by the same citeproc engine as the Word
//     integration, in the user-chosen CSL style + locale.
//
// Word is NOT required to build the file; it only opens it afterwards (best
// effort, via the system default application).
//
// Placeholder contract (this is what the tool description promises):
//   - `text` carries [[N]] markers; N resolves to the `citations` entry whose
//     `id` is N. The array order of `citations` never matters — the marker
//     decides where the field lands.
//   - one marker = one citation cluster, so the same id may be repeated and the
//     same work can be cited twice in a single paragraph;
//   - clusters are rendered in READING order, which is what makes numeric CSL
//     styles number the document correctly (first appearance wins);
//   - numbers and the bibliography are produced by citeproc — never by us.
import fs from 'node:fs'
import path from 'node:path'
import { zipSync } from '../../../vendor/deps.js'
import { openExternal } from '../open.js'
import { createEngine } from './csl-citeproc.js'
import { DocumentData } from './document-data.js'
import { Citation, Bibliography } from './citation.js'
import { createItemRegistry } from './items.js'
import { FIELD_CODE_ITEM_PREFIX, FIELD_CODE_BIBL_PREFIX, FIELD_CODE_BIBL_SUFFIX, randomString, escapeXml } from './constants.js'

const KEY_PATTERN = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/
const PREFS_PROPERTY = 'ZOTERO_PREF'
const MAX_PROPERTY_LENGTH = 255
const FMTID = '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}'

const LIMITS = {
  title: 200,
  blocks: 400,
  paragraph: 20_000,
  citations: 200,
  citationItems: 20,
}

/** Validate and normalise the tool's outline into heading/paragraph blocks. */
export function normalizeOutline(outline) {
  if (!Array.isArray(outline) || outline.length === 0) {
    throw new Error('outline 不能为空：用 heading 块组织章节、用 text 块写正文段落')
  }
  if (outline.length > LIMITS.blocks) throw new Error(`outline 超过 ${LIMITS.blocks} 块，请分多篇生成`)
  const blocks = []
  for (const raw of outline) {
    if (!raw || typeof raw !== 'object') throw new Error('outline 每项必须是对象')
    if (raw.heading !== undefined) {
      const heading = String(raw.heading ?? '').trim()
      if (heading === '') throw new Error('heading 块的标题不能为空')
      if (heading.length > 300) throw new Error('标题过长（>300 字符）')
      const level = Number(raw.level)
      blocks.push({ kind: 'heading', text: heading, level: Number.isInteger(level) && level >= 1 && level <= 3 ? level : 1 })
      continue
    }
    const text = String(raw.text ?? '')
    if (text.trim() === '') throw new Error('正文块的 text 不能为空（空行不需要单独成块）')
    if (text.length > LIMITS.paragraph) throw new Error(`单段正文超过 ${LIMITS.paragraph} 字符，请拆分`)
    const rawCitations = Array.isArray(raw.citations) ? raw.citations : []
    const citations = []
    for (const entry of rawCitations) {
      if (!entry || typeof entry !== 'object') throw new Error('citations 每项必须是对象')
      const keys = (Array.isArray(entry.keys) ? entry.keys : [])
        .map(key => String(key ?? '').trim().toUpperCase())
        .filter(key => KEY_PATTERN.test(key))
      if (keys.length === 0) throw new Error('每条引文需要至少一个有效的 8 位文库条目 key（来自 library_search / library_add）')
      if (keys.length > LIMITS.citationItems) throw new Error(`单条引文最多 ${LIMITS.citationItems} 个条目`)
      const citation = { keys }
      if (entry.locator !== undefined && String(entry.locator).trim() !== '') citation.locator = String(entry.locator).trim().slice(0, 50)
      if (entry.prefix !== undefined && String(entry.prefix).trim() !== '') citation.prefix = String(entry.prefix).trim().slice(0, 100)
      if (entry.suffix !== undefined && String(entry.suffix).trim() !== '') citation.suffix = String(entry.suffix).trim().slice(0, 100)
      const id = Number(entry.id)
      if (!Number.isInteger(id) || id < 1 || id > 999) throw new Error('citations 每项需要数字 id（与 text 中 [[N]] 标记对应）')
      citation.id = id
      citations.push(citation)
    }
    const ids = new Set(citations.map(citation => citation.id))
    if (ids.size !== citations.length) throw new Error('同一段落里 citations 的 id 重复')
    for (const marker of text.matchAll(/\[\[(\d{1,3})\]\]/g)) {
      if (!ids.has(Number(marker[1]))) throw new Error(`text 中有标记 [[${marker[1]}]]，但 citations 里没有 id=${marker[1]} 的条目`)
    }
    for (const citation of citations) {
      if (![...text.matchAll(/\[\[(\d{1,3})\]\]/g)].some(marker => Number(marker[1]) === citation.id)) {
        throw new Error(`citations 中 id=${citation.id} 没有在 text 里使用`)
      }
    }
    blocks.push({ kind: 'paragraph', text, citations })
  }
  const total = blocks.reduce((sum, block) => sum + (block.kind === 'paragraph' ? block.citations.length : 0), 0)
  if (total > LIMITS.citations) throw new Error(`引文总数超过 ${LIMITS.citations}，请分篇生成`)
  return blocks
}

/**
 * Convert citeproc HTML output (`<i>`, `<b>`, `<sup>`, `<sub>`, spans) into
 * OOXML runs. Anything more exotic degrades to plain text runs.
 */
export function htmlToRuns(html) {
  const source = String(html ?? '')
  const out = []
  let state = { i: false, b: false, sup: false, sub: false }
  const open = { i: false, b: false, sup: false, sub: false }
  for (const match of source.matchAll(/<[^>]*>|[^<]+/g)) {
    const token = match[0]
    if (token.startsWith('<')) {
      const closing = token.startsWith('</')
      const name = /<\/?([a-zA-Z0-9]+)/.exec(token)?.[1]?.toLowerCase() ?? ''
      if (name === 'i' || name === 'b' || name === 'sup' || name === 'sub') {
        open[name] = !closing
        state = { ...open }
      }
      continue
    }
    const text = token
      .replace(/&nbsp;/g, '\u00a0')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    if (text === '') continue
    const props = []
    if (state.i) props.push('<w:i/><w:iCs/>')
    if (state.b) props.push('<w:b/><w:bCs/>')
    if (state.sup) props.push('<w:vertAlign w:val="superscript"/>')
    if (state.sub) props.push('<w:vertAlign w:val="subscript"/>')
    out.push(`<w:r>${props.length ? `<w:rPr>${props.join('')}</w:rPr>` : ''}`
      + `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`)
  }
  return out
}

/** Word field: begin / instrText / separate / pre-rendered result / end. */
function fieldRuns(instr, resultRuns) {
  return [
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    `<w:r><w:instrText xml:space="preserve">${escapeXml(instr)}</w:instrText></w:r>`,
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    ...resultRuns,
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  ]
}

function paragraphXml(inner, styleId) {
  return `<w:p>${styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : ''}${inner}</w:p>`
}

/** The minimal styles part: Chinese-first defaults, title and three headings. */
export function stylesXml() {
  const fonts = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/>'
  const heading = (id, size, before, level) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/>`
    + '<w:basedOn w:val="Normal"/><w:qFormat/>'
    + `<w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="120"/><w:outlineLvl w:val="${level}"/></w:pPr>`
    + `<w:rPr>${fonts}<w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>${fonts}<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto" w:after="80"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="360"/></w:pPr>
<w:rPr>${fonts}<w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
${heading('Heading1', 30, 240, 0)}
${heading('Heading2', 28, 200, 1)}
${heading('Heading3', 26, 160, 2)}
</w:styles>`
}

/** Custom document properties holding the chunked ZOTERO_PREF document data. */
export function customPropsXml(value) {
  const text = String(value ?? '')
  const chunks = []
  for (let i = 0; i * MAX_PROPERTY_LENGTH < text.length || (i === 0 && text === ''); i += 1) {
    chunks.push(text.slice(i * MAX_PROPERTY_LENGTH, (i + 1) * MAX_PROPERTY_LENGTH))
  }
  const props = chunks.map((chunk, index) => `<property fmtid="${FMTID}" pid="${index + 2}" `
    + `name="${PREFS_PROPERTY}_${index + 1}"><vt:lpstr>${escapeXml(chunk)}</vt:lpstr></property>`)
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${props.join('')}</Properties>`
}

/** Assemble the final .docx package (pure zip, no Word). */
export function buildDocx({ title, creator, docData, bodyParagraphs }) {
  const enc = new TextEncoder()
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>
</Types>`
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>
</Relationships>`
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>dsh-zot-library</Application></Properties>`
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>${escapeXml(creator)}</dc:creator><cp:lastModifiedBy>${escapeXml(creator)}</cp:lastModifiedBy></cp:coreProperties>`
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${paragraphXml(`<w:r><w:t xml:space="preserve">${escapeXml(title)}</w:t></w:r>`, 'Title')}
${bodyParagraphs.join('\n')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>
</w:body></w:document>`
  return zipSync({
    '[Content_Types].xml': enc.encode(contentTypes),
    '_rels/.rels': enc.encode(rels),
    'word/document.xml': enc.encode(document),
    'word/_rels/document.xml.rels': enc.encode(docRels),
    'word/styles.xml': enc.encode(stylesXml()),
    'docProps/core.xml': enc.encode(core),
    'docProps/app.xml': enc.encode(app),
    'docProps/custom.xml': enc.encode(customPropsXml(docData)),
  })
}

/**
 * @param {object} deps
 * @param {import('./csl-styles.js')} deps.styles - the office style store.
 * @param {import('./items.js')} deps.items - the library item provider.
 * @param {string} deps.home - plugin data directory (reports land in home/reports).
 */
export function createReportGenerator({ styles, items, home, logger = console, version = '0.2.1' }) {
  const reportsDir = path.join(home, 'reports')

  /** Resolve a style reference: styleID / short name / (partial) title. */
  function resolveStyle(input) {
    const value = String(input ?? '').trim()
    if (value === '') return styles.get('http://www.zotero.org/styles/apa')
    try {
      return styles.get(value)
    } catch { /* fall through to fuzzy matching */ }
    const needle = value.toLowerCase()
    const installed = styles.list()
    const exact = installed.find(entry => entry.shortName.toLowerCase() === needle)
      ?? installed.find(entry => entry.styleID.toLowerCase() === needle)
    if (exact) return styles.get(exact.styleID)
    const titled = installed.find(entry => entry.title.toLowerCase() === needle)
      ?? installed.find(entry => entry.title.toLowerCase().includes(needle))
    if (titled) return styles.get(titled.styleID)
    throw new Error(`未找到引用样式「${value}」。已安装的样式：`
      + installed.map(entry => entry.shortName).join('、')
      + '。可先用 library_cite_styles 检索并安装更多样式（或让用户在文库设置里安装）。')
  }

  function outputPath(title) {
    fs.mkdirSync(reportsDir, { recursive: true })
    const stamp = new Date()
    const pad = value => String(value).padStart(2, '0')
    const base = `${title.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)}`
      + `-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`
    let candidate = path.join(reportsDir, `${base}.docx`)
    for (let i = 2; fs.existsSync(candidate); i += 1) candidate = path.join(reportsDir, `${base}-${i}.docx`)
    return candidate
  }

  /**
   * Generate the report document.
   * @param {object} options - {title, outline, style, locale, open}
   * @returns {{path:string, dir:string, styleID:string, locale:string,
   *   citations:number, bibliographyEntries:number, characters:number, opened:boolean}}
   */
  async function generate(options = {}) {
    const title = String(options.title ?? '').trim()
    if (title === '') throw new Error('title 不能为空（用作报告标题与文件名）')
    if (title.length > LIMITS.title) throw new Error(`title 超过 ${LIMITS.title} 字符`)
    const blocks = normalizeOutline(options.outline)
    const style = resolveStyle(options.style)
    const locale = styles.resolveLocale(String(options.locale ?? '').trim() || 'zh-CN')

    // Validate every key against the library BEFORE rendering anything.
    for (const block of blocks) {
      for (const citation of block.citations ?? []) {
        for (const key of citation.keys) {
          if (!items.cslItem(key)) throw new Error(`条目 ${key} 不在文库中。请用 library_search 重新确认 key 后再生成。`)
        }
      }
    }

    const sessionID = randomString(8)
    const registry = createItemRegistry(items, sessionID)
    const engine = createEngine({
      xml: style.xml,
      locale,
      retrieveLocale: tag => styles.localeXml(tag),
      retrieveItem: id => registry.retrieve(id),
      format: 'html',
    })

    // Expand the [[N]] markers BEFORE rendering: one marker = one citation
    // cluster, and clusters must be processed in READING order (the order the
    // markers appear in the text), because citeproc numbers numeric styles by
    // first appearance. The N inside a marker is resolved against
    // `citations[].id` — the order of that array is irrelevant, and the same id
    // may be written several times (same work cited twice in one paragraph →
    // two independent clusters, numbered alike by the style).
    const instances = []
    for (const block of blocks) {
      if (block.kind !== 'paragraph') continue
      const byId = new Map(block.citations.map(citation => [citation.id, citation]))
      block.slots = []
      for (const marker of block.text.matchAll(/\[\[(\d{1,3})\]\]/g)) {
        block.slots.push(instances.length)
        instances.push(byId.get(Number(marker[1])))
      }
    }
    if (instances.length > LIMITS.citations) {
      throw new Error(`引文总数超过 ${LIMITS.citations}（[[N]] 标记计数），请分篇生成`)
    }

    const orderedKeys = []
    for (const spec of instances) {
      for (const key of spec.keys) if (!orderedKeys.includes(key)) orderedKeys.push(key)
    }
    if (orderedKeys.length) engine.updateItems(orderedKeys)

    // Clusters in reading order; citeproc assigns numbers on the fly and may
    // re-render earlier clusters (disambiguation) — the changed map carries
    // every text we need.
    const clusters = []
    const texts = []
    const codes = []
    for (const spec of instances) {
      const citation = new Citation(null, {
        citationID: randomString(8),
        properties: { noteIndex: 0 },
        citationItems: spec.keys.map((key, index) => ({
          id: key,
          uris: items.uriFor(key),
          ...(index === 0 && spec.prefix ? { prefix: spec.prefix } : {}),
          ...(index === spec.keys.length - 1 && spec.suffix ? { suffix: spec.suffix } : {}),
          ...(spec.locator ? { locator: spec.locator } : {}),
        })),
      }, 0)
      const action = await citation.loadItemData(registry, { promptToReselect: false })
      if (action !== 0 || citation.citationItems.some(item => item.missing)) {
        throw new Error(`条目 ${spec.keys.join('、')} 无法从文库解析为 CSL 数据，已中止。`)
      }
      codes.push(citation.serialize(registry))
      clusters.push(citation.toCluster())
    }
    for (let i = 0; i < clusters.length; i += 1) {
      // citeproc wants the surrounding citations as [citationID, noteIndex]
      // pairs (Session.getCiteprocLists shape), and only citations that are
      // ALREADY registered may appear in pre/post. We append in document
      // order, so pre = the processed clusters and post is empty — exactly
      // Zotero's insert-at-the-end flow.
      const pre = clusters.slice(0, i).map(cluster => [cluster.citationID, cluster.properties?.noteIndex ?? 0])
      const [, changed] = engine.processCitationCluster(clusters[i], pre, [])
      for (const entry of changed ?? []) texts[Number(entry[0])] = String(entry[1] ?? '')
    }
    if (clusters.some((_, index) => !texts[index])) {
      throw new Error('引文渲染不完整，请重试或换一个样式。')
    }

    const bibliography = { entries: [], code: new Bibliography(null, {}, registry).serialize() }
    if (style.hasBibliography && clusters.length) {
      const made = engine.makeBibliography()
      bibliography.entries = (Array.isArray(made?.[1]) ? made[1] : []).map(entry => String(entry))
    }

    // ---- assemble document.xml body ------------------------------------
    const body = []
    for (const block of blocks) {
      if (block.kind === 'heading') {
        body.push(paragraphXml(`<w:r><w:t xml:space="preserve">${escapeXml(block.text)}</w:t></w:r>`, `Heading${block.level}`))
        continue
      }
      // Markers are consumed in reading order and matched against `block.slots`,
      // which was built from the same regex above: slot N holds the cluster that
      // was rendered for marker N, whatever id that marker carried.
      const runs = []
      let slot = 0
      for (const piece of block.text.split(/(\[\[\d{1,3}\]\])/g)) {
        if (piece === '') continue
        if (!/^\[\[\d{1,3}\]\]$/.test(piece)) {
          runs.push(`<w:r><w:t xml:space="preserve">${escapeXml(piece)}</w:t></w:r>`)
          continue
        }
        const index = block.slots[slot]
        slot += 1
        // The full Word field instruction mirrors the VBA layout:
        // " ADDIN ZOTERO_" + client code + " ".
        runs.push(...fieldRuns(` ADDIN ZOTERO_${FIELD_CODE_ITEM_PREFIX}${codes[index]} `, htmlToRuns(texts[index])))
      }
      body.push(paragraphXml(runs.join('')))
    }
    if (bibliography.entries.length) {
      body.push(paragraphXml(`<w:r><w:t xml:space="preserve">参考文献</w:t></w:r>`, 'Heading1'))
      const instr = ` ADDIN ZOTERO_${FIELD_CODE_BIBL_PREFIX}${bibliography.code}${FIELD_CODE_BIBL_SUFFIX} `
      if (bibliography.entries.length === 1) {
        body.push(paragraphXml(fieldRuns(instr, htmlToRuns(bibliography.entries[0])).join('')))
      } else {
        bibliography.entries.forEach((entry, index) => {
          const runs = htmlToRuns(entry)
          if (index === 0) body.push(paragraphRunsFieldOpen(instr, runs))
          else if (index === bibliography.entries.length - 1) body.push(paragraphRunsFieldClose(runs))
          else body.push(paragraphXml(runs.join('')))
        })
      }
    }

    const data = DocumentData.fresh(version)
    data.sessionID = sessionID
    data.style = {
      styleID: style.styleID,
      locale,
      hasBibliography: Boolean(style.hasBibliography),
      bibliographyStyleHasBeenSet: false,
    }
    const creator = 'dsh 文献助手'
    const file = outputPath(title)
    fs.writeFileSync(file, buildDocx({ title, creator, docData: data.serialize(), bodyParagraphs: body }))

    let opened = false
    if (options.open !== false) opened = openExternal(file)
    logger.info?.(`library: word report written: ${file} (${clusters.length} citations, ${bibliography.entries.length} bibliography entries)`)
    return {
      path: file,
      dir: reportsDir,
      styleID: style.styleID,
      styleTitle: style.title,
      locale,
      citations: clusters.length,
      bibliographyEntries: bibliography.entries.length,
      characters: blocks.reduce((sum, block) => sum + (block.kind === 'paragraph' ? block.text.length : 0), 0),
      opened,
    }
  }

  return { generate, resolveStyle, reportsDir: () => reportsDir }
}

/** A bibliography field opens in the first entry paragraph... */
function paragraphRunsFieldOpen(instr, runs) {
  return paragraphXml([
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    `<w:r><w:instrText xml:space="preserve">${escapeXml(instr)}</w:instrText></w:r>`,
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    ...runs,
  ].join(''))
}

/** ...and closes after the last entry paragraph (fields span paragraphs). */
function paragraphRunsFieldClose(runs) {
  return paragraphXml([...runs, '<w:r><w:fldChar w:fldCharType="end"/></w:r>'].join(''))
}
