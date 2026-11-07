// Agent tools: the library's open interface for reading, editing, summarizing.
import fs from 'node:fs'
import path from 'node:path'
import { readAnnotations, readAttachmentRows, readCollections, readItem, readItems, readStats, readTags, attachmentTarget } from './read.js'
import { createItem, trashItems, updateItem, deleteForever, createCollection, renameCollection, trashCollection, createUrlAttachment } from './write.js'
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
 * @param {object} [deps.logger]
 */
export function createTools(deps) {
  const { getDb, paths, getSettings, logger = console } = deps

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
      description: '在文库中新建条目（先 library_lookup 检索确认元数据再入库）。itemType 用 Zotero 类型名（journalArticle、book、preprint、conferencePaper、thesis、report、webpage、document、note…），fields 放 title、abstractNote、date、DOI、url、publicationTitle、volume、issue、pages、publisher、ISBN、language 等字段。creators 为 [{firstName,lastName,creatorType}]，机构作者用 [{fieldMode:1,lastName}]。返回新条目 key。',
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
      description: '检索一条文献的元数据而不入库：给 identifier（DOI / ISBN / arXiv id / PMID）返回规范元数据草稿（itemType、fields、creators、tags、来源）；给 query（题名片段）返回 Crossref 候选列表。用户让你「收录某篇文章」或要补全字段时先调它，把结果报给用户确认后再用 library_add 写入库。',
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
      description: '修改已有条目：设置或清除字段（值为 null 即清除）、整体替换作者/标签、加入或移出分类。每次写入都标记为本地改动，由 Zotero 自身同步上传。',
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
        updateItem(db, key, {
          itemType: typeof args.itemType === 'string' ? args.itemType : undefined,
          fields: args.fields && typeof args.fields === 'object' ? args.fields : undefined,
          creators: args.creators,
          tags: args.tags,
          addCollections: args.addCollections,
          removeCollections: args.removeCollections,
        })
        return { key, updated: true }
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
      description: '在系统 PDF 阅读器中打开条目的 PDF（或用文件管理器显示文件）。用户要求"在电脑上打开/查看这篇文献"时用。',
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
      description: '与已配置的 Zotero WebDAV 存储同步附件文件：上传本地改动、下载远端更新。verify:true 时只检查服务器配置不做同步。用户要求同步文库或批量导入之后用。',
      parameters: {
        type: 'object',
        properties: { verify: { type: 'boolean', description: 'true 时只验证 WebDAV 连接' } },
      },
      output: { schema: JSON_SCHEMA, render: renderJson },
      timeoutMs: 600_000,
      async execute(args = {}) {
        const db = getDb()
        const settings = getSettings()
        if (settings.webdav.url === '') throw new Error('WebDAV is not configured. Ask the user to fill in the server URL, user name and password in the library settings.')
        const client = new WebDavClient(settings.webdav)
        if (args.verify === true) return await client.verify()
        return await syncStorage({ db, storageDir: paths.storageDir, client, logger })
      },
    },
    {
      name: 'library_cite',
      description: '按条目 key 列表或搜索词导出 CSL-JSON 或 BibTeX。用户要引用格式、参考文献列表或给其他工具提供文献数据时用（也是未来 Word/LibreOffice 插件的接口）。',
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
  ].map(tool => ({
    ...tool,
    async execute(args = {}) {
      return lossless(await tool.execute(args))
    },
  }))
}
