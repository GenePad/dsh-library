// Dialog manager. Zotero opens a small native XUL window; here the same UI is
// served by the local integration server and shown in a chromeless standalone
// window (Edge/Chrome --app), falling back to the default browser only when no
// Chromium browser is available. The engine awaits `open()` until the page
// POSTs its result; the window is then closed for the user.
import { openExternal } from '../open.js'
import { createEngine } from './csl-citeproc.js'
import { createItemRegistry } from './items.js'
import { openDialogWindow, closeDialogWindow, raiseDialogWindow } from './window.js'
import { objectKey } from '../util.js'

const DIALOG_TTL = 20 * 60_000
const NO_BROWSER = process.env.DSH_LIBRARY_OFFICE_NO_BROWSER === '1'

export function createDialogManager({ styles, items, logger = console, getBaseUrl, home = '' }) {
  function showDialog(id, type) {
    const base = baseUrlProvider?.()
    if (!base) return false
    const url = `${base}/office/dialog/${id}`
    if (openDialogWindow({ url, id, type, home, logger })) return true
    return openExternal(url)
  }
  const pending = new Map()
  let progress = { id: '', percent: 0, label: '' }
  let baseUrlProvider = getBaseUrl
  function setBaseUrl(provider) { baseUrlProvider = provider }

  function sweep() {
    const now = Date.now()
    for (const [id, dialog] of pending) {
      if (now - dialog.createdAt > DIALOG_TTL) {
        pending.delete(id)
        if (!NO_BROWSER) closeDialogWindow(id, logger)
        dialog.resolve({ cancelled: true, reason: 'timeout' })
      }
    }
  }

  /** Open a modal dialog and resolve with its answer. */
  function open({ type, io = {}, title = '文库引用' }) {
    sweep()
    const id = objectKey()
    const promise = new Promise((resolve) => { pending.set(id, { id, type, io, title, resolve, createdAt: Date.now() }) })
    if (!NO_BROWSER && type !== 'progress') {
      try { showDialog(id, type) } catch (error) {
        logger.warn?.(`library: could not open citation dialog: ${error?.message ?? error}`)
      }
    }
    return promise
  }

  /** Re-open a pending dialog window (e.g. after the user closed it). */
  function reopen(id) {
    const dialog = pending.get(id) ?? [...pending.values()][0]
    if (!dialog || NO_BROWSER) return Boolean(dialog)
    // Re-raise an existing window even if Chromium reuses the running
    // instance instead of creating a new one.
    raiseDialogWindow(dialog.id, logger)
    try {
      return showDialog(dialog.id, dialog.type)
    } catch (error) {
      logger.warn?.(`library: could not reopen citation dialog: ${error?.message ?? error}`)
      return false
    }
  }

  function reopenAll() {
    let count = 0
    for (const id of pending.keys()) if (reopen(id)) count += 1
    return count
  }

  function pendingDialogs() {
    sweep()
    return [...pending.values()].map(({ id, type, title, createdAt }) => ({
      id, type, title, createdAt, url: `/office/dialog/${id}`,
    }))
  }

  function state(id) {
    const dialog = pending.get(id)
    return dialog ? { id, type: dialog.type, title: dialog.title, io: dialog.io } : null
  }

  function answer(id, payload = {}) {
    const dialog = pending.get(id)
    if (!dialog) return false
    pending.delete(id)
    dialog.resolve(payload?.cancel
      ? { cancelled: true }
      : { cancelled: false, ...(payload?.value ?? payload ?? {}) })
    // Zotero's dialog disappears on OK/Cancel. Chromium ignores window.close()
    // for app windows, so close it from the host by its title marker.
    if (!NO_BROWSER) closeDialogWindow(id, logger)
    return true
  }

  function stylesList() {
    return {
      styles: styles.list(),
      locales: styles.localesList(),
    }
  }

  async function installStyle(styleID) {
    const style = await styles.install({ styleID })
    return {
      styleID: style.styleID,
      title: style.title,
      titleShort: style.titleShort,
      class: style.class,
      hasBibliography: style.hasBibliography,
    }
  }

  /** Collection tree for the citation dialog's "文献库" browser. */
  function collections(id) {
    if (!pending.has(id)) return { collections: [], unfiled: 0, trash: 0 }
    if (typeof items.collections !== 'function') return { collections: [], unfiled: 0, trash: 0 }
    return items.collections()
  }

  function findCollection(nodes, raw) {
    for (const node of nodes ?? []) {
      if (String(node.id) === raw || String(node.key) === raw) return node
      const child = findCollection(node.children, raw)
      if (child) return child
    }
    return null
  }

  /** A collection's own id plus every descendant id. */
  function subtreeIDs(node, out = []) {
    out.push(Number(node.id))
    for (const child of node.children ?? []) subtreeIDs(child, out)
    return out
  }

  /**
   * Resolve a collection id/key sent by the dialog into a readItems filter.
   * Browsing a category shows its own items AND those of its subcategories,
   * which is exactly what the tree's `itemCount` badge counts.
   */
  function collectionScope(value) {
    const raw = String(value ?? '').trim()
    if (!raw || raw === 'all') return { label: '全部文献' }
    if (raw === 'unfiled') return { label: '未分类', unfiled: true }
    const tree = typeof items.collections === 'function' ? items.collections() : { collections: [] }
    const node = findCollection(tree.collections ?? [], raw)
    if (node) {
      return {
        label: node.name,
        collectionIDs: subtreeIDs(node),
        itemCount: Number(node.itemCount ?? node.totalCount ?? node.count ?? 0),
      }
    }
    if (/^\d+$/.test(raw)) return { label: '该分类', collectionID: Number(raw) }
    return { label: '全部文献' }
  }

  /**
   * Two deliberately different result sources for the citation dialog:
   *   layout=list    -> ONLY items matching the text typed in the search box.
   *   layout=library -> items of one collection (optionally filtered by text),
   *                    browsed through the collection tree.
   */
  function search(id, query = '', mode = 'citation', scope = '', layout = 'list', collection = '') {
    if (!pending.has(id)) return { groups: [] }
    const dialog = pending.get(id)
    const text = String(query ?? '').trim()
    const limit = 50
    const citedCounts = new Map((dialog.io?.citedItems ?? []).map(entry => [String(entry.id), Number(entry.count) || 1]))
    const decorate = entry => ({ ...entry, count: citedCounts.get(String(entry.id)) ?? 0 })

    if (layout === 'library') {
      const target = collectionScope(collection)
      // 500 is readItems' hard cap. Grouping by the rows actually returned
      // keeps the label and the tree badge in sync even for huge categories.
      const rows = items.search(text, {
        limit: 500, mode,
        ...(target.collectionIDs ? { collectionIDs: target.collectionIDs } : {}),
        ...(Number.isInteger(target.collectionID) ? { collectionID: target.collectionID } : {}),
        ...(target.unfiled ? { unfiled: true } : {}),
      }).map(decorate)
      const truncated = Number.isInteger(target.itemCount) && target.itemCount > rows.length && rows.length >= 500
      return {
        groups: rows.length
          ? [{ key: 'collection', label: `${target.label}（${rows.length} 条）`, items: rows }]
          : [],
        hint: rows.length
          ? (truncated ? '分类条目较多，仅显示前 500 条；可用搜索框缩小范围' : '')
          : (text ? '该分类下没有匹配的条目' : '该分类下暂无文献'),
      }
    }

    if (!text) return { groups: [], hint: '输入关键词检索文献；或切换到「文献库」按分类添加' }
    const rows = items.search(text, { limit, mode }).map(decorate)
    const groups = rows.length ? [{ key: 'search', label: `搜索结果（${rows.length} 条）`, items: rows }] : []
    if (scope === 'annotations') {
      const annotations = []
      for (const entry of rows.slice(0, 20)) {
        for (const annotation of items.annotations(entry.id)) annotations.push({ ...annotation, title: `${entry.title} · 批注`, creator: entry.creator, year: entry.year })
      }
      if (annotations.length) groups.unshift({ key: 'annotations', label: `注释 (${annotations.length})`, items: annotations })
    }
    return { groups, hint: rows.length ? '' : '没有匹配的条目' }
  }

  /** Live preview of a citation through citeproc. */
  function preview(id, citation) {
    const dialog = pending.get(id)
    if (!dialog) return { html: '' }
    try {
      const styleID = dialog.io?.style?.styleID || 'http://www.zotero.org/styles/apa'
      const style = styles.get(styleID)
      const registry = createItemRegistry(items, 'preview')
      const cluster = {
        citationID: citation?.citationID || 'preview',
        properties: { ...(citation?.properties ?? {}), noteIndex: 0 },
        citationItems: (citation?.citationItems ?? []).map((item) => {
          const resolved = registry.resolve(item.id, item.itemData, item.uris)
          const out = { id: resolved ?? String(item.id) }
          for (const key of ['locator', 'label', 'prefix', 'suffix', 'suppress-author', 'author-only']) {
            if (item[key] !== undefined) out[key] = item[key]
          }
          return out
        }),
      }
      const engine = createEngine({
        xml: style.xml,
        locale: styles.resolveLocale(dialog.io?.style?.locale || 'en-US'),
        retrieveLocale: tag => styles.localeXml(tag),
        retrieveItem: itemID => registry.retrieve(itemID),
        format: 'html',
      })
      const result = engine.previewCitationCluster(cluster, [], [], 'html')
      return { html: String(result ?? '') }
    } catch (error) {
      logger.warn?.(`library: citation preview failed: ${error?.message ?? error}`)
      return { html: '', error: String(error?.message ?? error) }
    }
  }

  /** Lightweight progress reporter (Zotero's progressBar.xhtml equivalent). */
  function progressReporter() {
    const id = objectKey()
    let segment = 0
    progress = { id, percent: 0, label: '正在更新文档…' }
    return {
      id,
      start() { progress = { ...progress, percent: Math.min(progress.percent, 90) } },
      update(percent) { progress = { ...progress, percent: Math.max(0, Math.min(100, Number(percent) || 0)) } },
      finishSegment() { segment += 1; progress = { ...progress, percent: Math.min(100, segment * 25) } },
      hide() { progress = { ...progress, percent: 100 } },
      reset() { segment = 0; progress = { ...progress, percent: 0 } },
    }
  }

  function progressState() { return { ...progress } }

  function dispose() {
    for (const [id, dialog] of pending) {
      pending.delete(id)
      if (!NO_BROWSER) closeDialogWindow(id, logger)
      dialog.resolve({ cancelled: true, reason: 'server-stopped' })
    }
  }

  return {
    open, setBaseUrl, reopen, reopenAll, pendingDialogs, state, answer, stylesList, installStyle,
    search, collections, preview, progressReporter, progressState, dispose,
    get size() { return pending.size },
  }
}
