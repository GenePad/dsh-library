// Zotero.Integration.Session, ported to Node.
//
// A session owns one document: the citeproc engine, the fields read from the
// document, every citation cluster, the bibliography, and the bookkeeping that
// decides which fields have to be written back. One integration command is one
// transaction; sessions are cached by document data sessionID so citeproc's
// disambiguation state survives between commands.
import {
  FORCE_CITATIONS_FALSE, FORCE_CITATIONS_REGENERATE, FORCE_CITATIONS_RESET_TEXT,
  DIALOG_ICON_CAUTION, DIALOG_BUTTONS_YES_NO, DIALOG_ICON_WARNING,
  DIALOG_BUTTONS_YES_NO_CANCEL, INTEGRATION_TYPE_ITEM, INTEGRATION_TYPE_BIBLIOGRAPHY,
  NO_ACTION, REMOVE_CODE, DELETE, NOTE_FOOTNOTE, NOTE_ENDNOTE,
  EXPORTED_DOCUMENT_MARKER, DELAYED_CITATION_RTF_STYLING, DELAYED_CITATION_RTF_STYLING_CLEAR,
  AlertError, UserCancelled, randomString,
} from './constants.js'
import { createEngine, plainText } from './csl-citeproc.js'
import { DocumentData } from './document-data.js'
import { Field, CitationField, BibliographyField } from './fields.js'
import { Citation, Bibliography, URIMap } from './citation.js'
import { createItemRegistry } from './items.js'

const DELAY_CITATIONS_PROMPT_TIMEOUT = 15

function sleep() { return new Promise(resolve => setImmediate(resolve)) }

/**
 * Older builds wrote citeproc's RTF markup into the field as *literal text*
 * ("(B\uc0\u252{}ning ... 2019)" or a whole "{\rtf ...}" bibliography). That
 * is corrupted output, not a user edit: regenerate it silently on the next
 * refresh instead of asking whether to keep a "manual modification".
 */
function isUnrenderedRtf(text) {
  const value = String(text ?? '')
  return /\{\\rtf/.test(value)
    || /\\uc\d+/.test(value)
    || /\\u-?\d+\s*\{/.test(value)
    || /\\[a-z]+\d*\s*\{\}/.test(value)
    || /\\uldash|\\ulclear/.test(value)
}

export function createSession({ doc, app, styles, items, dialogs, logger = console, version }) {
  return new Session({ doc, app, styles, items, dialogs, logger, version })
}

export class Session {
  constructor({ doc, app, styles, items, dialogs, logger, version }) {
    this._doc = doc
    this._app = app
    this.styles = styles
    this.items = items
    this.dialogs = dialogs
    this.logger = logger
    this.version = version
    this.sessionID = randomString(8)
    this.registry = createItemRegistry(items, this.sessionID)
    this.uriMap = new URIMap(this.registry)
    this.citationsByIndex = {}
    this.primaryFieldType = app.primaryFieldType
    this.secondaryFieldType = app.secondaryFieldType
    this.outputFormat = app.outputFormat || 'rtf'
    this._dontActivateDocument = false
    this._sessionUpToDate = false
    this._transactionUpToDate = false
    this._shouldMerge = false
    this._fields = null
    this._fieldsPromise = null
    this.ignoreEmptyBibliography = true
    this._removeCodeFields = {}
    this._deleteFields = {}
    this._bibliographyFields = []
    this.progressCallback = null
    this.bibliographyHasChanged = false
    this.bibliographyDataHasChanged = false
    this.forceUpdateAllCitations = false
    this.rebuildCiteprocState = true
    // A brand new document has no stored data: Zotero shows the document
    // preferences dialog on the first command and only then picks a style.
    this.data = new DocumentData('', version)
    this.style = null
    this.styleClass = 'in-text'
    this.styleID = ''
    this.bibliography = null
    this.timer = null
    this.resetRequest(doc)
  }

  // ---------------------------------------------------------------- state ---

  resetRequest(doc) {
    this.uriMap = new URIMap(this.registry)
    this.bibliographyHasChanged = false
    this.bibliographyDataHasChanged = false
    this.oldCitations = new Set(Object.values(this.citationsByIndex).map(c => c.citationID))
    this.newIndices = {}
    this.updateIndices = {}
    this.forceUpdateAllCitations = false
    this.processIndices = {}
    this.citationsByItemID = {}
    this.documentCitationIDs = {}
    const previous = this.citationsByIndex
    this.citationsByIndex = {}
    // Indices added during an aborted transaction must be considered new.
    if (this._cancelledNewIndices) {
      for (const index of this._cancelledNewIndices) this.newIndices[index] = true
      this._cancelledNewIndices = null
    }
    this._previousCitations = previous
    if (doc) this._doc = doc
  }

  get fieldOptions() {
    return {
      outputFormat: this.outputFormat,
      alert: (...args) => this.displayAlert(...args),
    }
  }

  async displayAlert(text, icon, buttons) {
    return this._doc.displayAlert(String(text), Number(icon) || 0, Number(buttons) || 0)
  }

  /** getFields() de-duplicates concurrent callers (Zotero uses the same guard). */
  async getFields(force = false) {
    if (this._fields && !force) return this._fields
    if (this._fieldsPromise) return this._fieldsPromise
    this._fieldsPromise = (async () => {
      const fieldType = this.data?.prefs?.fieldType || this.primaryFieldType
      const raw = await this._doc.getFields(fieldType)
      this._fields = await Promise.all((raw ?? []).map(field => Field.loadExisting(field, this.fieldOptions)))
      return this._fields
    })().finally(() => { this._fieldsPromise = null })
    return this._fieldsPromise
  }

  /** Create a new TEMP field at the cursor, Zotero's wdFieldQuote trick. */
  async addField(note = false, fieldIndex = -1) {
    const canInsert = await this._doc.canInsertField(this.data.prefs.fieldType)
    if (canInsert === false) throw new AlertError('无法在当前位置插入引注。请把光标移到正文或脚注中再试。')
    const current = await this._doc.cursorInField(this.data.prefs.fieldType)
    if (current) {
      const choice = await this.displayAlert(
        '光标位于一个引注内部。是否用新引注替换它？', DIALOG_ICON_CAUTION, DIALOG_BUTTONS_YES_NO)
      if (choice !== 0) throw new UserCancelled('inserting citation')
      // The caller is about to rewrite this field's code; drop the cached
      // field list so updateFromDocument sees the new type.
      this._fields = null
      return current
    }
    const noteType = note ? this.data.prefs.noteType || NOTE_FOOTNOTE : 0
    const field = await this._doc.insertField(this.data.prefs.fieldType, noteType)
    await field.setCode('TEMP')
    if (fieldIndex >= 0 && this._fields) this._fields.splice(fieldIndex, 0, field)
    else this._fields = null
    return field
  }

  // -------------------------------------------------------------- styling ---

  /** Install the style/citeproc engine for a document data object. */
  async setData(data, resetStyle = false) {
    const oldStyle = this.data?.style ?? null
    this.data = data
    this.data.sessionID = this.sessionID
    if (data.style?.styleID && (!oldStyle || oldStyle.styleID !== data.style.styleID || resetStyle || !this.style)) {
      let style
      try {
        style = this.styles.get(data.style.styleID)
      } catch (error) {
        // Zotero tries to auto-install a trusted missing style, then falls back
        // to the bundled APA style, and only then to the preferences dialog.
        if (error?.code === 'style/missing') {
          try {
            style = await this.styles.install({ styleID: data.style.styleID })
          } catch {
            try {
              style = this.styles.get('http://www.zotero.org/styles/apa')
            } catch {
              await this.setDocPrefs(true)
              return true
            }
          }
        } else throw error
      }
      data.style.hasBibliography = style.hasBibliography
      this.style = createEngine({
        xml: style.xml,
        locale: this.styles.resolveLocale(data.style.locale || style.defaultLocale || 'en-US'),
        retrieveLocale: tag => this.styles.localeXml(tag),
        retrieveItem: id => this.registry.retrieve(id),
        format: this.outputFormat,
      })
      this.styleClass = style.class
      this.styleID = data.style.styleID
      this.rebuildCiteprocState = true
      return true
    }
    if (!data.style) data.style = {}
    if (oldStyle) data.style = { ...oldStyle, ...data.style }
    return false
  }

  /** Show the document preferences dialog and rebuild the document data. */
  async setDocPrefs(showImportExport = false) {
    const oldData = this.data
    const io = {
      style: oldData?.style?.styleID ?? '',
      locale: oldData?.style?.locale ?? '',
      primaryFieldType: this.primaryFieldType,
      secondaryFieldType: this.secondaryFieldType,
      supportedNotes: this._app.supportedNotes ?? [],
      styleClass: this.styleClass,
      useEndnotes: oldData?.prefs?.noteType ? oldData.prefs.noteType - 1 : 0,
      fieldType: oldData?.prefs?.fieldType ?? this.primaryFieldType,
      delayCitationUpdates: oldData?.prefs?.delayCitationUpdates ?? false,
      dontAskDelayCitationUpdates: oldData?.prefs?.dontAskDelayCitationUpdates ?? false,
      automaticJournalAbbreviations: oldData?.prefs?.automaticJournalAbbreviations ?? false,
      showImportExport: Boolean(showImportExport && oldData?.prefs?.fieldType && this._app.supportsImportExport),
      requireStoreReferences: this.registry.items.size > 0,
    }
    const result = await this.dialogs.open({ type: 'docPrefs', io, title: '文档设置' })
    if (!result || result.cancelled) throw new UserCancelled('document preferences window')
    if (result.exportDocument) return this.exportDocument()
    if (!result.style || !result.fieldType) throw new UserCancelled('document preferences window')

    const data = DocumentData.fresh(this.version)
    data.dataVersion = oldData?.dataVersion ?? 3
    data.sessionID = oldData?.sessionID ?? this.sessionID
    data.style = {
      styleID: result.style,
      locale: result.locale || '',
      hasBibliography: true,
      bibliographyStyleHasBeenSet: false,
    }
    data.prefs = {
      ...(oldData?.prefs ?? {}),
      fieldType: result.fieldType,
      automaticJournalAbbreviations: Boolean(result.automaticJournalAbbreviations),
      delayCitationUpdates: Boolean(result.delayCitationUpdates),
      dontAskDelayCitationUpdates: Boolean(result.dontAskDelayCitationUpdates),
    }
    const forceStyleReset = oldData && (
      oldData.prefs?.automaticJournalAbbreviations !== data.prefs.automaticJournalAbbreviations
      || oldData.style?.locale !== data.style.locale
    )
    await this.setData(data, forceStyleReset)
    data.prefs.noteType = this.styleClass === 'note' ? (Number(result.useEndnotes) || 0) + 1 : 0
    if (!oldData || oldData.style?.styleID !== data.style.styleID
      || oldData.prefs?.noteType !== data.prefs.noteType
      || oldData.prefs?.fieldType !== data.prefs.fieldType
      || oldData.prefs?.delayCitationUpdates !== data.prefs.delayCitationUpdates
      || oldData.prefs?.automaticJournalAbbreviations !== data.prefs.automaticJournalAbbreviations) {
      this.forceUpdateAllCitations = true
      this.rebuildCiteprocState = true
    }
    return oldData ?? null
  }

  // ------------------------------------------------------- document sync ---

  async init(require = false, dontRunSetDocPrefs = false) {
    const fieldTypes = this.data?.prefs?.fieldType
      ? [this.data.prefs.fieldType] : [this.primaryFieldType, this.secondaryFieldType]
    let haveFields = false
    if (require) {
      for (const fieldType of fieldTypes) {
        const fields = await this.getFields()
        if (fields.length) { haveFields = true; break }
      }
    }
    if (require && !haveFields) {
      throw new AlertError('文档中还没有引注。请先插入一条引注，再使用此命令。')
    }
    if (!this.data?.prefs?.fieldType) {
      if (dontRunSetDocPrefs) return false
      await this.setDocPrefs()
    }
    return true
  }

  /** Rebuild the session from the document's fields. */
  async updateFromDocument(forceCitations = FORCE_CITATIONS_FALSE) {
    if (this._transactionUpToDate) return
    const fields = await this.getFields()
    this.resetRequest(this._doc)
    this._removeCodeFields = {}
    this._deleteFields = {}
    this._bibliographyFields = []
    if (forceCitations === FORCE_CITATIONS_REGENERATE || forceCitations === FORCE_CITATIONS_RESET_TEXT) {
      this.forceUpdateAllCitations = true
      this.rebuildCiteprocState = true
    }
    const mergeNext = []
    for (let i = 0; i < fields.length; i += 1) {
      const field = fields[i]
      if (field.type === INTEGRATION_TYPE_ITEM) {
        const data = await field.unserialize()
        const noteIndex = Number(await field._field.getNoteIndex()) || 0
        const citation = new Citation(field, data, noteIndex)
        citation.fieldIndex = i
        citation.options = { reselect: (id, itemData) => this.reselectItem(id, itemData) }
        const action = await citation.loadItemData(this.registry)
        if (action === REMOVE_CODE) this._removeCodeFields[i] = true
        if (action === DELETE) this._deleteFields[i] = true
        this.addCitation(i, noteIndex, citation, mergeNext)
        if (this._shouldMerge && await field._field.isAdjacentToNextField()) mergeNext.push(i)
      } else if (field.type === INTEGRATION_TYPE_BIBLIOGRAPHY) {
        const text = await field.getText()
        if (this.ignoreEmptyBibliography && !text) {
          this._removeCodeFields[i] = true
        } else {
          field.index = i
          this._bibliographyFields.push(field)
        }
      }
    }
    if (this._bibliographyFields.length) {
      const field = this._bibliographyFields[0]
      this.bibliography = new Bibliography(field, await field.unserialize(), this.registry)
    } else {
      this.bibliography = null
    }
    if (this.rebuildCiteprocState && this.style) this.restoreProcessorState()
    this._sessionUpToDate = true
    this._transactionUpToDate = true
  }

  async reselectItem(id, itemData) {
    const result = await this.dialogs.open({
      type: 'itemPicker',
      io: { id, itemData },
      title: '重新选择条目',
    })
    return result && !result.cancelled ? result.id : null
  }

  addCitation(index, noteIndex, citation, adjacent = []) {
    const key = Number(index)
    this.citationsByIndex[key] = citation
    citation.fieldIndex = key
    citation.properties.noteIndex = noteIndex
    if (!citation.citationID) citation.citationID = randomString(8)
    for (const item of citation.citationItems) {
      const id = String(item.id ?? '')
      if (!id) continue
      if (!this.citationsByItemID[id]) this.citationsByItemID[id] = []
      this.citationsByItemID[id].push(citation)
      this.citationsByItemID[id].sort((a, b) => (a.properties.zoteroIndex ?? 0) - (b.properties.zoteroIndex ?? 0))
    }
    if (this.documentCitationIDs[citation.citationID] !== undefined) {
      const previous = this.documentCitationIDs[citation.citationID]
      this.newIndices[previous] = true
      this.newIndices[key] = true
      citation.citationID = randomString(8)
    }
    this.documentCitationIDs[citation.citationID] = key
    if (!this.oldCitations.has(citation.citationID)) this.newIndices[key] = true
    if (this.forceUpdateAllCitations) this.updateIndices[key] = true
    if (adjacent.length && adjacent.includes(key - 1)) {
      const previous = this.citationsByIndex[key - 1]
      if (previous) {
        previous.mergeCitation(citation)
        this._deleteFields[key] = true
      }
    }
  }

  getCiteprocLists() {
    const citations = []
    const fieldToCitationIdxMapping = {}
    const citationToFieldIdxMapping = {}
    let i = 0
    const indices = Object.keys(this.citationsByIndex).map(Number).sort((a, b) => a - b)
    for (const idx of indices) {
      if (idx in this.newIndices || this._deleteFields[idx]) continue
      const citation = this.citationsByIndex[idx]
      citations.push([citation.citationID, citation.properties.noteIndex ?? 0])
      fieldToCitationIdxMapping[i] = idx
      citationToFieldIdxMapping[idx] = i
      i += 1
    }
    return [citations, fieldToCitationIdxMapping, citationToFieldIdxMapping]
  }

  restoreProcessorState() {
    if (!this.style) return
    const uncited = this.bibliography ? [...this.bibliography.uncitedItemIDs] : []
    const citations = Object.values(this.citationsByIndex).filter(c => !this._deleteFields[c.fieldIndex])
    this.style.updateItems([])
    this.style.rebuildProcessorState(citations.map(c => c.toCluster()), this.outputFormat, uncited)
  }

  async _updateCitations() {
    let [citations, fieldToCitationIdxMapping, citationToFieldIdxMapping] = this.getCiteprocLists()
    for (const [isNew, indexList] of [[true, this.newIndices], [false, this.updateIndices]]) {
      for (const rawIndex of Object.keys(indexList)) {
        if (isNew) {
          delete this.newIndices[rawIndex]
          delete this.updateIndices[rawIndex]
          ;[citations, fieldToCitationIdxMapping, citationToFieldIdxMapping] = this.getCiteprocLists()
        }
        const index = Number(rawIndex)
        const citation = this.citationsByIndex[index]
        if (!citation) continue
        await sleep()
        const position = citationToFieldIdxMapping[index] ?? citations.length
        const pre = citations.slice(0, position)
        const post = citations.slice(position + 1)
        const [info, changed] = this.style.processCitationCluster(citation.toJSON(this.registry), pre, post)
        if (info?.bibchange) this.bibliographyHasChanged = true
        for (const entry of changed ?? []) {
          const fieldIndex = fieldToCitationIdxMapping[entry[0]]
          if (fieldIndex === undefined) continue
          this.processIndices[fieldIndex] = true
          if (this.citationsByIndex[fieldIndex]) this.citationsByIndex[fieldIndex].text = entry[1]
        }
      }
      ;[citations, fieldToCitationIdxMapping, citationToFieldIdxMapping] = this.getCiteprocLists()
    }
  }

  async updateDocument(forceCitations = FORCE_CITATIONS_FALSE, forceBibliography = false, ignoreCitationChanges = false) {
    const started = Date.now()
    await this._updateCitations()
    await this._updateDocument(forceCitations, forceBibliography, ignoreCitationChanges)
    const seconds = (Date.now() - started) / 1000
    if (seconds > DELAY_CITATIONS_PROMPT_TIMEOUT && !this.data.prefs.dontAskDelayCitationUpdates
      && !this.data.prefs.delayCitationUpdates) {
      const choice = await this.displayAlert(
        '更新引注耗时较长。是否启用「延迟更新引注」以加快大型文档中的插入速度？\n\n启用后可随时点击「刷新」重新计算。',
        DIALOG_ICON_WARNING, DIALOG_BUTTONS_YES_NO_CANCEL)
      if (choice === 2) this.data.prefs.delayCitationUpdates = true
      if (choice) this.data.prefs.dontAskDelayCitationUpdates = true
    }
  }

  async _updateDocument(forceCitations, forceBibliography, ignoreCitationChanges) {
    let indicesToUpdate = Object.keys(this.processIndices).map(Number)
    if (this.bibliography) {
      if (Object.keys(this.citationsByIndex).length === 0) {
        for (const field of this._bibliographyFields) this._deleteFields[field.index] = true
      } else if (this.bibliographyHasChanged || forceBibliography) {
        for (const field of this._bibliographyFields) indicesToUpdate.push(Number(field.index))
      }
    }
    // Reverse order: editing a field can shift all following field indices.
    indicesToUpdate = [...new Set(indicesToUpdate)].sort((a, b) => b - a)
    for (const index of indicesToUpdate) {
      await sleep()
      const citation = this.citationsByIndex[index]
      if (citation) {
        let formatted = citation.properties.custom || citation.text || ''
        const field = citation.field
        const currentText = await field.getText()
        // Word normalises whitespace when it stores rich text; compare a
        // whitespace-insensitive form so only real manual edits are flagged.
        const squash = value => String(value ?? '').replace(/\s+/g, '')
        const plaintextChanged = citation.properties.plainCitation
          && squash(currentText) !== squash(citation.properties.plainCitation)
        // Repair fields damaged by the old RTF bug without blaming the user.
        const damaged = isUnrenderedRtf(currentText)
        if (damaged) citation.properties.dontUpdate = false
        if (!citation.properties.dontUpdate && !ignoreCitationChanges && plaintextChanged && !damaged) {
          await field.select()
          const choice = await this.displayAlert(
            `文档中的引注文本被手工修改过。是否保留手工修改？\n\n原文：${citation.properties.plainCitation}\n当前：${currentText}`,
            DIALOG_ICON_CAUTION, DIALOG_BUTTONS_YES_NO)
          if (choice) citation.properties.dontUpdate = true
        }
        if (!citation.properties.dontUpdate) {
          const changed = formatted && citation.properties.formattedCitation !== formatted
          if (forceCitations === FORCE_CITATIONS_RESET_TEXT
            || (Boolean(formatted) && (changed || plaintextChanged || damaged))) {
            const wasDelayed = citation.properties.formattedCitation?.includes(DELAYED_CITATION_RTF_STYLING)
            if (this.outputFormat === 'rtf' && wasDelayed) {
              await field.setText(`${DELAYED_CITATION_RTF_STYLING_CLEAR}{${formatted}}`)
            } else {
              await field.setText(formatted)
            }
            citation.properties.formattedCitation = formatted
            citation.properties.plainCitation = await field.getText()
          }
        }
        const serialized = citation.serialize(this.registry)
        if (serialized !== citation.properties.field) await field.setCode(serialized)
      } else {
        const field = this._bibliographyFields.find(entry => Number(entry.index) === index)
        if (!field) continue
        if (forceBibliography || this.bibliographyDataHasChanged) await field.setCode(this.bibliography.serialize())
        const bib = this.bibliography.getCiteprocBibliography(this.style)
        let text = ''
        if (bib) {
          if (this.outputFormat === 'rtf') {
            text = bib[0].bibstart + bib[1].join('\\\r\n') + '\\\r\n' + bib[0].bibend
          } else {
            text = bib[0].bibstart + bib[1].join('') + bib[0].bibend
          }
          if (!this.data.style.bibliographyStyleHasBeenSet) {
            const params = {
              firstLineIndent: Math.round((bib[0].maxoffset ?? 0) * 240),
              indent: 0,
              lineSpacing: Math.round((bib[0].linespacing ?? 1) * 240),
              entrySpacing: Math.round((bib[0].entryspacing ?? 0) * 240),
              tabStops: [720],
            }
            await this._doc.setBibliographyStyle(params.firstLineIndent, params.indent,
              params.lineSpacing, params.entrySpacing, params.tabStops)
            this.data.style.bibliographyStyleHasBeenSet = true
          }
        }
        await field.setText(text || '{Bibliography}')
      }
    }
    for (const index of Object.keys(this._removeCodeFields).map(Number).sort((a, b) => b - a)) {
      await this._fields[index]?.removeCode()
    }
    for (const index of Object.keys(this._deleteFields).map(Number).sort((a, b) => b - a)) {
      await this._fields[index]?.delete()
    }
    this.processIndices = {}
  }

  // -------------------------------------------------------------- citing ---

  /** Open the citation dialog and insert the accepted citation. */
  async cite(docField = null, { addNote = false, addAnnotations = false } = {}) {
    let newField = false
    let citationField
    let citation
    if (docField) {
      const loaded = await Field.loadExisting(docField, this.fieldOptions)
      if (loaded.type === INTEGRATION_TYPE_BIBLIOGRAPHY) {
        throw new AlertError('光标位于参考文献表内部。请使用「添加/编辑引注」插入引注。')
      }
      if (loaded.type === INTEGRATION_TYPE_ITEM) {
        citationField = loaded
        citation = new Citation(loaded, await loaded.unserialize(), Number(await docField.getNoteIndex()) || 0)
      } else {
        newField = true
        citationField = new CitationField(docField, '', this.fieldOptions)
        citation = new Citation(citationField, {}, Number(await docField.getNoteIndex()) || 0)
      }
    } else {
      newField = true
      const field = await this.addField(addNote)
      citationField = new CitationField(field, '', this.fieldOptions)
      citation = new Citation(citationField, {}, Number(await field.getNoteIndex()) || 0)
    }
    if (!citation.citationID) citation.citationID = randomString(8)
    citation.prepareForEditing()
    await citation.loadItemData(this.registry, { promptToReselect: false })

    // Make sure the engine knows about every existing citation before preview.
    this._transactionUpToDate = false
    await this.updateFromDocument(FORCE_CITATIONS_FALSE)

    const citedItems = Object.keys(this.citationsByItemID).map(id => {
      const info = this.items.describe(id) ?? {}
      return { id, ...info, count: this.citationsByItemID[id].length }
    })
    const io = {
      citation: citation.toJSON(this.registry),
      citedItems,
      sortable: Boolean(this.style?.opt?.sort_citations),
      isCitingNotes: addNote,
      isAddingAnnotations: addAnnotations,
      disableDialogTypeSwitch: Boolean(docField),
      style: { styleID: this.styleID, class: this.styleClass, locale: this.data.style.locale },
    }
    const result = await this.dialogs.open({ type: 'citation', io, title: '添加/编辑引注' })
    const accepted = result && !result.cancelled ? result.citation : null
    if (!accepted || !accepted.citationItems?.length) {
      if (newField) {
        try { await citationField.delete() } catch { /* field is already gone */ }
      }
      throw new UserCancelled('inserting citation')
    }
    citation.citationItems = accepted.citationItems.map(item => ({ ...item }))
    citation.properties = {
      ...(accepted.properties ?? {}),
      noteIndex: citation.properties.noteIndex,
      ...(accepted.unsorted ? { unsorted: true } : {}),
    }
    await citation.loadItemData(this.registry, { promptToReselect: false })
    await citationField.setCode(citation.serialize(this.registry))

    // The document changed: re-read all fields and render.
    this._fields = null
    this._transactionUpToDate = false
    if (this.data.prefs.delayCitationUpdates) {
      // Delayed mode: only re-read state; _afterCite writes the dashed
      // placeholder and the real update waits for an explicit refresh.
      await this.updateFromDocument(FORCE_CITATIONS_FALSE)
    } else {
      // Regenerate the whole document inline (the same path as the 刷新
      // command). An edited citation keeps its citationID, so the incremental
      // newIndices/updateIndices bookkeeping never picks it up and numbering
      // plus the bibliography would otherwise wait for a manual refresh.
      await this.updateFromDocument(FORCE_CITATIONS_REGENERATE)
      await this.updateDocument(FORCE_CITATIONS_REGENERATE, true, false)
    }
    return [citation]
  }

  /** Write a citation rendered with a dashed underline (delayed updates). */
  async writeDelayedCitation(field, citation) {
    const text = citation.properties.custom || this.style.previewCitationCluster(citation.toCluster(), [], [], this.outputFormat)
    const styled = this.outputFormat === 'rtf'
      ? `${DELAYED_CITATION_RTF_STYLING}{${text}}`
      : `<span style="text-decoration: underline dashed">${text}</span>`
    await field.setText(styled)
    await field.setCode(citation.serialize(this.registry))
  }

  // -------------------------------------------------------- bibliography ---

  async editBibliography(bibliography) {
    // The editor mutates the bibliography object it was given; make it the
    // session's active bibliography so _updateDocument serialises the result.
    this.bibliography = bibliography
    await this._updateCitations()
    const bib = bibliography.getCiteprocBibliography(this.style)
    const entries = (bib[1] ?? []).map((text, index) => ({
      id: String(bib[0]?.entry_ids?.[index]?.[0] ?? index),
      text,
      edited: Boolean(bibliography.customEntryText[String(bib[0]?.entry_ids?.[index]?.[0] ?? index)]),
      cited: true,
    }))
    const result = await this.dialogs.open({
      type: 'bibliography',
      io: { entries, uncited: [...bibliography.uncitedItemIDs], omitted: [...bibliography.omittedItemIDs] },
      title: '编辑参考文献表',
    })
    if (!result || result.cancelled) throw new UserCancelled('bibliography editing')
    bibliography.customEntryText = result.customText ?? {}
    bibliography.uncitedItemIDs = new Set(result.uncited ?? [])
    bibliography.omittedItemIDs = new Set(result.omitted ?? [])
    this.bibliographyDataHasChanged = true
    this.bibliographyHasChanged = true
  }

  async openCitationExplorer() {
    const citations = Object.values(this.citationsByIndex).map(c => ({
      id: c.citationID,
      index: c.fieldIndex,
      text: c.text || c.properties.plainCitation || '',
      items: c.citationItems.map(item => ({ id: String(item.id), ...(this.items.describe(item.id) ?? {}) })),
    }))
    const cited = new Set(Object.keys(this.citationsByItemID))
    const result = await this.dialogs.open({
      type: 'explorer',
      io: {
        citations,
        items: [...cited].map(id => ({ id, ...(this.items.describe(id) ?? {}) })),
        uncited: [...(this.bibliography?.uncitedItemIDs ?? [])],
      },
      title: '查看引注',
    })
    if (result?.editIndex !== undefined && this._fields[result.editIndex]) {
      await this.cite(this._fields[result.editIndex]._field)
    }
  }

  // ------------------------------------------------------------- transfer ---

  async exportDocument() {
    const fields = await this.getFields()
    const lines = []
    lines.push('ZOTERO_TRANSFER_DOCUMENT')
    lines.push(`DOCUMENT_PREFERENCES ${this.data.serialize()}`)
    lines.push(`BIBLIOGRAPHY_STYLE ${this.data.style.styleID} ${this.data.style.locale || ''}`)
    for (const field of fields) {
      if (field.type === INTEGRATION_TYPE_ITEM) lines.push(`ITEM CSL_CITATION ${field.getCode()}`)
      else if (field.type === INTEGRATION_TYPE_BIBLIOGRAPHY) lines.push(`BIBL ${field.getCode()} CSL_BIBLIOGRAPHY`)
    }
    await this._doc.exportDocument(this.data.prefs.fieldType, lines.join('\n'))
  }

  async importDocument() {
    const text = String(await this._doc.importDocument(this.data.prefs.fieldType) ?? '')
    let data = DocumentData.fresh(this.version)
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('DOCUMENT_PREFERENCES ')) {
        data = new DocumentData(line.slice('DOCUMENT_PREFERENCES '.length), this.version)
      }
    }
    this._fields = null
    this._transactionUpToDate = false
    return data
  }
}

export { EXPORTED_DOCUMENT_MARKER, plainText }
