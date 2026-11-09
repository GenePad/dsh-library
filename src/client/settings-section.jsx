// The 文库 page inside dsh's NATIVE settings modal (settings.section seat):
// the shell owns the panel chrome and navigation; this page only draws its own
// rows, styled with the host's --dsw-* tokens and built from dsh primitives.
// The old hand-drawn 文库设置 dialog was replaced by this page.
import * as React from 'react'
import * as api from './api.js'
import { Button, Input, SegmentedControl, SegmentedTabs, Switch } from './platform.jsx'
import { downloadText } from './util.js'

// The library page listens for this so "打开 PDF 的方式" applies without a reload.
export const SETTINGS_SAVED_EVENT = 'dsh-library:settings-saved'

const TABS = [
  { value: 'source', label: '数据来源', id: 'lib-set-tab-source', panelId: 'lib-set-panel-source' },
  { value: 'pdf', label: 'PDF 与导出', id: 'lib-set-tab-pdf', panelId: 'lib-set-panel-pdf' },
  { value: 'office', label: '写作插件', id: 'lib-set-tab-office', panelId: 'lib-set-panel-office' },
  { value: 'translate', label: 'AI 翻译', id: 'lib-set-tab-translate', panelId: 'lib-set-panel-translate' },
  { value: 'webdav', label: 'WebDAV 同步', id: 'lib-set-tab-webdav', panelId: 'lib-set-panel-webdav' },
  { value: 'misc', label: '更新', id: 'lib-set-tab-misc', panelId: 'lib-set-panel-misc' },
]

function restoreForm(settings) {
  return {
    zoteroDataDir: settings?.zoteroDataDir ?? '',
    url: settings?.webdav?.url ?? '',
    username: settings?.webdav?.username ?? '',
    password: '',
    autoSync: settings?.autoSync === true,
    updateFeed: settings?.updateFeed ?? '',
    // Older settings may still hold the removed 'dsh' value; it means builtin.
    pdfOpen: settings?.pdfOpen === 'native' ? 'native' : 'builtin',
    translateThinking: settings?.translate?.thinking === true,
    translateAuto: settings?.translate?.auto === true,
    translateModelSource: settings?.translate?.modelSource === 'fixed' ? 'fixed' : 'follow',
    translateModel: typeof settings?.translate?.model === 'string' ? settings.translate.model : '',
  }
}

/** The 文库 settings section: tabbed rows inside the native settings panel. */
export function LibrarySettingsSection() {
  const [tab, setTab] = React.useState('source')
  const [snapshot, setSnapshot] = React.useState(undefined)
  const [form, setForm] = React.useState(restoreForm(undefined))
  const [busy, setBusy] = React.useState('')
  const [message, setMessage] = React.useState('')
  // dsh 已配置的模型（供「指定模型」下拉选择），随设置页一起加载。
  const [models, setModels] = React.useState([])
  const [currentModel, setCurrentModel] = React.useState(null)
  // Microsoft Word 引文插件：服务 / 安装 / 样式管理。
  const [office, setOffice] = React.useState(undefined)
  const [styleQuery, setStyleQuery] = React.useState('')
  const [styleResults, setStyleResults] = React.useState([])
  const [installedStyles, setInstalledStyles] = React.useState([])

  const load = React.useCallback(async () => {
    try {
      const state = await api.call('state', {})
      setSnapshot(state)
      setForm(restoreForm(state.settings))
    } catch (error) {
      setMessage(error?.message ?? String(error))
    }
    try {
      const listed = await api.call('translate-models', {})
      setModels(Array.isArray(listed?.models) ? listed.models : [])
      setCurrentModel(listed?.current ?? null)
    } catch {
      setModels([]) // 旧宿主没有该端点时隐藏指定模型下拉即可
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const set = key => event => setForm(previous => ({ ...previous, [key]: event.target.value }))

  const save = async () => {
    setBusy('save')
    setMessage('')
    try {
      const webdav = { url: form.url, username: form.username }
      // An empty password field keeps the stored password; type a new one to replace it.
      if (form.password !== '') webdav.password = form.password
      const saved = await api.call('settings-set', {
        patch: {
          zoteroDataDir: form.zoteroDataDir,
          webdav,
          autoSync: form.autoSync,
          updateFeed: form.updateFeed,
          pdfOpen: form.pdfOpen,
          translate: {
            thinking: form.translateThinking,
            auto: form.translateAuto,
            modelSource: form.translateModelSource,
            model: form.translateModel,
          },
        },
      })
      window.dispatchEvent(new CustomEvent(SETTINGS_SAVED_EVENT, { detail: saved }))
      setSnapshot(previous => ({ ...previous, settings: saved }))
      setMessage('已保存')
    } catch (error) {
      setMessage(error?.message ?? String(error))
    } finally {
      setBusy('')
    }
  }

  const verify = async () => {
    setBusy('verify')
    setMessage('')
    try {
      const result = await api.call('sync-verify', {})
      setMessage(`WebDAV 连接正常：${result.url}`)
    } catch (error) {
      setMessage(error?.message ?? String(error))
    } finally {
      setBusy('')
    }
  }

  const runSync = async () => {
    setBusy('sync')
    setMessage('')
    try {
      const result = await api.call('sync-run', {})
      setMessage(`同步完成：上传 ${result.uploaded}，下载 ${result.downloaded}，冲突 ${result.conflicts}，失败 ${result.failed}`)
    } catch (error) {
      setMessage(error?.message ?? String(error))
    } finally {
      setBusy('')
    }
  }

  const checkUpdate = async () => {
    setBusy('update')
    setMessage('')
    try {
      const status = await api.call('update-check', {})
      setMessage(status.available
        ? `发现新版本 ${status.latest}（当前 ${status.current}）。`
        : status.feed === false ? '未配置更新源。' : `已是最新版本（${status.current}）。`)
    } catch (error) {
      setMessage(error?.message ?? String(error))
    } finally {
      setBusy('')
    }
  }

  const applyUpdate = async () => {
    setBusy('apply')
    setMessage('')
    try {
      const result = await api.call('update-apply', {})
      setMessage(result.applied ? `已安装 ${result.lastApplied?.version}，重启 dsh 后生效。` : '没有可安装的更新。')
    } catch (error) {
      setMessage(error?.message ?? String(error))
    } finally {
      setBusy('')
    }
  }

  const switchSource = async (mode) => {
    setBusy(`setup-${mode}`)
    setMessage('')
    try {
      await api.call('setup', { mode })
      await load()
      setMessage(mode === 'standalone' ? '已切换到独立文库。' : '已切换为关联 Zotero（未找到时会提示）。')
    } catch (error) {
      setMessage(error?.message ?? String(error))
    } finally {
      setBusy('')
    }
  }

  const exportLibrary = async (format) => {
    setBusy(`export-${format}`)
    setMessage('')
    try {
      const stamp = new Date().toISOString().slice(0, 10)
      if (format === 'bibtex') {
        const result = await api.call('cite-bibtex', { limit: 500 })
        downloadText(`dsh-library-${stamp}.bib`, result.text, 'application/x-bibtex;charset=utf-8')
        setMessage('已导出 BibTeX。')
      } else {
        const result = await api.call('cite-json', { limit: 500 })
        downloadText(`dsh-library-${stamp}.json`, JSON.stringify(result.items, null, 2), 'application/json;charset=utf-8')
        setMessage(`已导出 ${result.items.length} 条 CSL-JSON 记录。`)
      }
    } catch (error) {
      setMessage(error?.message ?? String(error))
    } finally {
      setBusy('')
    }
  }

  const loadOffice = React.useCallback(async (fresh = false) => {
    try {
      const result = await api.call('office-status', { fresh })
      setOffice(result)
    } catch {
      setOffice(undefined)
    }
  }, [])
  React.useEffect(() => {
    if (tab !== 'office') return
    void loadOffice()
    void api.call('cite-styles-list', {}).then(list => setInstalledStyles(Array.isArray(list) ? list : [])).catch(() => {})
  }, [tab, loadOffice])

  const wordInstall = async (uninstall) => {
    setBusy('office-word')
    setMessage('')
    try {
      const result = await api.call(uninstall ? 'office-uninstall' : 'office-install', {})
      await loadOffice(true)
      if (uninstall) {
        setMessage('已移除 Word 引文插件，重启 Word 后生效。')
      } else {
        const where = Array.isArray(result?.paths) ? ` 安装位置：${result.paths.join('、')}` : ''
        setMessage(`${result?.note ?? '安装完成。'}${where}`)
      }
    } catch (error) {
      setMessage(error?.message ?? String(error))
    } finally {
      setBusy('')
    }
  }

  const officeRestart = async () => {
    setBusy('office-restart')
    setMessage('')
    try {
      await api.call('office-server-restart', {})
      await loadOffice(true)
      setMessage('写作插件服务已重启。')
    } catch (error) {
      setMessage(error?.message ?? String(error))
    } finally {
      setBusy('')
    }
  }

  const styleSearch = async () => {
    setBusy('style-search')
    try {
      const list = await api.call('cite-styles-search', { query: styleQuery })
      setStyleResults(Array.isArray(list) ? list : [])
    } catch (error) {
      setMessage(error?.message ?? String(error))
    } finally {
      setBusy('')
    }
  }

  const styleInstall = async (styleID) => {
    setBusy(`style-${styleID}`)
    try {
      await api.call('cite-styles-install', { styleID })
      const list = await api.call('cite-styles-list', {})
      setInstalledStyles(Array.isArray(list) ? list : [])
      setMessage('样式已安装，可在 Word 的「文档首选项」中选用。')
    } catch (error) {
      setMessage(error?.message ?? String(error))
    } finally {
      setBusy('')
    }
  }

  const openPendingDialogs = async () => {
    try {
      const result = await api.call('office-dialog-open', {})
      setMessage(result?.opened ? '已在独立小窗口中重新打开待处理的引文对话框。' : '当前没有待处理的对话框。')
    } catch (error) {
      setMessage(error?.message ?? String(error))
    }
  }

  const openStartupFolder = async () => {
    try {
      await api.call('office-open-folder', {})
    } catch (error) {
      setMessage(error?.message ?? String(error))
    }
  }

  const sourceLabel = snapshot?.source === 'standalone'
    ? `独立文库（${snapshot.dataDir}）`
    : snapshot?.available ? `Zotero（${snapshot.dataDir}）` : '未连接'

  return (
    <div className="lib-settings">
      <SegmentedTabs items={TABS} value={tab} onChange={setTab} label="文库设置分区" size="sm" />
      <div className="lib-settings-body">
        {tab === 'source' ? (
          <div id="lib-set-panel-source" role="tabpanel" aria-labelledby="lib-set-tab-source">
            <div className="lib-settings-row">
              <div className="lib-settings-label">当前数据来源</div>
              <div className="lib-settings-value">{sourceLabel}</div>
              <div className="lib-settings-actions">
                <Button variant="outline" size="sm" disabled={busy !== '' || snapshot?.source === 'zotero'} onClick={() => switchSource('zotero')}>关联 Zotero</Button>
                <Button variant="outline" size="sm" disabled={busy !== '' || snapshot?.source === 'standalone'} onClick={() => switchSource('standalone')}>改用独立文库</Button>
              </div>
              <div className="lib-settings-hint">
                独立文库按 Zotero 规范存放在 dsh 数据目录，可随时用「PDF 与导出」页的导出迁移到 Zotero。
              </div>
            </div>
            <div className="lib-settings-row">
              <div className="lib-settings-label">Zotero 数据目录</div>
              <Input value={form.zoteroDataDir} placeholder="留空自动检测（包含 zotero.sqlite 的文件夹）" onChange={set('zoteroDataDir')} />
              <div className="lib-settings-hint">
                {snapshot?.available ? snapshot.dataDir : (snapshot?.error?.message ?? '未检测到')}
              </div>
            </div>
          </div>
        ) : null}

        {tab === 'pdf' ? (
          <div id="lib-set-panel-pdf" role="tabpanel" aria-labelledby="lib-set-tab-pdf">
            <div className="lib-settings-row">
              <div className="lib-settings-label">打开 PDF 的方式（双击条目或点「打开 PDF」）</div>
              <SegmentedControl
                id="lib-set-pdfopen"
                label="打开 PDF 的方式"
                options={[
                  { value: 'builtin', label: 'dsh 内建查看器' },
                  { value: 'native', label: '系统 PDF 阅读器' },
                ]}
                value={form.pdfOpen}
                onChange={value => setForm(previous => ({ ...previous, pdfOpen: value }))}
              />
              <div className="lib-settings-hint">
                内建查看器在文库内开标签页（pdf.js 渲染），支持选择文本、高亮/下划线/批注、旋转与全文查找。
              </div>
            </div>
            <div className="lib-settings-row">
              <div className="lib-settings-label">导出</div>
              <div className="lib-settings-actions">
                <Button variant="outline" size="sm" disabled={busy !== ''} onClick={() => exportLibrary('csl-json')}>{busy === 'export-csl-json' ? '导出中…' : '导出 CSL JSON'}</Button>
                <Button variant="outline" size="sm" disabled={busy !== ''} onClick={() => exportLibrary('bibtex')}>{busy === 'export-bibtex' ? '导出中…' : '导出 BibTeX'}</Button>
              </div>
              <div className="lib-settings-hint">CSL JSON 可直接被 Zotero「导入…」读取。</div>
            </div>
          </div>
        ) : null}

        {tab === 'office' ? (
          <div id="lib-set-panel-office" role="tabpanel" aria-labelledby="lib-set-tab-office">
            <div className="lib-settings-row">
              <div className="lib-settings-label">Word 引文集成服务</div>
              <div className="lib-settings-value">
                {office === undefined ? '（加载中…）'
                  : office.server?.running ? `运行中（127.0.0.1:${office.server.port}）` : `未运行${office.server?.error ? `：${office.server.error}` : ''}`}
              </div>
              <div className="lib-settings-actions">
                <Button variant="outline" size="sm" disabled={busy !== ''} onClick={officeRestart}>重启服务</Button>
                <Button variant="outline" size="sm" disabled={busy !== ''} onClick={openPendingDialogs}>打开待处理对话框</Button>
              </div>
              <div className="lib-settings-hint">
                完整移植 Zotero 的文字处理集成：引文对话框（文献列表按关键词检索 / 文献库按分类浏览）、参考文献表、文档首选项、刷新、移除域代码、引注浏览器。
                引文对话框在独立的无地址栏小窗口中打开（不是浏览器标签页），确定/取消后自动关闭。以 Zotero 兼容的本地 HTTP 协议与 Word 通信，域代码可与 Zotero 文档互通。
              </div>
            </div>
            <div className="lib-settings-row">
              <div className="lib-settings-label">Microsoft Word</div>
              <div className="lib-settings-value">
                {office?.install === undefined ? '（加载中…）'
                  : !office.install.installed
                    ? (office.install.available ? '未安装' : `未检测到 Word${office.install.reason ? `（${office.install.reason}）` : ''}`)
                    : office.install.valid === false ? '已安装，但模板损坏（功能区不会出现）'
                      : `已安装「文库引用」加载项（${office.install.modules?.length ?? 0} 个宏模块${office.install.size ? ` · ${Math.round(office.install.size / 1024)} KB` : ''}）`}
              </div>
              <div className="lib-settings-actions">
                {office?.install?.installed ? (
                  <Button variant="outline" size="sm" disabled={busy !== ''} onClick={() => wordInstall(true)}>
                    {busy === 'office-word' ? '卸载中…' : '卸载插件'}
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" disabled={busy !== '' || office?.install?.available === false} onClick={() => wordInstall(false)}>
                    {busy === 'office-word' ? '安装中…' : '安装 Word 引文插件'}
                  </Button>
                )}
                <Button variant="outline" size="sm" disabled={busy !== ''} onClick={openStartupFolder}>打开启动文件夹</Button>
              </div>
              <div className="lib-settings-hint">
                {office?.install?.valid === false
                  ? `模板自检未通过：${(office.install.problems ?? []).join('；')}。请点「卸载插件」后重新「安装 Word 引文插件」。`
                  : office?.install?.wordRunning
                    ? '检测到 Word 正在运行：必须完全退出 Word（含后台进程）再打开，启动目录里的插件才会被加载。'
                    : '安装后启动 Word 即出现「文库引用」选项卡；插入/编辑引注会在默认浏览器打开引注对话框。'}
              </div>
            </div>
            <div className="lib-settings-row">
              <div className="lib-settings-label">引用样式（已安装 {installedStyles.length} 个）</div>
              <div className="lib-settings-actions">
                <Input value={styleQuery} onChange={event => setStyleQuery(event.target.value)} placeholder="检索 Zotero 样式库" />
                <Button variant="outline" size="sm" disabled={busy !== ''} onClick={styleSearch}>
                  {busy === 'style-search' ? '检索中…' : '在线检索'}
                </Button>
              </div>
              <div className="lib-settings-hint">
                文档内切换样式请用 Word 功能区的「文档首选项」；这里用于预先安装样式。
              </div>
            </div>
            {styleResults.length ? (
              <div className="lib-settings-row">
                <div className="lib-settings-label">在线样式</div>
                <div className="lib-settings-value">
                  {styleResults.slice(0, 8).map(style => (
                    <div key={style.styleID} className="lib-settings-value" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ flex: 1 }}>{style.title}</span>
                      {style.installed ? <span className="lib-settings-hint">已安装</span> : (
                        <Button variant="outline" size="sm" disabled={busy !== ''} onClick={() => styleInstall(style.styleID)}>安装</Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === 'translate' ? (
          <div id="lib-set-panel-translate" role="tabpanel" aria-labelledby="lib-set-tab-translate">
            <div className="lib-settings-row">
              <div className="lib-settings-label">阅读器「译」按钮</div>
              <div className="lib-settings-hint">
                在内建 PDF 查看器里选中文字后，浮窗会对选中内容做一次临时翻译：
                流式输出到浮窗内颜色行下方，可直接「添加到备注」成为批注。翻译不进入文献助手对话。
              </div>
            </div>
            <div className="lib-settings-row">
              <div className="lib-settings-label">划词后自动翻译</div>
              <Switch
                checked={form.translateAuto}
                label={form.translateAuto ? '开启（选中文本即开始翻译）' : '关闭（点浮窗里的「译」才开始）'}
                onChange={checked => setForm(previous => ({ ...previous, translateAuto: checked }))}
              />
            </div>
            <div className="lib-settings-row">
              <div className="lib-settings-label">翻译时开启思考</div>
              <Switch
                checked={form.translateThinking}
                label={form.translateThinking ? '开启（思考内容折叠显示）' : '关闭（更快出结果）'}
                onChange={checked => setForm(previous => ({ ...previous, translateThinking: checked }))}
              />
            </div>
            <div className="lib-settings-row">
              <div className="lib-settings-label">翻译使用的模型</div>
              <SegmentedControl
                id="lib-set-translate-model"
                label="翻译使用的模型"
                options={[
                  { value: 'follow', label: '跟随 dsh 当前模型' },
                  { value: 'fixed', label: '指定模型' },
                ]}
                value={form.translateModelSource}
                onChange={value => setForm(previous => ({ ...previous, translateModelSource: value }))}
              />
              {form.translateModelSource === 'follow' && currentModel ? (
                <div className="lib-settings-hint">
                  当前 dsh 模型：
                  {models.find(model => model.provider === currentModel.provider && model.model === currentModel.model)?.name
                    ?? `${currentModel.provider}/${currentModel.model}`}
                </div>
              ) : null}
              {form.translateModelSource === 'fixed' ? (
                <select
                  className="lib-settings-select"
                  value={form.translateModel}
                  onChange={event => setForm(previous => ({ ...previous, translateModel: event.target.value }))}
                >
                  <option value="">{models.length === 0 ? '（暂未读到可用模型）' : '选择模型…'}</option>
                  {models.map(model => (
                    <option key={model.id} value={model.id}>{model.name ?? model.id}</option>
                  ))}
                </select>
              ) : null}
            </div>
          </div>
        ) : null}

        {tab === 'webdav' ? (
          <div id="lib-set-panel-webdav" role="tabpanel" aria-labelledby="lib-set-tab-webdav">
            <div className="lib-settings-row">
              <div className="lib-settings-label">WebDAV 服务器地址</div>
              <Input value={form.url} placeholder="https://dav.example.com/remote.php/dav/files/me" onChange={set('url')} />
            </div>
            <div className="lib-settings-grid">
              <div className="lib-settings-row">
                <div className="lib-settings-label">用户名</div>
                <Input value={form.username} onChange={set('username')} autoComplete="off" />
              </div>
              <div className="lib-settings-row">
                <div className="lib-settings-label">密码</div>
                <Input
                  type="password"
                  value={form.password}
                  placeholder={snapshot?.settings?.webdav?.hasPassword ? '已保存（留空不修改）' : ''}
                  onChange={set('password')}
                  autoComplete="new-password"
                />
              </div>
            </div>
            <div className="lib-settings-row">
              <div className="lib-settings-hint">
                与 Zotero 客户端使用同一套 WebDAV 文件同步协议：服务器上需存在 zotero 文件夹；凭证仅保存在本机 dsh 数据目录。
              </div>
              <div className="lib-settings-actions">
                <Button variant="outline" size="sm" disabled={busy !== ''} onClick={verify}>{busy === 'verify' ? '验证中…' : '验证连接'}</Button>
                <Button variant="outline" size="sm" disabled={busy !== ''} onClick={runSync}>{busy === 'sync' ? '同步中…' : '立即同步'}</Button>
                <Switch
                  checked={form.autoSync}
                  label="每 30 分钟自动同步"
                  onChange={checked => setForm(previous => ({ ...previous, autoSync: checked }))}
                />
              </div>
            </div>
          </div>
        ) : null}

        {tab === 'misc' ? (
          <div id="lib-set-panel-misc" role="tabpanel" aria-labelledby="lib-set-tab-misc">
            <div className="lib-settings-row">
              <div className="lib-settings-label">插件更新源（manifest.json 地址）</div>
              <Input value={form.updateFeed} placeholder="https://…/feed/manifest.json（留空使用官方源）" onChange={set('updateFeed')} />
              <div className="lib-settings-actions">
                <Button variant="outline" size="sm" disabled={busy !== ''} onClick={checkUpdate}>{busy === 'update' ? '检查中…' : '检查更新'}</Button>
                <Button variant="outline" size="sm" disabled={busy !== ''} onClick={applyUpdate}>{busy === 'apply' ? '安装中…' : '安装更新'}</Button>
              </div>
              <div className="lib-settings-hint">
                留空使用官方源（GitHub GenePad/dsh-library 的 feed/manifest.json）；填写 off 关闭在线更新。
              </div>
            </div>
          </div>
        ) : null}
      </div>
      <div className="lib-settings-foot">
        <span className="lib-settings-message">{message}</span>
        <Button variant="primary" size="sm" disabled={busy !== ''} onClick={save}>{busy === 'save' ? '保存中…' : '保存'}</Button>
      </div>
    </div>
  )
}
