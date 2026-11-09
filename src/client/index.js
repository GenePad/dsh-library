// Browser half of dsh-zot-library: a Zotero-like library rendered as a main panel.
import { LibraryPage } from './library-page.jsx'
import { LibraryFooterEntry } from './footer.jsx'
import { LibraryChatArea } from './chat-dock.jsx'
import { LibrarySettingsSection } from './settings-section.jsx'
import { installStyles } from './styles.js'

export const name = 'dsh-zot-library'
export const inject = ['slots', 'layout']

/**
 * Jump the open settings panel to the 文库 section. The shell's nav rows expose
 * no section ids (SettingsRoot renders plain buttons keyed by label), so match
 * our section's label inside the modal nav; the modal mounts through a portal
 * a frame after open, hence the short retry.
 */
function selectLibrarySection(attempt = 0) {
  const panel = document.querySelector('[role="dialog"][data-shortcut-modal="settings"]')
  const button = panel
    ? [...panel.querySelectorAll('nav button')].find(node => node.textContent?.trim() === '文库')
    : undefined
  if (button) {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return
  }
  if (attempt < 24) setTimeout(() => selectLibrarySection(attempt + 1), 50)
}

/**
 * The settings panel's open state is shell-owned and exposes no service, so
 * the library's gear button runs the shell's own "settings.open" command and
 * then lands on the 文库 section (already open → just jump, no toggle-close).
 * Primary path invokes the command in the shortcut registry (desktop gestures
 * arrive over the native Electron bridge and are NEVER dispatched from DOM key
 * events, so a synthesized KeyboardEvent is silently ignored there); the
 * fallback replays the effective binding as a key event for web-shaped hosts.
 */
function dispatchSettingsShortcut(shortcuts) {
  const panel = document.querySelector('[role="dialog"][data-shortcut-modal="settings"]')
  if (!panel) {
    const registry = shortcuts?.registry
    let opened = false
    if (registry && typeof registry.invoke === 'function') {
      try {
        // Mirror the shell's own modal detection (shortcuts/dom.ts): an open
        // foreign dialog must not be covered silently.
        const modals = document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="menu"]')
        const top = modals.length > 0 ? modals[modals.length - 1] : undefined
        const modal = top ? (top.dataset?.shortcutModal ?? 'other') : null
        registry.invoke('settings.open', { target: document.activeElement ?? document.body, region: 'page', modal })
        opened = true
      } catch {
        // Registry shape changed across a dsh upgrade — fall through.
      }
    }
    if (!opened) {
      let binding = null
      try {
        const row = shortcuts?.catalog?.getSnapshot?.().find(entry => entry.id === 'settings.open')
        binding = row?.binding ?? null
      } catch {
        // Service unavailable — fall through to the platform defaults below.
      }
      if (!binding) {
        const runtime = shortcuts?.runtime ?? 'desktop'
        const platform = shortcuts?.platform ?? 'windows'
        binding = runtime === 'web'
          ? { code: 'Comma', modifiers: ['control', 'alt'] }
          : { code: 'Comma', modifiers: [platform === 'macos' ? 'meta' : 'control'] }
      }
      try {
        window.dispatchEvent(new KeyboardEvent('keydown', {
          code: binding.code,
          ctrlKey: binding.modifiers.includes('control'),
          altKey: binding.modifiers.includes('alt'),
          shiftKey: binding.modifiers.includes('shift'),
          metaKey: binding.modifiers.includes('meta'),
          bubbles: true,
          cancelable: true,
        }))
      } catch (error) {
        console.warn('[dsh-zot-library] opening the settings panel failed', error)
      }
    }
  }
  selectLibrarySection()
}

export function apply(ctx) {
  ctx.effect(() => installStyles(), 'library: styles')

  // One-time carry-over of UI prefs saved under the previous package name's
  // prefix (dsh-library → dsh-zlibrary → dsh-zot-library). Idempotent: after
  // the first run the legacy keys are gone and this becomes a no-op.
  ctx.effect(() => {
    for (const suffix of ['view', 'sort', 'details-open', 'columns', 'column-widths', 'sections', 'collections-expanded', 'reader-split']) {
      const legacy = localStorage.getItem(`dsh-library:${suffix}`)
      if (legacy === null) continue
      const key = `dsh-zot-library:${suffix}`
      if (localStorage.getItem(key) === null) localStorage.setItem(key, legacy)
      localStorage.removeItem(`dsh-library:${suffix}`)
    }
  }, 'library: storage migration')

  // The left sidebar's foot entry, beside Settings: one click opens the library,
  // a second click returns to the conversation.
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-zot-library',
    order: -50,
    inject: () => ({ layout: ctx.layout }),
  }, LibraryFooterEntry)), 'library: sidebar entry')

  // Native conversation support for the 文献助手 dock:
  // - `sessions` retains a SessionReference for the Library workspace session,
  //   which the dock binds through SessionProvider;
  // - `uiWorkspace` remains the fallback jump when no sessions service exists.
  let retainSession
  let openNativeSession
  ctx.effect(() => ctx.inject(['sessions'], (scoped) => {
    retainSession = (sessionId, signal) => scoped.sessions.retain(sessionId, { source: 'libraryDock', signal })
    return () => { retainSession = undefined }
  }), 'library: session bridge')
  ctx.effect(() => ctx.inject(['uiWorkspace'], (scoped) => {
    openNativeSession = (sessionId) => scoped.uiWorkspace.openSession(sessionId)
    return () => { openNativeSession = undefined }
  }), 'library: native session bridge')

  // The 文库 gear button opens dsh's native settings panel via the shell's own
  // settings.open shortcut (see dispatchSettingsShortcut above).
  let openSettings
  ctx.effect(() => ctx.inject(['shortcuts'], (scoped) => {
    openSettings = () => dispatchSettingsShortcut(scoped.shortcuts)
    return () => { openSettings = undefined }
  }), 'library: settings bridge')

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'library',
    // The dock hosts one embedded Conversation for the Library session.
    children: { 'library.chat.area': { kind: 'single', scope: 'session' } },
    inject: () => ({
      layout: ctx.layout,
      openSettings: () => openSettings?.(),
      retainSession: (sessionId, signal) => retainSession?.(sessionId, signal),
      openNativeSession: (sessionId) => openNativeSession?.(sessionId),
    }),
  }, LibraryPage)), 'library: main panel')

  // The 文库 page inside dsh's native settings modal: source / PDF & export /
  // WebDAV / update, built from the host's own atoms.
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'library',
    order: 60,
    label: () => '文库',
  }, LibrarySettingsSection)), 'library: settings section')

  // The docked Conversation occurrence: renders the shared `conversation.content`
  // Factory (native transcript + composer) with its View pinned to Chat.
  ctx.effect(() => ctx.slots.inject('library.chat.area', () => ctx.slots.register({
    name: 'library.chat.area',
  }, LibraryChatArea)), 'library: docked conversation')
}
