// Opening library files with the system's default application.
import fs from 'node:fs'
import { spawn } from 'node:child_process'

// Smoke-suite hook: when DSH_LIBRARY_OPEN_SINK names a file, "opens" are
// appended there as JSON lines instead of spawning a real browser/Explorer.
const openSink = process.env.DSH_LIBRARY_OPEN_SINK ?? ''

function recordSink(kind, target) {
  try {
    fs.appendFileSync(openSink, `${JSON.stringify({ kind, target })}\n`)
  } catch {
    // A broken sink must not break opening itself.
  }
}

/**
 * Open a file or URL with the operating system's default application.
 * @param {string} target - absolute path or URL.
 * @returns {boolean} whether a launcher was started.
 */
export function openExternal(target) {
  const value = String(target ?? '')
  if (value === '') return false
  if (openSink !== '') {
    recordSink('open', value)
    return true
  }
  try {
    if (process.platform === 'win32') {
      if (/^https?:\/\//i.test(value)) {
        // explorer.exe opens files reliably, but handing it an http(s) URL
        // from an Electron host silently does nothing (office dialogs never
        // appeared). FileProtocolHandler goes straight through the shell
        // association without cmd's argument re-parsing (trap 8).
        spawn('rundll32.exe', ['url.dll,FileProtocolHandler', value], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      } else {
        // explorer.exe performs ShellExecute on the path without cmd re-parsing it.
        spawn('explorer.exe', [value], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      }
    } else if (process.platform === 'darwin') {
      spawn('open', [value], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [value], { detached: true, stdio: 'ignore' }).unref()
    }
    return true
  } catch {
    return false
  }
}

/** Open the containing folder and select the file when the platform supports it. */
export function revealInFolder(target) {
  const value = String(target ?? '')
  if (value === '') return false
  if (openSink !== '') {
    recordSink('reveal', value)
    return true
  }
  try {
    if (process.platform === 'win32') {
      // The flag and the path must be SEPARATE arguments. Node quotes an
      // argument containing spaces as a whole (`"/select,C:\a b\c.pdf"`),
      // which Explorer cannot parse — it silently opens the default shell
      // folder (Documents) instead. With `/select,` on its own the path is
      // quoted alone, and file names containing commas survive too.
      spawn('explorer.exe', ['/select,', value], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', ['-R', value], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [target.replace(/[\\/][^\\/]*$/, '')], { detached: true, stdio: 'ignore' }).unref()
    }
    return true
  } catch {
    return false
  }
}
