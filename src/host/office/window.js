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
