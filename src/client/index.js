// Browser half of dsh-library: a Zotero-like library rendered as a main panel.
import { LibraryPage } from './library-page.jsx'
import { LibraryFooterEntry } from './footer.jsx'
import { LibraryChatArea } from './chat-dock.jsx'
import { LibrarySettingsSection } from './settings-section.jsx'
import { installStyles } from './styles.js'

export const name = 'dsh-library'
export const inject = ['slots', 'layout']

/**
 * The settings panel's open state is shell-owned and exposes no service, so
 * the library's gear button replays the shell's own "settings.open" shortcut:
 * resolve the effective binding from the catalog (user remaps honored) and
 * synthesize that key event.
 */
function dispatchSettingsShortcut(shortcuts) {
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
    console.warn('[dsh-library] opening the settings panel failed', error)
  }
}

export function apply(ctx) {
  ctx.effect(() => installStyles(), 'library: styles')

  // The left sidebar's foot entry, beside Settings: one click opens the library,
  // a second click returns to the conversation.
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-library',
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
