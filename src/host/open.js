// Opening library files with the system's default application.
import { spawn } from 'node:child_process'

/**
 * Open a file or URL in the operating system's default application.
 * @param {string} target - absolute path or URL.
 * @returns {boolean} whether a launcher was started.
 */
export function openExternal(target) {
  const value = String(target ?? '')
  if (value === '') return false
  try {
    if (process.platform === 'win32') {
      // explorer.exe performs ShellExecute on the path without cmd re-parsing it.
      spawn('explorer.exe', [value], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
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
  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', [`/select,${value}`], { detached: true, stdio: 'ignore' }).unref()
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
