import * as React from 'react'
import { Button } from './platform.jsx'
import {
  ChatIcon, CollectionIcon, FolderIcon, InboxIcon, TagIcon, TrashIcon,
} from './icons.jsx'

// The collection tree's expansion state survives panel switches and restarts,
// so a restored selection is visible immediately instead of buried under
// collapsed roots.
const EXPANDED_STORAGE = 'dsh-zot-library:collections-expanded'

function restoreExpanded() {
  try {
    const saved = JSON.parse(localStorage.getItem(EXPANDED_STORAGE) ?? '[]')
    if (Array.isArray(saved)) return new Set(saved.map(Number).filter(Number.isInteger))
  } catch {
    // A malformed preference falls back to everything collapsed.
  }
  return new Set()
}

/** Chain of collection ids from a root down to `id` (inclusive); [] when absent. */
function ancestorIds(nodes, id, path = []) {
  for (const node of nodes) {
    const chain = [...path, node.id]
    if (node.id === id) return chain
    const deeper = ancestorIds(node.children, id, chain)
    if (deeper.length > 0) return deeper
  }
  return []
}

function TreeRow({ node, depth, expanded, toggle, selectedId, onSelect, onContext }) {
  const hasChildren = node.children.length > 0
  // Compare by id HERE: passing the parent's `selected` down made a whole
  // subtree light up when only the clicked collection is active.
  const selected = selectedId === node.id
  return (
    <>
      <div
        className={`lib-row${selected ? ' selected' : ''}`}
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={() => onSelect({ kind: 'collection', id: node.id, name: node.name })}
        onContextMenu={(event) => {
          event.preventDefault()
          onContext?.(event, node)
        }}
        title={node.name}
      >
        <span
          className="lib-caret"
          onClick={(event) => {
            if (!hasChildren) return
            event.stopPropagation()
            toggle(node.id)
          }}
        >
          {hasChildren ? (expanded.has(node.id) ? '▾' : '▸') : null}
        </span>
        <span style={{ display: 'inline-flex', color: 'var(--lib-text-3)' }}><CollectionIcon size={13} /></span>
        <span className="lib-label">{node.name}</span>
        <span className="lib-count">{node.totalCount}</span>
      </div>
      {hasChildren && expanded.has(node.id)
        ? node.children.map(child => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
              selectedId={selectedId}
              onSelect={onSelect}
              onContext={onContext}
            />
          ))
        : null}
    </>
  )
}

/** Left pane: smart views, the collection tree and the tag cloud. */
export function CollectionsPane({
  data, tags, view, onSelectView, loading, onCreateCollection, onCollectionContext, onBackToChat,
}) {
  const [expanded, setExpanded] = React.useState(restoreExpanded)
  const toggle = React.useCallback((id) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  React.useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_STORAGE, JSON.stringify([...expanded]))
    } catch {
      // Preferences are optional.
    }
  }, [expanded])
  // A restored (or newly picked) collection must be visible: unfold its
  // ancestor chain, e.g. right after reopening the library.
  React.useEffect(() => {
    if (view.kind !== 'collection' || !data) return
    const chain = ancestorIds(data.collections ?? [], view.id)
    setExpanded((previous) => {
      const missing = chain.filter(id => !previous.has(id))
      if (missing.length === 0) return previous
      const next = new Set(previous)
      for (const id of missing) next.add(id)
      return next
    })
  }, [view.kind, view.id, data])
  const selectedCollectionID = view.kind === 'collection' ? view.id : undefined
  const allCount = data?.collections
    ? data.collections.reduce((sum, node) => sum + node.totalCount, 0)
    : 0

  return (
    <div className="lib-col lib-left">
      <div
        className={`lib-row${view.kind === 'all' ? ' selected' : ''}`}
        onClick={() => onSelectView({ kind: 'all' })}
      >
        <span className="lib-caret" />
        <span style={{ display: 'inline-flex' }}><FolderIcon size={13} /></span>
        <span className="lib-label" style={{ fontWeight: 600 }}>我的文库</span>
        <span className="lib-count">{allCount}</span>
      </div>
      <div
        className={`lib-row${view.kind === 'unfiled' ? ' selected' : ''}`}
        onClick={() => onSelectView({ kind: 'unfiled' })}
      >
        <span className="lib-caret" />
        <span style={{ display: 'inline-flex', color: 'var(--lib-text-3)' }}><InboxIcon size={13} /></span>
        <span className="lib-label">未分类</span>
        <span className="lib-count">{data?.unfiled ?? 0}</span>
      </div>

      <div className="lib-section">
        <span>我的分类</span>
        <span style={{ marginLeft: 'auto' }} />
        <Button variant="ghost" size="sm" title="新建分类" onClick={onCreateCollection}>＋</Button>
      </div>
      <div className="lib-tree">
        {loading && !data ? <div className="lib-empty">读取中…</div> : null}
        {(data?.collections ?? []).map(node => (
          <TreeRow
            key={node.id}
            node={node}
            depth={0}
            expanded={expanded}
            toggle={toggle}
            selectedId={selectedCollectionID}
            onSelect={onSelectView}
            onContext={onCollectionContext}
          />
        ))}
        {data && data.collections.length === 0 ? <div className="lib-empty" style={{ padding: '10px 12px' }}>还没有分类</div> : null}
      </div>

      <div className="lib-section"><TagIcon size={12} /><span>标签</span></div>
      <div className="lib-taglist">
        {(tags ?? []).map(tag => (
          <button
            key={tag.name}
            className={`lib-tagchip${view.kind === 'tag' && view.name === tag.name ? ' active' : ''}`}
            title={tag.name}
            onClick={() => onSelectView(view.kind === 'tag' && view.name === tag.name ? { kind: 'all' } : { kind: 'tag', name: tag.name })}
          >
            <span className="lib-tag-name">{tag.name}</span>
            <span className="lib-count">{tag.count}</span>
          </button>
        ))}
        {(tags ?? []).length === 0 ? <span className="lib-form-hint">暂无标签</span> : null}
      </div>

      <div className="lib-taglist-spacer" />

      <div className="lib-section"><TrashIcon size={12} /><span>回收站</span></div>
      <div
        className={`lib-row${view.kind === 'trash' ? ' selected' : ''}`}
        onClick={() => onSelectView({ kind: 'trash' })}
      >
        <span className="lib-caret" />
        <span style={{ display: 'inline-flex', color: 'var(--lib-text-3)' }}><TrashIcon size={13} /></span>
        <span className="lib-label">回收站</span>
        <span className="lib-count">{data?.trash ?? 0}</span>
      </div>

      <button className="lib-back-to-chat" title="关闭文库视图，回到对话模式" onClick={onBackToChat}>
        <ChatIcon size={13} /> 回到对话模式
      </button>
    </div>
  )
}
