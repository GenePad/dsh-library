// Agent tools: the library's open interface for reading, editing, summarizing.
import fs from 'node:fs'
import path from 'node:path'
import { readAnnotations, readAttachmentRows, readCollections, readItem, readItems, readStats, readTags, attachmentTarget } from './read.js'
import { createItem, trashItems, updateItem, deleteForever, createCollection, renameCollection, trashCollection, createUrlAttachment, createNoteItem, updateNoteItem } from './write.js'
import { importFile } from './ingest.js'
import { lookupDoi, lookupArxiv, lookupIsbn, lookupPmid, resolveMetadata, searchCrossref } from './metadata.js'
import { extractPdfText, pdfPageTexts } from './pdf.js'
import { openExternal } from './open.js'
import { WebDavClient, syncStorage } from './webdav.js'
import { toBibtex, toCslJson } from './cite.js'

const JSON_SCHEMA = { type: 'object' }
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

/**
 * Strip values the harness's lossless-JSON tool-output check rejects
 * (undefined properties, functions, symbols, BigInt). The web API channel
 * tolerates `undefined` because JSON.stringify drops it, but the agent tool
 * framework validates the raw return value and fails the whole call with
 * "returned invalid output: value is not lossless JSON".
 */
function lossless(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null
  if (typeof value === 'bigint') return Number(value)
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(lossless)
  const out = {}
  for (const [name, entry] of Object.entries(value)) {
    if (entry === undefined) continue
    out[name] = lossless(entry)
  }
  return out
}

function requireKey(args, name = 'key') {
  const value = String(args?.[name] ?? '').trim().toUpperCase()
  if (!/^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(value)) {
    throw new Error(`"${name}" must be an 8-character Zotero item key`)
  }
  return value
}

/** The best attachment to read for a key: the item itself or its first PDF child. */
function textAttachment(db, paths, key) {
  const meta = db.schema()
  const row = db.get('SELECT itemID, key, itemTypeID FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, key)
  if (!row) throw new Error(`No item with key ${key}`)
  const typeName = meta.itemTypeNames.get(row.itemTypeID)
  if (typeName === 'attachment') {
    const attachment = db.get('SELECT linkMode, path FROM itemAttachments WHERE itemID = ?', row.itemID)
    return attachment ? { itemID: row.itemID, key: row.key, linkMode: attachment.linkMode, rawPath: attachment.path } : undefined
  }
  const child = db.get(
    `SELECT a.itemID, i.key, a.linkMode, a.path FROM itemAttachments a JOIN items i ON i.itemID = a.itemID
     WHERE a.parentItemID = ? ORDER BY CASE WHEN a.contentType = 'application/pdf' THEN 0 ELSE 1 END, i.dateAdded LIMIT 1`,
    row.itemID,
  )
  return child ? { itemID: child.itemID, key: child.key, linkMode: child.linkMode, rawPath: child.path } : undefined
}

/**
 * Build agent tool definitions bound to the current database and settings.
 * @param {object} deps
 * @param {import('./db.js').ZoteroDb} deps.db
 * @param {{storageDir:string, dataDir:string}} deps.paths
 * @param {() => object} deps.getSettings
 * @param {() => object} [deps.wordAi] - the Word AI task service (runtime.office.ai).
 * @param {() => object} [deps.wordAgent] - the Word agent bridge (runtime.office.wordAgent).
 * @param {() => object} [deps.wordReport] - the Word report generator (runtime.office.report).
 * @param {() => object} [deps.citeStyles] - the CSL style store (runtime.office.styles).
 * @param {object} [deps.logger]
 */
export function createTools(deps) {
  const { getDb, paths, getSettings, runSync, wordAi, wordAgent, wordReport, citeStyles, logger = console } = deps

  // ------------------------------------------- opened-Word document tools ---
  // Shared plumbing for library_word_* : resolve the Word process holding the
  // document, register the current dsh agent (the mask's 终止 button can then
  // force-cancel the turn), optionally hold the blocking mask around the op.
  const docNameOf = docId => String(docId ?? '').replaceAll('\\', '/').split('/').pop() || String(docId ?? '')

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  /**
   * Turn a failed reachability probe into an ACCURATE message: "no Word"
   * must only be said when COM actually found no Word.Application; a live
   * Word that did not report within the retry window gets its own wording
   * (busy / service just restarted), which is actionable instead of
   * misleading.
   */
  function wordUnreachable(probe, subject) {
    const base = subject
      ? `该文档当前没有在 Word 中打开（未收到它的心跳）：${subject}`
      : '没有检测到正在运行的 Word。'
    if (probe?.wordFound === false) {
      return `${base}\n请先在 Word 中打开该文档；若 Word 未安装文库模板，请在文库设置的「写作插件」页一键安装，然后重新打开 Word。`
    }
    if (probe?.wordFound === true) {
      return `${base}\n检测到 Word 正在运行，但文库插件在这几秒内没有收到它的心跳（Word 可能正忙或插件服务刚重载）。请稍等几秒重试；若持续出现，请在 Word 里点一下文档正文，或到文库设置「写作插件」页重装模板后完全重启 Word。`
    }
    return `${base}\n请确认文档已在 Word 中打开；若仍失败，请到文库设置「写作插件」页检查模板安装状态并重启 Word。`
  }

  async function wordTarget(args, exec) {
    const agent = wordAgent?.()
    if (!agent) throw new Error('写作插件服务不可用（Word 代理未启动）。')
    const docId = String(args?.docId ?? '').trim()
    if (docId === '') throw new Error('缺少 docId：先用 library_word_list 获取已打开文档的 docId（完整路径；未保存空白文档为文档名）。')
    let pid = agent.findPidForDoc(docId)
    let probe = null
    if (!pid && agent.nudge) {
      // No fresh heartbeat: push ticks into Word over COM (the pull channel's
      // only real fault is a dead/delayed tick loop) and poll for the report.
      for (let attempt = 0; attempt < 4 && !pid; attempt += 1) {
        const info = await agent.nudge()
        if (info?.wordFound !== null) probe = info
        await sleep(3500) // > NUDGE_DEDUPE so every attempt really pushes
        pid = agent.findPidForDoc(docId)
      }
    }
    if (!pid) throw new Error(wordUnreachable(probe, docId))
    agent.setAgent(exec?.agent ?? null)
    return { agent, pid, docId }
  }

  async function wordOp(args, exec, { docId, pid, type, opArgs, timeoutMs, maskText, mask = true }) {
    const { agent } = await wordTarget({ docId }, exec)
    const signal = exec?.signal ?? null
    const run = () => agent.call({ type, docId, pid, args: opArgs, timeoutMs, signal })
    // Session-scoped blocking mask: the FIRST operation of a task opens it
    // and it STAYS UP across every later operation (the user cannot edit
    // between our reads and writes). It comes down only via
    // library_word_busy(action:"end"), the 终止 button, or the idle safety
    // net — so a whole multi-step task is protected by one mask.
    if (mask) agent.ensureMask({ pid, docId, text: maskText, signal })
    const result = await run()
    if (result.ok !== true) throw new Error(result.error)
    return result.value
  }

  const WORD_CITE_PARAMS = {
    para: { type: 'number', description: '目标段号（1 起，来自 library_word_read 返回的 paras[].n 或 search 的 hit.para）' },
    query: { type: 'string', description: '检索词：命中该文字的段落作为目标段' },
  }

  return [
    {
      name: 'library_status',
      description: '查看已连接文库的状态：数据目录、schema 版本、条目/附件/批注/分类数量、WebDAV 配置。用户问「我的文库/我的 Zotero」或不确定文库是否可用时先调用它。',
      parameters: { type: 'object', properties: {} },
      output: { schema: JSON_SCHEMA, render: renderJson },
      async execute() {
        const db = getDb()
        const settings = getSettings()
        return {
          dataDir: paths.dataDir,
          storageDir: paths.storageDir,
          counts: readStats(db),
          webdav: { configured: settings.webdav.url !== '' },
        }
      },
    },
    {
      name: 'library_search',
      description: '按标题/作者/标签/DOI/期刊等元数据找条目（找"某篇文章"用这个）。可选限定分类或标签。返回 8 位条目 key、类型、标题、作者、年份、是否有 PDF；用 key 配合 library_item / library_read / library_annotations。要在摘要或全文里找内容则改用 library_read 的 search。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '自由文本（中英文均可）；留空返回全部条目' },
          collectionID: { type: 'number', description: '限定分类 id（来自 library_collections）' },
          tag: { type: 'string', description: '限定单个标签名' },
          limit: { type: 'number', description: '最多返回条数，默认 50' },
          sort: { type: 'string', enum: ['title', 'creator', 'date', 'dateAdded', 'dateModified'], description: '排序键，默认 dateAdded' },
        },
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      async execute(args = {}) {
        const db = getDb()
        const result = readItems(db, {
          query: String(args.query ?? ''),
          collectionID: Number.isInteger(args.collectionID) ? args.collectionID : undefined,
          tag: typeof args.tag === 'string' ? args.tag : undefined,
          limit: Number.isInteger(args.limit) ? Math.min(args.limit, 200) : 50,
          sort: args.sort,
        })
        if (result.total === 0 && String(args.query ?? '').trim() !== '') {
          return {
            total: 0,
            items: [],
            hint: '未找到匹配条目。可换关键词变体重试（同义词、英文拼写、单复数、可能的手误，如 capx→capsid），或留空 query 浏览全部条目；确实没有相关文献时如实告知用户，不要反复用同一关键词重试。',
          }
        }
        return { total: result.total, items: result.items }
      },
    },
    {
      name: 'library_item',
      description: '读单个条目的完整记录：类型、全部字段（abstractNote 是摘要，优先从它回答而不是读全文）、作者、标签、分类、子附件（含绝对路径）、子笔记和批注列表。参数 key 接受父条目或附件 key。',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: '8 位 Zotero 条目 key' } },
        required: ['key'],
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      async execute(args = {}) {
        const db = getDb()
        const item = readItem(db, requireKey(args), paths)
        // Keep the transcript readable: notes and annotation positions are summarized.
        return {
          ...item,
          notes: item.notes.map(note => ({ key: note.key, title: note.title, chars: String(note.html ?? '').length })),
          annotations: item.annotations.map(annotation => ({
            key: annotation.key,
            type: annotation.type,
            color: annotation.color,
            pageLabel: annotation.pageLabel,
            text: annotation.text,
            comment: annotation.comment,
          })),
        }
      },
    },
    {
      name: 'library_read',
      description: '读论文全文（优先后读 .zotero-ft-cache，缺失时从 PDF 现提取）或在其中搜索。先看 library_item 的摘要，摘要够用就不读全文；要定位某段内容用 search（返回 offset、摘录和近似页码，page 可直接定位），不要从头顺序读；用 offset 分页续读，响应含 totalChars 和 nextOffset。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '条目或附件 key' },
          offset: { type: 'number', description: '起始字符偏移，默认 0' },
          maxChars: { type: 'number', description: '本次读取字符数，默认 12000，上限 40000' },
          search: { type: 'string', description: '在全文中查找该文本（代替顺序阅读）；返回偏移、摘录与近似页码' },
        },
        required: ['key'],
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      timeoutMs: 120000,
      async execute(args = {}) {
        const db = getDb()
        const key = requireKey(args)
        const attachment = textAttachment(db, paths, key)
        if (!attachment) throw new Error(`Item ${key} has no attachment to read`)
        const target = attachmentTarget(paths.storageDir, attachment.key, attachment.rawPath, attachment.linkMode)
        if (target.kind !== 'file') throw new Error(`Attachment ${attachment.key} is not a local file`)
        if (!fs.existsSync(target.path)) throw new Error(`Attachment file is missing: ${target.path}`)
        let text
        const cache = path.join(path.dirname(target.path), '.zotero-ft-cache')
        try {
          text = fs.readFileSync(cache, 'utf8')
        } catch {
          if (!target.path.toLowerCase().endsWith('.pdf')) throw new Error('No text is available for this attachment type')
          text = await extractPdfText(target.path)
          fs.writeFileSync(cache, text)
        }
        const fileName = path.basename(target.path)
        const needle = typeof args.search === 'string' ? args.search.trim().toLowerCase() : ''
        if (needle !== '') {
          const flat = text.toLowerCase()
          const matches = []
          let pos = flat.indexOf(needle)
          while (pos !== -1 && matches.length < 50) {
            matches.push({
              offset: pos,
              snippet: text.slice(Math.max(0, pos - 120), Math.min(text.length, pos + needle.length + 240)).replace(/\s+/g, ' '),
            })
            pos = flat.indexOf(needle, pos + needle.length)
          }
          // Approximate page numbers: locate each hit's snippet inside the
          // per-page text of the PDF (the .zotero-ft-cache itself has no pages).
          let pages
          if (matches.length > 0 && target.path.toLowerCase().endsWith('.pdf')) {
            try {
              pages = (await pdfPageTexts(target.path)).map(page => page.toLowerCase())
            } catch {
              pages = undefined
            }
          }
          if (pages) {
            const pageCount = pages.length
            for (const match of matches) {
              match.pageCount = pageCount
              // The needle plus following context starts on a word boundary,
              // so it survives normalization; retry shorter forms as a
              // fallback (extraction engines may disagree on hyphenation).
              const context = text.slice(match.offset, Math.min(text.length, match.offset + needle.length + 80)).replace(/\s+/g, ' ').toLowerCase().trim()
              for (const probe of [context, context.slice(0, needle.length + 40), needle]) {
                const pageIndex = pages.findIndex(page => page.includes(probe))
                if (pageIndex !== -1) { match.page = pageIndex + 1; break }
              }
            }
          }
          return { attachmentKey: attachment.key, fileName, totalChars: text.length, search: args.search, matches }
        }
        const offset = Number.isInteger(args.offset) ? Math.max(0, args.offset) : 0
        const maxChars = Number.isInteger(args.maxChars) ? Math.min(Math.max(args.maxChars, 1000), 40_000) : 12_000
        const chunk = text.slice(offset, offset + maxChars)
        return {
          attachmentKey: attachment.key,
          fileName,
          totalChars: text.length,
          offset,
          nextOffset: offset + chunk.length < text.length ? offset + chunk.length : null,
          text: chunk,
        }
      },
    },
    {
      name: 'library_annotations',
      description: '列出用户在某篇论文上做的批注（高亮/下划线/笔记/评论）。参数 key 接受父条目或附件 key。每条含页码标签、颜色、引文、用户评论及所属附件；position.pageIndex 可定位到 PDF 页。',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: '条目或附件 key' } },
        required: ['key'],
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      async execute(args = {}) {
        const db = getDb()
        const key = requireKey(args)
        const meta = db.schema()
        const row = db.get('SELECT itemID, itemTypeID FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, key)
        if (!row) throw new Error(`No item with key ${key}`)
        const typeName = meta.itemTypeNames.get(row.itemTypeID)
        if (typeName === 'attachment') return { attachmentKey: key, annotations: readAnnotations(db, key) }
        const children = db.all(
          `SELECT i.key FROM itemAttachments a JOIN items i ON i.itemID = a.itemID WHERE a.parentItemID = ?`, row.itemID,
        )
        const annotations = []
        for (const child of children) {
          for (const annotation of readAnnotations(db, child.key)) annotations.push({ ...annotation, parentKey: child.key })
        }
        return { itemKey: key, annotations }
      },
    },
    {
      name: 'library_collections',
      description: '列出文库的分类树（含 id 和条目数）与全部标签（含条目数）。分类 id / 标签名可传给 library_search 做限定。',
      parameters: { type: 'object', properties: {} },
      output: { schema: JSON_SCHEMA, render: renderJson },
      async execute() {
        const db = getDb()
        return { ...readCollections(db), tags: readTags(db) }
      },
    },
    {
      name: 'library_add',
      description: '在文库中新建条目（先 library_lookup 检索确认元数据再入库）。itemType 用 Zotero 类型名（journalArticle、book、preprint、conferencePaper、thesis、report、webpage、document、note…），fields 放 title、abstractNote（摘要——library_lookup 草稿里带有的话必须原样带入，不要省略）、date、DOI、url、publicationTitle、volume、issue、pages、publisher、ISBN、language 等字段。creators 为 [{firstName,lastName,creatorType}]，机构作者用 [{fieldMode:1,lastName}]。返回新条目 key。',
      parameters: {
        type: 'object',
        properties: {
          itemType: { type: 'string', description: 'Zotero 条目类型名' },
          fields: { type: 'object', description: '字段名 → 字符串值' },
          creators: { type: 'array', items: { type: 'object' }, description: '作者对象列表' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签名列表' },
          collectionIDs: { type: 'array', items: { type: 'number' }, description: '放入的分类 id 列表' },
        },
        required: ['itemType'],
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      async execute(args = {}) {
        const db = getDb()
        const created = createItem(db, {
          itemType: String(args.itemType),
          fields: args.fields && typeof args.fields === 'object' ? args.fields : {},
          creators: args.creators,
          tags: args.tags,
          collectionIDs: args.collectionIDs,
        })
        return { key: created.key }
      },
    },
    {
      name: 'library_lookup',
      description: '检索一条文献的元数据而不入库：给 identifier（DOI / ISBN / arXiv id / PMID）返回规范元数据草稿（itemType、fields——含 abstractNote 摘要——creators、tags、来源）；给 query（题名片段）返回 Crossref 候选列表。用户让你「收录某篇文章」或要补全字段时先调它，把结果（全部字段，含摘要）报给用户确认后再用 library_add 写入库。',
      parameters: {
        type: 'object',
        properties: {
          identifier: { type: 'string', description: 'DOI / ISBN / arXiv id / PMID，可带前缀（doi: 10.xxxx/xxx、arXiv:2401.01234）' },
          query: { type: 'string', description: '没有标识符时按题名检索（Crossref），返回候选' },
        },
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      timeoutMs: 60_000,
      async execute(args = {}) {
        const identifier = String(args.identifier ?? '').trim()
        if (identifier !== '') {
          const lower = identifier.toLowerCase()
          const explicit = /^(doi:\s*|https?:\/\/doi\.org\/)(.+)$/i.exec(identifier)
          if (explicit) {
            const draft = await lookupDoi(explicit[2])
            return draft ?? { found: false, identifier }
          }
          const arXiv = /^arxiv[:\s]*(.+)$/i.exec(identifier)
          if (arXiv) return await lookupArxiv(arXiv[1]) ?? { found: false, identifier }
          if (/^\d{5,9}$/.test(identifier) || /^pmid/i.test(lower)) {
            const draft = await lookupPmid(identifier.replace(/\D/g, ''))
            return draft ?? { found: false, identifier }
          }
          const draft = await resolveMetadata({ identifier })
          return draft ?? { found: false, identifier }
        }
        const query = String(args.query ?? '').trim()
        if (query === '') throw new Error('Provide an identifier or a query')
        const candidates = await searchCrossref(query, { rows: 5 })
        return { query, candidates }
      },
    },
    {
      name: 'library_attach',
      description: '给已有条目添加附件：path 为本地文件（复制进 Zotero 存储，PDF 会提取全文）或 url 为网页链接（不存文件）。用户要求「把某 PDF 关联到这条文献」时用。返回附件 key。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '要挂附件的条目 key（8 位）' },
          path: { type: 'string', description: '文件绝对路径' },
          url: { type: 'string', description: '网页链接（http/https）；给了 path 就忽略' },
          title: { type: 'string', description: '网页链接附件的标题，默认用 URL' },
        },
        required: ['key'],
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      timeoutMs: 180_000,
      async execute(args = {}) {
        const db = getDb()
        const key = requireKey(args)
        const meta = db.schema()
        const parent = db.get('SELECT itemID FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, key)
        if (!parent) throw new Error(`No item with key ${key}`)
        if (typeof args.path === 'string' && args.path.trim() !== '') {
          const result = await importFile(db, paths, {
            filePath: String(args.path),
            parentKey: key,
            lookup: false,
            logger,
          })
          return { attachmentKey: result.attachmentKey, fileName: result.fileName, kind: 'file' }
        }
        const url = String(args.url ?? '').trim()
        if (url === '') throw new Error('Provide a file path or a url')
        const created = createUrlAttachment(db, { parentKey: key, url, title: typeof args.title === 'string' ? args.title : undefined })
        return { attachmentKey: created.key, url, kind: 'url' }
      },
    },
    {
      name: 'library_collection',
      description: '管理分类（collections）：create 新建（可指定父分类）、rename 重命名、trash 移入回收站。整理文库、按主题归类时配合 library_update 的 addCollections/removeCollections 把条目移入移出。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'rename', 'trash'], description: '默认 create' },
          name: { type: 'string', description: '分类名（create/rename 必需）' },
          id: { type: 'number', description: '分类 id（rename/trash 必需，来自 library_collections）' },
          parentID: { type: 'number', description: '父分类 id（create 可选）' },
        },
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      async execute(args = {}) {
        const db = getDb()
        const action = args.action === 'rename' || args.action === 'trash' ? args.action : 'create'
        if (action === 'create') {
          const created = createCollection(db, {
            name: String(args.name ?? ''),
            parentID: Number.isInteger(args.parentID) ? args.parentID : null,
          })
          return { action, key: created.key, collectionID: created.collectionID }
        }
        if (!Number.isInteger(args.id)) throw new Error(`"${action}" needs a collection id`)
        if (action === 'rename') {
          renameCollection(db, args.id, String(args.name ?? ''))
          return { action, id: args.id }
        }
        const changed = trashCollection(db, args.id, true)
        return { action, id: args.id, changed }
      },
    },
    {
      name: 'library_update',
      description: '修改已有条目：设置或清除字段（值为 null 即清除）、整体替换作者/标签、加入或移出分类、更换条目类型。对独立附件（无父条目的 PDF）更换类型不会改写附件本身，而是新建该类型的父条目并返回 parentKey——后续修改请改用 parentKey。每次写入都标记为本地改动，由 Zotero 自身同步上传。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '8 位条目 key' },
          itemType: { type: 'string', description: '新条目类型，可选' },
          fields: { type: 'object', description: '字段名 → 值；null 表示删除该字段' },
          creators: { type: 'array', items: { type: 'object' }, description: '替换后的作者列表' },
          tags: { type: 'array', items: { type: 'string' }, description: '替换后的标签列表' },
          addCollections: { type: 'array', items: { type: 'number' }, description: '要加入的分类 id' },
          removeCollections: { type: 'array', items: { type: 'number' }, description: '要移出的分类 id' },
        },
        required: ['key'],
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      async execute(args = {}) {
        const db = getDb()
        const key = requireKey(args)
        const result = updateItem(db, key, {
          itemType: typeof args.itemType === 'string' ? args.itemType : undefined,
          fields: args.fields && typeof args.fields === 'object' ? args.fields : undefined,
          creators: args.creators,
          tags: args.tags,
          addCollections: args.addCollections,
          removeCollections: args.removeCollections,
        })
        return result.parentKey ? { key, updated: true, parentKey: result.parentKey } : { key, updated: true }
      },
    },
    {
      name: 'library_note',
      description: '新建或修改笔记：create 在条目下建子笔记（parentKey 为文献条目 key；text 为纯文本，按空行分段）；update 整体替换某个笔记的正文（key 为笔记 key，从 library_item 的 notes 里取）。用户要求「给这篇文献写条笔记 / 把笔记内容改成…」时用。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update'], description: '默认 create' },
          parentKey: { type: 'string', description: 'create：挂笔记的文献条目 key；缺省为独立笔记' },
          key: { type: 'string', description: 'update：要修改的笔记 key（8 位）' },
          text: { type: 'string', description: '笔记正文（纯文本，空行分段）' },
        },
        required: ['text'],
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      async execute(args = {}) {
        const db = getDb()
        if (String(args.action ?? 'create') === 'update') {
          const key = requireKey(args)
          return updateNoteItem(db, key, String(args.text ?? ''))
        }
        return createNoteItem(db, {
          parentKey: typeof args.parentKey === 'string' ? args.parentKey : undefined,
          text: String(args.text ?? ''),
        })
      },
    },
    {
      name: 'library_import',
      description: '把文件（通常是 PDF）导入文库：复制进 Zotero 存储、建附件、提取全文和 PDF 内嵌批注，并通过文件名/正文中的 DOI/arXiv id/ISBN 或 Crossref 题名检索自动补全父条目元数据。用户要求"添加/导入某篇 PDF"时用。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件的绝对路径' },
          parentKey: { type: 'string', description: '挂到这个已有条目下（代替新建父条目）' },
          collectionID: { type: 'number', description: '新条目放入的分类 id' },
          lookup: { type: 'boolean', description: '是否在线检索元数据，默认 true' },
          metadata: { type: 'object', description: '显式元数据 {itemType, fields, creators, tags}；提供则跳过在线检索' },
        },
        required: ['path'],
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      timeoutMs: 180000,
      async execute(args = {}) {
        const db = getDb()
        const result = await importFile(db, paths, {
          filePath: String(args.path),
          parentKey: typeof args.parentKey === 'string' ? args.parentKey : undefined,
          collectionID: Number.isInteger(args.collectionID) ? args.collectionID : undefined,
          lookup: args.lookup !== false,
          metadata: args.metadata && typeof args.metadata === 'object' ? args.metadata : undefined,
          logger,
        })
        return result
      },
    },
    {
      name: 'library_open',
      description: '在系统 PDF 阅读器中打开条目的 PDF（或用文件管理器显示文件）。条目没有 PDF 时自动改为在浏览器打开它的网页链接或 DOI。用户要求"在电脑上打开/查看这篇文献"时用。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '条目或附件 key' },
          reveal: { type: 'boolean', description: 'true 时在文件管理器中显示文件而不打开' },
        },
        required: ['key'],
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      async execute(args = {}) {
        const db = getDb()
        const key = requireKey(args)
        const attachment = textAttachment(db, paths, key)
        if (!attachment) throw new Error(`Item ${key} has no attachment to open`)
        const target = attachmentTarget(paths.storageDir, attachment.key, attachment.rawPath, attachment.linkMode)
        if (target.kind === 'url') {
          openExternal(target.url)
          return { opened: target.url }
        }
        if (!fs.existsSync(target.path)) throw new Error(`Attachment file is missing: ${target.path}`)
        const opened = args.reveal === true ? openExternal(path.dirname(target.path)) : openExternal(target.path)
        return { opened: opened ? target.path : undefined, ok: opened }
      },
    },
    {
      name: 'library_sync',
      description: '同步文库。关联 Zotero 模式下唤起 Zotero 客户端并置前，由用户在 Zotero 里点同步按钮（结果 kind 告知是否已置前，同步结果之后经 revision 轮询自动回流）；独立文库模式下与已配置的 WebDAV 存储同步附件文件。verify:true 时只检查 WebDAV 连接不做同步。用户要求同步文库或批量导入之后用。',
      parameters: {
        type: 'object',
        properties: { verify: { type: 'boolean', description: 'true 时只验证 WebDAV 连接' } },
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      timeoutMs: 600_000,
      async execute(args = {}) {
        const settings = getSettings()
        if (args.verify === true) {
          if (settings.webdav.url === '') throw new Error('WebDAV is not configured. Ask the user to fill in the server URL, user name and password in the library settings.')
          return await new WebDavClient(settings.webdav).verify()
        }
        // Zotero mode: the Zotero client owns the sync; runSync dispatches.
        if (settings.mode === 'zotero' && typeof runSync === 'function') return await runSync()
        const db = getDb()
        if (settings.webdav.url === '') throw new Error('WebDAV is not configured. Ask the user to fill in the server URL, user name and password in the library settings.')
        const client = new WebDavClient(settings.webdav)
        return await syncStorage({ db, storageDir: paths.storageDir, client, logger })
      },
    },
    {
      name: 'library_cite',
      description: '按条目 key 列表或搜索词导出 CSL-JSON 或 BibTeX。用户要引用格式、参考文献列表或给其他工具提供文献数据时用。',
      parameters: {
        type: 'object',
        properties: {
          keys: { type: 'array', items: { type: 'string' }, description: '要导出的条目 key 列表' },
          query: { type: 'string', description: '不传 keys 时按搜索词导出（空串 = 整个文库）' },
          format: { type: 'string', enum: ['csl-json', 'bibtex'], description: '输出格式，默认 csl-json' },
        },
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      async execute(args = {}) {
        const db = getDb()
        const input = {
          ...(Array.isArray(args.keys) ? { keys: args.keys } : {}),
          ...(typeof args.query === 'string' ? { query: args.query } : {}),
        }
        if (args.format === 'bibtex') {
          const text = toBibtex(db, input)
          return { format: 'bibtex', entries: text.split('\n\n').length, text }
        }
        const items = toCslJson(db, input)
        return { format: 'csl-json', items }
      },
    },
    {
      name: 'library_trash',
      description: '把条目移入 Zotero 回收站（可恢复）、从回收站恢复，或对已在回收站的条目永久删除。仅在用户明确要求时使用。',
      parameters: {
        type: 'object',
        properties: {
          keys: { type: 'array', items: { type: 'string' }, description: '条目 key 列表' },
          action: { type: 'string', enum: ['trash', 'restore', 'delete'], description: '默认 trash（移入回收站）' },
        },
        required: ['keys'],
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      async execute(args = {}) {
        const db = getDb()
        const keys = (Array.isArray(args.keys) ? args.keys : []).map(key => requireKey({ key }))
        if (keys.length === 0) throw new Error('No item keys given')
        if (args.action === 'delete') return { deleted: deleteForever(db, keys) }
        return { changed: trashItems(db, keys, args.action !== 'restore') }
      },
    },
    {
      name: 'library_word_apply',
      description: '把修改结果写回 Microsoft Word 中发起 AI 任务的选中文本（自动检索引文 / AI 修改任务专用）。只在任务消息给出 taskId 时使用；会同步等待 Word 端应用并自动刷新引注与参考文献表。replace=整段替换：text 为完整新文本，引注位置用 [[1]]、[[2]] 占位标记；insert=原文定点插入：citations 每项的 after 填选中文本里的一段独特原文片段。任务已写回成功后发现还缺引文，可传 reopen=true 并提供 Word 中该段当前的 selection 文本，做第二轮补插（同一文档、同一选区）。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务消息中的 taskId（形如 AIXXXXXXXXXX）' },
          mode: { type: 'string', enum: ['replace', 'insert'], description: 'replace=整段替换选中文本；insert=保留原文只在指定位置插入引文' },
          text: { type: 'string', description: 'replace 模式：替换后的完整文本，引注位置写 [[N]] 占位标记' },
          reopen: { type: 'boolean', description: '任务已写回后继续补插时置 true（此时必须同时给出 selection）' },
          selection: { type: 'string', description: 'reopen 用：Word 中该段当前的完整文本（含上一轮插入的引文），after 片段需在其中存在' },
          pid: { type: 'number', description: 'reopen 接管已丢失任务时用：Word 进程号（可从 Word 侧读取）' },
          docId: { type: 'string', description: 'reopen 接管已丢失任务时用：文档完整路径（与 Word 侧一致）' },
          docName: { type: 'string', description: 'reopen 接管时用：文档名（可选）' },
          citations: {
            type: 'array',
            description: '引文列表，replace 模式按 id 与 [[N]] 标记对应，insert 模式按 after 定位',
            items: {
              type: 'object',
              properties: {
                id: { type: 'number', description: 'replace 模式：与 text 中 [[N]] 标记对应的编号' },
                keys: { type: 'array', items: { type: 'string' }, description: '文库条目 key（8 位，来自 library_search / library_add）' },
                after: { type: 'string', description: 'insert 模式：选中文本里的一段独特原文片段，引文插到它之后' },
                locator: { type: 'string', description: '定位符，如页码 "10"' },
                prefix: { type: 'string', description: '引注前缀，如 "见"' },
                suffix: { type: 'string', description: '引注后缀，如 "及后续"' },
              },
            },
          },
        },
        required: ['taskId', 'citations'],
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      timeoutMs: 180_000,
      async execute(args = {}) {
        const ai = wordAi?.()
        if (!ai) throw new Error('写作插件服务不可用（无法写回 Word）。')
        const taskId = String(args.taskId ?? '').trim()
        if (taskId === '') throw new Error('缺少 taskId：使用任务消息里给出的 taskId。')
        const result = await ai.submit(taskId, {
          mode: args.mode,
          text: args.text,
          citations: args.citations,
          reopen: args.reopen === true,
          selection: args.selection,
          pid: args.pid,
          docId: args.docId,
          docName: args.docName,
        })
        if (result?.ok !== true) throw new Error(String(result?.error ?? '写回失败'))
        return {
          ok: true,
          mode: args.mode === 'insert' ? 'insert' : 'replace',
          inserted: result.inserted ?? 0,
          note: '已写回 Word 并自动刷新引注与参考文献表。',
        }
      },
    },
    {
      name: 'library_cite_styles',
      description: '查看 / 检索 / 安装 CSL 引用样式（apa、ieee、nature、gb-t-7714-2015-numeric 等）。用户指定报告或引文的参考文献样式但该样式未安装时：先用 query 检索（本地+zotero.org 官方仓库），把候选报给用户，用户选定后用 install 安装。不传参数时列出全部已安装样式。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词（样式名/标题片段），空则只列已安装' },
          install: { type: 'string', description: '要安装的样式 styleID（来自检索结果，形如 http://www.zotero.org/styles/xxx）' },
        },
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      timeoutMs: 60_000,
      async execute(args = {}) {
        const styles = citeStyles?.()
        if (!styles) throw new Error('写作插件服务不可用。')
        if (args.install) {
          const styleID = String(args.install).trim()
          const installed = await styles.install({ styleID })
          return {
            installed: true,
            styleID: installed.styleID,
            title: installed.title,
            class: installed.class,
            hasBibliography: installed.hasBibliography,
          }
        }
        const list = await styles.search(String(args.query ?? ''))
        return {
          query: String(args.query ?? ''),
          styles: list.slice(0, 40).map(entry => ({
            styleID: entry.styleID,
            shortName: entry.shortName,
            title: entry.title,
            class: entry.class,
            hasBibliography: entry.hasBibliography,
            installed: entry.installed === true,
          })),
          hint: 'install 传 styleID 即可安装（dependent: true 的样式安装时会自动带上父样式）。',
        }
      },
    },
    {
      name: 'library_word_report',
      description: '不用打开 Word，直接生成一份带真实引文的 .docx 报告：引文按指定的 CSL 样式排版并带 Zotero 域代码（之后在 Word 里可用「文库引用」刷新/换样式），文末自动生成参考文献表，生成后自动用系统默认程序打开。用户说「写/生成一份关于 XX 的报告/综述/文档（Word）」时用这个工具；先 library_search / library_read 收集资料。写法：正文各段是一个 text 块，引注位置写 [[N]]，N 必须等于本段 citations 中某项的 id。要点：(1) 一个 [[N]] = 一处引文域，一段可以写多个，同一篇文献也可以在一段里出现多次（重复写同一个 id 即可）；(2) 引文的编号与参考文献顺序由 CSL 处理器按正文出现顺序自动计算，正文里不要自己写编号、citations 也无需按文献顺序排列——程序按 id 匹配，数组顺序无关；(3) 每条引文的 locator/prefix/suffix 都可选。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '报告标题（同时用作文件名）' },
          outline: {
            type: 'array',
            description: '报告内容块，按顺序排列',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string', description: '章节标题（给此块则为标题块）' },
                level: { type: 'number', description: '标题级别 1-3，默认 1' },
                text: { type: 'string', description: '正文段落（给此块则为正文块）；引注处写 [[N]]，N 与该段 citations 的 id 对应，可与 citations 顺序无关地任意多次使用' },
                citations: {
                  type: 'array',
                  description: '本段引文列表；每项的 id 对应 text 中的一个 [[N]]，keys 是文库条目 key（同一处引文可放多个 key = 一条引文簇）',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'number', description: '与 text 中 [[N]] 对应的编号（1-999，本段内唯一；同一个 id 可在正文出现多次表示多处引用同一处引文）' },
                      keys: { type: 'array', items: { type: 'string' }, description: '文库条目 key（8 位）' },
                      locator: { type: 'string', description: '定位符，如页码 "10"' },
                      prefix: { type: 'string', description: '引注前缀' },
                      suffix: { type: 'string', description: '引注后缀' },
                    },
                  },
                },
              },
            },
          },
          style: { type: 'string', description: 'CSL 引用样式：styleID、短名（如 ieee）或标题；用户没指定时默认 apa。未安装的样式先用 library_cite_styles 安装' },
          locale: { type: 'string', description: '样式语言标签，如 zh-CN（默认）、en-US' },
          open: { type: 'boolean', description: '生成后是否用系统默认程序打开（默认 true）' },
        },
        required: ['title', 'outline'],
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      timeoutMs: 120_000,
      async execute(args = {}) {
        const report = wordReport?.()
        if (!report) throw new Error('写作插件服务不可用（无法生成报告）。')
        const result = await report.generate({
          title: args.title,
          outline: args.outline,
          style: args.style,
          locale: args.locale,
          open: args.open !== false,
        })
        return {
          ok: true,
          path: result.path,
          dir: result.dir,
          style: result.styleID,
          styleTitle: result.styleTitle,
          locale: result.locale,
          citations: result.citations,
          bibliographyEntries: result.bibliographyEntries,
          characters: result.characters,
          opened: result.opened,
          note: '已生成 Word 报告（引文带真实 Zotero 域代码，可在 Word 的「文库引用」选项卡里刷新或换样式）。',
        }
      },
    },
    {
      name: 'library_word_list',
      description: '列出当前已打开的 Microsoft Word 文档（需已安装文库 Word 写作插件且 Word 正在运行）：docId（完整路径）、页数、段落数、字符数、是否未保存/只读。要读取或编辑某个已打开的 Word 文档时，先用这个工具拿到 docId。',
      parameters: {
        type: 'object',
        properties: {},
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      timeoutMs: 45_000,
      async execute(args = {}, exec = null) {
        const agent = wordAgent?.()
        if (!agent) throw new Error('写作插件服务不可用（Word 代理未启动）。')
        agent.setAgent(exec?.agent ?? null)
        let instances = agent.liveInstances()
        let probe = null
        if (instances.length === 0 && agent.nudge) {
          // Push ticks into Word before reporting "no Word": covers the
          // startup / plugin-reload window and a dropped timer chain.
          for (let attempt = 0; attempt < 4 && instances.length === 0; attempt += 1) {
            const info = await agent.nudge()
            if (info?.wordFound !== null) probe = info
            await sleep(3500) // > NUDGE_DEDUPE so every attempt really pushes
            instances = agent.liveInstances()
          }
        }
        if (instances.length === 0) throw new Error(wordUnreachable(probe))
        const result = await agent.call({ type: 'list', timeoutMs: 20_000, signal: exec?.signal ?? null })
        if (result.ok !== true) throw new Error(result.error)
        return { docs: result.value.docs ?? [], instances: instances.length }
      },
    },
    {
      name: 'library_word_read',
      description: '读取一个已打开的 Word 文档的指定位置（read-opened-word）：按页（page）、按段落（para 起连续 paras 段或 para..toPara）、或按检索词（query，返回命中段落及上下各 contextParas 段）。不传定位参数时从头读前 paras 段。返回带段号（n，全局 1 起）的段落列表，写回时用段号定位。操作期间 Word 会出现「DSH 正在阅读」遮罩（可用 mask=false 关闭）。',
      parameters: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: '文档标识（来自 library_word_list；未保存的空白文档是文档名，如 文档1）' },
          page: { type: 'number', description: '读第几页（1 起）' },
          para: { type: 'number', description: '起始段号（1 起）' },
          paras: { type: 'number', description: '读多少段（默认 30；不传 para 时=从头读的段数，默认 40）' },
          toPara: { type: 'number', description: '结束段号（与 para 搭配）' },
          query: { type: 'string', description: '检索词：返回命中段落及其上下 contextParas 段' },
          contextParas: { type: 'number', description: 'query 命中时上下各带几段（默认 2，上限 10）' },
          maxChars: { type: 'number', description: '返回正文最大字符数（默认 12000，上限 40000）' },
          mask: { type: 'boolean', description: '是否弹出「正在阅读」遮罩（默认 true）' },
        },
        required: ['docId'],
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      timeoutMs: 90_000,
      async execute(args = {}, exec = null) {
        const target = await wordTarget(args, exec)
        return await wordOp(args, exec, {
          ...target,
          type: 'read',
          opArgs: {
            page: args.page, para: args.para, paras: args.paras, toPara: args.toPara,
            query: args.query, contextParas: args.contextParas, maxChars: args.maxChars,
          },
          timeoutMs: 60_000,
          maskText: `正在阅读：${docNameOf(args.docId)}`,
          mask: args.mask !== false,
        })
      },
    },
    {
      name: 'library_word_search',
      description: '在一个（或全部）已打开的 Word 文档里检索文字并返回命中段落的上下文（search-context-in-opened-word）：每条命中带段号（para）与命中段前后 contextParas 段的正文。docId 省略时在所有已打开文档中检索。命中段号可直接用于 library_word_write / library_word_cite 定位。',
      parameters: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: '文档标识；省略则在全部已打开文档中检索' },
          query: { type: 'string', description: '检索词（在 Word 可见正文中查找）' },
          maxHits: { type: 'number', description: '最多命中数（默认 20，上限 50）' },
          contextParas: { type: 'number', description: '命中段上下各带几段（默认 1，上限 10）' },
          mask: { type: 'boolean', description: '是否弹出「正在检索」遮罩（默认 true；多文档检索时每个文档一次）' },
        },
        required: ['query'],
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      timeoutMs: 120_000,
      async execute(args = {}, exec = null) {
        const agent = wordAgent?.()
        if (!agent) throw new Error('写作插件服务不可用（Word 代理未启动）。')
        agent.setAgent(exec?.agent ?? null)
        const query = String(args.query ?? '').trim()
        if (query === '') throw new Error('缺少 query（检索词）。')
        const targets = args.docId
          ? [await wordTarget(args, exec)]
          : agent.liveInstances().flatMap(instance => instance.docs.map(docId => ({ agent, pid: instance.pid, docId })))
        if (targets.length === 0) throw new Error('没有检测到正在运行的 Word。')
        const results = []
        for (const target of targets) {
          try {
            const value = await wordOp(args, exec, {
              ...target,
              type: 'search',
              opArgs: { query, maxHits: args.maxHits, contextParas: args.contextParas },
              timeoutMs: 60_000,
              maskText: `正在检索：${docNameOf(target.docId)}`,
              mask: args.mask !== false && targets.length <= 3,
            })
            results.push(value)
          } catch (error) {
            results.push({ docId: target.docId, error: String(error?.message ?? error) })
          }
        }
        return { query, docs: results }
      },
    },
    {
      name: 'library_word_write',
      description: '编辑写入一个已打开的 Word 文档（write-opened-word）：mode=replaceParas 用 text 替换 para..toPara 段（toPara 省略时只替换一段）；mode=insertAfter 在 para 段之后插入新段；mode=append 在文档末尾追加。多段文本用 \\n 分行。写入前请先 library_word_read 确认段号与原文（段号在编辑后会变化）。返回新的总段数，随后应复读确认。操作期间 Word 会出现「正在编辑」遮罩。',
      parameters: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: '文档标识（来自 library_word_list；未保存的空白文档是文档名，如 文档1）' },
          mode: { type: 'string', enum: ['replaceParas', 'insertAfter', 'append'], description: '默认 replaceParas' },
          para: { type: 'number', description: '目标段号（replaceParas 的起始段 / insertAfter 的锚点段）' },
          toPara: { type: 'number', description: 'replaceParas 的结束段号（省略=只替换 para 一段）' },
          text: { type: 'string', description: '写入文本，\\n 分段' },
          mask: { type: 'boolean', description: '是否弹出「正在编辑」遮罩（默认 true）' },
        },
        required: ['docId', 'text'],
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      timeoutMs: 90_000,
      async execute(args = {}, exec = null) {
        const target = await wordTarget(args, exec)
        const text = String(args.text ?? '')
        if (text.trim() === '') throw new Error('text 不能为空。')
        if (text.length > 30000) throw new Error('text 超过 30000 字符，请分段写入。')
        return await wordOp(args, exec, {
          ...target,
          type: 'write',
          opArgs: { mode: args.mode, para: args.para, toPara: args.toPara, text },
          timeoutMs: 60_000,
          maskText: `正在编辑：${docNameOf(args.docId)}`,
          mask: args.mask !== false,
        })
      },
    },
    {
      name: 'library_word_cite',
      description: '在已打开的 Word 文档的指定段落插入真实 Zotero 引注（带域代码，可用「文库引用」刷新/换样式）：先用 para 或 query 定位目标段，citations 每项的 after 填该段文字里一段独特片段（引注插到它后面），keys 为文库 8 位条目 key。文档需先设置过引文样式（「文库格式设置」）；未设置时会报错提示。需要引注位置写法与 library_word_apply 的 insert 模式一致。',
      parameters: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: '文档标识（来自 library_word_list；未保存的空白文档是文档名，如 文档1。文档需先设置过引文样式）' },
          para: { type: 'number', description: '目标段号（1 起）' },
          query: { type: 'string', description: '检索词：命中段落作为目标段' },
          citations: {
            type: 'array',
            description: '引文列表（本段内按数组顺序插入）',
            items: {
              type: 'object',
              properties: {
                after: { type: 'string', description: '目标段文字里一段足够独特的片段，引注插到它之后' },
                keys: { type: 'array', items: { type: 'string' }, description: '文库条目 key（8 位，来自 library_search / library_add）' },
                locator: { type: 'string', description: '定位符，如页码 "10"' },
                prefix: { type: 'string', description: '引注前缀' },
                suffix: { type: 'string', description: '引注后缀' },
              },
            },
          },
          mask: { type: 'boolean', description: '是否弹出「正在编辑」遮罩（默认 true）' },
        },
        required: ['docId', 'citations'],
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      timeoutMs: 200_000,
      async execute(args = {}, exec = null) {
        const ai = wordAi?.()
        if (!ai) throw new Error('写作插件服务不可用（无法插入引注）。')
        const target = await wordTarget(args, exec)
        const agent = wordAgent?.()
        const citations = Array.isArray(args.citations) ? args.citations : []
        if (citations.length === 0) throw new Error('citations 不能为空。')
        if (citations.length > 20) throw new Error('citations 过多（一次最多 20 条）。')
        if (!args.para && !args.query) throw new Error('需要 para（目标段号）或 query（检索词）定位目标段。')
        // Whether this call is the one that opens the mask (→ release it on
        // failure so a rejected plan never leaves Word locked).
        const maskHeldBefore = Boolean(agent?.status?.().mask && Number(agent.status().mask.pid) === target.pid)
        try {
          // 1. Word resolves the located paragraph and captures it as the
          //    apply anchor; the tool learns its exact visible text.
          const prep = await wordOp(args, exec, {
            ...target,
            type: 'citePrepare',
            opArgs: { para: args.para, query: args.query },
            timeoutMs: 60_000,
            maskText: `正在编辑：${docNameOf(args.docId)}`,
            mask: args.mask !== false,
          })
          // 2. Register the plan as an AI insert task (validates `after`
          //    anchors against the located text and the keys against the
          //    library, both in the HOST) and wait for the Word-side apply.
          const taskId = `WDC${Date.now().toString(36).toUpperCase()}`
          const submitPromise = ai.submit(taskId, {
            mode: 'insert',
            reopen: true,
            pid: target.pid,
            docId: target.docId,
            docName: docNameOf(target.docId),
            selection: prep.text,
            citations,
          })
          const applyResult = await wordOp({ mask: false }, exec, {
            ...target,
            type: 'citeApply',
            opArgs: { taskId },
            timeoutMs: 150_000,
            maskText: '',
            mask: false,
          }).catch(error => {
            // Fail the waiting submit immediately instead of letting it run
            // out its own 150 s claim window.
            ai.fail(taskId, error)
            return { ok: false, error: error?.message ?? String(error) }
          })
          // The submit waiter carries the real outcome AND the real engine
          // error (unknown item, missing style, transaction failure, ...).
          // Note: on success citeApply returns the VBA value WITHOUT an `ok`
          // field, so success must be judged by the submit result alone.
          const result = await submitPromise.catch(error => ({ ok: false, error: error?.message ?? String(error) }))
          if (result?.ok !== true) throw new Error(String(result?.error ?? applyResult.error ?? '插入引注失败'))
          return {
            ok: true,
            docId: target.docId,
            para: prep.para,
            inserted: result.inserted ?? citations.length,
            note: '已插入引注并自动刷新（带真实 Zotero 域代码，可在 Word 中继续编辑/换样式）。',
          }
        } catch (error) {
          // A failed citation call must not keep Word locked when this call
          // opened the mask (plans rejected in the host never reach Word).
          if (!maskHeldBefore && agent) await agent.endMask({ pid: target.pid }).catch(() => {})
          throw error
        }
      },
    },
    {
      name: 'library_word_busy',
      description: '在已打开的 Word 文档上弹出/关闭阻塞遮罩（msg box）：action=begin 时 Word 显示「DSH 正在工作 + 终止按钮」的模态窗体并锁住 Word 界面，防止用户在任务进行中改动文档；action=end 时关闭遮罩、恢复 Word 可用。注意：library_word_read/write/search/cite 等操作会自动开启并保持遮罩（整个任务期间 Word 一直被锁住），因此**完成全部 Word 操作后必须调用 action="end" 释放遮罩**，否则用户无法继续使用 Word。用户点击终止按钮会强制停止当前 dsh 任务；用户在对话中要求继续时，AI 需重新执行操作（遮罩会自动重新弹出）。文本用 text 自定义（如「正在整理参考文献」）。',
      parameters: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: '文档标识（来自 library_word_list；未保存的空白文档是文档名，如 文档1）' },
          action: { type: 'string', enum: ['begin', 'end'], description: '默认 begin' },
          text: { type: 'string', description: '遮罩提示文字（begin 时）' },
        },
        required: ['docId'],
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      timeoutMs: 60_000,
      async execute(args = {}, exec = null) {
        const { agent, pid, docId } = await wordTarget(args, exec)
        const signal = exec?.signal ?? null
        if (args.action === 'end') {
          await agent.endMask({ pid, signal })
          return { ok: true, closed: true, note: '遮罩已关闭，Word 恢复可用。' }
        }
        const maskText = String(args.text ?? '').trim() || 'DSH 正在工作中，请稍候。'
        const held = agent.ensureMask({ pid, docId, text: maskText, signal })
        return {
          ok: true,
          held: held.held === true,
          note: held.held
            ? '遮罩此前已开启，已保持（任务期间 Word 一直被锁住）。'
            : '遮罩已开启；完成全部 Word 操作后请调用 action="end" 释放。',
        }
      },
    },
  ].map(tool => ({
    ...tool,
    async execute(args = {}, exec = null) {
      return lossless(await tool.execute(args, exec))
    },
  }))
}
