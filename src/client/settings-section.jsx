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
  }
}

/** The 文库 settings section: tabbed rows inside the native settings panel. */
export function LibrarySettingsSection() {
  const [tab, setTab] = React.useState('source')
  const [snapshot, setSnapshot] = React.useState(undefined)
  const [form, setForm] = React.useState(restoreForm(undefined))
  const [busy, setBusy] = React.useState('')
  const [message, setMessage] = React.useState('')

  const load = React.useCallback(async () => {
    try {
      const state = await api.call('state', {})
      setSnapshot(state)
      setForm(restoreForm(state.settings))
    } catch (error) {
      setMessage(error?.message ?? String(error))
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
              <div className="lib-settings-label">导出（也是未来 Word / LibreOffice 插件的接口）</div>
              <div className="lib-settings-actions">
                <Button variant="outline" size="sm" disabled={busy !== ''} onClick={() => exportLibrary('csl-json')}>{busy === 'export-csl-json' ? '导出中…' : '导出 CSL JSON'}</Button>
                <Button variant="outline" size="sm" disabled={busy !== ''} onClick={() => exportLibrary('bibtex')}>{busy === 'export-bibtex' ? '导出中…' : '导出 BibTeX'}</Button>
              </div>
              <div className="lib-settings-hint">CSL JSON 可直接被 Zotero「导入…」读取。</div>
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
              <Input value={form.updateFeed} placeholder="https://…/feed/manifest.json（留空关闭在线更新）" onChange={set('updateFeed')} />
              <div className="lib-settings-actions">
                <Button variant="outline" size="sm" disabled={busy !== ''} onClick={checkUpdate}>{busy === 'update' ? '检查中…' : '检查更新'}</Button>
                <Button variant="outline" size="sm" disabled={busy !== ''} onClick={applyUpdate}>{busy === 'apply' ? '安装中…' : '安装更新'}</Button>
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
