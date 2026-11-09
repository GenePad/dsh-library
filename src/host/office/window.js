// Zotero shows a small, bordered native window for its citation dialog.
//
// We cannot create an XUL window, but Chromium/Edge's `--app=<url>` mode opens
// a standalone, chromeless window: no tab strip, no address bar, its own
// taskbar button and its own profile. Paired with the compact stylesheet in
// pages.js it looks and behaves like a desktop dialog rather than a web page.
//
// A unique short marker in document.title lets us close exactly that window
// (PostMessage WM_CLOSE) when the engine accepts/cancels the dialog -- Chrome
// ignores window.close() for windows it opened itself.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'

const SIZES = {
  citation: [720, 560],
  docPrefs: [700, 620],
  bibliography: [860, 620],
  explorer: [820, 600],
  itemPicker: [560, 460],
  progress: [360, 160],
}

export function windowSize(type) {
  return SIZES[type] ?? [720, 560]
}

/** Locate a Chromium-based browser that supports --app on this machine. */
export function findBrowser() {
  const local = process.env.LOCALAPPDATA || ''
  const pf = process.env.PROGRAMFILES || 'C:\\Program Files'
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  return candidates.find(candidate => { try { return fs.existsSync(candidate) } catch { return false } }) ?? null
}

/** Pure argument builder (unit-testable without launching a browser). */
export function buildWindowSpec({ browser, url, id, type, profileDir }) {
  const [width, height] = windowSize(type)
  const target = url + (url.includes('?') ? '&' : '?') + 'compact=1'
  return {
    browser,
    args: [
      `--app=${target}`,
      `--window-size=${width},${height}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Edge shows a "现在正在你的所有设备上同步你的浏览数据" modal when a
      // fresh profile implicitly signs into the Windows account. It looks
      // like our plugin syncing the user's data, so suppress the whole
      // first-run / implicit sign-in / sync surface. Unknown switches are
      // ignored by Chrome, so the same list is safe for either browser.
      '--disable-first-run-experience',
      '--disable-sync',
      '--disable-signin-promo',
      '--bwsi',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--noerrdialogs',
      // Word is maximised and holds the foreground when the dialog spawns, so
      // the app window is born fully covered by it. Chromium's Windows
      // occlusion tracker then marks it occluded and pauses the renderer's
      // compositor; our external SetWindowPos raise shows the frame but the
      // tracker never reliably re-evaluates, so the window stays blank white
      // until a mouse click re-activates it. Keep these windows permanently
      // renderable (the trio Electron runs by default) and stop Chromium from
      // trusting native occlusion at all, so the raise alone restores paint.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-features=Translate,msEdgeSidebarV2,ImplicitSignIn,msEdgeWelcomePage,msFre,EdgeFRE,EdgeFirstRun,msEdgeIdentityFRE,CalculateNativeWinOcclusion,msEfficiencyMode',
    ],
    width, height, target,
  }
}

/** Short marker embedded in the page title so we can find this exact window. */
export function dialogMarker(id) { return ` #${String(id).slice(0, 4)}` }

/**
 * Win32 script that finds the chromeless dialog by its title marker and puts
 * it above every other window. Word is very often maximised and keeps the
 * foreground, so merely launching Chromium leaves the dialog hidden behind
 * it; HWND_TOPMOST is what actually guarantees the user can see and type in
 * the citation dialog. The page sets its title only after /office/api/state
 * resolves, hence the retry loop (up to ~8s).
 */
export function buildRaiseScript(marker) {
  return `Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DshDlgRaise {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr i);

  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  public struct RECT { public int L, T, R, B; }
  // Windows refuses plain SetForegroundWindow from a background process;
  // attaching to the foreground thread is the documented workaround.
  public static void ForceForeground(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    if (fg == h) return;
    uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint myThread = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != myThread) attached = AttachThreadInput(myThread, fgThread, true);
    SetForegroundWindow(h);
    BringWindowToTop(h);
    SwitchToThisWindow(h, true);
    if (attached) AttachThreadInput(myThread, fgThread, false);
  }
  // Deterministic paint kicker: a real input event on the caption bar (button
  // press + release, no client-area effect). When Word is maximised the dialog
  // is born fully covered; Chromium's occlusion tracker can then pause the
  // renderer and an external SetWindowPos raise does not reliably clear that
  // mark, so the raised window stays blank until genuine user input. Real-
  // machine testing showed exactly that state (title rendered, viewport white,
  // isfg+topmost true) and a single caption click repaints it instantly.
  public static void Nudge(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return;
    // Move+click as immediate neighbouring events (virtual-screen absolute
    // coords) so a user hand movement cannot redirect the click elsewhere.
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
    int vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    int tx = (r.L + r.R) / 2, ty = r.T + 14;
    uint ax = (uint)((tx - vx) * 65535 / Math.Max(vw - 1, 1));
    uint ay = (uint)((ty - vy) * 65535 / Math.Max(vh - 1, 1));
    mouse_event(0x8000 | 0x4000 | 0x0001, ax, ay, 0, UIntPtr.Zero);  // MOVE|VIRTUALDESK|ABSOLUTE
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);                       // LEFTDOWN
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);                       // LEFTUP
  }
  public static int Raise(string needle) {
    for (int i = 0; i < 40; i++) {
      IntPtr found = IntPtr.Zero;
      EnumWindows((h, l) => {
        if (!IsWindowVisible(h)) return true;
        var s = new StringBuilder(1024);
        GetWindowText(h, s, 1024);
        if (!s.ToString().Contains(needle)) return true;
        found = h;
        return false;
      }, IntPtr.Zero);
      if (found != IntPtr.Zero) {
        ShowWindow(found, 9);                                  // SW_RESTORE
        // Chromium finishes setting up its window shortly after the title
        // appears and Word (maximised) can reclaim the Z-order. Re-apply the
        // topmost flag for ~2s so a single early SetWindowPos is not lost.
        for (int j = 0; j < 8; j++) {
          SetWindowPos(found, new IntPtr(-1), 0, 0, 0, 0, 0x0043);  // HWND_TOPMOST | NOSIZE | NOMOVE | SHOWWINDOW
          ForceForeground(found);
          System.Threading.Thread.Sleep(250);
        }
        Nudge(found);
        return 1;
      }
      System.Threading.Thread.Sleep(200);
    }
    return 0;
  }
}
'@
[DshDlgRaise]::Raise(${JSON.stringify(marker)})
`
}

/** Fire-and-forget Win32 helper. Never blocks the integration transaction. */
function runWindowScript(script, logger, label) {
  try {
    const child = execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text',
        '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 30_000, encoding: 'buffer' },
      (error, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout ?? '')
        const err = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '')
        if (error) logger.warn?.(`library: ${label} failed: ${error.message}`)
        else if (out.trim() === '0') logger.warn?.(`library: ${label}: window not found`)
        else if (out.trim() === '2') logger.warn?.(`library: ${label}: window restored but Windows kept the foreground (taskbar button is flashing)`)
        else if (err && /error|exception/i.test(err)) logger.warn?.(`library: ${label}: ${err.slice(0, 200)}`)
      })
    child.unref?.()
  } catch (error) {
    logger.warn?.(`library: could not ${label}: ${error?.message ?? error}`)
  }
}

/**
 * Raise an already-open dialog to the top (also used by "打开待处理对话框").
 */
export function raiseDialogWindow(id, logger = console) {
  if (process.platform !== 'win32' || !id) return
  // Headless smoke runs never create a real window; skip the Win32 helper too.
  if (process.env.DSH_LIBRARY_OFFICE_NO_BROWSER === '1') return
  runWindowScript(buildRaiseScript(dialogMarker(id)), logger, 'raising citation dialog window')
}

/**
 * Win32 script that brings the dsh window to the foreground. Used when a Word
 * AI task is dispatched: the user must see dsh take over and work, instead of
 * everything happening behind Word's maximised window.
 *
 * The visible window is NOT always owned by this process: the desktop shell
 * runs the plugin host in a child process (this one) while the Electron main
 * process owns the window. `pids` therefore carries the candidates (own pid
 * first, then its parent), and the script falls back to any window owned by an
 * executable called "DeepSeek Harness.exe" — a browser tab showing the same
 * page belongs to another executable and is never mistaken for the app. dsh
 * may be on screen, minimised, or hidden in the tray (an invisible window, which
 * the old visible-only filter skipped exactly then).
 */
export function buildFocusSelfScript(pids) {
  const list = (Array.isArray(pids) ? pids : [pids])
    .map(pid => Number(pid))
    .filter(pid => Number.isInteger(pid) && pid > 0)
  return `Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class DshSelfFocus {
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

  // An ALT tap grants the foreground right without touching the target window's
  // content: a synthetic caption click could land on the app's own UI controls.
  static void Nudge() {
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
  }

  // Windows refuses plain SetForegroundWindow from a background process; the
  // documented workaround is attaching to the current foreground thread first.
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

  // Top-level windows worth showing: the real main window has a caption;
  // helper/message windows are WS_EX_TOOLWINDOW or captionless.
  static bool IsMainWindow(IntPtr h) {
    if ((GetWindowLong(h, -16) & 0x00C00000) == 0) return false;   // GWL_STYLE, WS_CAPTION
    if ((GetWindowLong(h, -20) & 0x00000080) != 0) return false;   // GWL_EXSTYLE, WS_EX_TOOLWINDOW
    return true;
  }

  static string ImageOf(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return "";
    try {
      var sb = new StringBuilder(1024);
      uint size = 1024;
      return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : "";
    } finally { CloseHandle(h); }
  }

  static bool IsOurApp(uint pid) {
    string path = ImageOf(pid);
    return path.EndsWith("DeepSeek Harness.exe", StringComparison.OrdinalIgnoreCase);
  }

  static void Add(List<IntPtr> found, List<long> score, IntPtr h) {
    for (int i = 0; i < found.Count; i++) if (found[i] == h) return;
    found.Add(h);
    score.Add(GetWindowTextLength(h));
  }

  // Returns 1 when a dsh window took the foreground, 2 when it was brought back
  // (taskbar flashing) but Windows kept the foreground with the other app, 0
  // when no candidate window was found at all.
  //
  // The pids array holds the candidates in priority order: the plugin host
  // process does NOT own the visible window when the desktop shell runs the
  // host in a child process, so the Electron main process (the parent) has to
  // be tried too. As a last resort any window whose executable is
  // "DeepSeek Harness.exe" and whose title mentions the app is accepted — a
  // browser tab showing the web UI is a different executable and is therefore
  // never focused by mistake.
  public static int Focus(uint[] pids) {
    var found = new List<IntPtr>();
    var score = new List<long>();
    foreach (uint pid in pids) {
      if (pid == 0) continue;
      uint target = pid;
      EnumWindows((h, l) => {
        uint owner;
        GetWindowThreadProcessId(h, out owner);
        if (owner == target && IsMainWindow(h)) Add(found, score, h);
        return true;
      }, IntPtr.Zero);
    }
    if (found.Count == 0) {
      EnumWindows((h, l) => {
        if ((GetWindowLong(h, -20) & 0x00000080) != 0) return true;   // WS_EX_TOOLWINDOW
        var t = new StringBuilder(512);
        GetWindowText(h, t, 512);
        if (t.Length == 0 || !t.ToString().Contains("DeepSeek Harness")) return true;
        uint owner;
        GetWindowThreadProcessId(h, out owner);
        if (!IsOurApp(owner)) return true;
        Add(found, score, h);
        return true;
      }, IntPtr.Zero);
    }
    if (found.Count == 0) return 0;
    // Try longest title first, until one window actually holds the foreground.
    for (int i = 0; i < found.Count; i++) {
      int w = i;
      for (int j = i + 1; j < found.Count; j++) if (score[j] > score[w]) w = j;
      IntPtr t = found[i]; found[i] = found[w]; found[w] = t;
      long ts = score[i]; score[i] = score[w]; score[w] = ts;
    }
    IntPtr primary = found[0];
    foreach (IntPtr h in found) {
      if (h == IntPtr.Zero) continue;
      if (!IsWindowVisible(h)) ShowWindow(h, 5);    // SW_SHOW — back out of the tray
      if (IsIconic(h)) ShowWindow(h, 9);            // SW_RESTORE — un-minimise
      ForceForeground(h);
      System.Threading.Thread.Sleep(120);
      if (GetForegroundWindow() == h) return 1;
    }
    if (primary != IntPtr.Zero) {
      if (!IsWindowVisible(primary)) ShowWindow(primary, 5);
      if (IsIconic(primary)) ShowWindow(primary, 9);
      // Foreground-lock fallback: an ALT tap grants the switch without clicking
      // anything inside the window.
      Nudge();
      ForceForeground(primary);
      System.Threading.Thread.Sleep(200);
      if (GetForegroundWindow() == primary) return 1;
      // Still refused: flash the taskbar button until the user brings dsh up,
      // so a denied switch is still noticed.
      FLASHWINFO fw;
      fw.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO));
      fw.hwnd = primary;
      fw.dwFlags = 0x3 | 0xC;                       // FLASHW_ALL | FLASHW_TIMERNOFG
      fw.uCount = 10;
      fw.dwTimeout = 0;
      FlashWindowEx(ref fw);
    }
    return 2;
  }
}
'@
[DshSelfFocus]::Focus([uint32[]]@(${list.join(', ') || '0'}))
`
}

/**
 * Bring the dsh main window to the front so the user watches the assistant
 * work on a Word AI task. The window may be minimised or hidden in the tray —
 * the script restores/shows it first. If Windows' foreground lock refuses the
 * switch, the taskbar button flashes until the user clicks it. Fire-and-forget;
 * never blocks the caller.
 */
export function focusMainWindow(logger = console) {
  if (process.platform !== 'win32') return
  if (process.env.DSH_LIBRARY_OFFICE_NO_BROWSER === '1') return
  // The desktop shell may run this host in a child process: the window then
  // belongs to the parent (Electron main), not to us.
  const candidates = [process.pid, process.ppid].filter((pid, index, all) => (
    Number.isInteger(pid) && pid > 0 && all.indexOf(pid) === index
  ))
  runWindowScript(buildFocusSelfScript(candidates), logger, 'focusing the dsh window')
}

/**
 * Seed a brand-new Chromium profile so the first launch is not treated as a
 * first run. `First Run` is the sentinel Chromium checks; the two JSON files
 * additionally opt out of sign-in/sync. Never overwrite an existing profile.
 */
export function seedDialogProfile(profileDir) {
  fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true })
  const writeOnce = (file, value) => {
    if (fs.existsSync(file)) return
    try { fs.writeFileSync(file, value) } catch { /* best effort */ }
  }
  writeOnce(path.join(profileDir, 'First Run'), '')
  writeOnce(path.join(profileDir, 'Local State'), JSON.stringify({
    browser: { enabled_labs_experiments: [] },
    profile: {
      last_used: 'Default',
      info_cache: { Default: { name: '文库引用' } },
    },
    user_experience_metrics: { stability: { exited_cleanly: true } },
  }))
  writeOnce(path.join(profileDir, 'Default', 'Preferences'), JSON.stringify({
    profile: { name: '文库引用', exit_type: 'Normal', exited_cleanly: true },
    browser: { has_seen_welcome_page: true },
    signin: { allowed: false, allowed_on_next_startup: false },
    sync: { requested: false, keep_everything_synced: false },
    first_run_tabs: [],
  }))
}

/**
 * Open a standalone dialog window.
 * @returns {boolean} whether a chromeless window was launched.
 */
export function openDialogWindow({ url, id, type, home, logger = console }) {
  const browser = findBrowser()
  if (!browser) return false
  const profileDir = path.join(home, 'dialog-profile')
  try { seedDialogProfile(profileDir) } catch (error) {
    logger.warn?.(`library: could not seed dialog profile: ${error?.message ?? error}`)
  }
  const spec = buildWindowSpec({ browser, url, id, type, profileDir })
  try {
    const child = spawn(browser, spec.args, {
      detached: true, stdio: 'ignore', windowsHide: false,
    })
    child.on('error', error => logger.warn?.(`library: dialog window failed: ${error?.message ?? error}`))
    child.unref?.()
    raiseDialogWindow(id, logger)
    return true
  } catch (error) {
    logger.warn?.(`library: could not launch dialog window: ${error?.message ?? error}`)
    return false
  }
}

const CLOSE_SCRIPT = marker => `Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DshDlgCloser {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr res);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static int Close(string needle) {
    int n = 0;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var s = new StringBuilder(1024);
      GetWindowText(h, s, 1024);
      if (!s.ToString().Contains(needle)) return true;
      PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
      PostMessage(h, 0x0112, new IntPtr(0xF060), IntPtr.Zero);
      // Chromium swallows queued WM_CLOSE from another process; the synchronous
      // variant is the one that actually tears the app window down.
      IntPtr ignored;
      SendMessageTimeout(h, 0x0010, IntPtr.Zero, IntPtr.Zero, 0x0002, 2000, out ignored);
      n++;
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
'@
[DshDlgCloser]::Close(${JSON.stringify(marker)})
`

/** Ask the standalone window to close itself (fire-and-forget). */
export function closeDialogWindow(id, logger = console) {
  if (process.platform !== 'win32' || !id) return
  runWindowScript(CLOSE_SCRIPT(dialogMarker(id)), logger, 'closing dialog window')
}
