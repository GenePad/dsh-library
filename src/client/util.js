import * as React from 'react'

// Small helpers shared by the library UI.

export function classNames(...values) {
  return values.filter(Boolean).join(' ')
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

export const ITEM_TYPE_LABELS = {
  annotation: '批注',
  artwork: '艺术品',
  attachment: '附件',
  audioRecording: '录音',
  bill: '法案',
  blogPost: '博客文章',
  book: '图书',
  bookSection: '图书章节',
  case: '案例',
  computerProgram: '软件',
  conferencePaper: '会议论文',
  dataset: '数据集',
  dictionaryEntry: '词典条目',
  document: '文档',
  email: '邮件',
  encyclopediaArticle: '百科条目',
  film: '电影',
  forumPost: '论坛帖子',
  hearing: '听证会',
  instantMessage: '即时消息',
  interview: '访谈',
  journalArticle: '期刊论文',
  letter: '信件',
  magazineArticle: '杂志文章',
  manuscript: '手稿',
  map: '地图',
  newspaperArticle: '报纸文章',
  note: '笔记',
  patent: '专利',
  podcast: '播客',
  preprint: '预印本',
  presentation: '演示',
  radioBroadcast: '广播',
  report: '报告',
  standard: '标准',
  statute: '法规',
  thesis: '学位论文',
  tvBroadcast: '电视节目',
  videoRecording: '视频',
  webpage: '网页',
}

export const FIELD_LABELS = {
  title: '标题',
  abstractNote: '摘要',
  date: '日期',
  publicationTitle: '期刊/出版物',
  journalAbbreviation: '期刊缩写',
  volume: '卷',
  issue: '期',
  pages: '页码',
  DOI: 'DOI',
  URL: '网址',
  url: '网址',
  ISBN: 'ISBN',
  ISSN: 'ISSN',
  publisher: '出版社',
  place: '出版地',
  edition: '版次',
  language: '语言',
  shortTitle: '短标题',
  extra: '备注',
  libraryCatalog: '来源目录',
  accessDate: '访问日期',
  rights: '版权',
  numPages: '页数',
  conferenceName: '会议名称',
  university: '大学',
  thesisType: '学位类型',
  reportType: '报告类型',
  repository: '仓库',
  archiveID: '存档编号',
  series: '系列',
  seriesTitle: '系列标题',
  editionNumber: '版次',
  subject: '主题',
  type: '类型',
  number: '编号',
  versionNumber: '版本',
  programTitle: '节目',
  network: '网络',
  studio: '工作室',
  label: '标签',
  distributor: '发行',
  genre: '体裁',
  medium: '媒介',
  websiteTitle: '网站',
  blogTitle: '博客',
  forumTitle: '论坛',
  postType: '帖子类型',
  website: '网站',
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
      if (element.closest('.dsh-library-root')) continue
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
