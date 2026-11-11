// Handing "sync" over to the Zotero client (zotero mode). Zotero has no
// remote "sync now" endpoint (its local server only serves the connector and a
// read API), so the plugin does the next best thing: probe the local HTTP
// server (23119+, GET /connector/ping → "Zotero is running"), launch the
// client when it is closed, bring its window to the front and let the user
// click Zotero's own sync button. Database changes then flow back through the
// runtime's revision polling.
//
// Port identification: our own office integration server also answers
// GET /connector/ping (JSON with processorName), while Zotero answers the
// plain text "Zotero is running" — that difference is the discriminator.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'

/** The connector scans this range for Zotero; ours does the same. */
const DEFAULT_PORTS = Array.from({ length: 10 }, (_, index) => 23119 + index)
const PING_TIMEOUT_MS = 1200
const LAUNCH_WAIT_MS = envNumber('DSH_LIBRARY_ZOTERO_LAUNCH_WAIT_MS', 15_000)
const FOCUS_TIMEOUT_MS = envNumber('DSH_LIBRARY_ZOTERO_FOCUS_TIMEOUT_MS', 10_000)
// Records launch/focus attempts as JSON lines instead of spawning anything
// (smoke suite); DSH_LIBRARY_ZOTERO_LAUNCH_FAIL=1 makes launching fail — read
// at call time so a test suite can flip it between phases.
const LAUNCH_SINK = process.env.DSH_LIBRARY_ZOTERO_LAUNCH_SINK ?? ''

/** Call-time launch failure switch (smoke suite drives the not-installed path). */
function launchFailForced() {
  return process.env.DSH_LIBRARY_ZOTERO_LAUNCH_FAIL === '1'
}

function envNumber(name, fallback) {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

function envPorts() {
  const raw = process.env.DSH_LIBRARY_ZOTERO_PORTS
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_PORTS
  const ports = raw.split(',').map(Number).filter(port => Number.isInteger(port) && port > 0)
  return ports.length > 0 ? ports : DEFAULT_PORTS
}

/** Standard Zotero executable locations, most specific first. */
function exeCandidates() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = process.env.LOCALAPPDATA
    const list = []
    if (localAppData) list.push(path.join(localAppData, 'Programs', 'Zotero', 'zotero.exe'))
    list.push(path.join(programFiles, 'Zotero', 'zotero.exe'), path.join(programFilesX86, 'Zotero', 'zotero.exe'))
    return list
  }
  if (process.platform === 'darwin') return ['/Applications/Zotero.app']
  return ['zotero'] // resolved over PATH by spawn
}

/** The exe path the zotero:// protocol handler points at, best effort. */
async function exeFromProtocolHandler() {
  if (process.platform !== 'win32') return undefined
  const script = [
    `$roots = 'HKCU:\\Software\\Classes\\zotero\\shell\\open\\command','HKLM:\\Software\\Classes\\zotero\\shell\\open\\command'`,
    `foreach ($root in $roots) {`,
    `  try { $value = (Get-ItemProperty -LiteralPath $root -ErrorAction Stop).'(default)' } catch { continue }`,
    `  if ($value) { Write-Output $value; break }`,
    `}`,
  ].join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
      if (error) return resolve(undefined)
      const line = String(stdout ?? '').trim()
      if (line === '') return resolve(undefined)
      resolve(line)
    })
  })
}

/** Start Zotero; records into the sink instead of spawning when one is set. */
async function launchZotero(exeOverride) {
  if (LAUNCH_SINK !== '') {
    recordSink({ kind: 'launch-zotero', target: exeOverride || '' })
    return !launchFailForced()
  }
  if (launchFailForced()) return false
  if (process.platform === 'darwin') {
    try {
      spawn('open', ['-a', 'Zotero'], { detached: true, stdio: 'ignore' }).unref()
      return true
    } catch {
      return false
    }
  }
  const candidates = []
  if (typeof exeOverride === 'string' && exeOverride.trim() !== '') candidates.push(exeOverride.trim())
  if (process.platform === 'win32') {
    const registered = await exeFromProtocolHandler()
    if (registered) {
      const quoted = /"([^"]+\.exe)"/i.exec(registered)
      const bare = /^(\S+\.exe)/i.exec(registered)
      const exe = quoted?.[1] ?? bare?.[1]
      if (exe) candidates.push(exe)
    }
  }
  candidates.push(...exeCandidates())
  for (const candidate of candidates) {
    try {
      // The bare 'zotero' on Linux resolves over PATH; file candidates must exist.
      if (candidate !== 'zotero' && !fs.existsSync(candidate)) continue
      spawn(candidate, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      return true
    } catch {
      // Try the next candidate.
    }
  }
  return false
}

function recordSink(entry) {
  try {
    fs.appendFileSync(LAUNCH_SINK, `${JSON.stringify(entry)}\n`)
  } catch {
    // A broken sink must not break launching itself.
  }
}

/**
 * Win32 script that brings the Zotero window to the foreground so the user can
 * click Zotero's own sync button. Same proven scheme as the office module's
 * dsh self-focus (office/window.js): main windows of any zotero.exe process,
 * restore/show first, AttachThreadInput + SwitchToThisWindow for the
 * foreground-lock, an ALT tap as the nudge fallback, taskbar flashing last.
 * Prints 1 (foreground taken), 2 (shown/flashing but foreground refused) or
 * 0 (no window found).
 */
function buildFocusZoteroScript() {
  return `Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class DshZoteroFocus {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO info);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }

  static void Nudge() {
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
  }

  static void ForceForeground(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    if (fg == h) return;
    uint ignored;
    uint fgThread = GetWindowThreadProcessId(fg, out ignored);
    uint myThread = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != myThread) attached = AttachThreadInput(myThread, fgThread, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    SwitchToThisWindow(h, true);
    if (attached) AttachThreadInput(myThread, fgThread, false);
  }

  static bool IsMainWindow(IntPtr h) {
    if ((GetWindowLong(h, -16) & 0x00C00000) == 0) return false;   // GWL_STYLE, WS_CAPTION
    if ((GetWindowLong(h, -20) & 0x00000080) != 0) return false;   // GWL_EXSTYLE, WS_EX_TOOLWINDOW
    return true;
  }

  static bool IsZotero(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return false;
    try {
      var sb = new StringBuilder(1024);
      uint size = 1024;
      return QueryFullProcessImageName(h, 0, sb, ref size) && sb.ToString().EndsWith("zotero.exe", StringComparison.OrdinalIgnoreCase);
    } finally { CloseHandle(h); }
  }

  public static int Focus() {
    var found = new List<IntPtr>();
    var score = new List<long>();
    EnumWindows((h, l) => {
      if (!IsMainWindow(h)) return true;
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (!IsZotero(owner)) return true;
      found.Add(h);
      score.Add(GetWindowTextLength(h));
      return true;
    }, IntPtr.Zero);
    if (found.Count == 0) return 0;
    // Try longest title first (the real main window outranks helper windows).
    for (int i = 0; i < found.Count; i++) {
      int w = i;
      for (int j = i + 1; j < found.Count; j++) if (score[j] > score[w]) w = j;
      IntPtr t = found[i]; found[i] = found[w]; found[w] = t;
      long ts = score[i]; score[i] = score[w]; score[w] = ts;
    }
    IntPtr primary = found[0];
    foreach (IntPtr h in found) {
      if (!IsWindowVisible(h)) ShowWindow(h, 5);    // SW_SHOW — back out of the tray
      if (IsIconic(h)) ShowWindow(h, 9);            // SW_RESTORE — un-minimise
      ForceForeground(h);
      System.Threading.Thread.Sleep(120);
      if (GetForegroundWindow() == h) return 1;
    }
    // Foreground refused (Windows foreground lock): the window is at least
    // shown/restored — an ALT tap retry, then flash the taskbar button.
    Nudge();
    ForceForeground(primary);
    System.Threading.Thread.Sleep(200);
    if (GetForegroundWindow() == primary) return 1;
    FLASHWINFO fw;
    fw.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO));
    fw.hwnd = primary;
    fw.dwFlags = 0x3 | 0xC;                         // FLASHW_ALL | FLASHW_TIMERNOFG
    fw.uCount = 10;
    fw.dwTimeout = 0;
    FlashWindowEx(ref fw);
    return 2;
  }
}
'@
[DshZoteroFocus]::Focus()
`
}

/**
 * Bring the Zotero window up front. Resolves to true when a Zotero window was
 * found and shown (foreground taken or taskbar flashing); false when none
 * exists. Records into the launch sink instead of running PowerShell there.
 */
async function focusZotero() {
  if (LAUNCH_SINK !== '') {
    recordSink({ kind: 'focus-zotero' })
    return true
  }
  if (process.platform !== 'win32') return true // macOS/Linux launches already focus
  const encoded = Buffer.from(buildFocusZoteroScript(), 'utf16le').toString('base64')
  return await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: FOCUS_TIMEOUT_MS }, (error, stdout) => {
      if (error) return resolve(false)
      const code = Number(String(stdout ?? '').trim())
      resolve(code === 1 || code === 2)
    })
  })
}

/**
 * The Zotero client driver: probe the local server and launch + raise it so
 * the user can run the sync in Zotero itself.
 * @param {object} deps
 * @param {object} [deps.logger]
 * @param {() => object} deps.getSettings - plugin settings (zoteroExePath override).
 * @param {typeof fetch} [deps.fetchImpl]
 */
export function createZoteroClient({ logger = console, getSettings, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createZoteroClient requires fetch')
  let lastResult

  const record = (result) => {
    lastResult = { at: new Date().toISOString(), ...result }
    return lastResult
  }

  /** One GET /connector/ping; answers with "Zotero is running" = Zotero. */
  async function pingPort(port) {
    let response
    try {
      response = await fetchImpl(`http://127.0.0.1:${port}/connector/ping`, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) })
    } catch {
      return undefined
    }
    let body = ''
    try {
      body = await response.text()
    } catch {
      return undefined
    }
    if (!/Zotero is running/i.test(body)) return undefined
    // Zotero stamps every connector response with X-Zotero-Version.
    const version = typeof response.headers?.get === 'function' ? response.headers.get('x-zotero-version') : undefined
    return { port, ...(version ? { version } : {}) }
  }

  /** Probe all candidate ports; the first real Zotero answer wins. */
  async function probe() {
    for (const port of envPorts()) {
      const found = await pingPort(port)
      if (found) return found
    }
    return undefined
  }

  async function waitForProbe(deadlineMs) {
    const startedAt = Date.now()
    const interval = Math.max(200, Math.min(1000, deadlineMs / 8))
    while (Date.now() - startedAt < deadlineMs) {
      await new Promise(resolve => setTimeout(resolve, interval))
      const found = await probe()
      if (found) return found
    }
    return undefined
  }

  const SYNC_HINT = '点它工具栏的「同步」图标（⟳）完成同步'

  /**
   * Bring Zotero up (launching it when closed) and put its window in front so
   * the user can run the sync there. Never pretends to have synced: the
   * database changes arrive through the revision polling afterwards.
   */
  async function sync() {
    let client = await probe()
    if (client) {
      const shown = await focusZotero()
      return record({
        kind: 'focused',
        port: client.port,
        ...(client.version ? { version: client.version } : {}),
        ...(shown ? {} : { windowNotFound: true }),
        message: `已切到 Zotero：${SYNC_HINT}`,
      })
    }
    const settings = getSettings?.() ?? {}
    const launched = await launchZotero(settings.zoteroExePath)
    if (!launched) {
      return record({ kind: 'not-installed', message: '未找到 Zotero 客户端：请先启动 Zotero，或在文库设置里配置 zoteroExePath' })
    }
    logger.info?.('library: launched Zotero client, waiting for its HTTP server')
    client = await waitForProbe(LAUNCH_WAIT_MS)
    await focusZotero()
    if (!client) {
      // Slow first start (update dialogs, first-run) — the window is coming up.
      return record({ kind: 'launched', message: `Zotero 正在启动：就绪后${SYNC_HINT}` })
    }
    return record({
      kind: 'launched',
      port: client.port,
      ...(client.version ? { version: client.version } : {}),
      message: `Zotero 已启动：${SYNC_HINT}`,
    })
  }

  /** State for the settings page: client reachability, last hand-off result. */
  async function status() {
    const client = await probe()
    return {
      running: Boolean(client),
      ...(client ? { port: client.port, ...(client.version ? { version: client.version } : {}) } : {}),
      last: lastResult,
    }
  }

  return { probe, sync, status, lastSync: () => lastResult }
}
