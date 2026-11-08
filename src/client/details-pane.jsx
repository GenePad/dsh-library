import * as React from 'react'
import * as api from './api.js'
import { Button } from './platform.jsx'
import {
  ArrowDownIcon, ArrowUpIcon, CloseIcon, ExternalIcon, LinkIcon, MinusIcon, NoteIcon, PdfIcon, PlusIcon,
  SwitchFieldIcon,
} from './icons.jsx'
import {
  ANNOTATION_TYPE_LABELS, FIELD_LABELS, PANE_LABELS, creatorTypeLabel, fieldLabel, formatDate, formatDateTime,
  itemTypeLabel, itemTypeLabel as typeLabel,
} from './util.js'

const SECTIONS_STORAGE = 'dsh-library:sections'
// Zotero shows the first five creators and truncates the rest behind a
// "还有 N 个…" row.
const INITIAL_VISIBLE_CREATORS = 5

/** Which sections start open (Zotero's defaults; user toggles persist). */
const DEFAULT_SECTIONS = {
  info: true,
  abstract: true,
  attachments: true,
  annotations: true,
  notes: true,
  collections: true,
  tags: true,
}

function restoreSections() {
  try {
    const saved = JSON.parse(localStorage.getItem(SECTIONS_STORAGE) ?? 'null')
    if (saved && typeof saved === 'object') return { ...DEFAULT_SECTIONS, ...saved }
  } catch {
    // A malformed preference falls back to all-open.
  }
  return { ...DEFAULT_SECTIONS }
}

/** One collapsible item-pane section (Zotero's collapsible-section). */
function Section({ id, label, count, open, onToggle, actions, children }) {
  return (
    <section className={`lib-sectionpane${open ? ' open' : ''}`} data-section={id}>
      <div className="lib-sectionpane-head">
        <button
          type="button"
          className="lib-sectionpane-title"
          onClick={onToggle}
          title={open ? '折叠此栏' : '展开此栏'}
        >
          <span className={`lib-sectionpane-caret${open ? ' open' : ''}`}>▾</span>
          <span>{label}</span>
          {count !== undefined ? <span className="lib-sectionpane-count">{count}</span> : null}
        </button>
        <span className="lib-sectionpane-actions" onClick={event => event.stopPropagation()}>{actions}</span>
      </div>
      {open ? <div className="lib-sectionpane-body">{children}</div> : null}
    </section>
  )
}

function EditableField({ field, value, onSave, autoEdit = false, readOnly = false, hint }) {
  const [editing, setEditing] = React.useState(autoEdit)
  const [draft, setDraft] = React.useState(value)
  React.useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])
  const multiline = field === 'abstractNote' || field === 'extra' || String(value).length > 90
  const commit = () => {
    setEditing(false)
    if (draft !== value) onSave(draft)
  }
  const hintNode = hint ? <span className="lib-field-hint">{hint}</span> : null
  if (editing) {
    return (
      <div className="lib-field">
        <span className="lib-field-label">{fieldLabel(field)}</span>
        <span className="lib-field-editor">
          {multiline
            ? (
                <textarea
                  autoFocus
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  onBlur={commit}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') { setDraft(value); setEditing(false) }
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) commit()
                  }}
                />
              )
            : (
                <input
                  autoFocus
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  onBlur={commit}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commit()
                    if (event.key === 'Escape') { setDraft(value); setEditing(false) }
                  }}
                />
              )}
          {hintNode}
        </span>
      </div>
    )
  }
  return (
    <div
      className="lib-field"
      onClick={() => { if (!readOnly) setEditing(true) }}
      title={readOnly ? undefined : '点击编辑'}
      style={readOnly ? undefined : { cursor: 'text' }}
    >
      <span className="lib-field-label">{fieldLabel(field)}</span>
      <span className="lib-field-editor">
        <span className={`lib-field-value${String(value ?? '') === '' ? ' empty' : ''}`}>{String(value ?? '') || '—'}</span>
        {hintNode}
      </span>
    </div>
  )
}

/** One creator row: type menu + name fields + hover buttons, Zotero-style. */
function CreatorRow({ creator, index, typeOptions, onNameInput, onChange, onRemove, onAddAfter, onMove, onRowBlur, isFirst, isLast }) {
  const single = creator.fieldMode === 1
  return (
    <div className="lib-creator-row" data-creator-index={index} onBlur={onRowBlur}>
      <select
        className="lib-creator-type"
        value={creator.creatorType ?? typeOptions[0]}
        title="创建者类型"
        onChange={event => onChange(index, { creatorType: event.target.value })}
      >
        {typeOptions.map(type => <option key={type} value={type}>{creatorTypeLabel(type)}</option>)}
      </select>
      <span className="lib-creator-names">
        <input
          className="lib-creator-last"
          placeholder={single ? `（${PANE_LABELS.__placeholders.fullName}）` : `（${PANE_LABELS.__placeholders.lastName}）`}
          value={creator.lastName ?? ''}
          onChange={event => onNameInput(index, { lastName: event.target.value })}
        />
        {!single ? (
          <input
            className="lib-creator-first"
            placeholder={`（${PANE_LABELS.__placeholders.firstName}）`}
            value={creator.firstName ?? ''}
            onChange={event => onNameInput(index, { firstName: event.target.value })}
          />
        ) : null}
      </span>
      <span className="lib-creator-btns">
        <button
          type="button"
          className="lib-creator-btn"
          title={single ? '切换为双栏（姓 / 名）' : '切换单栏（全名）'}
          onClick={() => onChange(index, { fieldMode: single ? 0 : 1 })}
        >
          <SwitchFieldIcon size={12} />
        </button>
        <button type="button" className="lib-creator-btn" title="上移" disabled={isFirst} onClick={() => onMove(index, -1)}>
          <ArrowUpIcon size={11} />
        </button>
        <button type="button" className="lib-creator-btn" title="下移" disabled={isLast} onClick={() => onMove(index, 1)}>
          <ArrowDownIcon size={11} />
        </button>
        <button type="button" className="lib-creator-btn" title="添加创建者" onClick={() => onAddAfter(index)}>
          <PlusIcon size={11} />
        </button>
        <button type="button" className="lib-creator-btn danger" title="移除创建者" onClick={() => onRemove(index)}>
          <MinusIcon size={12} />
        </button>
      </span>
    </div>
  )
}

/**
 * The item info section, replicating Zotero's itemBox: an item type menu on
 * top, every field the type supports (empty ones included), creator rows in
 * between, and the read-only dateAdded/dateModified rows at the bottom.
 */
function InfoSection({ detail, schema, onPatch, onOpenUrl, onNotify }) {
  const typeShape = schema?.get(detail.itemType)
  const fieldNames = typeShape?.fields ?? []
  const typeOptions = typeShape?.creatorTypes?.map(entry => entry.creatorType) ?? ['author']
  const stored = new Map((detail.fields ?? []).map(entry => [entry.field, entry.value]))

  // Creators are edited locally (keystrokes stay in the row, like Zotero) and
  // committed on blur or when a row button is used.
  const fromDetail = React.useCallback(
    () => (detail.creators ?? []).map(creator => ({
      firstName: creator.firstName ?? '',
      lastName: creator.lastName ?? '',
      fieldMode: creator.fieldMode === 1 ? 1 : 0,
      creatorType: creator.creatorType ?? 'author',
    })),
    [detail.creators],
  )
  const [creators, setCreators] = React.useState(fromDetail)
  const dirtyRef = React.useRef(false)
  React.useEffect(() => {
    setCreators(fromDetail())
    dirtyRef.current = false
  }, [detail.key]) // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    // External changes (agent edits, Zotero sync) reach the rows while the
    // user has not touched them.
    if (!dirtyRef.current) setCreators(fromDetail())
  }, [fromDetail])

  // The type change mirrors Zotero: fields that survive transfer, the rest are
  // listed in a confirm dialog before anything is written.
  const changeType = async (itemType) => {
    if (!itemType || itemType === detail.itemType) return
    try {
      const plan = await api.call('change-type', { key: detail.key, itemType })
      if (Array.isArray(plan.dropped) && plan.dropped.length > 0) {
        const list = plan.dropped.map(name => ` - ${fieldLabel(name)}`).join('\n')
        if (!window.confirm(`您确定要更改条目类型吗？\n\n下列字段将丢失：\n${list}`)) return
      }
      await api.call('change-type', { key: detail.key, itemType, confirm: true })
      onPatch({})
    } catch (error) {
      onNotify(error?.message ?? String(error))
    }
  }

  const commitCreators = (next) => {
    setCreators(next)
    dirtyRef.current = true
    const cleaned = next
      .map(creator => (creator.fieldMode === 1
        ? { fieldMode: 1, lastName: creator.lastName ?? '', creatorType: creator.creatorType ?? 'author' }
        : { fieldMode: 0, firstName: creator.firstName ?? '', lastName: creator.lastName ?? '', creatorType: creator.creatorType ?? 'author' }))
      .filter(creator => String(creator.lastName).trim() !== '' || String(creator.firstName ?? '').trim() !== '')
    onPatch({ creators: cleaned })
  }
  // Typing only updates the local row; the write happens on blur (below) or
  // when a row button is pressed.
  const inputCreator = (index, patch) => {
    setCreators(previous => previous.map((creator, position) => (position === index ? { ...creator, ...patch } : creator)))
    dirtyRef.current = true
  }
  // Blur commit: ignore focus moves that stay inside the same row (姓 ↔ 名).
  const rowBlur = (event) => {
    const related = event.relatedTarget
    if (related && event.currentTarget.contains(related)) return
    commitCreators(creators)
  }
  const changeCreator = (index, patch) => {
    const next = creators.map((creator, position) => (position === index ? { ...creator, ...patch } : creator))
    if ('fieldMode' in patch) {
      // Single field folds the given name into the last-name box, like Zotero.
      const creator = next[index]
      if (patch.fieldMode === 1 && creator.firstName) {
        creator.lastName = `${creator.firstName} ${creator.lastName}`.trim()
        creator.firstName = ''
      }
      if (patch.fieldMode === 0 && creator.lastName && creator.lastName.includes(' ')) {
        const parts = creator.lastName.split(/\s+/)
        creator.firstName = parts.slice(0, -1).join(' ')
        creator.lastName = parts.at(-1)
      }
    }
    commitCreators(next)
  }
  const removeCreator = (index) => {
    const next = creators.filter((_, position) => position !== index)
    commitCreators(next)
  }
  const addCreatorAfter = (index) => {
    const template = creators[index] ?? { creatorType: typeOptions[0], fieldMode: 0 }
    const next = [...creators]
    next.splice(index + 1, 0, { firstName: '', lastName: '', fieldMode: 0, creatorType: template.creatorType })
    commitCreators(next)
  }
  const moveCreator = (index, delta) => {
    const target = index + delta
    if (target < 0 || target >= creators.length) return
    const next = [...creators]
    const [row] = next.splice(index, 1)
    next.splice(target, 0, row)
    commitCreators(next)
  }

  const [showAllCreators, setShowAllCreators] = React.useState(false)
  React.useEffect(() => { setShowAllCreators(false) }, [detail.key])
  const visibleCreators = creators.length > INITIAL_VISIBLE_CREATORS && !showAllCreators
    ? creators.slice(0, INITIAL_VISIBLE_CREATORS)
    : creators
  const hiddenCreatorCount = creators.length - visibleCreators.length

  // Fields valid for the type, in schema order; abstract lives in its own
  // section (Zotero's _ignoreFields), dateAdded/dateModified close the list.
  // 短标题 is the user's own key-points marker, so it sits right under the
  // title regardless of the schema's field order.
  const infoFields = fieldNames.filter(name => name !== 'abstractNote')
  const shortIndex = infoFields.indexOf('shortTitle')
  const titleIndex = infoFields.indexOf('title')
  if (shortIndex !== -1 && titleIndex !== -1) {
    infoFields.splice(shortIndex, 1)
    infoFields.splice(infoFields.indexOf('title') + 1, 0, 'shortTitle')
  }
  return (
    <>
      <div className="lib-field lib-field-type">
        <span className="lib-field-label">条目类型</span>
        <select
          className="lib-type-menu"
          value={detail.itemType}
          onChange={event => void changeType(event.target.value)}
        >
          {(schema ? [...schema.keys()] : [detail.itemType]).map(name => (
            <option key={name} value={name}>{typeLabel(name)}</option>
          ))}
        </select>
      </div>

      <div className="lib-fields">
        {infoFields.map((name) => {
          const value = stored.get(name) ?? ''
          if (name === 'DOI' || name === 'url') {
            return (
              <div className="lib-field" key={name}>
                <span className="lib-field-label">{fieldLabel(name)}</span>
                <span className="lib-field-value link" style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                  <span style={{ overflowWrap: 'anywhere' }}>{String(value) || '—'}</span>
                  {String(value ?? '') !== '' ? (
                    <button
                      type="button"
                      className="lib-iconbtn"
                      title="在线查看"
                      onClick={() => onOpenUrl(name === 'DOI' ? `https://doi.org/${value}` : value)}
                    >
                      <LinkIcon size={12} />
                    </button>
                  ) : null}
                </span>
              </div>
            )
          }
          return (
            <EditableField
              key={name}
              field={name}
              value={value}
              hint={name === 'shortTitle' ? PANE_LABELS.shortTitleHint : undefined}
              onSave={(next) => {
                const patch = { fields: { [name]: next } }
                if (name === 'title' && String(next).trim() === '') return
                onPatch(patch)
              }}
            />
          )
        })}
        <div className="lib-field">
          <span className="lib-field-label">{PANE_LABELS.dateAdded}</span>
          <span className="lib-field-value">{formatDateTime(detail.dateAdded)}</span>
        </div>
        <div className="lib-field">
          <span className="lib-field-label">{PANE_LABELS.dateModified}</span>
          <span className="lib-field-value">{formatDateTime(detail.dateModified)}</span>
        </div>
      </div>

      <div className="lib-subhead">创建者</div>
      <div className="lib-creators">
        {visibleCreators.map((creator, index) => (
          <CreatorRow
            key={`${detail.key}-${index}`}
            creator={creator}
            index={index}
            typeOptions={typeOptions}
            onNameInput={inputCreator}
            onChange={changeCreator}
            onRemove={removeCreator}
            onAddAfter={addCreatorAfter}
            onMove={moveCreator}
            onRowBlur={rowBlur}
            isFirst={index === 0}
            isLast={index === creators.length - 1}
          />
        ))}
        {creators.length === 0 ? (
          <CreatorRow
            creator={{ firstName: '', lastName: '', fieldMode: 0, creatorType: typeOptions[0] }}
            index={0}
            typeOptions={typeOptions}
            onNameInput={(_, patch) => commitCreators([{ firstName: '', lastName: '', fieldMode: 0, creatorType: typeOptions[0], ...patch }])}
            onChange={(_, patch) => commitCreators([{ firstName: '', lastName: '', fieldMode: 0, creatorType: typeOptions[0], ...patch }])}
            onRemove={() => {}}
            onAddAfter={() => {}}
            onMove={() => {}}
            isFirst
            isLast
          />
        ) : null}
        {hiddenCreatorCount > 0 ? (
          <button type="button" className="lib-more-creators" onClick={() => setShowAllCreators(true)}>
            还有 {hiddenCreatorCount} 个…
          </button>
        ) : null}
        {creators.length > 0 ? (
          <button type="button" className="lib-more-creators" onClick={() => commitCreators([...creators, { firstName: '', lastName: '', fieldMode: 0, creatorType: typeOptions[0] }])}>
            ＋ 添加创建者
          </button>
        ) : null}
      </div>

      {detail.attachment ? (
        <div className="lib-attachment-file">
          <div className="lib-field">
            <span className="lib-field-label">文件位置</span>
            <span className="lib-field-value" style={{ fontSize: 11 }}>{String(detail.attachment.rawPath ?? '').replace(/^storage:/, 'storage/')}</span>
          </div>
        </div>
      ) : null}
    </>
  )
}

/** Attachment list of one item, with Zotero's add menu (文件 / 网页链接). */
function AttachmentsSection({ detail, adding, setAdding, onOpen, onReveal, onTrash, onAddFile, onAddUrl, onNotify }) {
  const [url, setUrl] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const fileRef = React.useRef(null)
  const files = detail.attachment
    ? [{
        key: detail.key,
        title: String(detail.attachment.rawPath ?? '').replace(/^storage:/, ''),
        size: undefined,
      }]
    : (detail.attachments ?? [])
  const pdf = files.find(entry => /\.(pdf|epub)$/i.test(entry.title)) ?? files[0]

  const submitUrl = async () => {
    if (url.trim() === '') return
    setBusy(true)
    try {
      await onAddUrl(url.trim())
      setUrl('')
      setAdding(false)
    } catch (error) {
      onNotify(error?.message ?? String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {files.map(attachment => (
        <div className="lib-attachment" key={attachment.key} onDoubleClick={() => onOpen(attachment.key)}>
          <PdfIcon size={15} />
          <span className="lib-att-name" title={attachment.title}>{attachment.title}</span>
          <span className="lib-att-size">{attachment.size ? `${Math.max(1, Math.round(attachment.size / 1024))} KB` : ''}</span>
          <Button variant="ghost" size="sm" title="打开" onClick={() => onOpen(attachment.key)}><ExternalIcon size={13} /></Button>
          <Button variant="ghost" size="sm" title="在文件夹中显示" onClick={() => onReveal(attachment.key)}>📁</Button>
          <Button variant="ghost" size="sm" title="移到回收站" className="lib-danger-text" onClick={() => onTrash(attachment.key)}><MinusIcon size={13} /></Button>
        </div>
      ))}
      {files.length === 0 ? <div className="lib-form-hint">没有附件。把 PDF 拖到中间的列表即可作为附件导入。</div> : null}
      {adding ? (
        <div className="lib-att-add">
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              style={{ flex: 1, height: 26, padding: '0 6px', fontSize: 12 }}
              placeholder="https://…（网页链接）"
              value={url}
              onChange={event => setUrl(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void submitUrl() }}
            />
            <Button variant="primary" size="sm" disabled={busy} onClick={submitUrl}>添加链接</Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>取消</Button>
          </div>
          <button type="button" className="lib-more-creators" onClick={() => fileRef.current?.click()}>或选择本地文件…</button>
        </div>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void onAddFile(file)
        }}
      />
      {pdf ? (
        <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
          <Button variant="primary" size="sm" icon={<ExternalIcon size={13} />} onClick={() => onOpen(pdf.key)}>打开 PDF</Button>
          <Button variant="outline" size="sm" onClick={() => onReveal(pdf.key)}>在文件夹中显示</Button>
        </div>
      ) : null}
    </>
  )
}

/** Notes of one item: create + inline plain-text editing. */
function NotesSection({ detail, onUpdateNote, onRefresh, onNotify }) {
  const [editingKey, setEditingKey] = React.useState('')
  const [draft, setDraft] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const notes = detail.notes ?? []

  const startEdit = (note) => {
    setEditingKey(note.key)
    setDraft(note.html ?? '')
  }
  const save = async () => {
    if (editingKey === '') return
    setBusy(true)
    try {
      await onUpdateNote(editingKey, draft)
      setEditingKey('')
    } finally {
      setBusy(false)
    }
  }
  const create = async () => {
    setBusy(true)
    try {
      const created = await api.call('note-create', { parentKey: detail.key })
      if (created?.key) {
        setEditingKey(created.key)
        setDraft('')
        onRefresh?.()
      }
    } catch (error) {
      onNotify?.(error?.message ?? String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {notes.map(note => (
        <div className="lib-note-row" key={note.key}>
          <button type="button" className="lib-note-title" onClick={() => (editingKey === note.key ? setEditingKey('') : startEdit(note))}>
            <NoteIcon size={13} />
            <span>{note.title || '笔记'}</span>
            <span className="lib-form-hint">{formatDate(note.dateAdded)}</span>
          </button>
          {editingKey === note.key ? (
            <div className="lib-note-editor">
              <textarea
                autoFocus
                value={draft}
                disabled={busy}
                onChange={event => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setEditingKey('')
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void save()
                }}
                placeholder="输入笔记内容（Ctrl+Enter 保存，纯文本段落）"
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <Button variant="primary" size="sm" disabled={busy} onClick={save}>保存</Button>
                <Button variant="ghost" size="sm" onClick={() => setEditingKey('')}>取消</Button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
      {detail.note ? (
        <div className="lib-note-row">
          {detail.itemType === 'note' ? (
            <>
              {editingKey === 'self' ? (
                <div className="lib-note-editor">
                  <textarea
                    autoFocus
                    value={draft}
                    disabled={busy}
                    onChange={event => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setEditingKey('')
                      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void save()
                    }}
                    placeholder="输入笔记内容（Ctrl+Enter 保存，纯文本段落）"
                  />
                  <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                    <Button variant="primary" size="sm" disabled={busy} onClick={save}>保存</Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditingKey('')}>取消</Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="lib-note-html">{String(detail.note.html ?? '').replace(/<[^>]+>/g, ' ').trim()}</div>
                  <button type="button" className="lib-more-creators" onClick={() => { setEditingKey('self'); setDraft(String(detail.note.html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()) }}>
                    编辑笔记
                  </button>
                </>
              )}
            </>
          ) : (
            <div className="lib-note-html">{String(detail.note.html ?? '').replace(/<[^>]+>/g, ' ').trim()}</div>
          )}
        </div>
      ) : null}
      {notes.length === 0 && !detail.note ? <div className="lib-form-hint">没有笔记</div> : null}
      {detail.itemType !== 'note' ? (
        <button type="button" className="lib-more-creators" disabled={busy} onClick={() => void create()}>
          ＋ 添加笔记
        </button>
      ) : null}
    </>
  )
}

/** Right pane: the selected item's record, as Zotero's scrolling item pane. */
export function DetailsPane({ detail, loading, collections, schema, onUpdate, onOpen, onReveal, onOpenUrl, onAddFile, onAddUrl, onTrashAttachment, onUpdateNote, onRefresh, onNotify }) {
  const [sections, setSections] = React.useState(restoreSections)
  React.useEffect(() => {
    try {
      localStorage.setItem(SECTIONS_STORAGE, JSON.stringify(sections))
    } catch {
      // Preferences are optional.
    }
  }, [sections])
  const toggle = id => setSections(previous => ({ ...previous, [id]: !previous[id] }))

  const [tagDraft, setTagDraft] = React.useState('')
  const [addingAttachment, setAddingAttachment] = React.useState(false)
  React.useEffect(() => {
    setTagDraft('')
    setAddingAttachment(false)
  }, [detail?.key])

  if (loading && !detail) return <div className="lib-right"><div className="lib-empty">读取中…</div></div>
  if (!detail) {
    return (
      <div className="lib-right">
        <div className="lib-empty">选择一篇文献查看详情<br /><span className="lib-form-hint">双击列表标题即可打开 PDF</span></div>
      </div>
    )
  }

  const fieldMap = new Map((detail.fields ?? []).map(entry => [entry.field, entry.value]))
  const annotations = detail.annotations ?? []
  const saveField = (field, value) => onUpdate(detail.key, { fields: { [field]: value } })
  const addTag = () => {
    const name = tagDraft.trim()
    if (name === '') return
    const existing = detail.tags.map(tag => tag.name)
    if (!existing.includes(name)) onUpdate(detail.key, { tags: [...existing, name] })
    setTagDraft('')
  }
  const removeTag = (name) => onUpdate(detail.key, { tags: detail.tags.map(tag => tag.name).filter(tag => tag !== name) })
  const isNote = detail.itemType === 'note'
  const schemaRef = schema

  return (
    <div className="lib-right">
      <div className="lib-detail-head">
        <div className="lib-detail-title">{detail.title || '(无标题)'}</div>
        <div className="lib-detail-sub">
          <span className="lib-pill">{itemTypeLabel(detail.itemType)}</span>
          {detail.deleted ? <span className="lib-pill" style={{ color: 'var(--lib-danger)' }}>回收站</span> : null}
          <span>{detail.key}</span>
          <span>·</span>
          <span>修改于 {formatDateTime(detail.dateModified)}</span>
        </div>
      </div>

      {!isNote ? (
        <Section
          id="info"
          label="信息"
          open={sections.info}
          onToggle={() => toggle('info')}
        >
          <InfoSection
            detail={detail}
            schema={schemaRef}
            onPatch={patch => onUpdate(detail.key, patch)}
            onOpenUrl={onOpenUrl}
            onNotify={onNotify}
          />
        </Section>
      ) : null}

      {!isNote ? (
        <Section id="abstract" label="摘要" open={sections.abstract} onToggle={() => toggle('abstract')}>
          <EditableField
            field="abstractNote"
            value={fieldMap.get('abstractNote') ?? ''}
            onSave={value => saveField('abstractNote', value)}
          />
        </Section>
      ) : null}

      {!isNote ? (
        <Section
          id="attachments"
          label="附件"
          count={detail.attachments?.length || undefined}
          open={sections.attachments}
          onToggle={() => toggle('attachments')}
          actions={(
            <button
              type="button"
              className="lib-iconbtn"
              title="添加附件（文件 / 网页链接）"
              onClick={() => { setAdding(true); if (!sections.attachments) toggle('attachments') }}
            ><PlusIcon size={12} /></button>
          )}
        >
          <AttachmentsSection
            detail={detail}
            adding={addingAttachment}
            setAdding={setAddingAttachment}
            onOpen={onOpen}
            onReveal={onReveal}
            onNotify={onNotify}
            onTrash={onTrashAttachment}
            onAddFile={onAddFile}
            onAddUrl={onAddUrl}
          />
        </Section>
      ) : null}

      <Section
        id="annotations"
        label="批注"
        count={annotations.length || undefined}
        open={sections.annotations}
        onToggle={() => toggle('annotations')}
      >
        {annotations.map(annotation => (
          <div className="lib-annotation" key={annotation.key} onDoubleClick={() => onOpen(annotation.parentKey)} title="双击打开 PDF">
            <span className="lib-anno-dot" style={{ background: annotation.color || '#ffd400' }} />
            <div className="lib-anno-body">
              <div className="lib-anno-text">{annotation.text || annotation.comment || '(无文字)'}</div>
              {annotation.comment && annotation.text ? <div className="lib-anno-comment">💬 {annotation.comment}</div> : null}
              <div className="lib-anno-meta">
                第 {annotation.pageLabel || '?'} 页 · {ANNOTATION_TYPE_LABELS[annotation.type] ?? '批注'}
                {annotation.parentKey ? ` · 附件 ${annotation.parentKey}` : ''}
              </div>
            </div>
          </div>
        ))}
        {annotations.length === 0 ? <div className="lib-form-hint">还没有批注。在内置阅读器中高亮的段落会出现在这里。</div> : null}
      </Section>

      <Section
        id="notes"
        label="笔记"
        count={(detail.notes?.length ?? 0) || undefined}
        open={sections.notes}
        onToggle={() => toggle('notes')}
      >
        <NotesSection
          detail={detail}
          onUpdateNote={onUpdateNote}
          onRefresh={onRefresh}
          onNotify={onNotify}
        />
      </Section>

      <Section id="collections" label="分类" count={detail.collections?.length || undefined} open={sections.collections} onToggle={() => toggle('collections')}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
          {(detail.collections ?? []).map(entry => (
            <span className="lib-tagchip" key={entry.collectionID}>
              {entry.collectionName}
              <button
                className="lib-tag-remove"
                title="移出分类"
                onClick={() => onUpdate(detail.key, { removeCollections: [entry.collectionID] })}
              ><CloseIcon size={11} /></button>
            </span>
          ))}
          <select
            value=""
            style={{ height: 24, fontSize: 11, padding: '0 4px' }}
            onChange={(event) => {
              const id = Number(event.target.value)
              if (Number.isInteger(id)) onUpdate(detail.key, { addCollections: [id] })
            }}
          >
            <option value="">＋ 加入分类…</option>
            {(collections ?? []).map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
        </div>
      </Section>

      <Section id="tags" label="标签" count={detail.tags?.length || undefined} open={sections.tags} onToggle={() => toggle('tags')}>
        <div className="lib-tag-edit">
          {(detail.tags ?? []).map(tag => (
            <span className="lib-tagchip" key={tag.name}>
              {tag.name}
              <button className="lib-tag-remove" title="移除标签" onClick={() => removeTag(tag.name)}><CloseIcon size={11} /></button>
            </span>
          ))}
          <input
            className="lib-tag-add"
            placeholder="+ 标签"
            value={tagDraft}
            onChange={event => setTagDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addTag()
              if (event.key === 'Escape') setTagDraft('')
            }}
          />
        </div>
      </Section>

      <div className="lib-form-hint" style={{ marginTop: 10, marginBottom: 14 }}>
        加入日期 {formatDate(detail.dateAdded)} · 版本 {detail.version}
      </div>
    </div>
  )
}
