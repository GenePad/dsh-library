// Item-type schema helpers over the bundled global schema (schema-data.js,
// generated from Zotero's published schema.json). The item pane, type changes
// and the create-item menu all read from here — no database queries needed,
// since the schema is versioned data, not library content.
import { GLOBAL_SCHEMA } from './schema-data.js'

const BY_TYPE = new Map(GLOBAL_SCHEMA.itemTypes.map(type => [type.itemType, type]))

/** One item type's shape: {itemType, fields[], fieldBases{}, creatorTypes[]}. */
export function typeSchema(itemType) {
  const found = BY_TYPE.get(String(itemType))
  if (!found) throw Object.assign(new Error(`Unknown Zotero item type "${itemType}"`), { code: 'library/invalid' })
  return found
}

/** All item types in schema order (the 新建条目 / type menus). */
export function typeList() {
  return GLOBAL_SCHEMA.itemTypes.map(type => ({ itemType: type.itemType, fields: type.fields, creatorTypes: type.creatorTypes }))
}

/**
 * Plan a type change the way Zotero's Zotero.Item.setType does: a stored field
 * transfers when the target type maps the same base field, and is dropped
 * otherwise. `storedFields` is the item's current field name list.
 */
export function planTypeChange(fromType, toType, storedFields) {
  const source = typeSchema(fromType)
  const target = typeSchema(toType)
  // Base field → target field. A field name maps to itself first (e.g. `title`),
  // then to the type-specific field over that base (fieldBases).
  const baseToTarget = new Map()
  for (const field of target.fields) {
    const base = target.fieldBases[field] ?? field
    if (!baseToTarget.has(base)) baseToTarget.set(base, field)
  }
  const transfers = []
  const dropped = []
  for (const field of storedFields) {
    if (!source.fields.includes(field)) continue // not shown for the type anyway
    const base = source.fieldBases[field] ?? field
    const targetField = baseToTarget.get(base)
    if (targetField) transfers.push([field, targetField])
    else dropped.push(field)
  }
  return { transfers, dropped }
}
