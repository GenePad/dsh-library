import * as React from 'react'
import { Button } from './platform.jsx'
import { AttachmentIcon, ChevronDown, LibraryIcon, NoteIcon, PdfIcon } from './icons.jsx'
import { formatDate, itemTypeLabel } from './util.js'

const COLUMNS_STORAGE = 'dsh-library:columns'

/** Every column the item list can show, Zotero-style. `sort` maps to the host sort key. */
export const COLUMN_DEFS = [
  { id: 'title', label: '标题', width: 'minmax(160px, 1fr)', fixed: true, sort: 'title' },
  { id: 'creator', label: '创建者', width: '150px', sort: 'creator' },
  { id: 'year', label: '年份', width: '48px', sort: 'date', numeric: true },
  { id: 'publicationTitle', label: '期刊/出版物', width: '170px' },
  { id: 'publisher', label: '出版社', width: '130px' },
  { id: 'doi', label: 'DOI', width: '110px' },
  { id: 'tags', label: '标签', width: '150px' },
  { id: 'itemType', label: '条目类型', width: '82px' },
  { id: 'dateAdded', label: '添加时间', width: '96px', sort: 'dateAdded' },
  { id: 'dateModified', label: '修改时间', width: '96px', sort: 'dateModified' },
]
const DEFAULT_COLUMNS = ['title', 'creator', 'year']
const KNOWN = new Set(COLUMN_DEFS.map(column => column.id))

/** Persisted visible-column order; the title column always stays. */
function restoreColumns() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMNS_STORAGE) ?? 'null')
    if (Array.isArray(saved)) {
      const kept = saved.filter(id => KNOWN.has(id))
      if (!kept.includes('title')) kept.unshift('title')
      if (kept.length > 0) return kept
    }
  } catch {
    // A malformed preference falls back to the default three columns.
  }
  return [...DEFAULT_COLUMNS]
}

function TypeIcon({ itemType }) {
  if (itemType === 'note') return <NoteIcon size={13} />
  if (itemType === 'attachment') return <PdfIcon size={13} />
  return <LibraryIcon size={13} />
}

function cellValue(item, id) {
  switch (id) {
    case 'title': return item.title
    case 'creator': return item.creators
    case 'year': return item.year ?? ''
    case 'publicationTitle': return item.publicationTitle
    case 'publisher': return item.publisher
    case 'doi': return item.doi
    case 'tags': return (item.tags ?? []).join(', ')
    case 'itemType': return itemTypeLabel(item.itemType)
    case 'dateAdded': return formatDate(item.dateAdded)
    case 'dateModified': return formatDate(item.dateModified)
    default: return ''
  }
}

/** Middle pane: the item table with drag-and-drop import and column picker. */
export function ItemsPane({
  items, total, view, sort, desc, loading,
  selectedKeys, activeKey, onSelect, onOpen, onSort, onLoadMore, onNotify,
  onImportFiles, importing,
}) {
  const [columns, setColumns] = React.useState(restoreColumns)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const menuRef = React.useRef(null)
  const [dragging, setDragging] = React.useState(false)
  const dragDepth = React.useRef(0)

  React.useEffect(() => {
    try {
      localStorage.setItem(COLUMNS_STORAGE, JSON.stringify(columns))
    } catch {
      // Column preferences are optional.
    }
  }, [columns])

  React.useEffect(() => {
    if (!menuOpen) return undefined
    const close = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  const handleDragEnter = (event) => {
    event.preventDefault()
    dragDepth.current += 1
    if (event.dataTransfer?.types?.includes('Files')) setDragging(true)
  }
  const handleDragLeave = (event) => {
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const handleDrop = (event) => {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length > 0) onImportFiles(files)
  }

  const openItem = (item) => {
    if (item.hasAttachment || item.itemType === 'attachment') {
      onOpen(item.key)
    } else {
      onNotify?.('该条目没有可打开的附件')
    }
  }

  const rows = items ?? []
  const viewName = view.kind === 'collection' ? view.name : view.kind === 'tag' ? `#${view.name}` : ''
  const visible = columns.map(id => COLUMN_DEFS.find(column => column.id === id)).filter(Boolean)
  const template = visible.map(column => column.width).join(' ')

  const toggleColumn = (id, fixed) => {
    if (fixed) return
    setColumns(previous => (previous.includes(id)
      ? (previous.length > 1 ? previous.filter(value => value !== id) : previous)
      : [...previous, id]))
  }

  const headerCell = (column) => {
    if (column.id === 'title') {
      return (
        <button
          key={column.id}
          className={sort === 'title' ? 'sorted' : ''}
          onClick={() => onSort('title')}
          title="按标题排序"
        >
          标题{sort === 'title' ? (desc ? ' ↓' : ' ↑') : ''}
        </button>
      )
    }
    if (!column.sort) {
      return <span key={column.id} className={column.numeric ? 'num' : ''}>{column.label}</span>
    }
    return (
      <button
        key={column.id}
        className={`${sort === column.sort ? 'sorted' : ''}${column.numeric ? ' num' : ''}`}
        style={column.numeric ? { textAlign: 'right' } : undefined}
        onClick={() => onSort(column.sort)}
        title={`按${column.label}排序`}
      >
        {column.label}{sort === column.sort ? (desc ? ' ↓' : ' ↑') : ''}
      </button>
    )
  }

  return (
    <div
      className="lib-middle"
      onDragEnter={handleDragEnter}
      onDragOver={(event) => {
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ position: 'relative' }}
    >
      <div className="lib-table-head" style={{ gridTemplateColumns: `${template} 24px` }}>
        {visible.map(headerCell)}
        <div className="lib-colmenu-wrap" ref={menuRef}>
          <button
            className={`lib-colbtn${menuOpen ? ' open' : ''}`}
            title="选择要显示的列"
            onClick={() => setMenuOpen(value => !value)}
          >
            <ChevronDown size={12} />
          </button>
          {menuOpen ? (
            <div className="lib-colmenu">
              {COLUMN_DEFS.map(column => (
                <label
                  key={column.id}
                  className={`lib-colitem${column.fixed ? ' fixed' : ''}`}
                  onClick={(event) => {
                    event.preventDefault()
                    toggleColumn(column.id, column.fixed)
                  }}
                  title={column.fixed ? '标题列始终显示' : undefined}
                >
                  <input
                    type="checkbox"
                    checked={columns.includes(column.id)}
                    disabled={column.fixed === true}
                    onChange={() => toggleColumn(column.id, column.fixed)}
                  />
                  {column.label}
                </label>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="lib-items">
        {rows.map(item => {
          const selected = selectedKeys.includes(item.key)
          return (
            <div
              key={item.key}
              className={`lib-itemrow${selected ? ' selected' : ''}${activeKey === item.key ? ' active' : ''}`}
              style={{ gridTemplateColumns: `${template} 24px` }}
              onClick={(event) => onSelect(item.key, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey })}
              onDoubleClick={() => openItem(item)}
              title={`${item.title}\n${itemTypeLabel(item.itemType)}${item.creators ? ` · ${item.creators}` : ''}\n双击打开附件`}
            >
              {visible.map((column, index) => (index === 0
                ? (
                    <span className="lib-cell strong" key={column.id}>
                      <span className="lib-title">
                        <span className="lib-type"><TypeIcon itemType={item.itemType} /></span>
                        <span className="lib-title-text">{item.title}</span>
                        {item.hasAttachment ? <span className="lib-attach"><AttachmentIcon size={12} /></span> : null}
                      </span>
                    </span>
                  )
                : <span className={`lib-cell${column.numeric ? ' num' : ''}`} key={column.id}>{cellValue(item, column.id)}</span>
              ))}
              <span />
            </div>
          )
        })}
        {rows.length === 0 && !loading ? (
          <div className="lib-empty">
            {view.kind === 'trash' ? '回收站是空的' : viewName ? `「${viewName}」中还没有文献` : '没有匹配的文献'}
            <div className="lib-form-hint" style={{ marginTop: 8 }}>把 PDF 拖到这里即可导入并自动补全元数据</div>
          </div>
        ) : null}
        {loading ? <div className="lib-empty">读取中…</div> : null}
        {rows.length < total ? (
          <div className="lib-loadmore">
            <Button variant="ghost" size="sm" onClick={onLoadMore}>加载更多（{rows.length} / {total}）</Button>
          </div>
        ) : null}
      </div>

      {dragging ? (
        <div className="lib-drag-overlay">
          <strong>松开以导入到文库</strong>
          <span className="lib-form-hint">将自动识别 DOI/arXiv/ISBN 并补全文献信息，同时提取全文与批注</span>
        </div>
      ) : null}

      <div className="lib-import-log">
        {(importing ?? []).map(entry => (
          <div className="lib-import-item" key={entry.id}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <PdfIcon size={13} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
              <span style={{ marginLeft: 'auto', color: 'var(--lib-text-3)', fontSize: 11 }}>
                {entry.status === 'importing' ? '导入中…' : entry.status === 'done' ? '已完成' : '失败'}
              </span>
            </div>
            {entry.status === 'done' && entry.title ? (
              <div className="lib-form-hint" style={{ marginTop: 3 }}>{entry.title}</div>
            ) : null}
            {entry.status === 'done' && entry.needsHelp ? (
              <div className="lib-import-fix">
                <span>元数据不完整</span>
                <Button variant="ghost" size="sm" onClick={() => entry.onFix?.()}>用 AI 补全元数据</Button>
              </div>
            ) : null}
            {entry.status === 'error' ? <div className="lib-import-err" style={{ marginTop: 3 }}>{entry.error}</div> : null}
          </div>
        ))}
      </div>
    </div>
  )
}
