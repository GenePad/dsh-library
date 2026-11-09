import * as React from 'react'
import { Button } from './platform.jsx'
import { AttachmentIcon, ChevronDown, ChevronRightIcon, LibraryIcon, NoteIcon, PdfIcon } from './icons.jsx'
import { formatDate, itemTypeLabel } from './util.js'
import { FIELD_LABELS, PANE_LABELS } from './labels.js'

const COLUMNS_STORAGE = 'dsh-zot-library:columns'

/**
 * Every column the item list can show — Zotero's itemTreeColumns set (the
 * group-library/feed-only ones aside) plus our DOI/tags columns. `field` is
 * the itemData field name requested from the host; `sort` maps to the host
 * sort key ('field:<name>' sorts by any field).
 */
export const COLUMN_DEFS = [
  { id: 'title', label: '标题', width: 260, fixed: true, sort: 'title' },
  { id: 'creator', label: '创建者', width: 150, sort: 'creator' },
  { id: 'itemType', label: FIELD_LABELS.itemType, width: 82, sort: 'itemType' },
  { id: 'date', label: FIELD_LABELS.date, width: 110, sort: 'date' },
  { id: 'year', label: '年份', width: 52, sort: 'date', numeric: true },
  { id: 'publisher', label: FIELD_LABELS.publisher, width: 130, field: 'publisher' },
  { id: 'publicationTitle', label: FIELD_LABELS.publicationTitle, width: 170, field: 'publicationTitle' },
  { id: 'journalAbbreviation', label: FIELD_LABELS.journalAbbreviation, width: 90, field: 'journalAbbreviation' },
  { id: 'language', label: FIELD_LABELS.language, width: 80, field: 'language' },
  { id: 'accessDate', label: FIELD_LABELS.accessDate, width: 110, field: 'accessDate', sort: 'field:accessDate' },
  { id: 'libraryCatalog', label: FIELD_LABELS.libraryCatalog, width: 90, field: 'libraryCatalog' },
  { id: 'callNumber', label: FIELD_LABELS.callNumber, width: 100, field: 'callNumber' },
  { id: 'rights', label: FIELD_LABELS.rights, width: 90, field: 'rights' },
  { id: 'dateAdded', label: FIELD_LABELS.dateAdded, width: 96, sort: 'dateAdded' },
  { id: 'dateModified', label: FIELD_LABELS.dateModified, width: 96, sort: 'dateModified' },
  { id: 'archive', label: FIELD_LABELS.archive, width: 90, field: 'archive' },
  { id: 'archiveLocation', label: FIELD_LABELS.archiveLocation, width: 100, field: 'archiveLocation' },
  { id: 'place', label: FIELD_LABELS.place, width: 80, field: 'place' },
  { id: 'volume', label: FIELD_LABELS.volume, width: 60, field: 'volume' },
  { id: 'edition', label: FIELD_LABELS.edition, width: 70, field: 'edition' },
  { id: 'number', label: FIELD_LABELS.number, width: 70, field: 'number' },
  { id: 'pages', label: FIELD_LABELS.pages, width: 80, field: 'pages' },
  { id: 'issue', label: FIELD_LABELS.issue, width: 60, field: 'issue' },
  { id: 'series', label: FIELD_LABELS.series, width: 90, field: 'series' },
  { id: 'seriesTitle', label: FIELD_LABELS.seriesTitle, width: 100, field: 'seriesTitle' },
  { id: 'court', label: FIELD_LABELS.court, width: 100, field: 'court' },
  { id: 'medium', label: FIELD_LABELS.medium, width: 80, field: 'medium' },
  { id: 'type', label: FIELD_LABELS.type, width: 80, field: 'type' },
  { id: 'system', label: FIELD_LABELS.system, width: 80, field: 'system' },
  // 短标题 = the user's own marker for a paper's key points; shown first.
  { id: 'shortTitle', label: FIELD_LABELS.shortTitle, width: 150, field: 'shortTitle', sort: 'field:shortTitle', hint: PANE_LABELS.shortTitleHint },
  { id: 'extra', label: FIELD_LABELS.extra, width: 110, field: 'extra' },
  { id: 'doi', label: 'DOI', width: 110, field: 'DOI', sort: 'field:DOI' },
  { id: 'tags', label: FIELD_LABELS.tags, width: 150 },
  { id: 'hasAttachment', label: '附件', width: 36, icon: 'attachment', sort: 'hasAttachment' },
  { id: 'numNotes', label: '笔记', width: 36, icon: 'note', sort: 'numNotes', numeric: true },
]
const DEFAULT_COLUMNS = ['shortTitle', 'title', 'creator', 'year', 'publicationTitle', 'dateModified', 'dateAdded', 'itemType']
// The previous default set: a saved preference that matches it was never
// actually customized, so it migrates to the new default below.
const LEGACY_DEFAULT_COLUMNS = ['shortTitle', 'title', 'creator', 'year', 'hasAttachment']
const KNOWN = new Set(COLUMN_DEFS.map(column => column.id))
const COLUMN_BY_ID = new Map(COLUMN_DEFS.map(column => [column.id, column]))
const COLUMN_WIDTH_STORAGE = 'dsh-zot-library:column-widths'
const COLUMN_MIN_WIDTH = 24
const COLUMN_MAX_WIDTH = 1000
// Columns whose values come from dedicated list fields, not itemData.
const SPECIAL_COLUMNS = new Set([
  'title', 'creator', 'itemType', 'date', 'year', 'dateAdded', 'dateModified', 'tags', 'hasAttachment', 'numNotes',
])

/** Persisted per-column pixel widths; unknown ids and junk values are dropped. */
export function restoreColumnWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMN_WIDTH_STORAGE) ?? 'null')
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      const widths = {}
      for (const [id, value] of Object.entries(saved)) {
        if (KNOWN.has(id) && Number.isFinite(value) && value >= COLUMN_MIN_WIDTH && value <= COLUMN_MAX_WIDTH) {
          widths[id] = Math.round(value)
        }
      }
      return widths
    }
  } catch {
    // A malformed preference falls back to the defaults.
  }
  return {}
}

/** Persisted visible-column order; the title column always stays. Older
 * preference files are migrated so 短标题 leads the header. */
export function restoreColumns() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMNS_STORAGE) ?? 'null')
    if (Array.isArray(saved)) {
      const kept = saved.filter(id => KNOWN.has(id))
      if (!kept.includes('title')) kept.unshift('title')
      if (!kept.includes('shortTitle')) kept.unshift('shortTitle')
      if (kept.length > 0) {
        // The old default order was never customized → adopt the new default.
        if (kept.length === LEGACY_DEFAULT_COLUMNS.length && kept.every((id, index) => id === LEGACY_DEFAULT_COLUMNS[index])) {
          return [...DEFAULT_COLUMNS]
        }
        return kept
      }
    }
  } catch {
    // A malformed preference falls back to the default columns.
  }
  return [...DEFAULT_COLUMNS]
}

/** Move one column onto another's slot (the header's drag reorder). */
export function reorderColumns(list, fromId, toId) {
  const from = list.indexOf(fromId)
  const to = list.indexOf(toId)
  if (from === -1 || to === -1 || from === to) return list
  const next = [...list]
  next.splice(from, 1)
  next.splice(to, 0, fromId)
  return next
}

/** Move one column to an explicit slot (the header drag's push-aside preview). */
export function moveColumnToIndex(list, fromId, index) {
  const from = list.indexOf(fromId)
  if (from === -1) return list
  const next = list.filter(id => id !== fromId)
  next.splice(Math.max(0, Math.min(next.length, index)), 0, fromId)
  return next
}

/** itemData field names the host should return for the visible columns. */
export function columnFieldNames(columns) {
  return [...new Set((Array.isArray(columns) ? columns : [])
    .map(id => COLUMN_BY_ID.get(id)?.field ?? id)
    .filter(id => !SPECIAL_COLUMNS.has(id) && typeof id === 'string'))]
}

function TypeIcon({ itemType }) {
  if (itemType === 'note') return <NoteIcon size={13} />
  if (itemType === 'attachment') return <PdfIcon size={13} />
  return <LibraryIcon size={13} />
}

function cellValue(item, column) {
  switch (column.id) {
    case 'title': return item.title
    case 'creator': return item.creators
    case 'year': return item.year ?? ''
    case 'date': return item.date ?? ''
    case 'itemType': return itemTypeLabel(item.itemType)
    case 'tags': return (item.tags ?? []).join(', ')
    case 'dateAdded': return formatDate(item.dateAdded)
    case 'dateModified': return formatDate(item.dateModified)
    default:
      if (column.field) return item.fields?.[column.field] ?? ''
      return ''
  }
}

/** Middle pane: the item table with drag-and-drop import, column picker and the item context menu. */
export function ItemsPane({
  items, total, view, sort, desc, loading,
  selectedKeys, activeKey, onSelect, onOpen, onSort, onLoadMore, onNotify,
  onImportFiles, importing,
  columns, onSetColumns, columnWidths, onSetColumnWidth, reveal, onContextMenu,
}) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const menuRef = React.useRef(null)
  const [dragging, setDragging] = React.useState(false)
  const dragDepth = React.useRef(0)
  // Zotero-style expansion: a parent with attachments/notes shows a twisty and
  // lists its children as indented rows.
  const [expanded, setExpanded] = React.useState(() => new Set())
  const toggleExpanded = (key) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  // Column drag state for header reordering (Zotero lets you drag headers).
  const dragColumnId = React.useRef(null)
  // Live reorder preview: { from, p } while a header drag is in flight, p =
  // the insertion slot in the source-removed order. Header and row cells
  // translate toward the preview (the "push aside" effect); the real order is
  // committed only on drop.
  const [colDrag, setColDrag] = React.useState(null)
  const colDragPos = React.useRef(null)
  const listRef = React.useRef(null)
  // While a width handle is dragged, native HTML5 reordering must stay off.
  const [resizing, setResizing] = React.useState(false)

  React.useEffect(() => {
    if (!menuOpen) return undefined
    const close = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  // Locate request from the page (imports, show-in-library): scroll the row
  // into view. jsdom has no layout; a missing scrollIntoView is fine there.
  React.useEffect(() => {
    if (!reveal?.key) return
    const root = listRef.current
    if (!root) return
    const node = root.querySelector(`[data-key="${reveal.key}"]`)
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [reveal])

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
    // No attachment but a DOI: the host resolves the web address (url field /
    // doi.org) and opens the browser instead of failing.
    if (item.hasAttachment || item.itemType === 'attachment' || String(item.doi ?? '').trim() !== '') {
      onOpen(item.key)
    } else {
      onNotify?.('该条目没有可打开的附件')
    }
  }

  const selectForMenu = (event, key) => {
    event.preventDefault()
    event.stopPropagation()
    const keys = selectedKeys.includes(key) ? selectedKeys : [key]
    if (!selectedKeys.includes(key)) onSelect(key, {})
    onContextMenu?.({ x: event.clientX, y: event.clientY, keys })
  }

  const rows = items ?? []
  const viewName = view.kind === 'collection' ? view.name : view.kind === 'tag' ? `#${view.name}` : ''
  const visible = columns.map(id => COLUMN_DEFS.find(column => column.id === id)).filter(Boolean)
  // Explicit pixel widths (Zotero-style): every row and the header get the
  // same fixed tracks, so columns always line up; spare viewport width stays
  // blank at the right edge instead of stretching a column.
  const template = visible.map(column => `${Math.round(columnWidths?.[column.id] ?? column.width)}px`).join(' ')

  // While a header drag is live, cells translate toward the previewed order.
  // Rendering stays in the original order and only offsets move, so header
  // and every row keep their tracks aligned during the push animation.
  const dragSource = colDrag?.from ?? null
  let colDelta = null
  if (dragSource && colDrag.p != null) {
    const preview = moveColumnToIndex(columns, dragSource, colDrag.p)
    if (preview.some((id, index) => id !== columns[index])) {
      const widthOf = id => Math.round(columnWidths?.[id] ?? COLUMN_BY_ID.get(id)?.width ?? 100)
      const offsets = (ids) => {
        let x = 0
        const map = {}
        for (const id of ids) { map[id] = x; x += widthOf(id) }
        return map
      }
      const before = offsets(columns)
      const after = offsets(preview)
      colDelta = Object.fromEntries(columns.map(id => [id, after[id] - before[id]]))
    }
  }
  const cellShift = id => (colDelta?.[id] ? { transform: `translateX(${colDelta[id]}px)` } : undefined)

  const toggleColumn = (id, fixed) => {
    if (fixed) return
    onSetColumns(previous => (previous.includes(id)
      ? (previous.length > 1 ? previous.filter(value => value !== id) : previous)
      : [...previous, id]))
  }

  // Zotero-style width resize: drag the cell's right edge; double-click resets.
  const startColumnResize = (event, column) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = Math.round(columnWidths?.[column.id] ?? column.width)
    setResizing(true)
    const onMove = (moveEvent) => {
      const width = Math.min(COLUMN_MAX_WIDTH, Math.max(COLUMN_MIN_WIDTH, startWidth + moveEvent.clientX - startX))
      onSetColumnWidth(column.id, width)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('lib-col-resizing')
      setResizing(false)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.classList.add('lib-col-resizing')
  }
  const resizeHandle = column => (
    <span
      className="lib-colresize"
      title="拖动调整列宽；双击恢复默认宽度"
      onMouseDown={event => startColumnResize(event, column)}
      onDoubleClick={(event) => {
        event.stopPropagation()
        onSetColumnWidth(column.id, undefined)
      }}
      onClick={event => event.stopPropagation()}
      onMouseUp={event => event.stopPropagation()}
    />
  )

  const startColumnDrag = (id) => (event) => {
    dragColumnId.current = id
    colDragPos.current = null
    setColDrag({ from: id, p: null })
    try {
      event.dataTransfer.setData('text/plain', id)
      event.dataTransfer.effectAllowed = 'move'
    } catch {
      // jsdom dataTransfer is a stub; the drop handler passes the id through.
    }
  }
  // Hovered cell decides the insertion slot: left half inserts before it,
  // right half after it (empty rects → "before", which the smoke test relies
  // on since it fires dragstart/drop without dragover).
  const hoverColumn = (id, event) => {
    const from = dragColumnId.current
    const s = columns.indexOf(from)
    const v = columns.indexOf(id)
    if (!from || from === id || s === -1 || v === -1) return
    let side = 'before'
    const rect = event.currentTarget.getBoundingClientRect?.()
    if (rect && rect.width > 0) side = event.clientX - rect.left > rect.width / 2 ? 'after' : 'before'
    const p = v < s ? (side === 'before' ? v : v + 1) : (side === 'before' ? v - 1 : v)
    if (colDragPos.current === p) return
    colDragPos.current = p
    setColDrag({ from, p })
  }
  const dragOverColumn = (id) => (event) => {
    if (!dragColumnId.current) return // file drags keep the container's copy effect
    // stopPropagation keeps .lib-middle's file-import dragover from clobbering
    // our move effect with copy (effectAllowed=move + dropEffect=copy is the
    // mismatch that makes Chromium show the forbidden cursor everywhere).
    event.preventDefault()
    event.stopPropagation()
    try {
      event.dataTransfer.dropEffect = 'move'
    } catch { /* jsdom stub */ }
    hoverColumn(id, event)
  }
  const clearColumnDrag = () => {
    dragColumnId.current = null
    colDragPos.current = null
    setColDrag(null)
  }
  const dropColumnOn = (id) => (event) => {
    event.preventDefault()
    const from = dragColumnId.current
    const p = colDragPos.current
    clearColumnDrag()
    if (!from) return
    // A previewed slot wins: after the push-aside the "source" cell may sit
    // under the cursor, and dropping on it lands at the previewed position.
    if (p != null) onSetColumns(previous => moveColumnToIndex(previous, from, p))
    else if (from !== id) onSetColumns(previous => reorderColumns(previous, from, id))
  }
  // Drop released outside the header (over the rows): commit the previewed slot.
  const dropColumnPreview = (event) => {
    if (!dragColumnId.current) return
    event.preventDefault()
    const from = dragColumnId.current
    const p = colDragPos.current
    clearColumnDrag()
    if (from && p != null) onSetColumns(previous => moveColumnToIndex(previous, from, p))
  }

  // Reordering inside the column picker: the checked list's order IS the
  // header order.
  const menuDragId = React.useRef(null)
  const startMenuDrag = (id) => (event) => {
    menuDragId.current = id
    try {
      event.dataTransfer.setData('text/plain', id)
      event.dataTransfer.effectAllowed = 'move'
    } catch {
      // jsdom dataTransfer is a stub; the drop handler passes the id through.
    }
  }
  const dropMenuOn = (id) => (event) => {
    event.preventDefault()
    const from = menuDragId.current
    menuDragId.current = null
    if (from && from !== id) onSetColumns(previous => reorderColumns(previous, from, id))
  }

  const headerCell = (column) => {
    const label = column.icon
      ? (column.icon === 'attachment' ? <AttachmentIcon size={13} /> : <NoteIcon size={13} />)
      : column.label
    const dragging = dragSource === column.id
    if (!column.sort) {
      return (
        <span
          key={column.id}
          className={`${column.numeric ? 'num' : ''}${dragging ? ' lib-coldrag-src' : ''}`}
          style={cellShift(column.id)}
          draggable={!resizing}
          onDragStart={startColumnDrag(column.id)}
          onDragOver={dragOverColumn(column.id)}
          onDragEnd={clearColumnDrag}
          onDrop={dropColumnOn(column.id)}
        >
          {label}
          {resizeHandle(column)}
        </span>
      )
    }
    return (
      <button
        key={column.id}
        draggable={!resizing}
        onDragStart={startColumnDrag(column.id)}
        onDragOver={dragOverColumn(column.id)}
        onDragEnd={clearColumnDrag}
        onDrop={dropColumnOn(column.id)}
        className={`${sort === column.sort ? 'sorted' : ''}${column.numeric ? ' num' : ''}${dragging ? ' lib-coldrag-src' : ''}`}
        style={{ ...(column.numeric ? { textAlign: 'right' } : null), ...cellShift(column.id) }}
        onClick={() => onSort(column.sort)}
        title={`${column.hint ? `${column.label}：${column.hint}\n` : ''}按${column.label}排序（拖动可调整列顺序，右缘可调列宽）`}
      >
        {label}{sort === column.sort ? (desc ? ' ↓' : ' ↑') : ''}
        {resizeHandle(column)}
      </button>
    )
  }

  const renderTitleCell = (item, key, indent = 0) => (
    <span className="lib-cell strong" key={key} style={{ ...(indent ? { paddingLeft: indent } : null), ...cellShift(key) }}>
      <span className="lib-title">
        <span className="lib-type"><TypeIcon itemType={item.itemType} /></span>
        <span className="lib-title-text">{item.title}</span>
        {item.hasAttachment ? <span className="lib-attach"><AttachmentIcon size={12} /></span> : null}
      </span>
    </span>
  )

  const renderCell = (item, column) => {
    if (column.id === 'title') return renderTitleCell(item, column.id)
    if (column.id === 'hasAttachment') {
      return <span className={`lib-cell${item.hasAttachment ? ' att' : ''}`} key={column.id} style={cellShift(column.id)}>{item.hasAttachment ? <AttachmentIcon size={12} /> : ''}</span>
    }
    if (column.id === 'numNotes') {
      return <span className={`lib-cell${column.numeric ? ' num' : ''}`} key={column.id} style={cellShift(column.id)}>{item.numNotes > 0 ? item.numNotes : ''}</span>
    }
    return (
      <span className={`lib-cell${column.numeric ? ' num' : ''}`} key={column.id} style={cellShift(column.id)}>{cellValue(item, column)}</span>
    )
  }

  return (
    <div
      className="lib-middle"
      onDragEnter={handleDragEnter}
      onDragOver={(event) => {
        event.preventDefault()
        if (!event.dataTransfer) return
        // copy is only for file imports; clobbering the header drag's move
        // effect here is what showed the forbidden cursor during reordering.
        if (event.dataTransfer.types?.includes('Files')) event.dataTransfer.dropEffect = 'copy'
        else if (dragColumnId.current) event.dataTransfer.dropEffect = 'move'
      }}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ position: 'relative' }}
    >
      {/* Header and rows share one scroll container so the header follows
          horizontal scrolling and can never spill into the right pane. The
          .lib-table wrapper gives ALL rows and the header one identical width
          (the widest content), so the grid tracks resolve the same everywhere
          and the columns line up exactly. */}
      <div className="lib-items" ref={listRef}>
        <div className={`lib-table${dragSource ? ' lib-coldrag' : ''}`} onDrop={dropColumnPreview}>
          <div className="lib-table-head" style={{ gridTemplateColumns: `16px ${template} 24px` }}>
            <span />
            {visible.map(headerCell)}
            <span />
          </div>
        {rows.map((item) => {
          const selected = selectedKeys.includes(item.key)
          const children = Array.isArray(item.children) ? item.children : []
          const isExpanded = expanded.has(item.key)
          return (
            <React.Fragment key={item.key}>
              <div
                data-key={item.key}
                className={`lib-itemrow${selected ? ' selected' : ''}${activeKey === item.key ? ' active' : ''}`}
                style={{ gridTemplateColumns: `16px ${template} 24px` }}
                onClick={(event) => onSelect(item.key, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey })}
                onDoubleClick={() => openItem(item)}
                onContextMenu={event => selectForMenu(event, item.key)}
                title={`${item.title}\n${itemTypeLabel(item.itemType)}${item.creators ? ` · ${item.creators}` : ''}\n双击打开附件，右键更多操作`}
              >
                <span className="lib-twisty-cell">
                  {children.length > 0 ? (
                    <button
                      type="button"
                      className="lib-twisty"
                      title={isExpanded ? '收起附件与笔记' : '展开附件与笔记'}
                      aria-expanded={isExpanded}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleExpanded(item.key)
                      }}
                    >
                      {isExpanded ? <ChevronDown size={11} /> : <ChevronRightIcon size={11} />}
                    </button>
                  ) : null}
                </span>
                {visible.map(column => renderCell(item, column))}
                <span />
              </div>
              {isExpanded ? children.map(child => (
                <div
                  key={child.key}
                  data-key={child.key}
                  className={`lib-itemrow lib-childrow${selectedKeys.includes(child.key) ? ' selected' : ''}${activeKey === child.key ? ' active' : ''}`}
                  style={{ gridTemplateColumns: `16px ${template} 24px` }}
                  onClick={(event) => onSelect(child.key, { toggle: event.ctrlKey || event.metaKey, range: false })}
                  onDoubleClick={() => (child.kind === 'note' ? onSelect(child.key, {}) : onOpen(child.key))}
                  onContextMenu={event => selectForMenu(event, child.key)}
                  title={`${child.title}\n${itemTypeLabel(child.itemType)}\n双击打开`}
                >
                  <span className="lib-twisty-cell" />
                  {visible.map(column => (column.id === 'title'
                    ? (
                        <span className="lib-cell strong" style={{ paddingLeft: 16, ...cellShift(column.id) }} key={column.id}>
                          <span className="lib-title">
                            <span className="lib-type">
                              {child.kind === 'note' ? <NoteIcon size={12} /> : <PdfIcon size={12} />}
                            </span>
                            <span className="lib-title-text">{child.title}</span>
                          </span>
                        </span>
                      )
                    : <span className="lib-cell" key={column.id} style={cellShift(column.id)} />
                  ))}
                  <span />
                </div>
              )) : null}
            </React.Fragment>
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
      </div>

      {/* Column picker: pinned at the pane's top-right corner so it stays
          reachable no matter how far the header is scrolled. */}
      <div className="lib-colmenu-wrap" ref={menuRef}>
        <button
          className={`lib-colbtn${menuOpen ? ' open' : ''}`}
          title="选择要显示的列"
          onClick={() => setMenuOpen(value => !value)}
        >
          <ChevronDown size={12} />
        </button>
        {menuOpen ? (
          <div
            className="lib-colmenu"
            onDragOver={(event) => {
              event.preventDefault()
              event.stopPropagation()
              try {
                event.dataTransfer.dropEffect = 'move'
              } catch { /* jsdom stub */ }
            }}
          >
            <div className="lib-colmenu-title">显示中的列（拖动可调顺序）</div>
            {columns.map((id) => {
              const column = COLUMN_BY_ID.get(id)
              if (!column) return null
              return (
                <div
                  key={id}
                  className={`lib-colitem${column.fixed ? ' fixed' : ''}`}
                  draggable
                  onDragStart={startMenuDrag(id)}
                  onDrop={dropMenuOn(id)}
                  onClick={(event) => {
                    event.preventDefault()
                    if (event.target.tagName === 'INPUT') return
                    toggleColumn(id, column.fixed)
                  }}
                  title={column.hint ? `${column.label}：${column.hint}` : (column.fixed ? '标题列始终显示，可拖动调整位置' : undefined)}
                >
                  <span className="lib-colitem-drag" title="拖动调整列顺序">⋮⋮</span>
                  <input
                    type="checkbox"
                    checked
                    disabled={column.fixed === true}
                    onChange={() => toggleColumn(id, column.fixed)}
                  />
                  <span className="lib-colitem-label">{column.label}</span>
                </div>
              )
            })}
            <div className="lib-colmenu-title">可添加的列</div>
            {COLUMN_DEFS.filter(column => !columns.includes(column.id)).map(column => (
              <div
                key={column.id}
                className="lib-colitem"
                onClick={(event) => {
                  event.preventDefault()
                  if (event.target.tagName === 'INPUT') return
                  toggleColumn(column.id, false)
                }}
                title={column.hint ? `${column.label}：${column.hint}` : undefined}
              >
                <input
                  type="checkbox"
                  checked={false}
                  onChange={() => toggleColumn(column.id, false)}
                />
                <span className="lib-colitem-label">{column.label}</span>
              </div>
            ))}
            <button
              type="button"
              className="lib-colmenu-restore"
              onClick={() => onSetColumns([...DEFAULT_COLUMNS])}
            >
              恢复默认列
            </button>
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
