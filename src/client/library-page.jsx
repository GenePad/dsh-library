import * as React from 'react'
import * as api from './api.js'
import { CollectionsPane } from './collections-pane.jsx'
import { ItemsPane, restoreColumns, restoreColumnWidths, columnFieldNames } from './items-pane.jsx'
import { DetailsPane } from './details-pane.jsx'
import { ChatDock } from './chat-dock.jsx'
import { SETTINGS_SAVED_EVENT } from './settings-section.jsx'
import { CollectionDialog } from './create-dialog.jsx'
import { PdfViewer } from './pdf-viewer.jsx'
import { rememberReader, restoreReader, restoreViews } from './reader-store.js'
import { ItemContextMenu, PromptDialog } from './item-menu.jsx'
import {
  ChevronLeftIcon, ChevronRightIcon, GearIcon, LibraryIcon, PlusIcon, PdfIcon, SearchIcon, SyncIcon, WandIcon,
} from './icons.jsx'
import { Button } from './platform.jsx'
import { compareVersions, fileBase64, filePathOf, itemTypeLabel, useDarkMode, useDebounced, probeSidebarOpen } from './util.js'

const VIEW_STORAGE = 'dsh-zot-library:view'
const SORT_STORAGE = 'dsh-zot-library:sort'
// Right pane (文献信息) visibility, remembered across sessions like view/sort.
const DETAILS_STORAGE = 'dsh-zot-library:details-open'
// 保温查看器上限：最近查看的 PDF 标签保持挂载（隐藏不占布局），标签/列表/标签
// 之间切换零重渲（canvas 位图与滚动位置原样保留）。超限的最久未看标签卸载，
// 其解析好的文档进 reader-store 文档热缓存（LRU 3 份），回来也免重新解析。
const WARM_VIEWER_LIMIT = 4

function flattenCollections(nodes, depth = 0, out = []) {
  for (const node of nodes ?? []) {
    out.push({ id: node.id, label: `${'　'.repeat(depth)}${node.name}` })
    flattenCollections(node.children, depth + 1, out)
  }
  return out
}

function restoreView() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_STORAGE) ?? 'null')
    if (saved && typeof saved === 'object' && ['all', 'unfiled', 'trash', 'collection', 'tag'].includes(saved.kind)) return saved
  } catch {
    // A malformed preference falls back to My Library.
  }
  return { kind: 'all' }
}

function restoreSort() {
  const known = ['title', 'creator', 'date', 'dateAdded', 'dateModified', 'itemType', 'hasAttachment', 'numNotes']
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_STORAGE) ?? 'null')
    if (saved && typeof saved === 'object') {
      const sortKey = String(saved.sort ?? '')
      if (known.includes(sortKey) || /^field:[A-Za-z][A-Za-z0-9]*$/.test(sortKey)) {
        return { sort: sortKey, desc: saved.desc !== false }
      }
      return { sort: 'dateAdded', desc: true }
    }
  } catch {
    // Ignore a malformed preference.
  }
  return { sort: 'dateAdded', desc: true }
}

function restoreDetailsOpen() {
  try {
    return localStorage.getItem(DETAILS_STORAGE) !== '0'
  } catch {
    return true
  }
}

function viewTitle(view) {
  if (view.kind === 'collection') return view.name
  if (view.kind === 'tag') return `标签：${view.name}`
  if (view.kind === 'unfiled') return '未分类'
  if (view.kind === 'trash') return '回收站'
  return '我的文库'
}

function formatClock(iso) {
  const at = new Date(iso)
  return Number.isFinite(at.getTime()) ? at.toLocaleTimeString('zh-CN', { hour12: false }) : ''
}

/**
 * Toast = 通知 + 可复制错误：正文允许选中（报错原文常要贴给别人看），右侧
 * 一键复制全文。
 */
function Toast({ message }) {
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => { setCopied(false) }, [message])
  return (
    <div className="lib-toast">
      <span className="lib-toast-text">{message}</span>
      <button
        type="button"
        className="lib-toast-copy"
        onClick={() => {
          try { navigator.clipboard?.writeText(String(message ?? '')) } catch { /* clipboard denied */ }
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }}
      >
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  )
}

/**
 * 检索元数据 progress dialog (右键 → 检索元数据 / 重新获取): running → done /
 * failed; a failure asks whether to hand the job to the Library assistant.
 * The backdrop is inert while running so the fetch cannot be dismissed away.
 */
function RecognitionDialog({ state, onAI, onClose }) {
  const running = state.status === 'running'
  return (
    <div
      className="lib-modal-backdrop"
      onMouseDown={event => { if (!running && event.target === event.currentTarget) onClose() }}
    >
      <div className="lib-modal lib-recognize" style={{ width: 400 }} role="dialog" aria-label="检索元数据">
        <div className="lib-modal-head">检索元数据</div>
        <div className="lib-modal-body">
          {running ? (
            <>
              <div className="lib-recognize-run">
                <span className="lib-spinner" aria-hidden="true" />
                <span>正在检索元数据（{state.done}/{state.total}）…</span>
              </div>
              {state.current ? <div className="lib-form-hint">{state.current}</div> : null}
            </>
          ) : null}
          {!running && state.status === 'done' ? (
            <>
              <div className="lib-recognize-ok">✓ 已检索成功</div>
              {state.succeeded.map(entry => <div className="lib-form-hint" key={entry.key}>{entry.title}</div>)}
            </>
          ) : null}
          {!running && state.status === 'failed' ? (
            <>
              <div className="lib-recognize-bad">未能检索到元数据</div>
              {state.succeeded.map(entry => <div className="lib-form-hint" key={entry.key}>✓ {entry.title}</div>)}
              {state.failed.map(entry => (
                <div className="lib-recognize-item" key={entry.key}>
                  ✗ {entry.title || entry.key}{entry.message ? `：${entry.message}` : ''}
                </div>
              ))}
              <div className="lib-form-hint">可以让文献助手阅读附件全文，用 AI 检索并补全元数据。</div>
            </>
          ) : null}
        </div>
        <div className="lib-modal-foot">
          {running ? <span className="lib-form-hint">检索中，请稍候…</span> : null}
          {!running && state.status === 'done' ? <Button variant="primary" size="sm" onClick={onClose}>好</Button> : null}
          {!running && state.status === 'failed' ? (
            <>
              <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
              <Button variant="primary" size="sm" onClick={onAI}>让AI获取</Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** The whole library page: toolbar, three panes and the floating assistant. */
export function LibraryPage({ layout, openSettings, openNativeSession, retainSession, renderSlot, SessionProvider }) {
  const dark = useDarkMode()
  const initialSort = React.useMemo(restoreSort, [])
  const [view, setView] = React.useState(restoreView)
  const [query, setQuery] = React.useState('')
  const debouncedQuery = useDebounced(query, 300)
  const [sort, setSort] = React.useState(initialSort.sort)
  const [desc, setDesc] = React.useState(initialSort.desc)
  const [snapshot, setSnapshot] = React.useState(undefined)
  const [data, setData] = React.useState(undefined)
  const [tags, setTags] = React.useState([])
  const [items, setItems] = React.useState([])
  const [total, setTotal] = React.useState(0)
  const [itemsLoading, setItemsLoading] = React.useState(false)
  const [selectedKeys, setSelectedKeys] = React.useState([])
  const [activeKey, setActiveKey] = React.useState('')
  const [detail, setDetail] = React.useState(undefined)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [booting, setBooting] = React.useState(true)
  const [toast, setToast] = React.useState('')
  const [importing, setImporting] = React.useState([])
  const [collectionDialog, setCollectionDialog] = React.useState({ open: false, mode: 'create', target: undefined })
  const [syncing, setSyncing] = React.useState(false)
  const [reconnecting, setReconnecting] = React.useState(false)
  const [killingZotero, setKillingZotero] = React.useState(false)
  const [settingUp, setSettingUp] = React.useState('')
  // 「schema 比插件新」面板：更新插件 / 一键修复按钮的在途状态与结果消息。
  const [repairing, setRepairing] = React.useState('')
  const [schemaMessage, setSchemaMessage] = React.useState('')
  const [detailsOpen, setDetailsOpen] = React.useState(restoreDetailsOpen)
  // Visible list columns (Zotero's column picker): owned here so the items
  // request can carry the matching field names to the host.
  const [columns, setColumns] = React.useState(restoreColumns)
  // User-adjusted column widths (px per column id); defaults stay in COLUMN_DEFS.
  const [columnWidths, setColumnWidths] = React.useState(restoreColumnWidths)
  // Locate requests (newly imported / show-in-library): {key, nonce}; the
  // nonce makes repeated locates of the same key re-trigger the scroll.
  const [reveal, setReveal] = React.useState(null)
  // Item context menu (right-click on a row): {x, y, keys}.
  const [contextMenu, setContextMenu] = React.useState(null)
  // Small input dialog used where Electron lacks window.prompt (网页链接).
  const [prompt, setPrompt] = React.useState(null)
  // 检索元数据 progress dialog (right-click → 检索元数据 / 重新获取).
  const [recognizing, setRecognizing] = React.useState(null)
  const attachFileRef = React.useRef(null)
  const pendingAttachParentsRef = React.useRef([])
  // Bundled item-type schema (per type: field order + creator types), fetched
  // once; drives the item pane's type menu, field list and creator rows.
  const [schemaTypes, setSchemaTypes] = React.useState(undefined)
  // Toolbar 新建条目 menu + Add-by-Identifier popover (Zotero's magic wand).
  const [createMenuOpen, setCreateMenuOpen] = React.useState(false)
  const [identifierOpen, setIdentifierOpen] = React.useState(false)
  const [identifierDraft, setIdentifierDraft] = React.useState('')
  const [identifierBusy, setIdentifierBusy] = React.useState(false)
  const createMenuRef = React.useRef(null)
  const identifierRef = React.useRef(null)
  React.useEffect(() => {
    if (!createMenuOpen && !identifierOpen) return undefined
    const close = (event) => {
      if (createMenuRef.current && !createMenuRef.current.contains(event.target)) setCreateMenuOpen(false)
      if (identifierRef.current && !identifierRef.current.contains(event.target)) setIdentifierOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [createMenuOpen, identifierOpen])
  // In-app viewer tabs: [{key, parentKey, title, bytes}]; '' active = the list
  // view. Tabs host the pdf.js viewer (the "dsh 内建查看器"), which owns
  // selection, annotations, rotation and find. The tab list (metadata) and each
  // document's reading position persist across panel switches and dsh restarts
  // via reader-store.js — switching to the conversation and back restores them
  // (bytes come from the hot cache without a refetch; after a restart they are
  // pulled again when the tab activates).
  const [reader, setReader] = React.useState(restoreReader)
  const readerRef = React.useRef(reader)
  readerRef.current = reader
  // 保温查看器的 MRU 序：最近激活的标签优先保留挂载（上限 WARM_VIEWER_LIMIT，
  // 见 warmTabs），更久的标签卸载后靠 reader-store 的文档热缓存免解析回来。
  const warmOrderRef = React.useRef([])
  React.useEffect(() => {
    if (reader.active === '') return
    warmOrderRef.current = [reader.active, ...warmOrderRef.current.filter(key => key !== reader.active)]
  }, [reader.active])
  // Per-attachment reading progress, written by the viewer (saveView); read
  // here to seed a tab's viewer at its last position when it mounts.
  const readerViewsRef = React.useRef(restoreViews())
  // Host sidebar (the dsh conversation list): entering the library collapses
  // it, leaving restores it. The left pane's back-to-chat button is always
  // visible, so no visibility polling is needed.
  const collapsedByUsRef = React.useRef(false)
  const selectionContextTimer = React.useRef(0)
  const toastTimer = React.useRef(0)
  const revealNonceRef = React.useRef(0)
  const revisionRef = React.useRef(-1)
  const snapshotRef = React.useRef(undefined)
  snapshotRef.current = snapshot
  const viewRef = React.useRef(view)
  const queryRef = React.useRef('')
  const itemsRef = React.useRef([])
  const columnsRef = React.useRef(columns)
  const dockRef = React.useRef(null)
  const detailRef = React.useRef(undefined)
  const activeKeyRef = React.useRef('')
  const contextMenuRef = React.useRef(null)
  viewRef.current = view
  queryRef.current = debouncedQuery
  itemsRef.current = items
  columnsRef.current = columns
  detailRef.current = detail
  activeKeyRef.current = activeKey
  contextMenuRef.current = contextMenu

  const notify = React.useCallback((message) => {
    setToast(message)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 4200)
  }, [])
  React.useEffect(() => () => clearTimeout(toastTimer.current), [])

  // 错误统一走这里：schema 不匹配 / 数据库被断开都可能从任何操作冒出来（在
  // 轮询把 available 翻转之前用户点了什么），与其在几十个 catch 里各塞修复
  // 按钮，不如让错误把界面直接带到带按钮的专属面板，toast 只负责把原因说清楚。
  const showError = React.useCallback((error) => {
    const code = String(error?.code ?? '')
    if (code === 'library/schema-too-new' || code === 'library/schema-incompatible'
      || code === 'library/db-detached' || code === 'library/db-locked') {
      api.call('state', {}).then((state) => {
        setSnapshot(state)
      }).catch(() => {
        setSnapshot(previous => ({
          ...(previous ?? {}),
          available: false,
          needsChoice: false,
          error: { code, message: error?.message ?? String(error) },
        }))
      })
    }
    notify(error?.message ?? String(error))
  }, [notify])

  // Collapse the host sidebar's conversation list while the library is open;
  // restore it exactly once, when this page unmounts.
  React.useEffect(() => {
    const open = probeSidebarOpen()
    if (open && typeof layout?.toggleSidebar === 'function') {
      try {
        layout.toggleSidebar()
        collapsedByUsRef.current = true
      } catch {
        // Collapsing is cosmetic; never block the library over it.
      }
    }
    return () => {
      if (collapsedByUsRef.current && typeof layout?.toggleSidebar === 'function') {
        try { layout.toggleSidebar() } catch { /* already gone */ }
        collapsedByUsRef.current = false
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadCollections = React.useCallback(async () => {
    const value = await api.call('collections', {})
    setData({ collections: value.collections, unfiled: value.unfiled, trash: value.trash })
    setTags(value.tags ?? [])
    return value
  }, [])

  const loadItems = React.useCallback(async ({ append = false, viewOverride, queryOverride } = {}) => {
    const targetView = viewOverride ?? viewRef.current
    const targetQuery = queryOverride ?? queryRef.current
    setItemsLoading(true)
    try {
      const filter = { query: targetQuery, sort, desc, limit: 100, offset: append ? itemsRef.current.length : 0 }
      if (targetView.kind === 'collection') filter.collectionID = targetView.id
      if (targetView.kind === 'unfiled') filter.unfiled = true
      if (targetView.kind === 'trash') filter.trash = true
      if (targetView.kind === 'tag') filter.tag = targetView.name
      // Generic columns (页码/其他/…) fetch their itemData values by name.
      const fieldNames = columnFieldNames(columnsRef.current)
      if (fieldNames.length > 0) filter.columns = fieldNames
      const value = await api.call('items', filter)
      setItems(previous => (append ? [...previous, ...value.items] : value.items))
      setTotal(value.total)
      return value
    } finally {
      setItemsLoading(false)
    }
  }, [sort, desc])

  const loadDetail = React.useCallback(async (key) => {
    if (!key) {
      setDetail(undefined)
      return
    }
    setDetailLoading(true)
    try {
      const value = await api.call('item', { key })
      setDetail(value)
    } catch (error) {
      setDetail(undefined)
      showError(error)
    } finally {
      setDetailLoading(false)
    }
  }, [notify])

  const safeLoadItems = React.useCallback(async (options) => {
    try {
      return await loadItems(options)
    } catch (error) {
      showError(error)
      return undefined
    }
  }, [loadItems, notify])

  const refreshAll = React.useCallback(async () => {
    try {
      await Promise.all([loadCollections(), loadItems()])
      if (activeKeyRef.current) await loadDetail(activeKeyRef.current)
    } catch (error) {
      showError(error)
    }
  }, [loadCollections, loadItems, loadDetail, notify])

  const reloadState = React.useCallback(async () => {
    const state = await api.call('state', {})
    setSnapshot(state)
    return state
  }, [])

  // Settings now live in dsh's native settings panel (a settings.section page).
  // It fires this event after saving, so "打开 PDF 的方式" and WebDAV settings
  // apply without a panel switch.
  React.useEffect(() => {
    const handler = (event) => {
      const saved = event.detail
      if (saved) setSnapshot(previous => ({ ...previous, settings: saved }))
      void reloadState().catch(() => {})
      void refreshAll().catch(() => {})
    }
    window.addEventListener(SETTINGS_SAVED_EVENT, handler)
    return () => window.removeEventListener(SETTINGS_SAVED_EVENT, handler)
  }, [reloadState, refreshAll])

  // Boot: connect to the host, then load the tree and the first page.
  React.useEffect(() => {
    let stopped = false
    ;(async () => {
      try {
        const state = await api.call('state', {})
        if (stopped) return
        setSnapshot(state)
        if (state.available) {
          await loadCollections()
          await loadItems({ viewOverride: viewRef.current, queryOverride: '' })
        }
      } catch (error) {
        if (!stopped) setSnapshot({ available: false, error: { message: error?.message ?? String(error) } })
      } finally {
        if (!stopped) setBooting(false)
      }
    })()
    return () => { stopped = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 信息栏的「全部字段 + 条目类型菜单」依赖条目类型 schema，而 schema 只在文
  // 库可用时拿得到：若首次打开恰好撞上 Zotero 占库（available=false），schema
  // 再也不会加载，右侧信息区从此一片空白。所以只要文库可用而 schema 还没有，
  // 就补拉 —— 恢复可用、设置保存后的 reloadState 等任何时机都会走到。
  React.useEffect(() => {
    if (snapshot?.available !== true) return
    if (Array.isArray(schemaTypes) && schemaTypes.length > 0) return
    let cancelled = false
    api.call('schema', {}).then((types) => {
      if (cancelled) return
      const list = Array.isArray(types) ? types : []
      setSchemaTypes((previous) => {
        // A parallel fetch already satisfied it — keep the existing reference
        // so an empty catalogue can never loop this effect.
        if (Array.isArray(previous) && (previous.length > 0 || list.length === 0)) return previous
        return list
      })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [snapshot?.available, schemaTypes])

  // Persist navigation preferences across panel switches.
  React.useEffect(() => {
    try {
      localStorage.setItem(VIEW_STORAGE, JSON.stringify(view))
      localStorage.setItem(SORT_STORAGE, JSON.stringify({ sort, desc }))
      localStorage.setItem(DETAILS_STORAGE, detailsOpen ? '1' : '0')
      localStorage.setItem('dsh-zot-library:columns', JSON.stringify(columns))
      localStorage.setItem('dsh-zot-library:column-widths', JSON.stringify(columnWidths))
    } catch {
      // Preferences are optional.
    }
  }, [view, sort, desc, detailsOpen, columns, columnWidths])

  // Reader tabs persist too: the hot cache keeps bytes for instant panel
  // switches, localStorage keeps the metadata for the next dsh run.
  React.useEffect(() => {
    rememberReader(reader)
  }, [reader])

  // Reload whenever the view, search text or sort changes.
  React.useEffect(() => {
    if (booting || snapshot?.available !== true) return
    setSelectedKeys([])
    setActiveKey('')
    setDetail(undefined)
    void safeLoadItems({ viewOverride: view, queryOverride: debouncedQuery })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, debouncedQuery, sort, desc, booting, snapshot?.available])

  // The right pane (文献信息) follows what the user is looking at: the
  // selected row in the list, or the article behind the active reader tab.
  const activeReaderTab = reader.active !== '' ? reader.tabs.find(tab => tab.key === reader.active) : undefined
  const detailKey = activeReaderTab ? (activeReaderTab.parentKey || activeReaderTab.key) : activeKey
  // 保温标签：有字节的标签按 MRU 截到上限（活动标签强制入选，顶掉最久未看的），
  // 顺序跟随 reader.tabs——成员变化只在尾部增删，不重排 DOM，查看器实例原样保留。
  const warmTabs = (() => {
    const candidates = reader.tabs.filter(tab => tab.bytes)
    if (candidates.length <= WARM_VIEWER_LIMIT) return candidates
    const order = warmOrderRef.current
    const rank = key => {
      const index = order.indexOf(key)
      return index === -1 ? order.length + candidates.length : index
    }
    const sorted = [...candidates].sort((a, b) => rank(a.key) - rank(b.key))
    const keep = sorted.slice(0, WARM_VIEWER_LIMIT)
    if (activeReaderTab?.bytes && !keep.some(tab => tab.key === activeReaderTab.key)) {
      keep[keep.length - 1] = activeReaderTab
    }
    const chosen = new Set(keep.map(tab => tab.key))
    return candidates.filter(tab => chosen.has(tab.key))
  })()

  React.useEffect(() => {
    void loadDetail(detailKey)
  }, [detailKey, loadDetail])

  // 恢复出来的标签（重启 dsh 后）只有元数据：成为活动标签时再拉取文件字节；
  // 拉不到（附件已删 / 换了文库）就把该标签摘掉，避免查看器永远停在「正在解析」。
  React.useEffect(() => {
    const tab = activeReaderTab
    if (!tab || tab.bytes) return undefined
    const key = tab.key
    let cancelled = false
    ;(async () => {
      try {
        const bundle = await fetchPdfBundle(key)
        if (cancelled) return
        setReader(previous => {
          if (!previous.tabs.some(entry => entry.key === key)) return previous
          return {
            ...previous,
            tabs: previous.tabs.map(entry => (entry.key === key
              ? { ...entry, bytes: bundle.bytes, parentKey: bundle.parentKey || entry.parentKey, title: bundle.title || entry.title }
              : entry)),
          }
        })
      } catch (error) {
        if (cancelled) return
        setReader(previous => ({
          tabs: previous.tabs.filter(entry => entry.key !== key),
          active: previous.active === key ? '' : previous.active,
        }))
        notify(`无法恢复标签「${tab.title}」：${error?.message ?? error}`)
      }
    })()
    return () => { cancelled = true }
  }, [activeReaderTab?.key, activeReaderTab?.bytes]) // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the host so changes made by the agent or by Zotero show up, and so a
  // locked library (Zotero running) recovers the moment Zotero exits — the
  // poll keeps running while unavailable and watches the availability flag.
  React.useEffect(() => {
    if (booting) return undefined
    let stopped = false
    const timer = setInterval(async () => {
      if (stopped || document.hidden) return
      try {
        const value = await api.call('ping', {})
        if (stopped) return
        // Older hosts omit `available`; treat that as "unchanged".
        if (typeof value?.available === 'boolean') {
          const wasAvailable = snapshotRef.current?.available === true
          if (value.available !== wasAvailable) {
            const state = await api.call('state', {})
            if (stopped) return
            setSnapshot(state)
            revisionRef.current = state.revision
            if (state.available === true) {
              await refreshAll().catch(() => {})
            }
            return
          }
        }
        if (value?.revision !== undefined && value.revision !== revisionRef.current) {
          if (revisionRef.current !== -1) await refreshAll()
          revisionRef.current = value.revision
        }
      } catch {
        // The next tick retries; a transient miss is not user-facing.
      }
    }, 5000)
    return () => { stopped = true; clearInterval(timer) }
  }, [booting, refreshAll])

  const selectItem = (key, { toggle, range }) => {
    if (toggle) {
      setSelectedKeys(previous => (previous.includes(key) ? previous.filter(value => value !== key) : [...previous, key]))
      setActiveKey(key)
      return
    }
    if (range && activeKey) {
      const keys = items.map(item => item.key)
      const from = keys.indexOf(activeKey)
      const to = keys.indexOf(key)
      if (from !== -1 && to !== -1) {
        const [start, end] = from < to ? [from, to] : [to, from]
        setSelectedKeys(keys.slice(start, end + 1))
        setActiveKey(key)
        return
      }
    }
    setSelectedKeys([key])
    setActiveKey(key)
  }

  const openItem = async (key) => {
    // "Open" honors the pdfOpen setting: 'native' hands the file to the OS
    // reader; 'builtin' (the default; legacy 'dsh' settings mean the same)
    // opens an in-app tab rendered by the pdf.js viewer.
    const mode = snapshot?.settings?.pdfOpen ?? 'builtin'
    if (mode === 'native') {
      try {
        await api.call('open', { key })
      } catch (error) {
        showError(error)
      }
      return
    }
    await openInApp(key)
  }

  // Fetch the file bytes + identity headers for one attachment. Shared by
  // openInApp (fresh open) and the restore path (a tab remembered from an
  // earlier panel visit / dsh run whose bytes are not in memory). Error codes
  // ride on the Error so callers can route (web fallback / native open).
  const fetchPdfBundle = async (key) => {
    // Binary streaming route: no base64 round trip, so large papers open fast.
    const response = await fetch(`api/library/file?key=${encodeURIComponent(key)}`, { credentials: 'same-origin' })
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      let code = ''
      let url = ''
      try {
        const body = await response.json()
        message = body?.error?.message ?? message
        code = String(body?.error?.code ?? '')
        url = String(body?.error?.url ?? '')
      } catch { /* non-JSON error body */ }
      const error = new Error(message)
      error.code = code
      error.url = url
      throw error
    }
    const contentType = response.headers.get('content-type') ?? 'application/pdf'
    if (contentType !== 'application/pdf') {
      // Only PDFs render in the in-app viewer; everything else opens natively.
      const error = new Error('该附件不是 PDF')
      error.code = 'library/not-pdf'
      throw error
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    return {
      bytes,
      attachmentKey: response.headers.get('x-library-attachment-key') ?? key,
      parentKey: response.headers.get('x-library-parent-key') ?? key,
      title: decodeURIComponent(response.headers.get('x-library-title') ?? 'PDF'),
    }
  }

  const openInApp = async (key) => {
    try {
      const bundle = await fetchPdfBundle(key)
      setReader(previous => {
        const existing = previous.tabs.find(tab => tab.key === bundle.attachmentKey)
        if (existing) {
          // A restored tab (metadata only, no bytes yet) fills in here too.
          return {
            ...previous,
            active: bundle.attachmentKey,
            tabs: previous.tabs.map(entry => (entry.key === bundle.attachmentKey && !entry.bytes
              ? { ...entry, bytes: bundle.bytes, parentKey: bundle.parentKey, title: bundle.title }
              : entry)),
          }
        }
        return {
          tabs: [...previous.tabs, { key: bundle.attachmentKey, parentKey: bundle.parentKey, title: bundle.title, bytes: bundle.bytes }],
          active: bundle.attachmentKey,
        }
      })
    } catch (error) {
      // No openable file, but the record points at the web (url field / DOI):
      // open the browser instead of showing an error (Zotero's behaviour).
      if (error.code === 'library/open-url' && /^https?:\/\//i.test(error.url ?? '')) {
        try {
          await api.call('open-url', { url: error.url })
        } catch (openError) {
          notify(openError?.message ?? String(openError))
        }
        return
      }
      if (error.code === 'library/not-pdf') {
        try {
          await api.call('open', { key })
        } catch (openError) {
          showError(openError)
        }
        return
      }
      showError(error)
    }
  }

  const closeReaderTab = (key) => {
    setReader(previous => {
      const tabs = previous.tabs.filter(entry => entry.key !== key)
      return { tabs, active: previous.active === key ? '' : previous.active }
    })
  }

  // Keep the host-side chat context in step with the ACTIVE tab: a reader tab
  // → reader guidance for that paper; the 文献列表 tab → list guidance (the
  // selected item only as a weak hint). The native composer bypasses
  // chat-send, so without the list-side push the host would keep grounding
  // composer messages on the last-read paper after the user returns to the
  // list.
  React.useEffect(() => {
    clearTimeout(selectionContextTimer.current)
    selectionContextTimer.current = setTimeout(() => {
      const context = activeReaderTab
        ? { mode: 'reader', itemKey: activeReaderTab.parentKey, itemTitle: activeReaderTab.title }
        : (activeKeyRef.current && detailRef.current?.key === activeKeyRef.current
          ? { mode: 'list', itemKey: activeKeyRef.current, itemTitle: detailRef.current.title }
          : { mode: 'list' })
      api.call('chat-context', { context }).catch(() => {})
    }, 400)
    return () => clearTimeout(selectionContextTimer.current)
  }, [activeReaderTab?.key, activeKey, detail]) // eslint-disable-line react-hooks/exhaustive-deps

  const revealItem = async (key) => {
    try {
      await api.call('open', { key, reveal: true })
    } catch (error) {
      showError(error)
    }
  }

  const updateItem = async (key, patch) => {
    try {
      await api.call('update', { key, patch })
      await Promise.all([loadDetail(key), loadItems(), loadCollections()])
    } catch (error) {
      showError(error)
    }
  }

  // Zotero's 新建条目 menu: pick a type, an empty item is created at once and
  // edited in the details pane.
  const createItemOfType = async (itemType) => {
    setCreateMenuOpen(false)
    try {
      const created = await api.call('create', {
        itemType,
        fields: {},
        creators: [],
        collectionIDs: viewRef.current.kind === 'collection' ? [viewRef.current.id] : [],
      })
      await refreshAll()
      setSelectedKeys([created.key])
      setActiveKey(created.key)
      notify(`已创建${itemTypeLabel(itemType)}，在右侧信息栏中编辑`)
    } catch (error) {
      showError(error)
    }
  }

  // Zotero's magic wand: one DOI / ISBN / arXiv id / PMID per line, each
  // resolved online and added as a proper item.
  const addByIdentifier = async () => {
    if (identifierDraft.trim() === '') return
    setIdentifierBusy(true)
    try {
      const drafts = await api.call('lookup', { identifier: identifierDraft })
      const createdKeys = []
      for (const draft of Array.isArray(drafts) ? drafts : []) {
        if (!draft?.fields?.title) continue
        const created = await api.call('create', {
          itemType: draft.itemType ?? 'document',
          fields: draft.fields,
          creators: draft.creators ?? [],
          tags: draft.tags ?? [],
          collectionIDs: viewRef.current.kind === 'collection' ? [viewRef.current.id] : [],
        })
        createdKeys.push(created.key)
      }
      if (createdKeys.length === 0) {
        notify('没有找到匹配的元数据，请检查标识符（支持 DOI / ISBN / arXiv / PMID）')
        return
      }
      setIdentifierOpen(false)
      setIdentifierDraft('')
      await refreshAll()
      setSelectedKeys([createdKeys[0]])
      setActiveKey(createdKeys[0])
      notify(`已通过标识符添加 ${createdKeys.length} 条文献`)
    } catch (error) {
      showError(error)
    } finally {
      setIdentifierBusy(false)
    }
  }

  // Details-pane attachment/note actions.
  const openUrlExternal = async (url) => {
    try {
      await api.call('open-url', { url })
    } catch (error) {
      showError(error)
    }
  }
  const addAttachmentFile = async (file) => {
    const parentKey = activeKeyRef.current
    if (!parentKey) return
    try {
      const localPath = filePathOf(file)
      if (localPath) await api.call('import', { path: localPath, parentKey, lookup: false })
      else await api.call('upload', { name: file.name, data: await fileBase64(file), parentKey, lookup: false })
      notify('附件已添加')
      await refreshAll()
    } catch (error) {
      showError(error)
    }
  }
  const addAttachmentUrl = async (url) => {
    const parentKey = activeKeyRef.current
    if (!parentKey) return
    await api.call('attachment-url', { parentKey, url })
    await refreshAll()
  }
  const trashAttachment = async (key) => {
    if (!window.confirm('将附件移到回收站？')) return
    try {
      await api.call('trash', { keys: [key] })
      await refreshAll()
    } catch (error) {
      showError(error)
    }
  }
  const updateNote = async (key, text) => {
    await api.call('note-update', { key, text })
    await loadDetail(activeKeyRef.current)
  }

  const moveToTrash = async (restore = false, keys = selectedKeys) => {
    if (keys.length === 0) return
    try {
      await api.call('trash', { keys, restore })
      notify(restore ? '已还原' : '已移到回收站')
      setSelectedKeys([])
      setActiveKey('')
      await refreshAll()
    } catch (error) {
      showError(error)
    }
  }

  const deleteForever = async (keys = selectedKeys) => {
    if (keys.length === 0) return
    if (!window.confirm(`永久删除 ${keys.length} 条记录？该操作不可撤销。`)) return
    try {
      await api.call('delete', { keys })
      notify('已永久删除')
      setSelectedKeys([])
      setActiveKey('')
      await refreshAll()
    } catch (error) {
      showError(error)
    }
  }

  // Copy text to the OS clipboard with a user-visible verdict.
  const copyText = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text)
      notify(`已复制${label}`)
    } catch {
      notify('复制失败：剪贴板不可用')
    }
  }

  /**
   * Item context menu actions (Zotero's 条目右键菜单). `keys` is the selection
   * the menu was opened with; most handlers refresh and re-reveal the target.
   */
  const runItemAction = async (action, arg) => {
    setContextMenu(null)
    const keys = contextMenuRef.current?.keys ?? []
    if (keys.length === 0) return
    const first = keys[0]
    try {
      switch (action) {
        case 'open': {
          // Attachment rows open their file; DOI-only rows let the host resolve
          // a web address (url field / doi.org) and open the browser.
          const target = keys.find(key => itemsRef.current.some(row => row.key === key && (row.hasAttachment || row.itemType === 'attachment' || String(row.doi ?? '').trim() !== '')))
          await openItem(target ?? first)
          break
        }
        case 'open-native': {
          const target = keys.find(key => itemsRef.current.some(row => row.key === key && (row.hasAttachment || row.itemType === 'attachment')))
          await api.call('open', { key: target ?? first })
          break
        }
        case 'reveal': {
          const target = keys.find(key => itemsRef.current.some(row => row.key === key && (row.hasAttachment || row.itemType === 'attachment')))
          await revealItem(target ?? first)
          break
        }
        case 'show-in-library': {
          setQuery('')
          setView({ kind: 'all' })
          await loadItems({ viewOverride: { kind: 'all' }, queryOverride: '' })
          await loadCollections()
          setSelectedKeys([first])
          setActiveKey(first)
          setReveal({ key: first, nonce: (revealNonceRef.current += 1) })
          break
        }
        case 'add-note': {
          for (const key of keys) await api.call('note-create', { parentKey: key, text: '' })
          notify(keys.length > 1 ? `已为 ${keys.length} 条文献添加笔记` : '已添加笔记')
          await refreshAll()
          break
        }
        case 'note-from-annotations': {
          const created = await api.call('note-from-annotations', { key: first })
          notify('已从批注创建笔记')
          await refreshAll()
          if (created?.key) await loadDetail(first)
          break
        }
        case 'attach-file': {
          pendingAttachParentsRef.current = keys
          try {
            attachFileRef.current?.click()
          } catch {
            notify('无法打开文件选择器')
          }
          break
        }
        case 'attach-url': {
          setPrompt({
            title: '添加网页链接',
            placeholder: 'https://…',
            confirmLabel: '添加',
            onConfirm: async (url) => {
              setPrompt(null)
              try {
                for (const key of keys) await api.call('attachment-url', { parentKey: key, url })
                notify('已添加网页链接')
                await refreshAll()
              } catch (error) {
                showError(error)
              }
            },
          })
          break
        }
        case 'add-to-collection': {
          for (const key of keys) {
            await api.call('update', { key, patch: { addCollections: [Number(arg)] } })
          }
          notify('已添加到分类')
          await refreshAll()
          break
        }
        case 'remove-from-collection': {
          if (!window.confirm(`确定要从分类「${viewRef.current.name}」中移除所选条目吗？`)) return
          for (const key of keys) {
            await api.call('update', { key, patch: { removeCollections: [viewRef.current.id] } })
          }
          notify('已从分类中移除')
          await refreshAll()
          break
        }
        case 'duplicate': {
          const createdKeys = []
          for (const key of keys) {
            const created = await api.call('duplicate', { key })
            if (created?.key) createdKeys.push(created.key)
          }
          notify('已创建条目副本')
          await refreshAll()
          if (createdKeys[0]) await revealImported(createdKeys[0])
          break
        }
        case 'merge': {
          if (!window.confirm(`确定将 ${keys.length} 个条目合并为一个吗？其余条目将移入回收站。`)) return
          const result = await api.call('merge', { keys })
          notify('已合并条目')
          await refreshAll()
          if (result?.key) await revealImported(result.key)
          break
        }
        case 'create-parent': {
          for (const key of keys) {
            const created = await api.call('create-parent', { key })
            if (created?.parentKey) await revealImported(created.parentKey)
          }
          notify('已创建上级条目，在右侧信息栏中编辑')
          break
        }
        case 'recognize': {
          // 检索元数据 on standalone attachments: import-finalize builds the
          // parent when the lookup hits.
          await runRecognition('finalize', keys)
          break
        }
        case 'recognize-auto': {
          // 重新获取：re-read the attachment, resolve online, write back into
          // the SAME item (the host merges fetched values over existing ones).
          const targets = Array.isArray(arg) && arg.length > 0 ? arg : keys
          await runRecognition('item', targets)
          break
        }
        case 'recognize-ai': {
          // 让AI获取：hand the whole job to the Library assistant dock.
          sendRefetchTask(Array.isArray(arg) && arg.length > 0 ? arg : keys)
          break
        }
        case 'detach': {
          if (!window.confirm('确定将该附件转换为独立条目吗？')) return
          await api.call('detach-attachment', { key: first })
          notify('已转换为独立附件')
          await refreshAll()
          break
        }
        case 'copy-bibtex': {
          const result = await api.call('cite-bibtex', { keys })
          await copyText(result.text ?? '', 'BibTeX')
          break
        }
        case 'copy-csl': {
          const result = await api.call('cite-json', { keys })
          await copyText(JSON.stringify(result.items ?? [], null, 2), 'CSL JSON')
          break
        }
        case 'trash':
          await moveToTrash(false, keys)
          break
        case 'restore':
          await moveToTrash(true, keys)
          break
        case 'delete':
          await deleteForever(keys)
          break
        default:
          break
      }
    } catch (error) {
      showError(error)
    }
  }

  // Attach-file menu action finishes here after the OS picker closes.
  const onAttachFilesChosen = async (event) => {
    const files = [...(event.target?.files ?? [])]
    event.target.value = ''
    const parents = pendingAttachParentsRef.current
    pendingAttachParentsRef.current = []
    if (files.length === 0 || parents.length === 0) return
    try {
      for (const parentKey of parents) {
        for (const file of files) {
          const localPath = filePathOf(file)
          if (localPath) await api.call('import', { path: localPath, parentKey, lookup: false })
          else await api.call('upload', { name: file.name, data: await fileBase64(file), parentKey, lookup: false })
        }
      }
      notify('附件已添加')
      await refreshAll()
    } catch (error) {
      showError(error)
    }
  }

  // Ask the agent (in the Library workspace) to fix one import's metadata.
  const fixMetadataWithAgent = (entry) => {
    const hasParent = Boolean(entry.parentKey)
    const task = [
      '请为刚导入的文献补全元数据（标题、作者、年份、期刊/出版物、卷期页、DOI 等）：',
      `文件名「${entry.name}」${entry.parentKey ? `，条目 key ${entry.parentKey}` : '（尚未建立条目，只有附件）'}${entry.attachmentKey ? `，附件 key ${entry.attachmentKey}` : ''}。`,
      hasParent
        ? '建议先用 library_read 的 search 参数从全文中确认题名与作者，再用联网搜索核对，最后用 library_update 把字段写回该条目；同时维护 shortTitle（中文 10~20 字概括这篇文章的重点）与 abstractNote（忠实的原文摘要，拿不到就留空，不要编造）。'
        : '建议先用 library_read 的 search 参数从全文中确认题名与作者，再用联网搜索核对，最后用 library_add 建立规范的父条目并补全字段（含 shortTitle：中文 10~20 字重点概括；abstractNote：原文摘要，拿不到就留空，不要编造）。',
    ].join('')
    void dockRef.current?.openAndSend(task, { mode: 'list' })
  }

  /** Find a list row (parent or expanded child) by its item key. */
  const rowByKey = (key) => {
    for (const row of itemsRef.current) {
      if (row.key === key) return row
      for (const child of row.children ?? []) {
        if (child.key === key) return child
      }
    }
    return undefined
  }

  /**
   * Make a key visible in the current list and locate-select it. Falls back to
   * the whole library when the current view filters the item out (e.g. trash
   * or a tag view), so a freshly imported record is always findable.
   */
  const revealImported = async (key) => {
    if (!key) return
    try {
      const value = await loadItems({ viewOverride: viewRef.current, queryOverride: queryRef.current })
      let found = (value?.items ?? []).some(row => row.key === key)
      if (!found && viewRef.current.kind !== 'all') {
        const all = await loadItems({ viewOverride: { kind: 'all' }, queryOverride: '' })
        found = (all?.items ?? []).some(row => row.key === key)
        setView({ kind: 'all' })
        setQuery('')
      }
      await loadCollections()
      if (found) {
        setSelectedKeys([key])
        setActiveKey(key)
        setReveal({ key, nonce: (revealNonceRef.current += 1) })
      } else {
        notify('已导入，但当前列表未能显示该条目，请刷新查看')
      }
    } catch (error) {
      showError(error)
    }
  }

  /** 让AI获取: hand the whole job to the Library assistant dock. */
  const sendRefetchTask = (targets) => {
    const list = targets.map((key) => {
      const row = rowByKey(key)
      return `「${row?.title || '（未命名条目）'}」（条目 key ${key}）`
    }).join('、')
    const task = [
      `请为以下文献重新获取元数据：${list}。`,
      '先用 library_read 的 search 从附件全文确认题名、作者、年份、期刊/出版物、卷期页、DOI 等，再用联网搜索核对，最后用 library_update 把字段写回原条目（不要新建条目）；同时维护 shortTitle（中文 10~20 字概括这篇文章的重点，不是标题翻译）与 abstractNote（忠实的原文摘要，拿不到就留空，不要编造）。',
    ].join('')
    void dockRef.current?.openAndSend(task, { mode: 'list' })
  }

  /**
   * 重新获取/检索元数据 with visible feedback: a progress dialog that ends in
   * 已检索成功 or — with a one-click hand-off — 让AI获取 on failure.
   * kind 'finalize' re-recognizes standalone attachments (import-finalize,
   * which builds the parent), kind 'item' refreshes an item in place.
   */
  const runRecognition = async (kind, keys) => {
    const rows = keys.map(key => ({ key, title: rowByKey(key)?.title ?? '' }))
    setRecognizing({ status: 'running', total: rows.length, done: 0, current: rows[0]?.title ?? '', succeeded: [], failed: [] })
    const succeeded = []
    const failed = []
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      setRecognizing(previous => ({ ...previous, done: index, current: row.title }))
      try {
        const result = kind === 'finalize'
          ? await api.call('import-finalize', { attachmentKey: row.key })
          : await api.call('recognize-item', { key: row.key })
        const okResult = kind === 'finalize' ? Boolean(result?.parentKey) : Boolean(result?.updated)
        const title = result?.title ?? result?.metadata?.title ?? row.title
        if (okResult) {
          succeeded.push({ key: kind === 'finalize' ? result.parentKey : (result.key ?? row.key), title })
        } else {
          failed.push({ key: row.key, title, message: result?.message })
        }
      } catch (error) {
        failed.push({ key: row.key, title: row.title, message: error?.message ?? String(error) })
      }
      setRecognizing(previous => ({ ...previous, done: index + 1 }))
    }
    await refreshAll()
    if (succeeded[0]) await revealImported(succeeded[0].key)
    setRecognizing(previous => ({
      ...previous,
      status: failed.length === 0 ? 'done' : 'failed',
      succeeded,
      failed,
    }))
  }

  /**
   * Zotero-style two-phase drag import. Phase 1 registers each file as a
   * standalone attachment item right away and locates it in the list, so the
   * user immediately sees what landed. Phase 2 resolves metadata (and builds
   * the parent item); the located selection moves to the finished record.
   */
  const importFiles = async (files) => {
    const collectionID = viewRef.current.kind === 'collection' ? viewRef.current.id : null
    const staged = []
    // Phase 1: show every dropped file at once.
    for (const file of files) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      setImporting(previous => [...previous, { id, name: file.name, status: 'importing' }])
      try {
        const localPath = filePathOf(file)
        const result = localPath
          ? await api.call('import', { path: localPath, collectionID, deferMetadata: true })
          : await api.call('upload', { name: file.name, data: await fileBase64(file), collectionID, deferMetadata: true })
        staged.push({ id, file, result })
        await revealImported(result.attachmentKey)
      } catch (error) {
        setImporting(previous => previous.map(entry => (entry.id === id
          ? { ...entry, status: 'error', error: error?.message ?? String(error) }
          : entry)))
        staged.push({ id, file, failed: true })
      }
    }
    // Phase 2: metadata resolution (queued on the host), one record at a time.
    for (const { id, file, result, failed } of staged) {
      if (failed || !result?.attachmentKey) continue
      // Keep the "fix with AI" offer around longer than a plain success note.
      let sticky = 9000
      try {
        const final = await api.call('import-finalize', { attachmentKey: result.attachmentKey, collectionID })
        const parentKey = final.parentKey ?? null
        const needsHelp = final.needsMetadataHelp === true || !parentKey
        if (needsHelp) sticky = 120_000
        setImporting(previous => previous.map(entry => (entry.id === id
          ? {
              ...entry,
              status: 'done',
              title: final.metadata?.title ?? final.fileName,
              key: parentKey,
              parentKey,
              attachmentKey: final.attachmentKey ?? result.attachmentKey,
              needsHelp,
              onFix: needsHelp
                ? () => fixMetadataWithAgent({
                    name: file.name,
                    parentKey,
                    attachmentKey: final.attachmentKey ?? result.attachmentKey,
                  })
                : undefined,
            }
          : entry)))
        await revealImported(parentKey ?? final.attachmentKey)
        if (needsHelp) notify('已导入，但元数据不完整；可点击「用 AI 补全元数据」让文献助手处理')
      } catch (error) {
        setImporting(previous => previous.map(entry => (entry.id === id
          ? { ...entry, status: 'error', error: error?.message ?? String(error) }
          : entry)))
      } finally {
        const cleanup = setTimeout(() => setImporting(previous => previous.filter(entry => entry.id !== id)), sticky)
        // Long-lived stickies (the AI-fix offer) must not pin the host loop.
        if (typeof cleanup?.unref === 'function') cleanup.unref()
      }
    }
  }

  const runSync = async () => {
    setSyncing(true)
    try {
      // Zotero mode: bring the Zotero client up front — the user clicks sync
      // there; database changes arrive via the revision polling afterwards.
      // The hand-off disconnects our database so Zotero can take the file:
      // pull the state so the page switches to the detached panel at once.
      if (snapshot?.settings?.mode === 'zotero') {
        const result = await api.call('zotero-sync-run', {})
        await reloadState().catch(() => {})
        notify(result?.message ?? '已唤起 Zotero')
        return
      }
      if (snapshot?.settings?.webdav?.url === '') {
        openSettings?.()
        notify('请先在设置的 WebDAV 页配置服务器')
        return
      }
      const result = await api.call('sync-run', {})
      notify(`同步完成：上传 ${result.uploaded}，下载 ${result.downloaded}，冲突 ${result.conflicts}，失败 ${result.failed}`)
      await refreshAll()
    } catch (error) {
      showError(error)
    } finally {
      setSyncing(false)
    }
  }

  // 断连面板的「结束 Zotero 进程」：插件与 Zotero 对数据库互斥，等不了时的
  // 最后手段。强制结束会丢掉 Zotero 里未保存/未同步的内容，必须先确认。
  const killZoteroNow = async () => {
    if (!window.confirm('确定强制结束 Zotero 进程吗？\n\n文库数据库正被它独占（或正在等待它启动）。强制结束可立即解除占用，但 Zotero 中未保存或未同步的内容会丢失；结束后文库会自动重新连接。')) return
    setKillingZotero(true)
    try {
      const result = await api.call('zotero-kill', {})
      if (result?.state) setSnapshot(result.state)
      notify(result?.killed > 0
        ? (result.state?.available === true
          ? `已结束 ${result.killed} 个 Zotero 进程，文库已重新连接`
          : `已结束 ${result.killed} 个 Zotero 进程，等待文件锁释放后自动重连…`)
        : '没有找到正在运行的 Zotero 进程')
    } catch (error) {
      notify(error?.message ?? String(error))
    } finally {
      setKillingZotero(false)
    }
  }

  // 断连面板的「立即重新连接」：宿主每 5 秒也在自动尝试，按钮只是不等它。
  const reconnectNow = async () => {
    setReconnecting(true)
    try {
      const result = await api.call('db-reconnect', {})
      if (result?.state) setSnapshot(result.state)
      if (result?.reconnected) {
        notify('已重新连接文库数据库')
        await refreshAll()
      } else if (result?.reason === 'zotero-running') {
        notify('Zotero 仍在运行：请先退出 Zotero，文库会自动重连')
      } else if (result?.reason === 'waiting-zotero') {
        notify('Zotero 正在启动，稍候再试')
      } else if (result?.reason !== 'superseded') {
        notify('数据库仍被占用，稍后会自动重试')
      }
    } catch (error) {
      notify(error?.message ?? String(error))
    } finally {
      setReconnecting(false)
    }
  }

  // First open: link the existing Zotero library, or start standalone.
  const setupLibrary = async (mode) => {
    setSettingUp(mode)
    try {
      const state = await api.call('setup', { mode })
      setSnapshot(state)
      if (state.available) {
        await loadCollections()
        await loadItems({ viewOverride: { kind: 'all' }, queryOverride: '' })
        notify(mode === 'standalone' ? '已创建独立文库' : '已关联 Zotero 文库')
      } else {
        notify(state.error?.message ?? '设置失败')
      }
    } catch (error) {
      showError(error)
    } finally {
      setSettingUp('')
    }
  }

  // 「Zotero 数据库结构更新」面板的两个自助按钮。更新走 dsh 插件管理器的
  // 检查/安装（HMR 下插件会被短暂替换，应答中断就轮询 update-status 等新版
  // 本就位）；一键修复 = 宿主自检核心表结构后以兼容模式接受新 schema（结构
  // 差异过大时宿主会拒绝并给出原因）。
  const repairPlugin = async () => {
    setRepairing('update')
    setSchemaMessage('')
    try {
      const status = await api.call('update-check', {})
      if (!status.available) {
        setSchemaMessage(`${status.reason ?? `已是最新版本（${status.current}），还没有适配新 schema 的发布`}；可用「一键修复」以兼容模式继续使用文库。`)
        return
      }
      const target = status.latest
      let settled = false
      try {
        const result = await api.call('update-apply', { version: target })
        settled = true
        setSchemaMessage(result?.restartRequired
          ? `已安装 ${result?.to ?? target}，重启 dsh 后生效；若重启后文库仍不可用，再用「一键修复」。`
          : `已更新到 ${result?.to ?? target}；若文库仍不可用，再用「一键修复」。`)
      } catch (applyError) {
        const code = String(applyError?.code ?? '')
        if (code === 'library/update-failed' || code === 'library/update-none' || code === 'library/no-plugin-manager') {
          setSchemaMessage(applyError?.message ?? String(applyError))
          return
        }
        // 应答中断 = HMR 正在替换本插件：轮询直到新版本应答。
      }
      if (settled) return
      setSchemaMessage(`正在更新到 ${target}…（插件会短暂重启）`)
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2000))
        try {
          const next = await api.call('update-status', {})
          if (compareVersions(next?.current, target) >= 0) {
            setSchemaMessage(`已更新到 ${next.current}；若文库仍不可用，再用「一键修复」。`)
            return
          }
        } catch {
          // 插件替换期间通道不可用：继续轮询。
        }
      }
      setSchemaMessage('更新仍在进行：可稍后刷新页面，或到 dsh 的插件管理页确认状态。')
    } catch (error) {
      setSchemaMessage(error?.message ?? String(error))
    } finally {
      setRepairing('')
    }
  }

  const runRepair = async () => {
    setRepairing('repair')
    setSchemaMessage('')
    try {
      const state = await api.call('schema-repair', {})
      if (state.available) {
        setSnapshot(state)
        notify('修复完成：以兼容模式继续使用本文库')
      } else {
        setSchemaMessage(state?.error?.message ?? '修复失败')
      }
    } catch (error) {
      setSchemaMessage(error?.message ?? String(error))
    } finally {
      setRepairing('')
    }
  }

  const collectionFlat = React.useMemo(() => flattenCollections(data?.collections), [data])
  const schemaMap = React.useMemo(() => new Map((schemaTypes ?? []).map(type => [type.itemType, type])), [schemaTypes])

  // The dock's context: what the user is looking at when they send.
  // A PDF open in the built-in reader → 'reader'; an item merely selected in
  // the list is only a weak hint ('list' + key/title), not "the question is
  // about this paper" — the user may well be asking to *find* something.
  const getChatContext = React.useCallback(() => {
    const activeTab = readerRef.current.active !== ''
      ? readerRef.current.tabs.find(tab => tab.key === readerRef.current.active)
      : undefined
    if (activeTab) {
      return {
        mode: 'reader',
        itemKey: activeTab.parentKey || activeTab.key,
        itemTitle: activeTab.title,
      }
    }
    const key = activeKeyRef.current
    const current = detailRef.current
    if (key && current?.key === key) {
      return { mode: 'list', itemKey: key, itemTitle: current.title }
    }
    return { mode: 'list' }
  }, [])

  const rootClass = dark ? 'dsh-zot-library-root lib-scope-dark' : 'dsh-zot-library-root'

  if (booting) {
    return <div className={rootClass}><div className="lib-empty" style={{ marginTop: 80 }}>正在连接文库…</div></div>
  }

  if (snapshot?.available !== true) {
    const choice = snapshot?.needsChoice === true
    // 断连面板：宿主主动释放了数据库连接（同步握手 / Zotero 正占着库）。
    const detachedPanel = snapshot?.detached
      ?? (['library/db-detached', 'library/db-locked'].includes(String(snapshot?.error?.code))
        ? { reason: 'locked', message: snapshot?.error?.message }
        : undefined)
    return (
      <div className={rootClass}>
        <div className="lib-toolbar">
          <span className="lib-toolbar-title">我的文库</span>
          <span className="lib-spacer" />
          <Button variant="toolbar" size="sm" icon={<GearIcon size={14} />} onClick={() => openSettings?.()}>设置</Button>
        </div>
        {choice ? (
          <div className="lib-choice">
            <div className="lib-choice-title">欢迎使用文库</div>
            <div className="lib-choice-sub">
              选择一个数据来源。关联后本插件直接读写 Zotero 的数据库与附件（Zotero 自己的同步继续负责上传）；
              独立文库则保存在 dsh 数据目录中，之后可随时导出 CSL JSON / BibTeX 再导入 Zotero。
            </div>
            <div className="lib-choice-cards">
              {snapshot?.zoteroFound !== false ? (
                <button className="lib-choice-card" disabled={settingUp !== ''} onClick={() => setupLibrary('zotero')}>
                  <strong><LibraryIcon size={15} /> 关联本机 Zotero</strong>
                  <span>检测到本机已有 Zotero 数据目录，直接复用其中的一切条目、附件与批注。</span>
                  <span className="lib-choice-check">{settingUp === 'zotero' ? '正在关联…' : '点击开始使用'}</span>
                </button>
              ) : null}
              <button className="lib-choice-card" disabled={settingUp !== ''} onClick={() => setupLibrary('standalone')}>
                <strong><LibraryIcon size={15} /> 使用独立文库</strong>
                <span>没有 Zotero 也能用：数据按 Zotero 规范存在 dsh 目录，支持拖入导入、检索、批注与 WebDAV 同步。</span>
                <span className="lib-choice-check">{settingUp === 'standalone' ? '正在创建…' : '点击创建'}</span>
              </button>
              <button className="lib-choice-card" disabled={settingUp !== ''} onClick={() => openSettings?.()}>
                <strong><GearIcon size={15} /> 手动选择数据目录</strong>
                <span>Zotero 装在别的位置？在设置的「文库 → 数据来源」里填写包含 zotero.sqlite 的文件夹。</span>
                <span className="lib-choice-check">打开设置</span>
              </button>
            </div>
          </div>
        ) : detachedPanel ? (
          <div className="lib-choice">
            <div className="lib-choice-title">{detachedPanel.reason === 'sync' ? '已断开文库数据库连接' : 'Zotero 正在运行'}</div>
            <div className="lib-choice-sub">
              {detachedPanel.reason === 'sync'
                ? '为让 Zotero 正常启动并完成同步，文库已主动释放 zotero.sqlite 的文件锁。请在 Zotero 中点工具栏的同步图标（⟳），完成后退出 Zotero：文库每 5 秒自动尝试重连，检测到 Zotero 退出后会立即恢复，无需重启 dsh。'
                : 'Zotero 运行时会独占数据库（zotero.sqlite），文库暂时无法访问。请退出 Zotero：文库每 5 秒自动尝试重连，检测到 Zotero 退出后会立即恢复，无需重启 dsh。'}
            </div>
            {detachedPanel.lastStatus ? (
              <div className="lib-form-hint" style={{ marginTop: 10 }}>
                {detachedPanel.lastStatus === 'zotero-running'
                  ? `上次检测（${formatClock(detachedPanel.checkedAt)}）：Zotero 仍在运行`
                  : detachedPanel.lastStatus === 'waiting-zotero'
                    ? 'Zotero 正在启动，等它就绪后再尝试重连…'
                    : `上次检测（${formatClock(detachedPanel.checkedAt)}）：数据库仍被占用`}
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
              <Button variant="primary" size="sm" disabled={reconnecting} onClick={() => void reconnectNow()}>
                {reconnecting ? '重连中…' : '立即重新连接'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={killingZotero}
                title="强制结束 Zotero 进程以解除数据库占用（未保存/未同步的内容会丢失）"
                onClick={() => void killZoteroNow()}
              >
                {killingZotero ? '正在结束…' : '结束 Zotero 进程'}
              </Button>
            </div>
          </div>
        ) : snapshot?.error?.code === 'library/schema-too-new' ? (
          <div className="lib-choice">
            <div className="lib-choice-title">Zotero 数据库结构更新</div>
            <div className="lib-choice-sub">
              本机 Zotero 的数据库结构（schema {snapshot?.error?.schemaVersion ?? '?'}）比当前插件支持的最高版本
              （{snapshot?.error?.supported ?? '?'}）新。建议先「检查并更新插件」；
              若还没有适配版本，可用「一键修复」：插件会自检核心表结构，通过后以兼容模式继续读写本文库。
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
              <Button variant="primary" size="sm" disabled={repairing !== ''} onClick={() => void repairPlugin()}>
                {repairing === 'update' ? '检查中…' : '检查并更新插件'}
              </Button>
              <Button variant="outline" size="sm" disabled={repairing !== ''} onClick={() => void runRepair()}>
                {repairing === 'repair' ? '修复中…' : '一键修复'}
              </Button>
            </div>
            {schemaMessage ? (
              <div className="lib-form-hint" style={{ maxWidth: 560, margin: '12px auto 0', lineHeight: 1.7 }}>{schemaMessage}</div>
            ) : null}
          </div>
        ) : (
          <div className="lib-empty" style={{ marginTop: 70 }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>文库不可用</div>
            <div className="lib-form-hint" style={{ maxWidth: 520, margin: '0 auto 14px', lineHeight: 1.7 }}>
              {snapshot?.error?.message ?? '请确认已安装 Zotero 并至少打开过一次。'}
              <br />可以在设置中切换数据目录，或改用独立文库。
            </div>
            <Button variant="primary" size="sm" onClick={() => openSettings?.()}>打开设置</Button>
          </div>
        )}
        {toast ? <Toast message={toast} /> : null}
      </div>
    )
  }

  return (
    <div className={rootClass}>
      <div className="lib-toolbar">
        <span className="lib-toolbar-title" title={viewTitle(view)}>{viewTitle(view)}</span>
        <span className="lib-form-hint">{snapshot?.source === 'standalone' ? '独立文库' : '本机文库'}</span>
        <span className="lib-spacer" />
        {selectedKeys.length > 0 ? (
          view.kind === 'trash'
            ? (
                <>
                  <Button variant="toolbar" size="sm" onClick={() => moveToTrash(true)}>还原</Button>
                  <Button variant="toolbar" size="sm" className="lib-danger-text" onClick={deleteForever}>永久删除</Button>
                </>
              )
            : <Button variant="toolbar" size="sm" onClick={() => moveToTrash(false)}>移到回收站</Button>
        ) : null}
        <span className="lib-newitem-wrap" ref={createMenuRef} style={{ position: 'relative' }}>
          <Button variant="toolbar" size="sm" icon={<PlusIcon size={13} />} onClick={() => { setCreateMenuOpen(value => !value); setIdentifierOpen(false) }}>新建条目</Button>
          {createMenuOpen ? (
            <div className="lib-type-menu-pop">
              {[...(schemaTypes ?? [])].map(type => (
                <button key={type.itemType} type="button" onClick={() => void createItemOfType(type.itemType)}>
                  {itemTypeLabel(type.itemType)}
                </button>
              ))}
              {(schemaTypes ?? []).length === 0 ? <span className="lib-form-hint" style={{ padding: 6 }}>加载中…</span> : null}
            </div>
          ) : null}
        </span>
        <span className="lib-newitem-wrap" ref={identifierRef} style={{ position: 'relative' }}>
          <Button
            variant="toolbar"
            size="sm"
            icon={<WandIcon size={13} />}
            title="通过标识符添加条目（DOI / ISBN / arXiv / PMID，每行一个）"
            onClick={() => { setIdentifierOpen(value => !value); setCreateMenuOpen(false) }}
          >标识符添加</Button>
          {identifierOpen ? (
            <div className="lib-type-menu-pop lib-lookup-pop">
              <textarea
                placeholder={'10.1002/glia.23254\narXiv:2401.01234\n9787302106526\n每行一个标识符（DOI / ISBN / arXiv / PMID）'}
                value={identifierDraft}
                onChange={event => setIdentifierDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void addByIdentifier()
                }}
              />
              <Button variant="primary" size="sm" disabled={identifierBusy} onClick={() => void addByIdentifier()}>
                {identifierBusy ? '检索中…' : '检索并添加'}
              </Button>
            </div>
          ) : null}
        </span>
        <Button variant="toolbar" size="sm" icon={<SyncIcon size={14} />} disabled={syncing} onClick={runSync} title={snapshot?.settings?.mode === 'zotero' ? '唤起 Zotero，在它里面点同步' : '与 WebDAV 同步附件文件'}>
          {syncing ? '唤起中…' : '同步'}
        </Button>
        <Button variant="toolbar" size="sm" title="设置" icon={<GearIcon size={14} />} onClick={() => openSettings?.()} />
        <div className="lib-search">
          <SearchIcon size={14} />
          <input
            value={query}
            placeholder="在文库中搜索…"
            onChange={event => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') setQuery('') }}
          />
        </div>
      </div>

      {(() => {
        const dock = (
          <ChatDock
            controller={dockRef}
            onLibraryChanged={refreshAll}
            openNativeSession={openNativeSession}
            retainSession={retainSession}
            SessionProvider={SessionProvider}
            renderSlot={renderSlot}
            getContext={getChatContext}
          />
        )
        // Any collection / smart-view click while a viewer tab is open first
        // jumps back to the literature list tab.
        const handleSelectView = (next) => {
          if (readerRef.current.active !== '') setReader(previous => ({ ...previous, active: '' }))
          setView(next)
          setQuery('')
        }
        // The tab strip lives INSIDE the middle column and is always rendered:
        // the layout is identical with and without open PDFs, and the tabs
        // never reach across the collections column.
        const tabsRow = (
          <div className="lib-tabs">
            <button
              className={`lib-tab${activeReaderTab ? '' : ' active'}`}
              onClick={() => setReader(previous => ({ ...previous, active: '' }))}
            >
              <LibraryIcon size={12} /> 文献列表
            </button>
            {reader.tabs.map(tab => (
              <span
                key={tab.key}
                className={`lib-tab${reader.active === tab.key ? ' active' : ''}`}
                onClick={() => setReader(previous => ({ ...previous, active: tab.key }))}
                title={tab.title}
              >
                <PdfIcon size={12} />
                <span className="lib-tab-title">{tab.title}</span>
                <button
                  className="lib-tab-close"
                  title="关闭"
                  onClick={(event) => { event.stopPropagation(); closeReaderTab(tab.key) }}
                >×</button>
              </span>
            ))}
          </div>
        )
        return (
          <div className={`lib-main${detailsOpen ? '' : ' lib-main-no-details'}`}>
            <CollectionsPane
              data={data}
              tags={tags}
              view={view}
              loading={itemsLoading}
              onSelectView={handleSelectView}
              onCreateCollection={() => setCollectionDialog({ open: true, mode: 'create', target: undefined })}
              onCollectionContext={(_event, node) => setCollectionDialog({ open: true, mode: 'rename', target: node })}
              onBackToChat={() => {
                try { layout?.selectPanel?.(null) } catch (error) { console.warn('[dsh-zot-library] selectPanel failed', error) }
              }}
            />
            <div className="lib-midcol">
              {tabsRow}
              {/* 保温查看器：warmTabs 内的查看器常驻挂载，隐藏不占布局——标签
                  与文献列表之间切换瞬间回到原画面（canvas/滚动/查找都保留）；
                  超出 MRU 上限的标签在此卸载，文档进热缓存供快速恢复。 */}
              {warmTabs.map(tab => (
                <div
                  key={tab.key}
                  className="lib-reader"
                  style={tab.key === reader.active ? undefined : { display: 'none' }}
                >
                  <PdfViewer
                    key={tab.key}
                    bytes={tab.bytes}
                    title={tab.title}
                    attachmentKey={tab.key}
                    initialView={readerViewsRef.current[tab.key] ?? null}
                    onNotify={showError}
                    translateSettings={snapshot?.settings?.translate ?? null}
                    onOpenNative={() => {
                      void api.call('open', { key: tab.key }).catch(error => showError(error))
                    }}
                  />
                </div>
              ))}
              {!activeReaderTab ? (
                <ItemsPane
                  items={items}
                  total={total}
                  view={view}
                  sort={sort}
                  desc={desc}
                  loading={itemsLoading}
                  selectedKeys={selectedKeys}
                  activeKey={activeKey}
                  onSelect={selectItem}
                  onOpen={openItem}
                  onNotify={showError}
                  onSort={(next) => {
                    if (next === sort) setDesc(value => !value)
                    else {
                      setSort(next)
                      setDesc(next !== 'title')
                    }
                  }}
                  onLoadMore={() => { void safeLoadItems({ append: true }) }}
                  onImportFiles={importFiles}
                  importing={importing}
                  columns={columns}
                  onSetColumns={setColumns}
                  columnWidths={columnWidths}
                  onSetColumnWidth={(id, width) => setColumnWidths(previous => {
                    const next = { ...previous }
                    if (Number.isFinite(width)) next[id] = width
                    else delete next[id]
                    return next
                  })}
                  reveal={reveal}
                  onContextMenu={setContextMenu}
                />
              ) : null}
              {dock}
            </div>
            {detailsOpen ? (
              <div className="lib-right-wrap">
                <button
                  type="button"
                  className="lib-right-collapse"
                  title="收起文献信息栏"
                  onClick={() => setDetailsOpen(false)}
                >
                  <ChevronRightIcon size={13} />
                </button>
                <DetailsPane
                  detail={detail}
                  loading={detailLoading}
                  collections={collectionFlat}
                  schema={schemaMap}
                  onUpdate={updateItem}
                  onOpen={openItem}
                  onReveal={revealItem}
                  onOpenUrl={openUrlExternal}
                  onAddFile={addAttachmentFile}
                  onAddUrl={addAttachmentUrl}
                  onTrashAttachment={trashAttachment}
                  onUpdateNote={updateNote}
                  onNotify={showError}
                  onRefetch={() => { if (detail) void runRecognition('item', [detail.key]) }}
                />
              </div>
            ) : (
              <button
                type="button"
                className="lib-right-rail"
                title="展开文献信息栏"
                onClick={() => setDetailsOpen(true)}
              >
                <ChevronLeftIcon size={13} />
                <span className="lib-right-rail-text">文献信息</span>
              </button>
            )}
          </div>
        )
      })()}

      <CollectionDialog
        open={collectionDialog.open}
        mode={collectionDialog.mode}
        target={collectionDialog.target}
        collections={collectionFlat}
        onError={showError}
        onClose={() => setCollectionDialog({ open: false, mode: 'create', target: undefined })}
        onDone={async () => {
          setCollectionDialog({ open: false, mode: 'create', target: undefined })
          await refreshAll()
          notify('已更新分类')
        }}
      />
      {contextMenu ? (
        <ItemContextMenu
          menu={contextMenu}
          rows={items}
          collections={collectionFlat}
          view={view}
          onAction={runItemAction}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
      {prompt ? (
        <PromptDialog
          title={prompt.title}
          placeholder={prompt.placeholder}
          confirmLabel={prompt.confirmLabel}
          onConfirm={prompt.onConfirm}
          onClose={() => setPrompt(null)}
        />
      ) : null}
      {recognizing ? (
        <RecognitionDialog
          state={recognizing}
          onAI={() => {
            const targets = recognizing.failed.map(entry => entry.key)
            setRecognizing(null)
            if (targets.length > 0) sendRefetchTask(targets)
          }}
          onClose={() => setRecognizing(null)}
        />
      ) : null}
      <input
        ref={attachFileRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={onAttachFilesChosen}
      />
      {toast ? <Toast message={toast} /> : null}
    </div>
  )
}
