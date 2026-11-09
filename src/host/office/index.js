// Entry point of the rewritten word-processor integration.
//
//   Word (.dotm VBA)  <-- Zotero HTTP integration protocol -->  server.js
//   server.js         --> commands.js (Interface / execCommand)
//   commands.js       --> session.js (fields, citeproc, bibliography)
//   dialogs.js        --> pages.js  (citation / prefs / bibliography / explorer)
//   installer.js      --> assets/word (VBA + customUI -> Zotero.dotm)
import { dataDir } from '../settings.js'
import { createStyleStore } from './csl-styles.js'
import { createItemProvider } from './items.js'
import { createDialogManager } from './dialogs.js'
import { createIntegration } from './commands.js'
import { createOfficeServer } from './server.js'
import { createWordInstaller } from './installer.js'
import { createAiTasks } from './ai-tasks.js'
import { createReportGenerator } from './report.js'
import { focusMainWindow } from './window.js'

export function createOfficeService({ runtime, logger = console, packageDir, version = '0.2.1' }) {
  const home = dataDir()
  const styles = createStyleStore({ logger, packageDir, home })
  const items = createItemProvider({ withDb: fn => runtime.withDb(fn) })
  const dialogs = createDialogManager({ styles, items, logger, home })
  // Word AI tasks dispatch into the 文献助手 chat (runtime.chat) and focus the
  // dsh window so the user watches the assistant work.
  const ai = createAiTasks({
    chat: {
      open: options => runtime.chat.open(options),
      send: (text, context) => runtime.chat.send(text, context),
    },
    focus: () => focusMainWindow(logger),
    logger,
  })
  const integration = createIntegration({ styles, items, dialogs, ai, logger, version })
  // Word reports generated entirely host-side (no Word needed): the agent
  // writes a .docx with real Zotero citation fields + bibliography field.
  const report = createReportGenerator({ styles, items, home, logger, version })
  const server = createOfficeServer({ integration, dialogs, styles, ai, logger, version })
  dialogs.setBaseUrl(() => server.baseUrl())
  const installer = createWordInstaller({
    logger, version, packageDir, home,
    getPort: () => server.port,
  })

  async function start(port = 0) {
    return server.start(Number(port) || 0)
  }

  async function restart(port = 0) {
    server.stop()
    return start(port)
  }

  async function status() {
    return {
      server: server.status(),
      install: await installer.status({ fresh: false }),
    }
  }

  function dispose() {
    server.stop()
  }

  // The service listens even before a library is selected: the Word buttons
  // then produce a clear error instead of appearing to do nothing.
  void start().catch((error) => {
    logger.warn?.(`library: word integration server failed to start: ${error?.message ?? error}`)
  })

  return {
    start, restart, stop: () => server.stop(), status, dispose,
    styles, items, dialogs, integration, server, installer, ai, report,
  }
}
