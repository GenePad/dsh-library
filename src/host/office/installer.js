// Microsoft Word plugin installer.
//
// Zotero's own installer is deliberately boring: it ships a prebuilt
// Zotero.dotm and COPIES it into every Word STARTUP folder it can find. No COM,
// no macro import, no registry writes. We follow that model as closely as
// possible:
//
//   1. a prebuilt template shipped with the plugin (assets/word/DshLibrary.dotm)
//      or a previously built, verified cache is copied verbatim;
//   2. only when neither exists do we build a template locally through Word COM
//      (import the .bas modules, save as .dotm, inject customUI);
//   3. EVERY candidate template is unpacked and verified to actually contain a
//      VBA project with our four modules before it is installed. A template
//      without vbaProject.bin produces a Ribbon whose callbacks point at
//      macros that do not exist -- Word then hides the tab entirely.
//
// The last check is what makes "one click and it is installed" trustworthy: the
// installer can no longer report success for an empty shell.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { zipSync, unzipSync } from '../../../vendor/deps.js'
import { openExternal } from '../open.js'

const run = promisify(execFile)
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const TEMPLATE_NAME = 'DshLibrary.dotm'
const LEGACY_TEMPLATE_NAME = 'dsh-library.dotm'
const CUSTOMUI_PART = 'customUI/customUI.xml'
const CUSTOMUI_REL_TYPE = 'http://schemas.microsoft.com/office/2006/relationships/ui/extensibility'
const VBA_REL_TYPE = 'http://schemas.microsoft.com/office/2006/relationships/vbaProject'
const IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
const CUSTOMUI_RELS_PART = 'customUI/_rels/customUI.xml.rels'
/** Image ids referenced by customUI.xml. Zotero's template uses the same scheme. */
export function ribbonImageIds(customUI) {
  return [...new Set([...String(customUI).matchAll(/\bimage="([^"]+)"/g)].map(match => match[1]))]
}
// DshLib* prefix is mandatory: the official Zotero.dotm (often present in
// the same STARTUP folder) defines modules/macros named Zotero, ZoteroRibbon,
// ZoteroCommand, ZoteroTabLabel, ... Sharing those names makes Word resolve
// Ribbon callbacks to the wrong template and report a broken add-in.
const REQUIRED_MODULES = ['DshLibJson', 'DshLibCore', 'DshLibFields', 'DshLibRibbon']

function decodeOutput(buffer) {
  if (!buffer) return ''
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer))
  try {
    return new TextDecoder('gbk').decode(bytes)
  } catch {
    return bytes.toString('utf8')
  }
}

async function runProcess(command, args, options = {}) {
  try {
    const { stdout, stderr } = await run(command, args, {
      windowsHide: true, timeout: 180_000, encoding: 'buffer',
      env: { ...process.env, ...(options.env ?? {}) },
    })
    return { ok: true, stdout: decodeOutput(stdout), stderr: decodeOutput(stderr) }
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message ?? error),
      stdout: decodeOutput(error?.stdout),
      stderr: decodeOutput(error?.stderr),
    }
  }
}

/** Run a PowerShell script without tripping command-line quoting or the codepage. */
async function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return runProcess('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-OutputFormat', 'Text', '-EncodedCommand', encoded])
}

/**
 * One PowerShell round-trip reads every Word version's STARTUP override and
 * AccessVBOM value. Zotero uses the native registry API for the same reason:
 * it works even where spawning reg.exe is not permitted.
 */
async function registrySnapshot() {
  const script = `$ErrorActionPreference = 'SilentlyContinue'
$out = @{ startup = @(); vbom = @{} }
foreach ($v in 9..20) {
  $base = 'HKCU:\\Software\\Microsoft\\Office\\' + $v + '.0'
  $opts = Get-ItemProperty -Path ($base + '\\Word\\Options')
  if ($opts -and $opts.'STARTUP-PATH') { $out.startup += [string]$opts.'STARTUP-PATH' }
  $general = Get-ItemProperty -Path ($base + '\\Common\\General')
  if ($general -and $general.Startup) { $out.startup += [string]$general.Startup }
  $sec = Get-ItemProperty -Path ($base + '\\Word\\Security')
  if ($sec -and $null -ne $sec.AccessVBOM) { $out.vbom[[string]$v] = [int]$sec.AccessVBOM }
}
$out | ConvertTo-Json -Compress
`
  const result = await runPowerShell(script)
  if (!result.ok) return { startup: [], vbom: {} }
  try {
    const parsed = JSON.parse(result.stdout.trim())
    return {
      startup: Array.isArray(parsed?.startup) ? parsed.startup.filter(Boolean) : [],
      vbom: parsed?.vbom && typeof parsed.vbom === 'object' ? parsed.vbom : {},
    }
  } catch {
    return { startup: [], vbom: {} }
  }
}

function startupFolders() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return [
    path.join(appData, 'Microsoft', 'Word', 'STARTUP'),
    path.join(localAppData, 'Packages', 'Microsoft.Office.Desktop_8wekyb3d8bbwe',
      'LocalCache', 'Roaming', 'Microsoft', 'Word', 'Startup'),
  ]
}

/** Exactly Zotero's folder discovery: per-version registry overrides + defaults. */
async function configuredStartupFolders() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const snapshot = await registrySnapshot()
  const found = snapshot.startup.map(entry => (path.isAbsolute(entry)
    ? entry : path.join(appData, 'Microsoft', 'Word', entry)))
  return [...new Set([...found, ...startupFolders()])]
    .filter(folder => !folder.includes('Program Files'))
}

function wordIsProbablyInstalled() {
  const candidates = [
    path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Microsoft Office', 'root', 'Office16', 'WINWORD.EXE'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Office', 'root', 'Office16', 'WINWORD.EXE'),
  ]
  return candidates.some(candidate => { try { return fs.existsSync(candidate) } catch { return false } })
}

async function wordIsRunning() {
  if (process.platform !== 'win32') return false
  const result = await runProcess('tasklist', ['/FI', 'IMAGENAME eq WINWORD.EXE', '/NH'])
  return result.ok && /WINWORD\.EXE/i.test(result.stdout)
}

/**
 * Unpack and validate a .dotm. Returns a detailed report; `ok: false` means
 * Word would silently fail to show the Ribbon tab.
 */
export function inspectTemplate(dotmPath) {
  const report = {
    ok: false, path: dotmPath, size: 0, modules: [], images: [], problems: [], parts: 0,
  }
  try {
    report.size = fs.statSync(dotmPath).size
    const entries = unzipSync(new Uint8Array(fs.readFileSync(dotmPath)))
    const names = Object.keys(entries)
    report.parts = names.length
    const text = name => (entries[name] ? decoder.decode(entries[name]) : '')

    const vba = entries['word/vbaProject.bin']
    if (!vba || vba.length < 20_000) report.problems.push('缺少 VBA 工程（word/vbaProject.bin）')
    else {
      // CFB directory entries store module names as UTF-16LE. Checking those
      // proves OUR modules were imported, not just that some macro project exists.
      const raw = Buffer.from(vba).toString('latin1')
      for (const name of REQUIRED_MODULES) {
        if (raw.includes(Buffer.from(name, 'utf16le').toString('latin1'))) report.modules.push(name)
        else report.problems.push(`VBA 工程缺少模块 ${name}`)
      }
    }
    if (!text('word/_rels/document.xml.rels').includes(VBA_REL_TYPE)) {
      report.problems.push('document.xml.rels 缺少 vbaProject 关系')
    }
    if (!text('[Content_Types].xml').includes('vbaProject')) {
      report.problems.push('[Content_Types].xml 未声明 VBA 工程')
    }
    const customUI = text(CUSTOMUI_PART)
    if (!customUI.includes('DshLibraryTab')) report.problems.push('缺少自定义功能区 customUI.xml')
    if (!text('_rels/.rels').includes(CUSTOMUI_REL_TYPE)) {
      report.problems.push('包级 _rels/.rels 缺少 customUI 关系')
    }
    const imageIds = ribbonImageIds(customUI)
    report.images = []
    if (imageIds.length) {
      const cuRels = text(CUSTOMUI_RELS_PART)
      if (!/<Default\b[^>]*Extension="png"/i.test(text('[Content_Types].xml'))) {
        report.problems.push('[Content_Types].xml 未声明 png 图标类型')
      }
      for (const id of imageIds) {
        const target = new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`).exec(cuRels)?.[1]
        if (!target) { report.problems.push(`功能区图标关系缺失：${id}`); continue }
        const part = `customUI/${target}`
        if (!entries[part] || entries[part].length < 60) {
          report.problems.push(`功能区图标部件缺失或损坏：${part}`)
        } else report.images.push(id)
      }
    }
    const docMain = text('[Content_Types].xml')
    if (!docMain.includes('macroEnabledTemplate')) {
      report.problems.push('文档不是启用宏的模板 (.dotm)')
    }
    report.ok = report.problems.length === 0
    return report
  } catch (error) {
    report.problems.push(`无法解析模板：${error?.message ?? error}`)
    return report
  }
}

/**
 * Inject customUI.xml (package-level relationship) and its image parts into an
 * OOXML template. Zotero's shipped Zotero.dotm resolves `image="foo"` through
 * `customUI/_rels/customUI.xml.rels` -> `customUI/images/foo.png`; no VBA
 * loadImage callback is involved. Rebuilding the rels from the shipped icon
 * directory every time keeps the template in sync with customUI.xml.
 */
export function injectCustomUI(dotmPath, customUI, iconsDir = null) {
  const entries = unzipSync(new Uint8Array(fs.readFileSync(dotmPath)))
  const files = {}
  for (const [name, data] of Object.entries(entries)) files[name] = data
  files[CUSTOMUI_PART] = encoder.encode(customUI)

  const contentTypesPath = '[Content_Types].xml'
  let contentTypes = files[contentTypesPath] ? decoder.decode(files[contentTypesPath]) : ''
  if (!contentTypes.includes('/customUI/customUI.xml') && !/<Default\b[^>]*Extension="xml"/i.test(contentTypes)) {
    contentTypes = contentTypes.replace('</Types>',
      '<Override PartName="/customUI/customUI.xml" ContentType="application/xml" /></Types>')
    files[contentTypesPath] = encoder.encode(contentTypes)
  }

  const relsPath = '_rels/.rels'
  let rels = files[relsPath] ? decoder.decode(files[relsPath]) : ''
  if (!rels.includes(CUSTOMUI_REL_TYPE)) {
    const ids = [...rels.matchAll(/Id="(?:rId)?([0-9a-fA-F]+)"/g)]
      .map(match => Number.parseInt(match[1], 10)).filter(Number.isFinite)
    const next = `rId${Math.max(0, ...ids) + 1}`
    const rel = `<Relationship Id="${next}" Type="${CUSTOMUI_REL_TYPE}" Target="customUI/customUI.xml"/>`
    if (rels.includes('</Relationships>')) rels = rels.replace('</Relationships>', `${rel}</Relationships>`)
    else rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel}</Relationships>`
    files[relsPath] = encoder.encode(rels)
  }

  const imageIds = ribbonImageIds(customUI)
  if (imageIds.length) {
    if (!iconsDir) throw new Error('功能区引用了图标，但未提供图标目录')
    const relationships = []
    for (const id of imageIds) {
      const file = path.join(iconsDir, `${id}.png`)
      if (!fs.existsSync(file)) throw new Error(`功能区图标缺失：${id}.png`)
      files[`customUI/images/${id}.png`] = new Uint8Array(fs.readFileSync(file))
      relationships.push(`<Relationship Id="${id}" Type="${IMAGE_REL_TYPE}" Target="images/${id}.png"/>`)
    }
    files[CUSTOMUI_RELS_PART] = encoder.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`)
    if (!/<Default\b[^>]*Extension="png"/i.test(contentTypes)) {
      contentTypes = contentTypes.replace('</Types>',
        '<Default Extension="png" ContentType="image/png"/></Types>')
      files[contentTypesPath] = encoder.encode(contentTypes)
    }
  }
  fs.writeFileSync(dotmPath, zipSync(files, { level: 6 }))
}

function psQuote(value) { return `'${String(value).replaceAll("'", "''")}'` }

/**
 * Build a Word template through COM. Paths are embedded explicitly (no
 * environment variables, no Get-ChildItem) so a missing module can never turn
 * into a silently empty template. The script reports the exact import count.
 */
function buildScript(moduleFiles, clsFile, output) {
  const list = moduleFiles.map(file => `  ${psQuote(file)}`).join(',\n')
  return `$ErrorActionPreference = 'Stop'
$paths = @(
${list}
)
$word = $null
$doc = $null
$created = $false
$alertsSaved = $null
try {
  # Word is frequently already running. CoCreateInstance can fail with
  # CO_E_SERVER_EXEC_FAILURE in that case (different integrity level, a modal
  # error dialog, or Office first-run). Attach to the running instance instead.
  try {
    $word = New-Object -ComObject Word.Application
    $created = $true
    $word.Visible = $false
  }
  catch {
    $firstError = $_.Exception.Message
    try {
      $word = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
    }
    catch {
      throw ('Cannot start or attach to Microsoft Word: ' + $firstError + ' / ' + $_.Exception.Message)
    }
  }
  if ($word -eq $null) { throw 'Microsoft Word is not available' }
  try { $alertsSaved = $word.DisplayAlerts } catch {}
  try { $word.DisplayAlerts = 0 } catch {}
  $doc = $word.Documents.Add()
  $project = $doc.VBProject
  $imported = 0
  foreach ($p in $paths) {
    if (-not [System.IO.File]::Exists($p)) { throw ('VBA module missing: ' + $p) }
    $component = $project.VBComponents.Import($p)
    $imported = $imported + 1
    Write-Output ('DSH_MODULE ' + $component.Name)
  }
  $cls = ${psQuote(clsFile)}
  if ([System.IO.File]::Exists($cls)) {
    $lines = Get-Content -LiteralPath $cls -Encoding UTF8 | Where-Object { $_ -notmatch '^Attribute ' }
    if ($lines) {
      $null = $project.VBComponents.Item('ThisDocument').CodeModule.AddFromString(($lines -join "\`r\`n"))
    }
  }
  # 15 = wdFormatXMLTemplateMacroEnabled (.dotm). 14 is wdFormatXMLTemplate
  # (.dotx) and silently DISCARDS the VBA project, producing a file Word
  # refuses to open as a template.
  $doc.SaveAs2(${psQuote(output)}, 15)
  Write-Output ('DSH_IMPORTED=' + $imported)
  Write-Output 'DSH_TEMPLATE_OK'
}
catch {
  Write-Output ('DSH_ERROR ' + $_.Exception.Message)
  throw
}
finally {
  if ($doc -ne $null) { try { $doc.Close(0) } catch {} }
  if ($word -ne $null) {
    if ($alertsSaved -ne $null) { try { $word.DisplayAlerts = $alertsSaved } catch {} }
    # Never quit a Word instance that still holds the user's documents.
    if ($created) { try { if ($word.Documents.Count -eq 0) { $word.Quit() } } catch {} }
  }
}
`
}

export function createWordInstaller({ logger = console, version = '0.3.0', packageDir, home, getPort } = {}) {
  const assets = path.join(packageDir, 'assets', 'word')
  const vbaDir = path.join(assets, 'vba')
  const prebuilt = path.join(assets, TEMPLATE_NAME)
  const cacheFile = path.join(home ?? os.tmpdir(), 'word', TEMPLATE_NAME)
  let cache = null
  let cacheAt = 0
  let folderCache = null

  function destination() { return startupFolders()[0] }

  async function targetFolders() {
    if (!folderCache) folderCache = await configuredStartupFolders()
    return folderCache
  }

  function installedPaths(folders) {
    return folders.map(folder => path.join(folder, TEMPLATE_NAME)).filter(file => fs.existsSync(file))
  }

  async function status({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cacheAt < 30_000) return cache
    const folders = await targetFolders()
    const found = installedPaths(folders)
    const file = found[0] ?? path.join(destination(), TEMPLATE_NAME)
    const report = found.length ? inspectTemplate(found[0]) : null
    const available = wordIsProbablyInstalled() || fs.existsSync(path.dirname(file))
    cache = {
      installed: found.length > 0,
      valid: Boolean(report?.ok),
      available,
      path: file,
      paths: found,
      size: report?.size ?? 0,
      modules: report?.modules ?? [],
      problems: report?.problems ?? [],
      wordRunning: await wordIsRunning(),
      reason: !available ? '未检测到 Microsoft Word'
        : found.length && !report?.ok ? '已安装的模板不完整，请重新安装' : '',
      version,
      port: getPort?.() ?? 0,
    }
    cacheAt = Date.now()
    return cache
  }

  /**
   * Temporarily trust access to the VBA project object model. Uses PowerShell's
   * registry provider (Zotero uses the native registry API) instead of spawning
   * reg.exe, and only touches keys for Word versions that actually exist.
   */
  async function enableVBOM() {
    const script = `$ErrorActionPreference = 'SilentlyContinue'
$changed = @()
foreach ($v in 12..20) {
  $key = 'HKCU:\\Software\\Microsoft\\Office\\' + $v + '.0\\Word\\Security'
  $item = Get-ItemProperty -Path $key
  if ($null -eq $item) { continue }
  $cur = -1
  if ($null -ne $item.AccessVBOM) { $cur = [int]$item.AccessVBOM }
  if ($cur -ne 1) {
    Set-ItemProperty -Path $key -Name AccessVBOM -Value 1 -Type DWord
    $changed += [pscustomobject]@{ v = $v; old = $cur }
  }
}
$changed | ConvertTo-Json -Compress
`
    const result = await runPowerShell(script)
    let changed = []
    try {
      const parsed = JSON.parse(result.stdout.trim())
      changed = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : [])
    } catch { changed = [] }
    return async () => {
      if (!changed.length) return
      const payload = psQuote(JSON.stringify(changed))
      const restore = `$ErrorActionPreference = 'SilentlyContinue'
$changed = ConvertFrom-Json ${payload}
foreach ($c in @($changed)) {
  $key = 'HKCU:\\Software\\Microsoft\\Office\\' + $c.v + '.0\\Word\\Security'
  if ($c.old -eq -1) { Remove-ItemProperty -Path $key -Name AccessVBOM }
  else { Set-ItemProperty -Path $key -Name AccessVBOM -Value $c.old -Type DWord }
}
`
      await runPowerShell(restore)
    }
  }

  async function buildTemplate(output) {
    const customUIPath = path.join(assets, 'customUI.xml')
    const moduleFiles = fs.readdirSync(vbaDir).filter(name => name.endsWith('.bas'))
      .sort().map(name => path.join(vbaDir, name))
    if (!fs.existsSync(customUIPath) || moduleFiles.length < REQUIRED_MODULES.length) {
      throw new Error(`Word 插件资源不完整：${assets}`)
    }
    const restoreVBOM = await enableVBOM()
    try {
      const script = buildScript(moduleFiles, path.join(vbaDir, 'ThisDocument.cls'), output)
      const result = await runPowerShell(script)
      const outputText = `${result.stdout ?? ''}${result.stderr ?? ''}`
      const imported = Number(/DSH_IMPORTED=(\d+)/.exec(result.stdout ?? '')?.[1] ?? 0)
      const scriptError = /DSH_ERROR (.+)/.exec(result.stdout ?? '')?.[1]
      if (imported < REQUIRED_MODULES.length) {
        const why = scriptError || outputText.trim().slice(0, 300) || result.error
        throw new Error(`Word 未能导入 VBA 模块（成功 ${imported}/${REQUIRED_MODULES.length}）。`
          + `请完全退出 Word 后重试，并确认已安装 Word 桌面版、允许「信任对 VBA 工程对象模型的访问」。\n${why}`)
      }
      if (!fs.existsSync(output)) {
        throw new Error(`未能生成 Word 模板：${outputText.trim().slice(0, 300) || result.error}`)
      }
      injectCustomUI(output, fs.readFileSync(customUIPath, 'utf8'), path.join(assets, 'icons'))
      const report = inspectTemplate(output)
      if (!report.ok) throw new Error(`生成的模板未通过自检：${report.problems.join('；')}`)
      return report
    } finally {
      await restoreVBOM()
    }
  }

  /**
   * Zotero-style installation: prefer the template shipped with the plugin,
   * then a verified local cache, and only fall back to building one through
   * Word COM. Every candidate is staged, has the current customUI.xml injected
   * (so the Ribbon always matches the shipped XML) and must pass inspectTemplate.
   */
  async function obtainTemplate(buildDir) {
    const staged = path.join(buildDir, TEMPLATE_NAME)
    const customUI = fs.readFileSync(path.join(assets, 'customUI.xml'), 'utf8')
    for (const [file, label] of [[prebuilt, '随插件分发'], [cacheFile, '本地缓存']]) {
      if (!fs.existsSync(file)) continue
      try {
        fs.copyFileSync(file, staged)
        injectCustomUI(staged, customUI, path.join(assets, 'icons'))
        const report = inspectTemplate(staged)
        if (report.ok) return { file: staged, label, report }
        logger.warn?.(`library: ${label}模板不可用：${report.problems.join('；')}`)
      } catch (error) {
        logger.warn?.(`library: ${label}模板读取失败：${error?.message ?? error}`)
      }
    }
    const report = await buildTemplate(staged)
    // Cache the verified build so every later install is a plain file copy.
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
      fs.copyFileSync(staged, cacheFile)
    } catch (error) {
      logger.warn?.(`library: could not cache Word template: ${error?.message ?? error}`)
    }
    return { file: staged, label: '现场生成', report }
  }

  function removeLegacyTemplate(folder) {
    // The previous implementation left a second 文库引用 tab behind. Two
    // templates defining the same Ribbon tab confuse Word and hide both.
    // Word keeps STARTUP templates open, so deletion can fail: renaming to a
    // non-.dotm extension still stops Word from loading it.
    const failures = []
    for (const name of [LEGACY_TEMPLATE_NAME, '~$h-library.dotm', '~$hLibrary.dotm']) {
      const file = path.join(folder, name)
      if (!fs.existsSync(file)) continue
      try { fs.unlinkSync(file); continue } catch { /* try rename */ }
      try {
        fs.renameSync(file, `${file}.disabled`)
      } catch (error) {
        failures.push(`${name}: ${error?.message ?? error}`)
      }
    }
    return failures
  }

  async function install() {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-word-build-'))
    try {
      const { file, label, report } = await obtainTemplate(buildDir)
      const targets = await targetFolders()
      const copied = []
      const failures = []
      for (const target of targets) {
        try {
          if (!fs.existsSync(target) && target !== destination()) continue
          fs.mkdirSync(target, { recursive: true })
          const finalPath = path.join(target, TEMPLATE_NAME)
          fs.copyFileSync(file, finalPath)
          // Verify what actually landed on disk, not just the source.
          const landed = inspectTemplate(finalPath)
          if (!landed.ok) throw new Error(landed.problems.join('；'))
          const legacy = removeLegacyTemplate(target)
          if (legacy.length) failures.push(...legacy)
          copied.push(finalPath)
        } catch (error) {
          failures.push(`${target}: ${error?.message ?? error}`)
          logger.warn?.(`library: could not install template to ${target}: ${error?.message ?? error}`)
        }
      }
      if (!copied.length) {
        throw new Error(`未能把模板写入 Word 的 STARTUP 文件夹。${failures.join(' | ')}`)
      }
      cache = null
      const running = await wordIsRunning()
      logger.info?.(`library: installed Word template (${label}, ${report.size} bytes) at ${copied.join(', ')}`)
      const note = running
        ? '插件已装入 Word 的启动目录，但 Word 正在运行：请完全退出 Word（包括后台进程）再重新打开，「文库引用」选项卡才会出现。'
        : '插件已装入 Word 的启动目录，启动 Word 后会出现「文库引用」选项卡。'
      return {
        installed: true,
        valid: true,
        location: copied[0],
        paths: copied,
        size: report.size,
        modules: report.modules,
        source: label,
        wordRunning: running,
        note: failures.length
          ? `${note} 另外，旧版插件模板仍被占用，请完全退出 Word 后重新点一次「安装 Word 引文插件」以清理。`
          : note,
        ...(failures.length ? { failures } : {}),
      }
    } finally {
      const built = path.join(buildDir, TEMPLATE_NAME)
      try { fs.unlinkSync(built) } catch { /* already removed */ }
      try { fs.rmdirSync(buildDir) } catch { /* non-empty: leave it in temp */ }
    }
  }

  async function uninstall() {
    const folders = await targetFolders()
    const removed = []
    for (const folder of folders) {
      for (const name of [TEMPLATE_NAME, LEGACY_TEMPLATE_NAME]) {
        const file = path.join(folder, name)
        try { fs.unlinkSync(file); removed.push(file) } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
    }
    cache = null
    return { installed: false, location: removed[0] ?? path.join(destination(), TEMPLATE_NAME), removed }
  }

  function openStartupFolder() {
    const folder = destination()
    try { fs.mkdirSync(folder, { recursive: true }) } catch { /* best effort */ }
    return openExternal(folder)
  }

  return { status, install, uninstall, inspectTemplate, openStartupFolder, buildTemplate, destination: () => destination() }
}
