// Windows file associations for the reader's 「打开方式」 control: which
// applications a file type is registered with, each with its icon as a data
// URL, plus launching the file with one chosen application.
//
// Sources (all reads, no writes): HKCR\<ext>\OpenWithProgids, the user's
// FileExts OpenWithProgids + UserChoice, HKCR\<ext>\OpenWithList, and the
// class default ProgId. Icons come from each ProgId's DefaultIcon; exe-embedded
// icons are extracted with System.Drawing inside one batched PowerShell run
// (indirect FriendlyTypeName strings are resolved there too via
// SHLoadIndirectString). Everything is cached per extension with a TTL.
//
// Non-Windows platforms simply report no applications; the control then falls
// back to plain default-open behavior.
import { spawn } from 'node:child_process'
import { openExternal } from './open.js'

const ASSOC_TTL = 5 * 60 * 1000
const ICON_PAYLOAD_LIMIT = 24

const assocCache = new Map() // ext (lower) → { apps, at }
const commandCache = new Map() // progId (lower) → shell\open\command template | null

/** Run `reg query` and resolve to its stdout, or null when the key is absent. */
function regQuery(args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('reg', ['query', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      // Locked-down environments can forbid spawning reg.exe entirely. An
      // empty association list is a valid (if less convenient) answer.
      resolve(null)
      return
    }
    const chunks = []
    child.stdout.on('data', chunk => { chunks.push(chunk) })
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } resolve(null) }, 5000)
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('close', code => {
      clearTimeout(timer)
      resolve(code === 0 ? decodeOem(Buffer.concat(chunks)) : null)
    })
  })
}

/**
 * reg.exe writes the OEM codepage (GBK on zh-CN Windows), which Node's default
 * UTF-8 decode turns to garbage; switch when the strict decode shows U+FFFD.
 */
function decodeOem(buffer) {
  const utf8 = buffer.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return utf8
  }
}

/** reg.exe's localized placeholders for empty/default values are not names. */
function cleanRegValue(value) {
  const v = String(value ?? '').trim()
  if (!v || /^\((?:[^()]{1,12}未设置|默认|Default|value not set)\)$/i.test(v)) return null
  return v
}

/** Parse `reg query` rows: value-name lines are "<name>    REG_*    [data]". */
function regRows(output) {
  const rows = []
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s{2,}(\S+?)\s+REG_[A-Z]+\s*(.*)$/)
    if (match) rows.push([match[1], match[2] ?? ''])
  }
  return rows
}

/** One value's data from `reg query <key> /v <name>` (or the key default). */
async function regValue(key, valueName) {
  const out = await regQuery(valueName === undefined ? [key, '/ve'] : [key, '/v', valueName])
  if (out === null) return null
  for (const [name, data] of regRows(out)) {
    if (valueName === undefined || name.toLowerCase() === valueName.toLowerCase()) return cleanRegValue(data)
  }
  return null
}

/** All value NAMES under one key (data ignored) — OpenWithProgids listings. */
async function regValueNames(key) {
  const out = await regQuery([key])
  if (out === null) return []
  return regRows(out).map(([name]) => name)
}

/** Parse a DefaultIcon value ("C:\path\app.exe",1) into an absolute icon path. */
function parseIconSource(value) {
  if (!value) return null
  const trimmed = value.trim()
  if (trimmed.startsWith('@')) return null // indirect icon string; not worth resolving
  const match = trimmed.match(/^"([^"]+)"(?:\s*,\s*-?\d+)?$/) ?? trimmed.match(/^([^",]+?)(?:\s*,\s*-?\d+)?$/)
  const candidate = match?.[1]?.trim()
  if (!candidate || !/^[A-Za-z]:\\/.test(candidate)) return null
  return candidate
}

/** Extract the launching exe (+ argument template) of a ProgId's open command. */
async function progIdCommand(progId) {
  const key = progId.toLowerCase()
  if (commandCache.has(key)) return commandCache.get(key)
  const command = await regValue(`HKCR\\${progId}\\shell\\open\\command`, undefined)
  commandCache.set(key, command ?? null)
  return command ?? null
}

/** Resolve a ProgId's display name: FriendlyTypeName → key default → exe name. */
async function progIdName(progId, command) {
  const friendly = await regValue(`HKCR\\${progId}`, 'FriendlyTypeName')
  if (friendly) return friendly
  const label = await regValue(`HKCR\\${progId}`, undefined)
  if (label) return label
  const exe = /Applications\\([^\\]+)$/i.exec(progId)?.[1]
  if (exe) return exe.replace(/\.exe$/i, '')
  if (command) {
    const first = /"([^"]+)"/.exec(command)?.[1] ?? command.trim().split(/\s+/)[0]
    if (first) return first.replace(/\\/g, '/').split('/').pop()?.replace(/\.exe$/i, '') ?? progId
  }
  return null
}

/** One batched PowerShell run: resolve indirect names + extract icons as base64.
 * Payload and result both travel as base64 UTF-8 JSON so the console codepage
 * can never touch the data. */
function runIconPowerShell(payload) {
  const script = [
    "$ErrorActionPreference = 'Continue'",
    'Add-Type -AssemblyName System.Drawing',
    "$def = 'using System; using System.Runtime.InteropServices; public static class Shl { [DllImport(\"shlwapi.dll\", CharSet = CharSet.Unicode)] public static extern int SHLoadIndirectString(string src, System.Text.StringBuilder dst, int cch, IntPtr reserved); }'",
    'Add-Type -TypeDefinition $def',
    "$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json",
    '$out = New-Object System.Collections.ArrayList',
    'foreach ($item in $payload) {',
    '  $name = $item.name',
    "  if (-not [string]::IsNullOrEmpty($name) -and $name.StartsWith('@')) {",
    '    try {',
    '      $sb = New-Object System.Text.StringBuilder 1024',
    '      if ([Shl]::SHLoadIndirectString($name, $sb, 1024, [IntPtr]::Zero) -eq 0) { $name = $sb.ToString() }',
    '    } catch { }',
    '  }',
    '  $icon = $null',
    '  $mime = $null',
    '  $src = $item.icon',
    '  if (-not [string]::IsNullOrEmpty($src) -and (Test-Path -LiteralPath $src)) {',
    '    try {',
    "      if ([IO.Path]::GetExtension($src).ToLower() -eq '.ico') {",
    '        $icon = [Convert]::ToBase64String([IO.File]::ReadAllBytes($src)); $mime = \'image/x-icon\'',
    '      } else {',
    '        $i = [System.Drawing.Icon]::ExtractAssociatedIcon($src)',
    '        if ($i) { $ms = New-Object System.IO.MemoryStream; $i.ToBitmap().Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $icon = [Convert]::ToBase64String($ms.ToArray()); $mime = \'image/png\' }',
    '      }',
    '    } catch { $icon = $null }',
    '  }',
    '  [void]$out.Add([pscustomobject]@{ key = $item.key; name = $name; icon = $icon; mime = $mime })',
    '}',
    '$json = $out | ConvertTo-Json -Compress -Depth 3',
    '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))',
  ].join('\n')
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    } catch {
      resolve(null)
      return
    }
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } resolve(null) }, 15_000)
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const parsed = JSON.parse(Buffer.from(out, 'base64').toString('utf8'))
        resolve(Array.isArray(parsed) ? parsed : [parsed])
      } catch {
        resolve(null)
      }
    })
    try { child.stdin?.end(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')) } catch { /* spawn failed */ }
  })
}

/** Registry ProgIds registered for one extension, default-flagged, best order first. */
async function collectProgIds(ext) {
  const [userChoice, classDefault, classProgids, userProgids] = await Promise.all([
    regValue(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`, 'ProgId'),
    regValue(`HKCR\\${ext}`, undefined),
    regValueNames(`HKCR\\${ext}\\OpenWithProgids`),
    regValueNames(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\OpenWithProgids`),
  ])
  const ordered = []
  for (const id of [userChoice, ...userProgids, ...classProgids, classDefault]) {
    if (id && /^[A-Za-z0-9_.\-\\ ]{1,128}$/.test(id) && !ordered.includes(id)) ordered.push(id)
  }
  return { ordered, defaultId: userChoice ?? null }
}

/** Applications (id/name/icon/default) that can open one file path. */
export async function fileApplications(filePath) {
  if (process.platform !== 'win32') return []
  const ext = (filePath.match(/\.[A-Za-z0-9]+$/) ?? [''])[0].toLowerCase()
  if (!ext) return []
  const cached = assocCache.get(ext)
  if (cached && Date.now() - cached.at < ASSOC_TTL) return cached.apps

  const { ordered, defaultId } = await collectProgIds(ext)
  const infos = []
  for (const progId of ordered.slice(0, ICON_PAYLOAD_LIMIT)) {
    const command = await progIdCommand(progId)
    infos.push({ progId, command, name: await progIdName(progId, command) })
  }
  // Apps without an open command cannot be launched explicitly; keep them only
  // as the default entry (default-open still works through the OS). Store-app
  // (AppX) entries without any resolvable name are noise — drop unless default.
  const usable = infos.filter(info => {
    if (info.progId === defaultId) return true
    if (!info.command) return false
    if (/^AppX/i.test(info.progId) && !info.name) return false
    return true
  })
  // Dedup different ProgIds that launch the same exe.
  const seen = new Set()
  const deduped = []
  for (const info of usable) {
    const exe = /"([^"]+)"/.exec(info.command ?? '')?.[1]?.toLowerCase() ?? `progid:${info.progId.toLowerCase()}`
    if (seen.has(exe)) continue
    seen.add(exe)
    deduped.push(info)
  }

  const iconPayload = []
  for (const [index, info] of deduped.entries()) {
    iconPayload.push({
      key: String(index),
      name: info.name,
      icon: parseIconSource(await regValue(`HKCR\\${info.progId}\\DefaultIcon`, undefined)),
    })
  }
  const resolved = await runIconPowerShell(iconPayload)
  const byKey = new Map((resolved ?? []).map(entry => [String(entry.key), entry]))

  const apps = deduped.map((info, index) => {
    const entry = byKey.get(String(index))
    const name = (entry?.name ?? '').trim() || info.name
      || (/^AppX/i.test(info.progId) ? 'Windows 应用' : info.progId)
    const mime = entry?.mime ?? ''
    const icon = entry?.icon ? `data:${mime};base64,${entry.icon}` : null
    return { id: info.progId, name, icon, default: info.progId === defaultId }
  })
  // A default entry stays first for the preferred-slot rendering.
  apps.sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0))
  assocCache.set(ext, { apps, at: Date.now() })
  return apps
}

/**
 * Launch one file with a chosen registered application (by ProgId from
 * {@link fileApplications}). The id is only accepted when it belongs to the
 * cached association list; anything else refuses rather than spawning.
 */
export async function openWithApplication(filePath, applicationId) {
  if (process.platform !== 'win32') {
    openExternal(filePath)
    return { opened: filePath, fallback: true }
  }
  const id = String(applicationId ?? '')
  if (!/^[A-Za-z0-9_.\-\\ ]{1,128}$/.test(id)) {
    throw Object.assign(new Error(`Unknown application: ${id}`), { code: 'library/not-found' })
  }
  const ext = (filePath.match(/\.[A-Za-z0-9]+$/) ?? [''])[0].toLowerCase()
  const cached = assocCache.get(ext)
  const known = cached?.apps.find(app => app.id === id)
  if (!known) {
    throw Object.assign(new Error(`Unknown application: ${id}`), { code: 'library/not-found' })
  }
  const command = await progIdCommand(id)
  if (!command || !/%1|%L/i.test(command)) {
    // DDE-style or unusable template — hand the file to the OS default instead.
    openExternal(filePath)
    return { opened: filePath, fallback: true }
  }
  const quoted = `"${filePath}"`
  const filled = command
    .replace(/"\s*%1\s*"/gi, quoted)
    .replace(/"\s*%L\s*"/gi, quoted)
    .replace(/%1/gi, quoted)
    .replace(/%L/gi, quoted)
  const parts = []
  const tokenizer = /"([^"]*)"|(\S+)/g
  for (let match = tokenizer.exec(filled); match !== null; match = tokenizer.exec(filled)) {
    parts.push(match[1] ?? match[2])
  }
  const exe = parts[0]
  const args = parts.slice(1)
  if (!exe) {
    openExternal(filePath)
    return { opened: filePath, fallback: true }
  }
  const started = await new Promise((resolve) => {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => resolve(false))
    child.on('spawn', () => { child.unref(); resolve(true) })
  })
  if (!started) {
    openExternal(filePath)
    return { opened: filePath, fallback: true }
  }
  return { opened: `${exe} ${filePath}` }
}
