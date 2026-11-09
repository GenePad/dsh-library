// Zotero's HTTP integration client, host side.
//
// The word processor and Zotero talk in a strict one-question-one-answer loop:
//   execCommand  -> response carries the next {command, arguments}
//   respond      -> request carries the previous answer, response carries the
//                   next {command, arguments}
//   ... until "Document.complete" is emitted.
// Every command is serialised through a promise chain, mirroring
// Zotero.HTTPIntegrationClient.sendCommandPromise.
export function createTransport() {
  let chain = Promise.resolve()
  let pending = null
  const commandQueue = []
  const waiters = []

  function publish(payload) {
    if (waiters.length > 0) waiters.shift()(payload)
    else commandQueue.push(payload)
  }

  function nextCommand() {
    if (commandQueue.length > 0) return Promise.resolve(commandQueue.shift())
    return new Promise(resolve => waiters.push(resolve))
  }

  function sendCommand(command, args = []) {
    const payload = { command, arguments: args }
    const run = () => new Promise((resolve, reject) => {
      pending = { resolve, reject }
      publish(payload)
    })
    if (command === 'Document.complete') {
      // Terminal command: wait for outstanding commands, emit it, never wait
      // for an answer (Zotero does exactly this).
      chain = chain.then(
        () => { publish(payload); return undefined },
        () => { publish(payload); return undefined },
      )
      return Promise.resolve()
    }
    chain = chain.then(run, run)
    return chain
  }

  function deliver(result) {
    if (!pending) return
    const current = pending
    pending = null
    current.resolve(result)
  }

  function deliverError(error) {
    if (!pending) return
    const current = pending
    pending = null
    current.reject(error instanceof Error ? error : new Error(String(error?.message ?? error)))
  }

  /** Abort a hung transaction: reject the in-flight command and emit complete. */
  function abort(error) {
    deliverError(error ?? new Error('Integration transaction aborted'))
    publish({ command: 'Document.complete', arguments: [] })
  }

  return { sendCommand, nextCommand, deliver, deliverError, abort, get busy() { return pending !== null } }
}

export class HttpApplication {
  constructor(transport, defaults = {}) {
    this.transport = transport
    this.primaryFieldType = defaults.primaryFieldType ?? 'Field'
    this.secondaryFieldType = defaults.secondaryFieldType ?? 'Bookmark'
    this.outputFormat = defaults.outputFormat ?? 'rtf'
    this.supportedNotes = defaults.supportedNotes ?? ['footnotes', 'endnotes']
    this.supportsImportExport = defaults.supportsImportExport ?? true
    this.supportsTextInsertion = defaults.supportsTextInsertion ?? true
    this.supportsCitationMerging = defaults.supportsCitationMerging ?? true
    this.processorName = defaults.processorName ?? 'Word'
  }

  async getActiveDocument() {
    const result = await this.transport.sendCommand('Application.getActiveDocument', [])
    const info = result && typeof result === 'object' ? result : {}
    for (const key of ['outputFormat', 'supportedNotes', 'supportsImportExport',
      'supportsTextInsertion', 'supportsCitationMerging', 'processorName',
      'primaryFieldType', 'secondaryFieldType']) {
      if (info[key] !== undefined) this[key] = info[key]
    }
    return new HttpDocument(this.transport, String(info.documentID ?? 'document'))
  }

  async getDocument(docID) {
    return this.getActiveDocument(docID)
  }
}

const DOCUMENT_METHODS = [
  'activate', 'canInsertField', 'displayAlert', 'getDocumentData', 'setDocumentData',
  'setBibliographyStyle', 'importDocument', 'exportDocument', 'insertText', 'cleanup',
]

export class HttpDocument {
  constructor(transport, documentID) {
    this.transport = transport
    this.documentID = documentID
    for (const name of DOCUMENT_METHODS) {
      this[name] = async (...args) => transport.sendCommand(`Document.${name}`, [documentID, ...args])
    }
  }

  async cursorInField(fieldType) {
    const value = await this.transport.sendCommand('Document.cursorInField', [this.documentID, fieldType])
    return value ? new HttpField(this.transport, this.documentID, value) : null
  }

  async insertField(fieldType, noteType = 0) {
    const value = await this.transport.sendCommand('Document.insertField',
      [this.documentID, fieldType, Number.parseInt(noteType, 10) || 0])
    return new HttpField(this.transport, this.documentID, value)
  }

  async getFields(fieldType) {
    const values = await this.transport.sendCommand('Document.getFields', [this.documentID, fieldType])
    return (Array.isArray(values) ? values : []).map(value => new HttpField(this.transport, this.documentID, value))
  }

  async convert(fields, fieldType, noteTypes) {
    return this.transport.sendCommand('Document.convert', [
      this.documentID,
      (fields ?? []).map(field => String(field._id ?? field.id ?? '')),
      fieldType,
      noteTypes ?? [],
    ])
  }

  async convertPlaceholdersToFields(codes, placeholderIDs, noteType) {
    const values = await this.transport.sendCommand('Document.convertPlaceholdersToFields',
      [this.documentID, codes ?? [], placeholderIDs ?? [], Number.parseInt(noteType, 10) || 0])
    return (Array.isArray(values) ? values : []).map(value => new HttpField(this.transport, this.documentID, value))
  }

  // ------------------------------------------------------- AI write-back ---
  // The Word template holds the selection Range captured when the AI task was
  // started; these commands write text / citation fields into it sequentially.
  // `expected` guards against the document having been edited meanwhile: the
  // responder compares it with the live range and aborts without any mutation.

  async aiBegin(mode, expected = '') {
    const value = await this.transport.sendCommand('Document.aiBegin', [this.documentID, mode, expected])
    const info = value && typeof value === 'object' ? value : {}
    if (info.ok === false) {
      throw new Error(String(info.error ?? '选区校验失败，写回已取消'))
    }
    return info
  }

  async aiText(text) {
    // Word's paragraph mark is Chr(13); normalise platform newlines.
    const payload = String(text ?? '').replace(/\r?\n/g, '\r')
    return this.transport.sendCommand('Document.aiText', [this.documentID, payload])
  }

  async aiField(fieldType = 'Field') {
    const value = await this.transport.sendCommand('Document.aiField', [this.documentID, fieldType])
    return value && typeof value === 'object' ? new HttpField(this.transport, this.documentID, value) : null
  }

  async aiFieldAt(offset, fieldType, noteType = 0) {
    const value = await this.transport.sendCommand('Document.aiFieldAt',
      [this.documentID, Number(offset) || 0, fieldType, Number.parseInt(noteType, 10) || 0])
    return value && typeof value === 'object' ? new HttpField(this.transport, this.documentID, value) : null
  }

  async aiFieldAfter(anchor, fieldType = 'Field', noteType = 0) {
    const value = await this.transport.sendCommand('Document.aiFieldAfter',
      [this.documentID, String(anchor ?? ''), fieldType, Number.parseInt(noteType, 10) || 0])
    if (value && typeof value === 'object' && value.error) {
      throw new Error(String(value.error))
    }
    return value && typeof value === 'object' ? new HttpField(this.transport, this.documentID, value) : null
  }

  async aiEnd() {
    return this.transport.sendCommand('Document.aiEnd', [this.documentID])
  }

  async complete() {
    return this.transport.sendCommand('Document.complete', [this.documentID])
  }
}

export class HttpField {
  constructor(transport, documentID, json = {}) {
    this.transport = transport
    this._documentID = documentID
    this._id = String(json.id ?? '')
    this._code = String(json.code ?? '')
    this._text = String(json.text ?? '')
    this._noteIndex = Number(json.noteIndex ?? 0)
    this._adjacent = json.adjacent === true
  }

  get id() { return this._id }

  async delete() { return this.transport.sendCommand('Field.delete', [this._documentID, this._id]) }
  async select() { return this.transport.sendCommand('Field.select', [this._documentID, this._id]) }
  async removeCode() { return this.transport.sendCommand('Field.removeCode', [this._documentID, this._id]) }
  async setText(text, isRich = false) {
    this._text = String(text ?? '')
    // The VBA responder reads this flag with ArgNum() -> Val(CStr(v)).
    // A JSON boolean becomes "True"/"False" in VBA and Val() returns 0 for
    // both, so Word would take the plain-text branch and write the raw RTF
    // markup into the field. Send 1/0 so even an already installed (older)
    // .dotm takes the rich-text branch.
    return this.transport.sendCommand('Field.setText',
      [this._documentID, this._id, this._text, isRich ? 1 : 0])
  }
  async getText() { return this._text }
  async setCode(code) {
    this._code = String(code ?? '')
    return this.transport.sendCommand('Field.setCode', [this._documentID, this._id, this._code])
  }
  async getCode() { return this._code }
  async getNoteIndex() { return this._noteIndex }
  async equals(other) { return this._id === String(other?._id ?? other?.id ?? '') }
  async isAdjacentToNextField() { return this._adjacent }
  /** JSON shape sent back to the word processor for getFields/convert. */
  toJSON() {
    return {
      id: this._id, code: this._code, text: this._text,
      noteIndex: this._noteIndex, adjacent: this._adjacent,
    }
  }
}
