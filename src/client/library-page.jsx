import * as React from 'react'
import * as api from './api.js'
import { CollectionsPane } from './collections-pane.jsx'
import { ItemsPane } from './items-pane.jsx'
import { DetailsPane } from './details-pane.jsx'
import { ChatDock } from './chat-dock.jsx'
import { SETTINGS_SAVED_EVENT } from './settings-section.jsx'
import { CreateItemDialog, CollectionDialog } from './create-dialog.jsx'
import { PdfViewer } from './pdf-viewer.jsx'
import { GearIcon, LibraryIcon, PlusIcon, PdfIcon, SearchIcon, SyncIcon } from './icons.jsx'
import { Button } from './platform.jsx'
import { fileBase64, filePathOf, useDarkMode, useDebounced, probeSidebarOpen } from './util.js'

const VIEW_STORAGE = 'dsh-library:view'
const SORT_STORAGE = 'dsh-library:sort'

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
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_STORAGE) ?? 'null')
    if (saved && typeof saved === 'object') {
      return {
        sort: ['title', 'creator', 'date', 'dateAdded', 'dateModified'].includes(saved.sort) ? saved.sort : 'dateAdded',
        desc: saved.desc !== false,
      }
    }
  } catch {
    // Ignore a malformed preference.
  }
  return { sort: 'dateAdded', desc: true }
}

function viewTitle(view) {
  if (view.kind === 'collection') return view.name
  if (view.kind === 'tag') return `标签：${view.name}`
  if (view.kind === 'unfiled') return '未分类'
  if (view.kind === 'trash') return '回收站'
  return '我的文库'
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
  const [createOpen, setCreateOpen] = React.useState(false)
  const [collectionDialog, setCollectionDialog] = React.useState({ open: false, mode: 'create', target: undefined })
  const [syncing, setSyncing] = React.useState(false)
  const [settingUp, setSettingUp] = React.useState('')
  // In-app viewer tabs: [{key, parentKey, title, bytes}]; '' active = the list
  // view. Tabs host the pdf.js viewer (the "dsh 内建查看器"), which owns
  // selection, annotations, rotation and find.
  const [reader, setReader] = React.useState({ tabs: [], active: '' })
  const readerRef = React.useRef(reader)
  readerRef.current = reader
  // Host sidebar (the dsh conversation list): entering the library collapses
  // it, leaving restores it. The left pane's back-to-chat button is always
  // visible, so no visibility polling is needed.
  const collapsedByUsRef = React.useRef(false)
  const selectionContextTimer = React.useRef(0)
  const toastTimer = React.useRef(0)
  const revisionRef = React.useRef(-1)
  const snapshotRef = React.useRef(undefined)
  snapshotRef.current = snapshot
  const viewRef = React.useRef(view)
  const queryRef = React.useRef('')
  const itemsRef = React.useRef([])
  const dockRef = React.useRef(null)
  const detailRef = React.useRef(undefined)
  const activeKeyRef = React.useRef('')
  viewRef.current = view
  queryRef.current = debouncedQuery
  itemsRef.current = items
  detailRef.current = detail
  activeKeyRef.current = activeKey

  const notify = React.useCallback((message) => {
    setToast(message)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 4200)
  }, [])
  React.useEffect(() => () => clearTimeout(toastTimer.current), [])

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
      notify(error?.message ?? String(error))
    } finally {
      setDetailLoading(false)
    }
  }, [notify])

  const safeLoadItems = React.useCallback(async (options) => {
    try {
      return await loadItems(options)
    } catch (error) {
      notify(error?.message ?? String(error))
      return undefined
    }
  }, [loadItems, notify])

  const refreshAll = React.useCallback(async () => {
    try {
      await Promise.all([loadCollections(), loadItems()])
      if (activeKeyRef.current) await loadDetail(activeKeyRef.current)
    } catch (error) {
      notify(error?.message ?? String(error))
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

  // Persist navigation preferences across panel switches.
  React.useEffect(() => {
    try {
      localStorage.setItem(VIEW_STORAGE, JSON.stringify(view))
      localStorage.setItem(SORT_STORAGE, JSON.stringify({ sort, desc }))
    } catch {
      // Preferences are optional.
    }
  }, [view, sort, desc])

  // Reload whenever the view, search text or sort changes.
  React.useEffect(() => {
    if (booting || snapshot?.available !== true) return
    setSelectedKeys([])
    setActiveKey('')
    setDetail(undefined)
    void safeLoadItems({ viewOverride: view, queryOverride: debouncedQuery })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, debouncedQuery, sort, desc, booting, snapshot?.available])

  React.useEffect(() => {
    void loadDetail(activeKey)
  }, [activeKey, loadDetail])

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
        notify(error?.message ?? String(error))
      }
      return
    }
    await openInApp(key)
  }

  const openInApp = async (key) => {
    try {
      // Binary streaming route: no base64 round trip, so large papers open fast.
      const response = await fetch(`api/library/file?key=${encodeURIComponent(key)}`, { credentials: 'same-origin' })
      if (!response.ok) {
        let message = `HTTP ${response.status}`
        try {
          const body = await response.json()
          message = body?.error?.message ?? message
        } catch { /* non-JSON error body */ }
        throw new Error(message)
      }
      const contentType = response.headers.get('content-type') ?? 'application/pdf'
      if (contentType !== 'application/pdf') {
        // Only PDFs render in the in-app viewer; everything else opens natively.
        await api.call('open', { key })
        return
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      const attachmentKey = response.headers.get('x-library-attachment-key') ?? key
      const parentKey = response.headers.get('x-library-parent-key') ?? key
      const title = decodeURIComponent(response.headers.get('x-library-title') ?? 'PDF')
      setReader(previous => {
        const existing = previous.tabs.find(tab => tab.key === attachmentKey)
        if (existing) return { ...previous, active: attachmentKey }
        return {
          tabs: [...previous.tabs, { key: attachmentKey, parentKey, title, bytes }],
          active: attachmentKey,
        }
      })
    } catch (error) {
      notify(error?.message ?? String(error))
    }
  }

  const closeReaderTab = (key) => {
    setReader(previous => {
      const tabs = previous.tabs.filter(entry => entry.key !== key)
      return { tabs, active: previous.active === key ? '' : previous.active }
    })
  }

  const activeReaderTab = reader.active !== '' ? reader.tabs.find(tab => tab.key === reader.active) : undefined

  // While an article is open in the viewer, keep the host-side chat context
  // fresh (the native composer bypasses chat-send): the Literature Assistant
  // then knows which paper is on screen.
  const syncReaderContext = React.useCallback((tab) => {
    if (!tab) return
    clearTimeout(selectionContextTimer.current)
    selectionContextTimer.current = setTimeout(() => {
      api.call('chat-context', {
        context: { mode: 'reader', itemKey: tab.parentKey, itemTitle: tab.title },
      }).catch(() => {})
    }, 400)
  }, [])

  React.useEffect(() => {
    syncReaderContext(activeReaderTab)
    return () => clearTimeout(selectionContextTimer.current)
  }, [activeReaderTab?.key, syncReaderContext]) // eslint-disable-line react-hooks/exhaustive-deps

  const revealItem = async (key) => {
    try {
      await api.call('open', { key, reveal: true })
    } catch (error) {
      notify(error?.message ?? String(error))
    }
  }

  const updateItem = async (key, patch) => {
    try {
      await api.call('update', { key, patch })
      await Promise.all([loadDetail(key), loadItems(), loadCollections()])
    } catch (error) {
      notify(error?.message ?? String(error))
    }
  }

  const moveToTrash = async (restore = false) => {
    if (selectedKeys.length === 0) return
    try {
      await api.call('trash', { keys: selectedKeys, restore })
      notify(restore ? '已还原' : '已移到回收站')
      setSelectedKeys([])
      setActiveKey('')
      await refreshAll()
    } catch (error) {
      notify(error?.message ?? String(error))
    }
  }

  const deleteForever = async () => {
    if (selectedKeys.length === 0) return
    if (!window.confirm(`永久删除 ${selectedKeys.length} 条记录？该操作不可撤销。`)) return
    try {
      await api.call('delete', { keys: selectedKeys })
      notify('已永久删除')
      setSelectedKeys([])
      setActiveKey('')
      await refreshAll()
    } catch (error) {
      notify(error?.message ?? String(error))
    }
  }

  // Ask the agent (in the Library workspace) to fix one import's metadata.
  const fixMetadataWithAgent = (entry) => {
    const hasParent = Boolean(entry.parentKey)
    const task = [
      '请为刚导入的文献补全元数据（标题、作者、年份、期刊/出版物、卷期页、DOI 等）：',
      `文件名「${entry.name}」${entry.parentKey ? `，条目 key ${entry.parentKey}` : '（尚未建立条目，只有附件）'}${entry.attachmentKey ? `，附件 key ${entry.attachmentKey}` : ''}。`,
      hasParent
        ? '建议先用 library_read 的 search 参数从全文中确认题名与作者，再用联网搜索核对，最后用 library_update 把字段写回该条目。'
        : '建议先用 library_read 的 search 参数从全文中确认题名与作者，再用联网搜索核对，最后用 library_add 建立规范的父条目并补全字段。',
    ].join('')
    void dockRef.current?.openAndSend(task, { mode: 'list' })
  }

  const importFiles = async (files) => {
    for (const file of files) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      setImporting(previous => [...previous, { id, name: file.name, status: 'importing' }])
      // Keep the "fix with AI" offer around longer than a plain success note.
      let sticky = 9000
      try {
        const collectionID = viewRef.current.kind === 'collection' ? viewRef.current.id : null
        const localPath = filePathOf(file)
        const result = localPath
          ? await api.call('import', { path: localPath, collectionID })
          : await api.call('upload', { name: file.name, data: await fileBase64(file), collectionID })
        const needsHelp = result.needsMetadataHelp === true
        if (needsHelp) sticky = 120_000
        setImporting(previous => previous.map(entry => (entry.id === id
          ? {
              ...entry,
              status: 'done',
              title: result.metadata?.title ?? result.fileName,
              key: result.parentKey,
              parentKey: result.parentKey,
              attachmentKey: result.attachmentKey,
              needsHelp,
              onFix: needsHelp
                ? () => fixMetadataWithAgent({ name: file.name, parentKey: result.parentKey, attachmentKey: result.attachmentKey })
                : undefined,
            }
          : entry)))
        await refreshAll()
        if (result.parentKey) {
          setSelectedKeys([result.parentKey])
          setActiveKey(result.parentKey)
        }
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
    if (snapshot?.settings?.webdav?.url === '') {
      openSettings?.()
      notify('请先在设置的 WebDAV 页配置服务器')
      return
    }
    setSyncing(true)
    try {
      const result = await api.call('sync-run', {})
      notify(`同步完成：上传 ${result.uploaded}，下载 ${result.downloaded}，冲突 ${result.conflicts}，失败 ${result.failed}`)
      await refreshAll()
    } catch (error) {
      notify(error?.message ?? String(error))
    } finally {
      setSyncing(false)
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
      notify(error?.message ?? String(error))
    } finally {
      setSettingUp('')
    }
  }

  const collectionFlat = React.useMemo(() => flattenCollections(data?.collections), [data])

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

  const rootClass = dark ? 'dsh-library-root lib-scope-dark' : 'dsh-library-root'

  if (booting) {
    return <div className={rootClass}><div className="lib-empty" style={{ marginTop: 80 }}>正在连接文库…</div></div>
  }

  if (snapshot?.available !== true) {
    const choice = snapshot?.needsChoice === true
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
        ) : (
          <div className="lib-empty" style={{ marginTop: 70 }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>文库不可用</div>
            <div className="lib-form-hint" style={{ maxWidth: 520, margin: '0 auto 14px', lineHeight: 1.7 }}>
              {snapshot?.error?.message ?? '请确认已安装 Zotero 并至少打开过一次。'}
              {snapshot?.error?.code === 'library/db-locked'
                ? null
                : <><br />可以在设置中切换数据目录，或改用独立文库。</>}
            </div>
            {snapshot?.error?.code === 'library/db-locked'
              ? <div className="lib-form-hint" style={{ marginBottom: 14 }}>正在等待 Zotero 退出，每 5 秒自动重试…</div>
              : null}
            <Button variant="primary" size="sm" onClick={() => openSettings?.()}>打开设置</Button>
          </div>
        )}
        {toast ? <div className="lib-toast">{toast}</div> : null}
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
        <Button variant="toolbar" size="sm" icon={<PlusIcon size={13} />} onClick={() => setCreateOpen(true)}>新建条目</Button>
        <Button variant="toolbar" size="sm" icon={<SyncIcon size={14} />} disabled={syncing} onClick={runSync} title="与 WebDAV 同步附件文件">
          {syncing ? '同步中…' : '同步'}
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
          <div className="lib-main">
            <CollectionsPane
              data={data}
              tags={tags}
              view={view}
              loading={itemsLoading}
              onSelectView={handleSelectView}
              onCreateCollection={() => setCollectionDialog({ open: true, mode: 'create', target: undefined })}
              onCollectionContext={(_event, node) => setCollectionDialog({ open: true, mode: 'rename', target: node })}
              onBackToChat={() => {
                try { layout?.selectPanel?.(null) } catch (error) { console.warn('[dsh-library] selectPanel failed', error) }
              }}
            />
            <div className="lib-midcol">
              {tabsRow}
              {activeReaderTab ? (
                <>
                  <div className="lib-reader">
                    <PdfViewer
                      key={activeReaderTab.key}
                      bytes={activeReaderTab.bytes}
                      title={activeReaderTab.title}
                      attachmentKey={activeReaderTab.key}
                      onNotify={notify}
                      onOpenNative={() => {
                        void api.call('open', { key: activeReaderTab.key }).catch(error => notify(error?.message ?? String(error)))
                      }}
                    />
                  </div>
                  {dock}
                </>
              ) : (
                <>
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
                    onNotify={notify}
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
                  />
                  {dock}
                </>
              )}
            </div>
            <DetailsPane
              detail={detail}
              loading={detailLoading}
              collections={collectionFlat}
              onUpdate={updateItem}
              onOpen={openItem}
              onReveal={revealItem}
            />
          </div>
        )
      })()}

      <CreateItemDialog
        open={createOpen}
        collections={collectionFlat}
        defaultCollectionID={view.kind === 'collection' ? view.id : undefined}
        onClose={() => setCreateOpen(false)}
        onCreated={async (key) => {
          setCreateOpen(false)
          await refreshAll()
          setSelectedKeys([key])
          setActiveKey(key)
          notify('已创建')
        }}
      />
      <CollectionDialog
        open={collectionDialog.open}
        mode={collectionDialog.mode}
        target={collectionDialog.target}
        collections={collectionFlat}
        onClose={() => setCollectionDialog({ open: false, mode: 'create', target: undefined })}
        onDone={async () => {
          setCollectionDialog({ open: false, mode: 'create', target: undefined })
          await refreshAll()
          notify('已更新分类')
        }}
      />
      {toast ? <div className="lib-toast">{toast}</div> : null}
    </div>
  )
}
