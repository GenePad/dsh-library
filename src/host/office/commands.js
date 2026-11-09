// Zotero.Integration.Interface (all 13 commands) and execCommand, the outer
// transaction boundary. Command names are the exact strings Zotero's Word
// template sends, so documents stay interoperable with real Zotero.
import {
  FORCE_CITATIONS_FALSE, FORCE_CITATIONS_REGENERATE, FORCE_CITATIONS_RESET_TEXT,
  DIALOG_ICON_STOP, DIALOG_ICON_WARNING, DIALOG_BUTTONS_OK, DIALOG_BUTTONS_OK_CANCEL,
  DIALOG_BUTTONS_YES_NO, INTEGRATION_TYPE_ITEM, INTEGRATION_TYPE_BIBLIOGRAPHY,
  EXPORTED_DOCUMENT_MARKER, DATA_VERSION, commandList, randomString,
  AlertError, UserCancelled, isUserCancelled, REMOVE_CODE,
} from './constants.js'
import { DocumentData } from './document-data.js'
import { Field, CitationField, BibliographyField } from './fields.js'
import { Bibliography, Citation } from './citation.js'
import { Session } from './session.js'
import { HttpApplication } from './http-client.js'

/** The command dispatcher: one instance per integration command. */
export class IntegrationInterface {
  constructor(app, doc, session) {
    this._app = app
    this._doc = doc
    this._session = session
  }

  async _afterCite(citations) {
    if (this._session.data.prefs.delayCitationUpdates) {
      for (const citation of citations) await this._session.writeDelayedCitation(citation.field, citation)
    }
  }

  async addCitation() {
    await this._session.init(false, false)
    const citations = await this._session.cite(null)
    await this._afterCite(citations)
  }

  async editCitation() {
    await this._session.init(true, false)
    const docField = await this._doc.cursorInField(this._session.data.prefs.fieldType)
    if (!docField) throw new AlertError('光标不在引注内部。请把光标移到引注中再试。')
    return this.addEditCitation(docField)
  }

  async addEditCitation(docField = null) {
    await this._session.init(false, false)
    const field = docField || await this._doc.cursorInField(this._session.data.prefs.fieldType)
    const citations = await this._session.cite(field)
    await this._afterCite(citations)
  }

  async addNote() {
    await this._session.init(false, false)
    const canInsert = await this._doc.canInsertField(this._session.data.prefs.fieldType)
    if (canInsert === false) throw new AlertError('无法在当前位置插入笔记。')
    const citations = await this._session.cite(null, { addNote: true })
    await this._afterCite(citations)
  }

  async addAnnotation() {
    await this._session.init(false, false)
    const canInsert = await this._doc.canInsertField(this._session.data.prefs.fieldType)
    if (canInsert === false) throw new AlertError('无法在当前位置插入注释。')
    const citations = await this._session.cite(null, { addAnnotations: true })
    await this._afterCite(citations)
  }

  async _bibliographyField(fields) {
    for (let i = fields.length - 1; i >= 0; i -= 1) {
      const field = fields[i] instanceof Field ? fields[i] : await Field.loadExisting(fields[i], this._session.fieldOptions)
      if (field.type === INTEGRATION_TYPE_BIBLIOGRAPHY) return field
    }
    return null
  }

  async _citationsMode() {
    let mode = FORCE_CITATIONS_FALSE
    if (this._session.data.prefs.delayCitationUpdates) {
      this._session.rebuildCiteprocState = true
      mode = FORCE_CITATIONS_REGENERATE
    }
    return mode
  }

  async addBibliography() {
    await this._session.init(true, false)
    if (!this._session.data.style.hasBibliography) throw new AlertError('当前引用样式没有参考文献表。请在「引文格式设置」中选择带参考文献表的样式。')
    const existing = await this._bibliographyField(await this._session.getFields())
    if (existing) throw new AlertError('文档中已有参考文献表。请使用「编辑参考文献表」修改其内容。')
    const field = new BibliographyField(await this._session.addField(), '', this._session.fieldOptions)
    await field.clearCode()
    const mode = await this._citationsMode()
    await this._session.updateFromDocument(mode)
    await this._session.updateDocument(mode, true, false)
  }

  async editBibliography() {
    await this._session.init(true, false)
    const fields = await this._session.getFields()
    const field = await this._bibliographyField(fields)
    if (!field) throw new AlertError('文档中还没有参考文献表。请先插入参考文献表。')
    const bibliography = new Bibliography(field, await field.unserialize(), this._session.registry)
    const mode = await this._citationsMode()
    await this._session.updateFromDocument(mode)
    await this._session.editBibliography(bibliography)
    await this._session.updateDocument(mode, true, false)
  }

  async addEditBibliography() {
    await this._session.init(true, false)
    if (!this._session.data.style.hasBibliography) throw new AlertError('当前引用样式没有参考文献表。请在「引文格式设置」中选择带参考文献表的样式。')
    const fields = await this._session.getFields()
    let field = await this._bibliographyField(fields)
    const isNew = !field
    if (!field) {
      field = new BibliographyField(await this._session.addField(), '', this._session.fieldOptions)
      await field.clearCode()
    }
    const bibliography = new Bibliography(field, await field.unserialize(), this._session.registry)
    const mode = await this._citationsMode()
    await this._session.updateFromDocument(mode)
    if (!isNew) await this._session.editBibliography(bibliography)
    await this._session.updateDocument(mode, true, false)
  }

  async citationExplorer() {
    await this._session.init(true, false)
    const mode = await this._citationsMode()
    await this._session.updateFromDocument(mode)
    await this._session.openCitationExplorer()
    await this._session.updateDocument(mode, true, false)
  }

  async refresh() {
    await this._session.init(true, false)
    this._session._shouldMerge = true
    this._session.rebuildCiteprocState = this._session.rebuildCiteprocState
      || Boolean(this._session.data.prefs.delayCitationUpdates)
    await this._session.updateFromDocument(FORCE_CITATIONS_REGENERATE)
    await this._session.updateDocument(FORCE_CITATIONS_REGENERATE, true, false)
  }

  async removeCodes() {
    await this._session.init(true, false)
    const fields = await this._session.getFields()
    const choice = await this._doc.displayAlert(
      '移除域代码后，引注将变成纯文本，无法再与文库同步更新。确定继续吗？',
      DIALOG_ICON_WARNING, DIALOG_BUTTONS_OK_CANCEL)
    if (choice) return
    for (let i = fields.length - 1; i >= 0; i -= 1) await fields[i].removeCode()
  }

  async setDocPrefs() {
    const haveSession = await this._session.init(false, true)
    let oldData
    if (!haveSession) {
      oldData = await this._session.setDocPrefs(true)
    } else {
      const [, previous] = await Promise.all([
        this._session.getFields(),
        this._session.setDocPrefs(true),
      ])
      oldData = previous
    }
    if (!oldData) return false
    const fields = await this._session.getFields()
    const convertBibliographies = oldData?.prefs?.fieldType !== this._session.data.prefs.fieldType
    const convertItems = convertBibliographies || oldData?.prefs?.noteType !== this._session.data.prefs.noteType
    const fieldsToConvert = []
    const noteTypes = []
    for (const field of fields) {
      const wrapped = field instanceof Field ? field : await Field.loadExisting(field, this._session.fieldOptions)
      if (convertItems && wrapped.type === INTEGRATION_TYPE_ITEM) {
        const citation = await wrapped.unserialize()
        if (!citation.properties?.dontUpdate) {
          fieldsToConvert.push(field)
          noteTypes.push(this._session.data.prefs.noteType)
        }
      } else if (convertBibliographies && wrapped.type === INTEGRATION_TYPE_BIBLIOGRAPHY) {
        fieldsToConvert.push(field)
        noteTypes.push(0)
      }
    }
    if (fieldsToConvert.length) {
      await this._doc.convert(fieldsToConvert.map(field => field._field ?? field),
        this._session.data.prefs.fieldType, noteTypes)
    }
    this._session._fields = null
    this._session.ignoreEmptyBibliography = true
    // A preferences change is an explicit user action, so always re-render the
    // document right away — exactly like inserting a citation. The old guard
    // skipped this whenever 「延迟更新引注」 was on, which made a style switch
    // look like a no-op until the user pressed 刷新.
    this._session.rebuildCiteprocState = true
    this._session._transactionUpToDate = false
    await this._session.updateFromDocument(FORCE_CITATIONS_RESET_TEXT)
    await this._session.updateDocument(FORCE_CITATIONS_RESET_TEXT, true, true)
  }

  async exportDocument() {
    await this._session.init(true, false)
    const choice = await this._doc.displayAlert(
      '这将把文档中的引注转换为可在其他文字处理软件中继续编辑的形式。确定继续吗？',
      DIALOG_ICON_WARNING, DIALOG_BUTTONS_OK_CANCEL)
    if (choice) return
    await this._session.exportDocument()
  }

  // ------------------------------------------------------------ AI write ---

  /**
   * Build one citation cluster from validated agent input and write its field
   * code. `fieldJson` is the field the responder just created at the insertion
   * point; the cluster's items are resolved through the session registry.
   */
  async _aiCitation(fieldJson, spec) {
    const citationField = new CitationField(fieldJson, '', this._session.fieldOptions)
    const citation = new Citation(citationField, {}, 0)
    citation.citationID = randomString(8)
    citation.citationItems = spec.keys.map((key, index) => ({
      id: key,
      uris: this._session.items.uriFor(key),
      // Cluster-level prefix/suffix: prefix on the first item, suffix on the
      // last, mirroring how Zotero's quick-edit bar stores them.
      ...(index === 0 && spec.prefix ? { prefix: spec.prefix } : {}),
      ...(index === spec.keys.length - 1 && spec.suffix ? { suffix: spec.suffix } : {}),
      ...(spec.locator ? { locator: spec.locator } : {}),
    }))
    const action = await citation.loadItemData(this._session.registry, { promptToReselect: false })
    if (action === REMOVE_CODE || citation.citationItems.some(item => item.missing)) {
      throw new AlertError(`条目 ${spec.keys.join('、')} 无法从文库解析，已中止写回。`)
    }
    await citationField.setCode(citation.serialize(this._session.registry))
    return citation
  }

  /**
   * Apply an AI task's write-back plan to the captured selection: plain text
   * plus citation fields, then the same inline full regeneration the 刷新
   * command runs (requirement: citation changes must refresh automatically).
   * @param {object} task - {id, plan: {mode, text?, citations}, ...}
   */
  async applyAiEdit(task) {
    const plan = task.plan
    const session = this._session
    await session.init(false, true)
    if (!session.data?.prefs?.fieldType) {
      // The document has no citation format yet: silently default to APA
      // (bundled fallback) instead of blocking the AI write-back with an alert.
      const data = DocumentData.fresh(session.version)
      data.sessionID = session.sessionID
      data.style = {
        styleID: 'http://www.zotero.org/styles/apa',
        locale: '',
        hasBibliography: true,
        bibliographyStyleHasBeenSet: false,
      }
      data.prefs = {
        fieldType: session.primaryFieldType,
        automaticJournalAbbreviations: false,
        delayCitationUpdates: false,
        dontAskDelayCitationUpdates: false,
      }
      data.prefs.noteType = 0
      await session.setData(data)
      session.forceUpdateAllCitations = true
      session.rebuildCiteprocState = true
    }
    // Validate every key BEFORE touching the document.
    for (const spec of plan.citations) {
      for (const key of spec.keys) {
        if (!this._session.items.cslItem(key)) {
          throw new AlertError(`条目 ${key} 不在文库中，无法插入引文。请让助手修正后重试。`)
        }
      }
    }
    // aiBegin verifies the live selection still matches the captured text and
    // aborts WITHOUT mutating when it does not.
    await this._doc.aiBegin(plan.mode, task.selection)
    const inserted = []
    try {
      if (plan.mode === 'replace') {
        // Replace mode: clear the range, write the whole plain text in ONE go,
        // then drop each citation field after the text that precedes its
        // marker. Never drive this with a moving Word "insertion cursor":
        // CmdAiField's cursor advance proved unreliable in real Word (each
        // field's code is thousands of invisible characters), which piled every
        // field at the end of the passage. Anchors keep it deterministic.
        const pieces = String(plan.text).split(/(\[\[\d{1,2}\]\]\s*)/g)
        let plain = ''
        const spots = []
        for (const piece of pieces) {
          if (piece === '') continue
          const marker = /^\[\[(\d{1,2})\]\]\s*$/.exec(piece)
          if (marker) {
            const spec = plan.citations.find(entry => entry.id === Number(marker[1]))
            if (!spec) throw new AlertError(`text 中的标记 [[${marker[1]}]] 没有对应的引文。`)
            spots.push({ spec, at: plain.length })
          } else {
            plain += piece
          }
        }
        if (plain.trim() === '') throw new AlertError('替换后的文本为空，写回已取消。')
        await this._doc.aiText(plain)
        // Insert BACKWARDS (last marker first). Word finds each anchor in the
        // visible text, and a field inserted for a marker sits between the
        // preceding text and whatever follows it: with two adjacent markers
        // ("…表达[[1]][[2]]") a forward pass makes the second anchor
        // unreachable the moment the first field exists ("…表达{Citation}," no
        // longer contains "…表达,"). Walking from the end keeps every anchor
        // still intact, because a later insertion never touches earlier text.
        for (const spot of [...spots].sort((a, b) => b.at - a.at)) {
          const anchor = pickAnchor(plain, spot.at)
          if (!anchor) {
            throw new AlertError('这段文字以引注开头，无法确定插入位置；请把引注放到文字之后。')
          }
          const field = await this._doc.aiFieldAfter(anchor, this._session.data.prefs.fieldType, 0)
          if (!field) throw new AlertError('Word 未能定位引文插入点，写回已取消。')
          inserted.push(await this._aiCitation(field, spot.spec))
        }
      } else {
        // Insert mode: ANCHOR-based insertion. Word finds each `after` fragment
        // in the live selection text and drops the citation field right after
        // it. Character offsets must not be used here: Word positions count
        // the invisible characters of every field code (thousands per citation
        // field), so a plain-text offset computed from Range.Text lands inside
        // an earlier field's code as soon as one field exists and corrupts it.
        // Same backwards rule as replace mode: an anchor that ends where an
        // already inserted field begins would no longer match.
        const anchors = plan.citations
          .map(spec => ({ spec, at: task.selection.indexOf(spec.after) }))
          .sort((a, b) => b.at - a.at)
        for (const { spec } of anchors) {
          const field = await this._doc.aiFieldAfter(spec.after, this._session.data.prefs.fieldType, 0)
          if (!field) throw new AlertError('Word 未能定位引文插入点（原文可能已被修改），写回已取消。')
          inserted.push(await this._aiCitation(field, spec))
        }
      }
      await this._doc.aiEnd()
    } catch (error) {
      try { await this._doc.aiEnd() } catch { /* already ended */ }
      throw error
    }
    // The document changed: re-read all fields and regenerate inline (the
    // exact tail of Session.cite — citations, numbering and the bibliography
    // update immediately, no manual refresh needed).
    this._session._fields = null
    this._session._transactionUpToDate = false
    await this._session.updateFromDocument(FORCE_CITATIONS_REGENERATE)
    await this._session.updateDocument(FORCE_CITATIONS_REGENERATE, true, false)
    return { inserted: inserted.length }
  }
}

/**
 * Pick a unique text anchor ENDING at `at` (the characters right before a
 * [[N]] marker). Replace-mode write-back inserts each citation field after that
 * anchor, so the position is derived from the text itself instead of a
 * character offset. Whitespace at the edges is trimmed because Word's Find
 * compares visible text and paragraph marks would break the match.
 * @param {string} text full replacement text (markers already stripped)
 * @param {number} at offset of the marker in `text`
 * @returns {string} anchor, or '' when the marker starts the text
 */
function pickAnchor(text, at) {
  let end = at
  while (end > 0 && /\s/.test(text[end - 1])) end -= 1
  if (end === 0) return ''
  for (const size of [16, 24, 36, 48]) {
    const start = Math.max(0, end - size)
    const candidate = text.slice(start, end)
    if (start === 0) return candidate
    if (text.split(candidate).length - 1 === 1) return candidate
  }
  return text.slice(Math.max(0, end - 48), end)
}

/** Create the integration engine singleton (session cache + command runner). */
export function createIntegration({ styles, items, dialogs, ai = null, logger = console, version }) {
  const sessions = new Map()
  let currentCommandPromise = Promise.resolve()
  let currentDoc = null
  let currentSession = null

  async function getSession(app, doc, agent, command) {
    const dataString = String(await doc.getDocumentData() ?? '')
    let documentImported = false
    let data
    if (dataString === EXPORTED_DOCUMENT_MARKER) {
      data = new DocumentData('', version)
    } else {
      try {
        data = new DocumentData(dataString, version)
      } catch {
        data = new DocumentData('', version)
      }
    }
    if (dataString && dataString !== EXPORTED_DOCUMENT_MARKER && data.prefs?.fieldType) {
      if (data.dataVersion < DATA_VERSION) {
        // Zotero asks before upgrading; here we accept silently and rewrite in v3.
        data.dataVersion = DATA_VERSION
      } else if (data.dataVersion > DATA_VERSION && data.dataVersion !== 4) {
        throw new AlertError('该文档由更新版本的 Zotero 创建，无法在此处编辑。')
      }
      const allowed = [app.primaryFieldType, app.secondaryFieldType]
      if (!allowed.includes(data.prefs.fieldType)) {
        throw new AlertError(`文档字段类型（${data.prefs.fieldType}）与当前文字处理软件不匹配。`)
      }
    }
    const cacheKey = data.sessionID || doc.documentID || command
    let session = sessions.get(cacheKey)
    if (!session || session.agent !== agent) {
      session = new Session({ doc, app, styles, items, dialogs, logger, version })
      session.rebuildCiteprocState = true
      sessions.set(cacheKey, session)
    }
    session.agent = agent
    session._doc = doc
    session._fields = null
    session.ignoreEmptyBibliography = true
    session.progressCallback = null
    session._removeCodeFields = {}
    session._deleteFields = {}
    session._bibliographyFields = []
    session._shouldMerge = false
    session._transactionUpToDate = false
    if (dataString === EXPORTED_DOCUMENT_MARKER) {
      data = await session.importDocument()
      documentImported = true
    }
    await session.setData(data)
    return [session, documentImported]
  }

  async function handleCommandError(doc, error) {
    logger.warn?.(`library: integration command failed: ${error?.stack ?? error}`)
    let message
    if (error instanceof AlertError || error?.name === 'AlertError') message = error.message
    else if (String(error?.message ?? error).includes('ExceptionAlreadyDisplayed')) return
    else message = `文库引用插件遇到错误：${String(error?.message ?? error)}`
    try {
      await doc.displayAlert(message, DIALOG_ICON_STOP, DIALOG_BUTTONS_OK)
    } catch (nested) {
      logger.warn?.(`library: could not display integration error: ${nested?.message ?? nested}`)
    }
  }

  /**
   * Run one integration transaction.
   * @returns {Promise<void>} resolves when the engine is done; the transport
   *   emits "Document.complete" as its last command.
   */
  async function execCommand({ agent = 'Word', command, docId, transport, taskId = '', pid = 0 }) {
    const started = Date.now()
    let doc = null
    let session = null
    let aiTask = null
    try {
      if (!commandList.includes(command)) throw new AlertError(`未知的集成命令：${command}`)
      if (command === 'applyAiEdit') {
        if (!ai) throw new AlertError('AI 写回服务不可用。')
        // Claim the task first: it also verifies pid+docId, so the write lands
        // in the Word process/document that started it even when several Word
        // processes are connected at once. A rejected claim (foreign pid,
        // expired task) must also FAIL the task, otherwise the waiting agent
        // tool would hang until its own timeout.
        try {
          aiTask = ai.beginApply({ taskId, pid, docId })
        } catch (claimError) {
          ai.fail(taskId, claimError)
          throw claimError
        }
      }
      const app = new HttpApplication(transport)
      doc = await app.getDocument(docId)
      currentDoc = doc
      let documentImported = false
      ;[session, documentImported] = await getSession(app, doc, agent, command)
      currentSession = session
      if (!documentImported) {
        const iface = new IntegrationInterface(app, doc, session)
        const outcome = await iface[command](aiTask)
        if (aiTask) ai.finishApply(aiTask.id, { ok: true, ...outcome })
      } else if (aiTask) {
        // Transfer documents cannot take an AI write-back; fail it now so the
        // waiting agent tool does not hang until its own timeout.
        throw new AlertError('该文档是导入的传输文档，AI 无法写回。')
      }
      await doc.setDocumentData(session.data.serialize())
    } catch (error) {
      if (aiTask) ai.finishApply(aiTask.id, { ok: false, error: String(error?.message ?? error) })
      if (isUserCancelled(error)) {
        if (session && doc) {
          try {
            await doc.setDocumentData(session.data.serialize())
            if (Object.keys(session.processIndices ?? {}).length) {
              await session.updateDocument(FORCE_CITATIONS_FALSE, false, false)
            }
          } catch { /* cancellation: processor failures are ignored */ }
        }
      } else if (doc) {
        await handleCommandError(doc, error)
      } else {
        // No document yet (unknown command, client handshake failure): surface
        // the message through the word processor's own alert command.
        const message = error instanceof AlertError || error?.name === 'AlertError'
          ? error.message : `文库引用插件遇到错误：${String(error?.message ?? error)}`
        try {
          await transport.sendCommand('Document.displayAlert',
            [String(docId ?? ''), message, DIALOG_ICON_STOP, DIALOG_BUTTONS_OK])
        } catch { /* best effort */ }
      }
    } finally {
      logger.info?.(`library: ${agent}-${command} complete in ${((Date.now() - started) / 1000).toFixed(2)}s`)
      if (doc) {
        try { await doc.cleanup() } catch { /* best effort */ }
        if (!session?._dontActivateDocument) {
          try { await doc.activate() } catch { /* best effort */ }
        }
        try { await doc.complete() } catch { /* best effort */ }
      } else {
        // The engine failed before it ever reached the document: still end the
        // HTTP transaction so the word processor is not left waiting.
        try { await transport.sendCommand('Document.complete', [String(docId ?? '')]) } catch { /* ignore */ }
      }
      currentDoc = null
      currentSession = null
    }
  }

  return {
    execCommand,
    sessions,
    get status() {
      return { busy: currentDoc !== null, sessionID: currentSession?.sessionID ?? null }
    },
    get currentCommandPromise() { return currentCommandPromise },
  }
}
