import * as React from 'react'
import { ITEM_TYPE_LABELS, FIELD_LABELS, CREATOR_TYPE_LABELS, PANE_LABELS } from './labels.js'

// Small helpers shared by the library UI.

export { ITEM_TYPE_LABELS, FIELD_LABELS, CREATOR_TYPE_LABELS, PANE_LABELS }

export function classNames(...values) {
  return values.filter(Boolean).join(' ')
}

/** Dotted version compare: -1 / 0 / 1. Numeric segments compare numerically. */
export function compareVersions(left, right) {
  const a = String(left ?? '').split(/[.+-]/)
  const b = String(right ?? '').split(/[.+-]/)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = /^\d+$/.test(a[index] ?? '') ? Number(a[index]) : (a[index] ?? 0)
    const y = /^\d+$/.test(b[index] ?? '') ? Number(b[index]) : (b[index] ?? 0)
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}

/** Format a Zotero SQL datetime ("2025-02-25 06:34:32", UTC) for display. */
export function formatDateTime(value) {
  if (!value) return ''
  const parsed = new Date(String(value).replace(' ', 'T') + 'Z')
  if (Number.isNaN(parsed.getTime())) return String(value)
  return parsed.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function formatDate(value) {
  if (!value) return ''
  const match = /^(\d{4})(?:-(\d{2}))?/.exec(String(value))
  if (match) return match[2] && match[2] !== '00' ? `${match[1]}-${match[2]}` : match[1]
  return String(value)
}

export const ANNOTATION_TYPE_LABELS = {
  1: '高亮',
  2: '笔记',
  3: '图片',
  4: '墨迹',
  5: '下划线',
  6: '文本',
}

export function itemTypeLabel(name) {
  return ITEM_TYPE_LABELS[name] ?? name
}

export function fieldLabel(name) {
  return FIELD_LABELS[name] ?? name
}

export function creatorTypeLabel(name) {
  return CREATOR_TYPE_LABELS[name] ?? name
}

/** Parse one author line: "Last, First" or "First Last" (the create forms). */
export function parseCreatorLine(line) {
  const text = line.trim()
  if (text === '') return undefined
  if (text.includes(',')) {
    const [lastName, ...rest] = text.split(',')
    return { lastName: lastName.trim(), firstName: rest.join(',').trim(), creatorType: 'author' }
  }
  const parts = text.split(/\s+/)
  if (parts.length === 1) return { fieldMode: 1, lastName: text, creatorType: 'author' }
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1), creatorType: 'author' }
}

/**
 * Debounce a value by a delay. The FIRST value change applies immediately: a
 * fresh mount must not sit out the delay on its initial measurement (the
 * reader would lay out — and render page 1 — at the fallback size and then
 * re-render at the real one); every later change settles first.
 */
export function useDebounced(value, delay) {
  const [debounced, setDebounced] = React.useState(value)
  const leading = React.useRef(true)
  React.useEffect(() => {
    if (leading.current && !Object.is(value, debounced)) {
      leading.current = false
      setDebounced(value)
      return undefined
    }
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/**
 * True while the dsh dark theme is active. The theme presenter marks
 * `body[data-ds-dark-theme]`; observing it lets our own fallback palette stay
 * correct even when some `--dsw-alias-*` tokens are missing.
 */
export function useDarkMode() {
  const [dark, setDark] = React.useState(() => Boolean(typeof document !== 'undefined' && document.body?.hasAttribute?.('data-ds-dark-theme')))
  React.useEffect(() => {
    const body = document.body
    if (!body || typeof MutationObserver !== 'function') return undefined
    const observer = new MutationObserver(() => setDark(body.hasAttribute('data-ds-dark-theme')))
    observer.observe(body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

/** Save generated text (an export) as a downloaded file. */
export function downloadText(name, text, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** Subscribe to a dsh client observable source. */
export function useSource(source) {
  return React.useSyncExternalStore(
    source ? listener => source.subscribe(listener) : () => () => {},
    source ? () => source.getSnapshot() : () => undefined,
  )
}

/** Read a File as base64 without its data URL prefix. */
export function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma === -1 ? result : result.slice(comma + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/** Extract a local path from a dropped file when the desktop shell exposes one. */
export function filePathOf(file) {
  if (typeof file?.path === 'string' && file.path !== '') return file.path
  return ''
}

/**
 * Best-effort probe for the dsh app sidebar (the conversation list column to
 * the left of the main area). dsh exposes `layout.toggleSidebar()` but no
 * readable "is it open" flag, so we look for a visible left rail: a wide
 * (>= 140px), tall (>= 45% viewport) element hugging the window's left edge
 * that is not our own library page. When nothing matches we assume the
 * sidebar is open — that is dsh's default state.
 */
export function probeSidebarOpen() {
  try {
    const viewportWidth = window.innerWidth || 1200
    const viewportHeight = window.innerHeight || 800
    for (const element of document.body.querySelectorAll('aside, nav, [class*="sidebar"], [class*="Sidebar"]')) {
      if (element.closest('.dsh-zot-library-root')) continue
      const style = window.getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue
      const rect = element.getBoundingClientRect()
      if (rect.width < 140 || rect.height < viewportHeight * 0.45) continue
      if (rect.left > 24) continue
      if (rect.width > viewportWidth * 0.55) continue
      return true
    }
    return false
  } catch {
    return true
  }
}
