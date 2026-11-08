// Runtime: database lifecycle, storage watcher, import queue, sync, updates.
import fs from 'node:fs'
import path from 'node:path'
import { ZoteroDb } from './db.js'
import { locateZotero } from './locate.js'
import { dataDir, loadSettings, loadState, publicSettings, saveSettings, saveState } from './settings.js'
import { attachmentTarget, readAnnotations, readCollections, readItem, readItems, readStats, readTags } from './read.js'
import { createItem, updateItem, trashItems, deleteForever, createCollection, renameCollection, trashCollection, createAnnotationRecord, updateAnnotationRecord, removeAnnotationRecord, changeItemType, createNoteItem, updateNoteItem, createUrlAttachment, duplicateItem, createParentAttachment, detachAttachment, mergeItems, noteFromAnnotations } from './write.js'
import { typeList, typeSchema, planTypeChange } from './schema.js'
import { resolveEachIdentifier } from './metadata.js'
import { importFile, importStagedFile, finalizeImportFile, recognizeItemMetadata } from './ingest.js'
import { createStorageWatcher } from './watcher.js'
import { WebDavClient, syncStorage } from './webdav.js'
import { openExternal, revealInFolder } from './open.js'
import { fileApplications, openWithApplication } from './assoc.js'
import { PluginUpdater } from './updater.js'
import { createStandaloneLibrary } from './standalone.js'
import { ensureSession, openSession, readPage, sendMessage, stopTurn, workspaceDir } from './chat.js'
import { createTranslator } from './translate.js'
import { safeFileName, safeUnlink } from './util.js'

/** The library runtime shared by the API channel and tools. */
export function createLibraryRuntime({ ctx, config = {}, logger = console, packageDir }) {
  const home = dataDir()
  let settings = loadSettings()
  let state = loadState()
  let located
  let database
  let watcher
  let revision = 0
  let importChain = Promise.resolve()
  let syncTask
  let syncResult
  let autoSyncTimer

  const bump = () => {
    revision += 1
    return revision
  }

  function getSettings() {
    return settings
  }

  function paths() {
    if (located === undefined) {
      if (settings.mode === 'standalone') {
        located = createStandaloneLibrary(path.join(home, 'data'), logger)
        return located
      }
      const override = settings.zoteroDataDir || config.zoteroDataDir
      // First open: ask before touching the user's Zotero data. An explicit
      // directory (config or settings) counts as the answer "link".
      if (settings.mode !== 'zotero' && !override) {
        throw Object.assign(new Error(
          'The library source is not chosen yet. Open the library panel and link Zotero or create a standalone library.',
        ), { code: 'library/needs-choice' })
      }
      const found = locateZotero({ override })
      if (!found) {
        throw Object.assign(new Error(override
          ? `No zotero.sqlite under ${override}. Point the data directory at the Zotero folder, or switch to a standalone library.`
          : 'No Zotero data directory was found. Link your Zotero library or create a standalone one from the library page.'), { code: 'library/no-library' })
      }
      located = found
    }
    return located
  }

  /** Choose the library source: link Zotero ('zotero') or go standalone. */
  function setupLibrary(mode) {
    if (mode !== 'zotero' && mode !== 'standalone') {
      throw Object.assign(new Error('mode must be "zotero" or "standalone"'), { code: 'library/invalid' })
    }
    settings = saveSettings({ mode })
    located = undefined
    closeDb()
    if (mode === 'standalone') createStandaloneLibrary(path.join(home, 'data'), logger)
    startWatcher()
    bump()
    return stateSnapshot()
  }

  // Zotero is the source of truth; before the first local write of a run, keep
  // a full copy so a bad edit can always be reverted.
  let backupTaken = false
  function ensureBackup() {
    if (backupTaken) return
    const where = paths()
    const dir = path.join(home, 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = path.join(dir, `zotero-${stamp}.sqlite`)
    fs.copyFileSync(where.dbPath, target)
    const backups = fs.readdirSync(dir).filter(name => /^zotero-.*\.sqlite$/.test(name)).sort()
    for (const stale of backups.slice(0, Math.max(0, backups.length - 3))) {
      try {
        safeUnlink(path.join(dir, stale))
      } catch {
        // An old backup that cannot be removed is harmless.
      }
    }
    backupTaken = true
  }

  function closeDb() {
    try {
      database?.close()
    } finally {
      database = undefined
    }
  }

  function db() {
    if (database !== undefined) return database
    const where = paths()
    if (!fs.existsSync(where.dbPath)) {
      throw Object.assign(new Error(`zotero.sqlite is missing under ${where.dataDir}`), { code: 'library/no-library' })
    }
    const instance = new ZoteroDb({ dbPath: where.dbPath, logger })
    instance.open()
    // Expose storageDir to read helpers through the instance.
    instance.storageDir = where.storageDir
    database = instance
    try {
      instance.schema()
    } catch (error) {
      closeDb()
      throw error
    }
    return instance
  }

  /** Run a database operation, reopening once if the file was replaced underneath us. */
  function withDb(fn) {
    try {
      return fn(db())
    } catch (error) {
      if (String(error?.code ?? '').startsWith('ERR_SQLITE') && /disk I\/O|malformed|not a database|unable to open/i.test(String(error?.message))) {
        closeDb()
        return fn(db())
      }
      throw error
    }
  }

  function startWatcher() {
    if (watcher !== undefined) {
      watcher.dispose()
      watcher = undefined
    }
    let where
    try {
      where = paths()
    } catch {
      return
    }
    let instance
    try {
      instance = db()
    } catch (error) {
      logger.warn?.(`library: storage watcher not started: ${error?.message ?? error}`)
      return
    }
    watcher = createStorageWatcher({
      storageDir: where.storageDir,
      db: instance,
      logger,
      onChange: (keys) => {
        bump()
        logger.info?.(`library: attachment files changed (${keys.join(', ')})`)
      },
    })
  }

  function refreshSettings(patch) {
    settings = saveSettings(patch)
    located = undefined
    closeDb()
    startWatcher()
    bump()
    return publicSettings()
  }

  /**
   * A running Zotero holds the rollback-journal lock on zotero.sqlite; every
   * direct connection (even read-only) gets SQLITE_BUSY until it exits. Report
   * that case with its own code so the UI can explain and auto-recover.
   */
  function lockedError(error) {
    const text = `${error?.code ?? ''} ${error?.message ?? error}`
    if (/database is locked|ERR_SQLITE_BUSY/i.test(text)) {
      return {
        code: 'library/db-locked',
        message: 'Zotero 正在运行并锁定了数据库（zotero.sqlite）。退出 Zotero 后文库会自动恢复，无需重启 dsh。',
      }
    }
    return { code: error?.code ?? 'library/error', message: String(error?.message ?? error) }
  }

  function stateSnapshot() {
    const base = { settings: publicSettings(), sync: { running: syncTask !== undefined, last: syncResult }, revision, version: config.version }
    try {
      const where = paths()
      const stats = withDb(instance => readStats(instance))
      return {
        ...base,
        available: true,
        dataDir: where.dataDir,
        dbPath: where.dbPath,
        storageDir: where.storageDir,
        source: where.source,
        mode: settings.mode,
        schemaVersion: stats.schemaVersion,
        counts: stats,
      }
    } catch (error) {
      // With no choice made yet, tell the browser whether Zotero exists so the
      // first-open dialog can offer "link" next to "standalone".
      let zoteroFound
      if (settings.mode === 'unset') {
        try {
          zoteroFound = locateZotero({ override: settings.zoteroDataDir || config.zoteroDataDir }) !== undefined
        } catch {
          zoteroFound = false
        }
      }
      return {
        ...base,
        available: false,
        mode: settings.mode,
        needsChoice: settings.mode === 'unset',
        zoteroFound,
        error: lockedError(error),
      }
    }
  }

  function importOne(input) {
    const run = async () => {
      ensureBackup()
      const result = await importFile(db(), paths(), {
        filePath: input.filePath,
        parentKey: input.parentKey,
        collectionID: input.collectionID,
        lookup: input.lookup,
        metadata: input.metadata,
        logger,
      })
      bump()
      return result
    }
    importChain = importChain.then(run, run)
    return importChain
  }

  // Two-phase drag import: the staged step runs right away (one attachment
  // row) so the browser can reveal it; finalize joins the queue behind any
  // other pending imports since it extracts text and looks metadata up online.
  function importStaged(input) {
    ensureBackup()
    return importStagedFile(db(), paths(), { ...input, logger }).then((result) => {
      bump()
      return result
    })
  }

  function finalizeOne(input) {
    const run = async () => {
      ensureBackup()
      const result = await finalizeImportFile(db(), paths(), {
        attachmentKey: input.attachmentKey,
        collectionID: input.collectionID,
        lookup: input.lookup,
        metadata: input.metadata,
        logger,
      })
      bump()
      return result
    }
    importChain = importChain.then(run, run)
    return importChain
  }

  // Re-fetch metadata for an item that already has one (重识别走同一队列，
  // 避免与导入的 PDF 提取并发争用)。
  function recognizeOne(input) {
    const run = async () => {
      ensureBackup()
      const result = await recognizeItemMetadata(db(), paths(), {
        key: input.key,
        metadata: input.metadata,
        lookup: input.lookup,
        logger,
      })
      bump()
      return result
    }
    importChain = importChain.then(run, run)
    return importChain
  }

  function saveUpload(name, base64) {
    const buffer = Buffer.from(String(base64 ?? ''), 'base64')
    if (buffer.byteLength === 0) throw Object.assign(new Error('The uploaded file is empty'), { code: 'library/invalid' })
    const uploads = path.join(home, 'uploads')
    fs.mkdirSync(uploads, { recursive: true })
    const target = path.join(uploads, `${Date.now()}-${safeFileName(name)}`)
    fs.writeFileSync(target, buffer)
    return target
  }

  async function runSync() {
    if (syncTask !== undefined) return syncTask
    const settingsNow = getSettings()
    if (settingsNow.webdav.url === '') throw Object.assign(new Error('WebDAV is not configured'), { code: 'library/webdav-missing' })
    const client = new WebDavClient(settingsNow.webdav)
    syncTask = (async () => {
      try {
        const result = await syncStorage({ db: db(), storageDir: paths().storageDir, client, logger })
        syncResult = { at: new Date().toISOString(), ...result }
        bump()
        return syncResult
      } finally {
        syncTask = undefined
      }
    })()
    return syncTask
  }

  const updater = new PluginUpdater({
    packageDir,
    dataDir: home,
    currentVersion: config.version,
    feedUrl: () => getSettings().updateFeed || config.updateFeed || '',
    logger,
  })

  // One-shot reader translations ride dsh's own llm service (bridged lazily by
  // index.js — hosts without it keep the whole library working).
  const translator = createTranslator({ extensions: config.extensions ?? {}, getSettings, logger })

  function openRecord(key, reveal = false) {
    // resolveAttachment handles both shapes: a top-level attachment key
    // resolves to itself (its self row carries no `key` — feeding it into
    // attachmentTarget made path.join receive `undefined`), anything else
    // prefers its PDF child, then any child attachment.
    const { target } = resolveAttachment(key)
    if (target.kind === 'url') {
      openExternal(target.url)
      return { opened: target.url }
    }
    if (target.kind !== 'file' || !fs.existsSync(target.path)) {
      throw Object.assign(new Error(`附件文件不存在：${target.path}`), { code: 'library/not-found' })
    }
    const opened = reveal ? revealInFolder(target.path) : openExternal(target.path)
    return { opened: target.path, ok: opened }
  }

  // Open a web link from the built-in reader (PDF hyperlinks) in the system
  // browser. Only http(s) is allowed — everything else (file:, javascript:, …)
  // is rejected before it can reach the OS shell.
  function openUrl(rawUrl) {
    const value = String(rawUrl ?? '')
    let parsed
    try {
      parsed = new URL(value)
    } catch {
      throw Object.assign(new Error(`Invalid URL: ${value}`), { code: 'library/invalid-url' })
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw Object.assign(new Error(`Only http(s) links can be opened, got "${parsed.protocol}"`), { code: 'library/invalid-url' })
    }
    const opened = openExternal(parsed.href)
    return { opened: parsed.href, ok: opened }
  }

  // Resolve one attachment to its on-disk file for the built-in reader. Accepts
  // either an attachment key or a parent item key (like openRecord).
  function resolveAttachment(key) {
    const detail = withDb(instance => readItem(instance, String(key ?? ''), paths()))
    // A top-level attachment resolves to itself; anything else prefers its PDF child.
    let attachment
    if (detail.itemType === 'attachment' && detail.attachment) {
      attachment = {
        key: detail.key,
        title: detail.title,
        contentType: detail.attachment.contentType,
        rawPath: detail.attachment.rawPath,
        linkMode: detail.attachment.linkMode,
      }
    } else {
      const pdf = (detail.attachments ?? []).find(entry => entry.contentType === 'application/pdf')
      attachment = pdf ?? (detail.attachments ?? [])[0]
    }
    if (!attachment) throw Object.assign(new Error('该条目没有可打开的附件'), { code: 'library/not-found' })
    const target = attachmentTarget(paths().storageDir, attachment.key, attachment.rawPath, attachment.linkMode)
    if (target.kind !== 'file' || !fs.existsSync(target.path)) {
      throw Object.assign(new Error(`附件文件不存在：${target.path}`), { code: 'library/not-found' })
    }
    return {
      detailKey: detail.key,
      detailTitle: detail.title ?? '',
      attachment,
      target,
    }
  }

  // 「打开方式」数据源：当前附件的注册应用（含默认标记与图标 data URL）。
  function openApps(key) {
    const { target } = resolveAttachment(key)
    return fileApplications(target.path).then(apps => ({ apps }))
  }

  // 用用户在菜单里选中的注册应用打开附件；id 不在缓存列表内时拒绝。
  function openWith(key, application) {
    const { target } = resolveAttachment(key)
    return openWithApplication(target.path, application)
  }

  // Metadata for the binary reader route (no base64 round trip).
  function attachmentFileInfo(key) {
    const { detailKey, attachment, target } = resolveAttachment(key)
    return {
      key: attachment.key,
      parentKey: detailKey,
      title: attachment.title || '',
      fileName: path.basename(target.path),
      contentType: attachment.contentType || 'application/pdf',
      path: target.path,
      size: fs.statSync(target.path).size,
    }
  }

  const runtime = {
    ctx,
    logger,
    home,
    getSettings,
    paths,
    db,
    withDb,
    bump,
    state: stateSnapshot,
    /** The raw mutable chat state (chatSessionId / chatContext) for the prompt section. */
    chatState: () => state,
    /** The Library workspace directory (session-cwd gate for the guidance section). */
    workspaceDir: () => workspaceDir(home),
    collections: () => withDb(instance => readCollections(instance)),
    tags: () => withDb(instance => readTags(instance)),
    items: filter => withDb(instance => readItems(instance, filter)),
    item: key => withDb(instance => readItem(instance, key, paths())),
    create: input => {
      ensureBackup()
      const created = withDb(instance => createItem(instance, input))
      bump()
      return { key: created.key }
    },
    update: (key, patch) => {
      ensureBackup()
      withDb(instance => updateItem(instance, key, patch))
      bump()
      return { key, updated: true }
    },
    changeType: (key, itemType, confirm) => withDb((instance) => {
      // First call plans (the client confirms the dropped fields), the second applies.
      if (confirm === true) {
        ensureBackup()
        const result = withDb(instance2 => changeItemType(instance2, key, itemType))
        bump()
        return result
      }
      const meta = instance.schema()
      const row = instance.get('SELECT itemID, itemTypeID FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, String(key ?? ''))
      if (!row) throw Object.assign(new Error(`No item with key ${key}`), { code: 'library/not-found' })
      const fromType = meta.itemTypeNames.get(row.itemTypeID)
      const stored = instance.all(
        'SELECT f.fieldName FROM itemData d JOIN fieldsCombined f ON f.fieldID = d.fieldID WHERE d.itemID = ?', row.itemID,
      ).map(entry => entry.fieldName)
      const plan = planTypeChange(fromType, itemType, stored)
      return { key, itemType, transferred: plan.transfers, dropped: plan.dropped }
    }),
    /** Add-by-Identifier: resolve every DOI/ISBN/arXiv/PMID in a block of text. */
    lookupMany: async text => {
      const drafts = await resolveEachIdentifier(String(text ?? ''))
      return { drafts }
    },
    noteCreate: input => {
      ensureBackup()
      const created = withDb(instance => createNoteItem(instance, input))
      bump()
      return { key: created.key }
    },
    noteUpdate: (key, text) => {
      ensureBackup()
      const updated = withDb(instance => updateNoteItem(instance, key, text))
      bump()
      return updated
    },
    createUrlAttachment: input => {
      ensureBackup()
      const created = withDb(instance => createUrlAttachment(instance, input))
      bump()
      return { key: created.key }
    },
    /** Item-type shapes for the item pane / create menu (bundled schema, no db). */
    itemSchema: () => typeList(),
    itemTypeSchema: itemType => typeSchema(itemType),
    trash: (keys, deleted) => {
      ensureBackup()
      const changed = withDb(instance => trashItems(instance, keys, deleted))
      bump()
      return { changed }
    },
    deleteForever: keys => {
      ensureBackup()
      const deleted = withDb(instance => deleteForever(instance, keys))
      bump()
      return { deleted }
    },
    createCollection: input => {
      ensureBackup()
      const created = withDb(instance => createCollection(instance, input))
      bump()
      return created
    },
    renameCollection: (id, name) => {
      ensureBackup()
      withDb(instance => renameCollection(instance, id, name))
      bump()
      return { ok: true }
    },
    trashCollection: (id, deleted) => {
      ensureBackup()
      const changed = withDb(instance => trashCollection(instance, id, deleted))
      bump()
      return { changed }
    },
    importFile: importOne,
    importStaged,
    finalizeImport: finalizeOne,
    recognizeItem: recognizeOne,
    duplicate: key => {
      ensureBackup()
      const created = withDb(instance => duplicateItem(instance, key, paths()))
      bump()
      return created
    },
    createParent: key => {
      ensureBackup()
      const created = withDb(instance => createParentAttachment(instance, key, paths()))
      bump()
      return created
    },
    detachAttachment: key => {
      ensureBackup()
      const result = withDb(instance => detachAttachment(instance, key))
      bump()
      return result
    },
    merge: keys => {
      ensureBackup()
      const result = withDb(instance => mergeItems(instance, keys))
      bump()
      return result
    },
    noteFromAnnotations: key => {
      ensureBackup()
      const created = withDb(instance => noteFromAnnotations(instance, key))
      bump()
      return created
    },
    saveUpload,
    openRecord,
    openUrl,
    openApps,
    openWith,
    attachmentFileInfo: key => attachmentFileInfo(key),
    /** Annotations of one attachment, positions parsed (the built-in reader). */
    annotations: key => withDb(instance => readAnnotations(instance, String(key ?? ''))),
    createAnnotation: (attachmentKey, input) => {
      ensureBackup()
      const created = withDb(instance => createAnnotationRecord(instance, attachmentKey, input))
      bump()
      return created
    },
    updateAnnotation: (key, patch) => {
      ensureBackup()
      const updated = withDb(instance => updateAnnotationRecord(instance, key, patch))
      bump()
      return updated
    },
    removeAnnotation: key => {
      ensureBackup()
      const removed = withDb(instance => removeAnnotationRecord(instance, key))
      bump()
      return removed
    },
    runSync,
    verifySync: async () => {
      const settingsNow = getSettings()
      if (settingsNow.webdav.url === '') throw Object.assign(new Error('WebDAV is not configured'), { code: 'library/webdav-missing' })
      return await new WebDavClient(settingsNow.webdav).verify()
    },
    syncStatus: () => ({ running: syncTask !== undefined, last: syncResult }),
    refreshSettings,
    setupLibrary,
    /**
     * Update the dock context (open article / reader selection) without a
     * chat-send. The guidance section reads this on every model step, so the
     * native composer in the dock is grounded too. Not persisted immediately:
     * the next chat send/save writes it along.
     */
    setChatContext: context => {
      state.chatContext = {
        mode: ['list', 'item', 'reader'].includes(context?.mode) ? context.mode : 'list',
        itemKey: typeof context?.itemKey === 'string' ? context.itemKey : undefined,
        itemTitle: typeof context?.itemTitle === 'string' ? context.itemTitle : undefined,
      }
      return { saved: true }
    },
    chat: {
      open: async (options = {}) => {
        const result = options && typeof options === 'object'
          ? await openSession(ctx, home, state, { ...options, logger })
          : await ensureSession(ctx, home, state, { fresh: options === true, logger })
        saveState(state)
        return result
      },
      page: async (options) => {
        const page = await readPage(ctx, home, state, options)
        saveState(state)
        return page
      },
      send: async (text, context) => {
        const result = await sendMessage(ctx, home, state, text, context)
        saveState(state)
        return result
      },
      stop: async () => {
        const result = await stopTurn(ctx, home, state)
        saveState(state)
        return result
      },
    },
    updates: {
      status: () => updater.status(),
      check: () => updater.check(),
      apply: () => updater.apply(),
    },
    translateModels: () => translator.listModels(),
    translateStream: (text, signal) => translator.stream(text, signal),
    dispose() {
      watcher?.dispose()
      clearInterval(autoSyncTimer)
      closeDb()
    },
  }

  startWatcher()
  if (settings.autoSync && settings.webdav.url !== '') {
    autoSyncTimer = setInterval(() => {
      void runSync().catch(error => logger.warn?.(`library: auto sync failed: ${error?.message ?? error}`))
    }, 30 * 60_000)
    autoSyncTimer.unref?.()
    setTimeout(() => {
      void runSync().catch(() => {})
    }, 20_000).unref?.()
  }

  return runtime
}
