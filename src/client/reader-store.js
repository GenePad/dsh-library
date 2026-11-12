// 阅读器标签与阅读进度的持久化：从文库切回 dsh 对话再切回来（面板卸载重挂）、
// 乃至重启 dsh 之后，打开过的 PDF 标签与每篇的阅读位置（页码/缩放/旋转/分屏）
// 都要还原，不能一走就全丢。
//
// 两层存储：
// - 模块级热缓存（hotTabs）：同一次 dsh 运行内，标签连同 PDF 字节一起保住，
//   切回面板零等待、不重新下载文件；
// - localStorage：只存标签元数据与阅读进度（字节太大进不去），冷启动后按
//   附件 key 重新拉取文件；取不到（附件已删/换了文库）由页面把标签摘掉。
//
// 另有第三层：解析好的 pdf.js 文档热缓存（hotDocs）。面板卸载会把整个查看器
// 组件树拆掉，重挂时若只靠字节热缓存仍要重新解析（「正在解析」明显卡顿）——
// 查看器卸载时把解析好的文档交还这里（retainDoc），重挂时先来取（takeDoc），
// 命中就完全跳过解析。带 LRU 上限与字节指纹校验：换文件绝不复用旧解析。

const TABS_STORAGE = 'dsh-zot-library:reader-tabs'
const VIEWS_STORAGE = 'dsh-zot-library:reader-views'
const VIEW_LIMIT = 100
// 解析后的文档最多保留几份（内存换速度；面板重挂/标签重开命中即免解析）。
const DOC_CACHE_LIMIT = 3

let hotTabs = null
let hotViews = null
/** attachmentKey → { doc, fingerprint, at }；takeDoc 取出（不在缓存=使用中，不会被淘汰）。 */
let hotDocs = new Map()

function readJson(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** 恢复打开的标签（仅元数据，字节按需拉取）；同一次运行内直接给热缓存。 */
export function restoreReader() {
  if (hotTabs) return hotTabs
  const saved = readJson(TABS_STORAGE)
  const tabs = Array.isArray(saved?.tabs)
    ? saved.tabs
      .filter(tab => tab && typeof tab.key === 'string' && tab.key !== '')
      .map(tab => ({
        key: tab.key,
        parentKey: typeof tab.parentKey === 'string' ? tab.parentKey : '',
        title: typeof tab.title === 'string' && tab.title !== '' ? tab.title : 'PDF',
        bytes: undefined,
      }))
    : []
  const active = typeof saved?.active === 'string' && tabs.some(tab => tab.key === saved.active) ? saved.active : ''
  hotTabs = { tabs, active }
  return hotTabs
}

/** 每次标签变化都记一笔：热缓存保字节，localStorage 保元数据（尽力而为）。 */
export function rememberReader(reader) {
  hotTabs = reader
  try {
    localStorage.setItem(TABS_STORAGE, JSON.stringify({
      tabs: (reader?.tabs ?? []).map(({ key, parentKey, title }) => ({ key, parentKey, title })),
      active: reader?.active ?? '',
    }))
  } catch {
    // 配额满 / 隐私模式拿不到存储都不影响阅读本身。
  }
}

/** 每篇文档的阅读进度表（page/zoom/rotations/split），同一对象贯穿整个运行。 */
export function restoreViews() {
  if (hotViews) return hotViews
  const saved = readJson(VIEWS_STORAGE)
  const views = {}
  if (saved && typeof saved === 'object') {
    for (const [key, value] of Object.entries(saved)) {
      if (!key || !value || typeof value !== 'object') continue
      const page = Math.round(Number(value.page))
      if (!Number.isFinite(page) || page < 1) continue
      const zoom = value.zoom === null || value.zoom === undefined
        ? null
        : (Number.isFinite(Number(value.zoom)) ? Number(value.zoom) : null)
      const rotations = {}
      if (value.rotations && typeof value.rotations === 'object') {
        for (const [pageNumber, angle] of Object.entries(value.rotations)) {
          const turn = Number(angle)
          if (Number.isFinite(turn) && turn % 360 !== 0) rotations[pageNumber] = turn
        }
      }
      views[key] = {
        page: Math.max(1, page),
        zoom: zoom === null ? null : Math.min(5, Math.max(0.25, zoom)),
        rotations,
        split: value.split === true,
        splitRatio: Number.isFinite(Number(value.splitRatio)) ? Number(value.splitRatio) : 0.5,
      }
    }
  }
  hotViews = views
  return hotViews
}

/** ReaderPane 的视图状态落盘（带时间戳供容量淘汰），并同步进热缓存对象。 */
export function saveView(key, view) {
  const views = restoreViews()
  views[key] = { ...view, at: Date.now() }
  const keys = Object.keys(views)
  if (keys.length > VIEW_LIMIT) {
    keys.sort((a, b) => (views[a]?.at ?? 0) - (views[b]?.at ?? 0))
    for (const stale of keys.slice(0, keys.length - VIEW_LIMIT)) delete views[stale]
  }
  try {
    localStorage.setItem(VIEWS_STORAGE, JSON.stringify(views))
  } catch {
    // 进度保存是锦上添花，写不进去就算了。
  }
  return views
}

/** 字节流的廉价指纹（长度 + 抽样求和）：同一 key 的字节变了就绝不复用旧解析。 */
export function docFingerprint(bytes) {
  const source = bytes ?? null
  let sum = 0
  if (source && source.length > 0) {
    const step = Math.max(1, Math.floor(source.length / 64))
    for (let i = 0; i < source.length; i += step) sum = (sum + source[i]) % 0x7fffffff
  }
  return `${source?.length ?? 0}:${sum}`
}

/** 查看器卸载时把解析好的文档交还缓存（LRU，超限销毁最旧的一份）。 */
export function retainDoc(key, doc, bytes) {
  if (!key || !doc) return
  const existing = hotDocs.get(key)
  if (existing) {
    if (existing.doc === doc) {
      existing.at = Date.now()
      return
    }
    // 同一 key 换了新解析（旧文档还在缓存里）：旧的直接销毁。
    hotDocs.delete(key)
    try { existing.doc.destroy() } catch { /* already gone */ }
  }
  hotDocs.set(key, { doc, fingerprint: docFingerprint(bytes), at: Date.now() })
  while (hotDocs.size > DOC_CACHE_LIMIT) {
    let oldestKey = null
    let oldest = Infinity
    for (const [entryKey, entry] of hotDocs) {
      if (entry.at < oldest) {
        oldest = entry.at
        oldestKey = entryKey
      }
    }
    if (!oldestKey) break
    const stale = hotDocs.get(oldestKey)
    hotDocs.delete(oldestKey)
    try { stale.doc.destroy() } catch { /* already gone */ }
  }
}

/** 查看器挂载时取出缓存的解析（检出后不在缓存中，使用期间不可能被淘汰）。 */
export function takeDoc(key, bytes) {
  const entry = hotDocs.get(key)
  if (!entry) return null
  hotDocs.delete(key)
  if (entry.fingerprint !== docFingerprint(bytes)) {
    // 字节变过（附件文件被替换 / 换了文库）：旧解析作废。
    try { entry.doc.destroy() } catch { /* already gone */ }
    return null
  }
  return entry.doc
}
