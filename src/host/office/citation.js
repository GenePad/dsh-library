// Citation, Bibliography and URI map: the serialisable data model Zotero
// stores inside document fields.
import {
  CSL_CITATION_SCHEMA, NO_ACTION, UPDATE, DELETE, REMOVE_CODE,
  MissingItemException,
} from './constants.js'
import { createItemRegistry } from './items.js'

const SAVE_PROPERTIES = ['custom', 'unsorted', 'formattedCitation', 'plainCitation', 'dontUpdate', 'noteIndex']
const SAVE_ITEM_KEYS = ['locator', 'label', 'suppress-author', 'author-only', 'prefix', 'suffix', 'ignoreRetraction']

export class URIMap {
  constructor(registry) {
    this.registry = registry
    this.itemIDURIs = new Map()
  }

  add(id, uris) {
    const key = String(id)
    const list = Array.isArray(uris) ? uris.map(String) : []
    const merged = Array.from(new Set([...(this.itemIDURIs.get(key) ?? []), ...list]))
    this.itemIDURIs.set(key, merged)
    for (const uri of merged) this.registry.register(key, undefined, [uri])
  }

  getURIsForItemID(id) {
    const key = String(id)
    const known = this.itemIDURIs.get(key)
    if (known?.length) return [...known]
    if (key.includes('/')) return []
    return this.registry.urisFor(key)
  }

  /** Resolve a set of URIs back to a library/embedded item id. */
  getZoteroItemForURIs(uris) {
    const found = this.registry.findByURIs(uris)
    if (!found) return [null, false]
    const current = this.getURIsForItemID(found)
    const needUpdate = (Array.isArray(uris) ? uris : []).some(uri => !current.includes(String(uri)))
    if (needUpdate) this.add(found, uris)
    return [found, needUpdate]
  }
}

export class Citation {
  constructor(citationField, data = {}, noteIndex = 0) {
    const object = { ...data }
    this.citationID = object.citationID
    this.citationItems = Array.isArray(object.citationItems) ? object.citationItems : []
    this.properties = { ...(object.properties ?? {}) }
    this.properties.noteIndex = noteIndex
    this.field = citationField
    this.text = ''
  }

  static refreshEmbeddedData(itemData) {
    if (!itemData || typeof itemData !== 'object') return itemData
    const item = { ...itemData }
    if (item.shortTitle !== undefined && item['title-short'] === undefined) item['title-short'] = item.shortTitle
    return item
  }

  mergeCitation(citation) {
    const seen = new Set(this.citationItems.map(item => String(item.id)))
    for (const item of citation.citationItems ?? []) {
      if (!seen.has(String(item.id))) {
        this.citationItems.push({ ...item })
        seen.add(String(item.id))
      }
    }
  }

  /**
   * Resolve every citation item into the session item registry.
   * Returns one of NO_ACTION / UPDATE / DELETE / REMOVE_CODE.
   */
  async loadItemData(registry, { promptToReselect = true } = {}) {
    let action = NO_ACTION
    for (let index = 0; index < this.citationItems.length; index += 1) {
      const item = this.citationItems[index]
      const original = String(item.id ?? '')
      const resolved = registry.resolve(item.id, Citation.refreshEmbeddedData(item.itemData), item.uris)
      if (resolved) {
        if (resolved !== original) {
          item.id = resolved
          action = Math.max(action, UPDATE)
        }
        if (item.uris?.length) registry.register(resolved, undefined, item.uris)
        continue
      }
      if (promptToReselect && this.options?.reselect) {
        const replacement = await this.options.reselect(original, item.itemData)
        if (replacement) {
          item.id = String(replacement)
          action = Math.max(action, UPDATE)
          continue
        }
      }
      action = Math.max(action, REMOVE_CODE)
      item.missing = true
    }
    return action
  }

  /** Zotero 7 does a light clean-up before opening a citation for editing. */
  prepareForEditing() {
    const text = this.properties.plainCitation
    delete this.properties.formattedCitation
    delete this.properties.plainCitation
    delete this.properties.dontUpdate
    return text
  }

  toJSON(registry) {
    const citation = {
      citationID: this.citationID,
      properties: {},
      citationItems: new Array(this.citationItems.length),
      schema: CSL_CITATION_SCHEMA,
    }
    for (const key of SAVE_PROPERTIES) {
      if (key in this.properties) citation.properties[key] = this.properties[key]
    }
    for (let i = 0; i < this.citationItems.length; i += 1) {
      const item = this.citationItems[i]
      const out = {
        id: item.id,
        uris: new URIMap(registry).getURIsForItemID(item.id),
        itemData: registry.items.get(String(item.id)) ?? item.itemData ?? null,
      }
      for (const key of SAVE_ITEM_KEYS) {
        if (key in item) out[key] = item[key]
      }
      citation.citationItems[i] = out
    }
    return citation
  }

  serialize(registry) {
    return JSON.stringify(this.toJSON(registry))
  }

  /** citeproc's cluster shape (no itemData/uris). */
  toCluster() {
    return {
      citationID: this.citationID,
      properties: { ...this.properties },
      citationItems: this.citationItems.map(item => {
        const out = { id: item.id }
        for (const key of SAVE_ITEM_KEYS) if (key in item) out[key] = item[key]
        return out
      }),
    }
  }
}

export class Bibliography {
  constructor(bibliographyField, data = {}, registry) {
    this.field = bibliographyField
    this.registry = registry
    this.uncitedItemIDs = new Set()
    this.omittedItemIDs = new Set()
    this.customEntryText = {}
    this.dataLoaded = false
    this.loadItemData(data)
  }

  loadItemData(data = {}) {
    const uriMap = new URIMap(this.registry)
    const resolve = (value) => uriMap.getZoteroItemForURIs(Array.isArray(value) ? value : [])[0]
    // Current format: arrays of URI arrays.
    if (Array.isArray(data.uncited)) {
      for (const entry of data.uncited) {
        const id = resolve(entry)
        if (id) this.uncitedItemIDs.add(String(id))
      }
    } else if (data.uncited && typeof data.uncited === 'object') {
      // Legacy format: hash keyed by item id.
      for (const [id, uris] of Object.entries(data.uncited)) {
        const found = resolve(uris) ?? id
        this.uncitedItemIDs.add(String(found))
      }
    }
    if (Array.isArray(data.omitted)) {
      for (const entry of data.omitted) {
        const id = resolve(entry)
        if (id) this.omittedItemIDs.add(String(id))
      }
    }
    if (Array.isArray(data.custom)) {
      for (const [uris, text] of data.custom) {
        const id = resolve(uris)
        if (id) this.customEntryText[String(id)] = String(text ?? '')
      }
    } else if (data.custom && typeof data.custom === 'object') {
      for (const [id, text] of Object.entries(data.custom)) {
        if (text === undefined) continue
        this.customEntryText[String(id)] = typeof text === 'object' && text !== null
          ? String(text.text ?? '') : String(text)
      }
    }
    this.dataLoaded = true
    return this
  }

  /** Render the bibliography, applying omissions and custom entry text. */
  getCiteprocBibliography(engine) {
    engine.updateUncitedItems([...this.uncitedItemIDs].map(String))
    const bib = engine.makeBibliography()
    const meta = bib?.[0] ?? {}
    const entries = Array.isArray(bib?.[1]) ? [...bib[1]] : []
    const ids = Array.isArray(meta.entry_ids) ? meta.entry_ids : []
    const keptMeta = { ...meta, entry_ids: [] }
    const keptEntries = []
    for (let i = 0; i < entries.length; i += 1) {
      const group = Array.isArray(ids[i]) ? ids[i].map(String) : [String(ids[i] ?? '')]
      if (group.some(id => this.omittedItemIDs.has(id))) continue
      const custom = group.map(id => this.customEntryText[id]).find(Boolean)
      keptMeta.entry_ids.push(ids[i] ?? group)
      keptEntries.push(custom ?? entries[i])
    }
    return [keptMeta, keptEntries]
  }

  serialize() {
    const uriMap = new URIMap(this.registry)
    return JSON.stringify({
      uncited: [...this.uncitedItemIDs].map(id => uriMap.getURIsForItemID(id)),
      omitted: [...this.omittedItemIDs].map(id => uriMap.getURIsForItemID(id)),
      custom: Object.entries(this.customEntryText).map(([id, text]) => [uriMap.getURIsForItemID(id), text]),
    })
  }
}
