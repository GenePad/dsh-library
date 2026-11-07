// Metadata lookup: DOI/ISBN/arXiv resolution plus Crossref bibliographic search.
import { fetchJson } from './util.js'

const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)\b/i
const ARXIV_RE = /(?:arxiv[:\s./]*)(\d{4}\.\d{4,5})(?:v\d+)?/i
const ARXIV_OLD_RE = /(?:arxiv[:\s./]*)([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/i
const ISBN_RE = /\b(97[89]\d{10}|\d{9}[\dX])\b/
// PMID only with explicit context — bare digit runs would match years and page
// numbers all over the place (Zotero requires the same).
const PMID_RE = /\b(?:pmid[:\s]*|pubmed[:\s\/]*id[:\s]*)(\d{5,9})\b/i

/** Detect identifiers inside arbitrary text (a file name, a pasted line, a PDF first page). */
export function detectIdentifiers(text) {
  const value = String(text ?? '')
  const found = {}
  const doi = DOI_RE.exec(value)
  if (doi) found.doi = doi[1].replace(/[.,;]+$/, '')
  const arxiv = ARXIV_RE.exec(value) ?? ARXIV_OLD_RE.exec(value)
  if (arxiv) found.arxiv = arxiv[1]
  const isbn = ISBN_RE.exec(value.replace(/[-\s]/g, ''))
  if (isbn) found.isbn = isbn[1]
  const pmid = PMID_RE.exec(value)
  if (pmid) found.pmid = pmid[1]
  return found
}

/**
 * Every identifier in a text, in order of appearance — the Add-by-Identifier
 * box accepts one id per line (Zotero's lookup panel behaviour).
 */
export function extractIdentifiers(text) {
  const value = String(text ?? '')
  const found = []
  const seen = new Set()
  const push = (kind, id) => {
    const entry = { kind, id }
    const signature = `${kind}:${id}`
    if (!seen.has(signature)) {
      seen.add(signature)
      found.push(entry)
    }
  }
  for (const match of value.matchAll(new RegExp(DOI_RE.source, 'gi'))) push('doi', match[1].replace(/[.,;]+$/, ''))
  for (const pattern of [ARXIV_RE, ARXIV_OLD_RE]) {
    const match = pattern.exec(value)
    if (match) push('arxiv', match[1])
  }
  for (const match of value.replace(/[-\s]/g, ' ').matchAll(new RegExp(ISBN_RE.source, 'g'))) push('isbn', match[1])
  for (const match of value.matchAll(new RegExp(PMID_RE.source, 'gi'))) push('pmid', match[1])
  return found
}

/** Strip JATS/HTML markup Crossref abstracts carry. */
function cleanAbstract(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function dateParts(message) {
  for (const key of ['issued', 'published-print', 'published-online', 'published', 'created']) {
    const parts = message?.[key]?.['date-parts']?.[0]
    if (Array.isArray(parts) && parts.length > 0) {
      const [year, month, day] = parts
      if (!year) continue
      if (month && day) return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      if (month) return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-00`
      return String(year)
    }
  }
  return ''
}

function crossrefType(type) {
  return ({
    'journal-article': 'journalArticle',
    'proceedings-article': 'conferencePaper',
    'book-chapter': 'bookSection',
    'book': 'book',
    'monograph': 'book',
    'edited-book': 'book',
    'reference-book': 'book',
    'posted-content': 'preprint',
    'dissertation': 'thesis',
    'report': 'report',
    'standard': 'standard',
    'dataset': 'dataset',
    'peer-review': 'journalArticle',
    'other': 'document',
  })[String(type ?? '')] ?? 'journalArticle'
}

/** Map one Crossref work into a Zotero-shaped item draft. */
export function fromCrossref(message) {
  if (!message || typeof message !== 'object') return undefined
  const fields = {}
  const title = Array.isArray(message.title) ? message.title[0] : message.title
  if (title) fields.title = String(title).replace(/\s+/g, ' ').trim()
  const container = Array.isArray(message['container-title']) ? message['container-title'][0] : message['container-title']
  if (container) fields.publicationTitle = String(container)
  const short = Array.isArray(message['short-container-title']) ? message['short-container-title'][0] : message['short-container-title']
  if (short) fields.journalAbbreviation = String(short)
  if (message.volume) fields.volume = String(message.volume)
  if (message.issue) fields.issue = String(message.issue)
  if (message.page) fields.pages = String(message.page)
  if (message.publisher) fields.publisher = String(message.publisher)
  const date = dateParts(message)
  if (date) fields.date = date
  if (Array.isArray(message.ISSN) && message.ISSN[0]) fields.ISSN = String(message.ISSN[0])
  if (Array.isArray(message.ISBN) && message.ISBN[0]) fields.ISBN = String(message.ISBN[0])
  if (message.abstract) fields.abstractNote = cleanAbstract(message.abstract)
  if (message.URL) fields.url = String(message.URL)
  if (message.DOI) fields.DOI = String(message.DOI)
  if (message.language) fields.language = String(message.language)
  if (message['article-number']) fields.pages = fields.pages || String(message['article-number'])
  const creators = []
  const authors = Array.isArray(message.author) ? message.author : []
  for (const author of authors) {
    if (author?.family) creators.push({ firstName: String(author.given ?? ''), lastName: String(author.family), creatorType: 'author' })
    else if (author?.name) creators.push({ fieldMode: 1, lastName: String(author.name), creatorType: 'author' })
  }
  const editors = Array.isArray(message.editor) ? message.editor : []
  for (const editor of editors) {
    if (editor?.family) creators.push({ firstName: String(editor.given ?? ''), lastName: String(editor.family), creatorType: 'editor' })
    else if (editor?.name) creators.push({ fieldMode: 1, lastName: String(editor.name), creatorType: 'editor' })
  }
  const tags = Array.isArray(message.subject) ? message.subject.slice(0, 12).map(String) : []
  if (Object.keys(fields).length === 0) return undefined
  return {
    itemType: crossrefType(message.type),
    fields,
    creators,
    tags,
    source: 'crossref',
    identifier: message.DOI ? `doi:${message.DOI}` : undefined,
  }
}

/** Resolve one DOI through Crossref. */
export async function lookupDoi(doi) {
  try {
    const data = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)
    const draft = fromCrossref(data?.message)
    if (draft) return draft
  } catch {
    // Crossref miss falls through to doi.org content negotiation.
  }
  try {
    const response = await fetch(`https://doi.org/${encodeURIComponent(doi)}`, {
      headers: { accept: 'application/vnd.citationstyles.csl+json' },
      signal: AbortSignal.timeout(20_000),
    })
    if (response.ok) {
      const csl = await response.json()
      const message = {
        title: csl.title ? [csl.title] : undefined,
        'container-title': csl['container-title'] ? [csl['container-title']] : undefined,
        volume: csl.volume,
        issue: csl.issue,
        page: csl.page,
        publisher: csl.publisher,
        DOI: csl.DOI ?? doi,
        URL: csl.URL,
        type: csl.type === 'article-journal' ? 'journal-article' : csl.type,
        issued: { 'date-parts': csl.issued?.['date-parts'] },
        author: Array.isArray(csl.author) ? csl.author.map(author => ({ family: author.family, given: author.given, name: author.literal })) : [],
      }
      const draft = fromCrossref(message)
      if (draft) return draft
    }
  } catch {
    // No answer from the DOI resolver either.
  }
  return undefined
}

/** Resolve an ISBN through Open Library. */
export async function lookupIsbn(isbn) {
  const key = `ISBN:${isbn}`
  try {
    const data = await fetchJson(`https://openlibrary.org/api/books?bibkeys=${encodeURIComponent(key)}&format=json&jscmd=data`)
    const entry = data?.[key]
    if (!entry) return undefined
    const fields = { title: String(entry.title ?? ''), ISBN: isbn }
    if (entry.subtitle) fields.shortTitle = String(entry.subtitle)
    if (entry.publishers?.[0]?.name) fields.publisher = String(entry.publishers[0].name)
    if (entry.publish_date) fields.date = String(entry.publish_date)
    if (entry.number_of_pages) fields.numPages = String(entry.number_of_pages)
    if (entry.url) fields.url = String(entry.url)
    const creators = (entry.authors ?? []).map(author => ({ fieldMode: 1, lastName: String(author.name ?? ''), creatorType: 'author' })).filter(author => author.lastName)
    const tags = Array.isArray(entry.subjects) ? entry.subjects.slice(0, 12).map(subject => String(subject.name ?? '')).filter(Boolean) : []
    return { itemType: 'book', fields, creators, tags, source: 'openlibrary', identifier: `isbn:${isbn}` }
  } catch {
    return undefined
  }
}

/** Resolve an arXiv id through the export API (Atom XML, read with narrow patterns). */
export async function lookupArxiv(arxivId) {
  try {
    const response = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}&max_results=1`, {
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) return undefined
    const xml = await response.text()
    const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1]
    if (!entry) return undefined
    const text = tag => {
      const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry)
      return match ? match[1].replace(/\s+/g, ' ').trim() : ''
    }
    const fields = {
      title: text('title'),
      abstractNote: text('summary'),
      date: text('published').slice(0, 10),
      url: text('id').replace('/abs/', '/abs/'),
      repository: 'arXiv',
      archiveID: `arXiv:${arxivId}`,
    }
    const creators = []
    const authorPattern = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g
    let match
    while ((match = authorPattern.exec(entry)) !== null) {
      const name = match[1].replace(/\s+/g, ' ').trim()
      const parts = name.split(' ')
      creators.push({ firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) ?? name, creatorType: 'author' })
    }
    return { itemType: 'preprint', fields, creators, tags: [], source: 'arxiv', identifier: `arxiv:${arxivId}` }
  } catch {
    return undefined
  }
}

/** Resolve a PubMed id through NCBI's eutils summary API. */
export async function lookupPmid(pmid) {
  try {
    const response = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=json`, {
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) return undefined
    const data = await response.json()
    const result = data?.result?.[String(pmid)]
    if (!result || result.error) return undefined
    const fields = {
      title: String(result.title ?? '').replace(/\s*\.\s*$/, ''),
      publicationTitle: String(result.fulljournalname ?? result.source ?? ''),
      journalAbbreviation: String(result.source ?? ''),
      date: String(result.pubdate ?? ''),
      volume: String(result.volume ?? ''),
      issue: String(result.issue ?? ''),
      pages: String(result.pages ?? ''),
    }
    for (const key of Object.keys(fields)) if (fields[key] === '') delete fields[key]
    if (Array.isArray(result.articleids)) {
      const doi = result.articleids.find(entry => entry.idtype === 'doi')?.value
      if (doi) fields.DOI = String(doi)
    }
    const creators = (Array.isArray(result.authors) ? result.authors : []).map(author => {
      const name = String(author.name ?? '')
      const parts = name.split(/\s+/)
      return parts.length > 1
        ? { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1), creatorType: 'author' }
        : { fieldMode: 1, lastName: name, creatorType: 'author' }
    }).filter(creator => creator.lastName)
    if (Object.keys(fields).length === 0) return undefined
    return { itemType: 'journalArticle', fields, creators, tags: [], source: 'pubmed', identifier: `pmid:${pmid}` }
  } catch {
    return undefined
  }
}

/**
 * Resolve every identifier in a block of text (the Add-by-Identifier box).
 * Returns one draft per identifier, `undefined` for the ones that missed, so
 * the caller can report partial failures like Zotero's lookup does.
 */
export async function resolveEachIdentifier(text) {
  const identifiers = extractIdentifiers(text).slice(0, 50)
  return Promise.all(identifiers.map(async ({ kind, id }) => {
    try {
      if (kind === 'doi') return await lookupDoi(id) ?? undefined
      if (kind === 'arxiv') return await lookupArxiv(id) ?? undefined
      if (kind === 'isbn') return await lookupIsbn(id) ?? undefined
      if (kind === 'pmid') return await lookupPmid(id) ?? undefined
    } catch {
      // One failed identifier must not kill the batch.
    }
    return undefined
  }))
}

/** Turn a Zotero-style file name into a bibliographic query. */
export function queryFromFileName(fileName) {
  let name = String(fileName ?? '').replace(/\.[a-z0-9]{2,5}$/i, '')
  // Zotero names downloads "<Authors> - <Year> - <Title>"; the title is the
  // longest dash-separated part.
  const parts = name.split(/\s+-\s+/).map(part => part.trim()).filter(Boolean)
  if (parts.length > 1) {
    name = parts.reduce((best, part) => (part.length > best.length ? part : best), '')
  }
  return name
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Bibliographic search by free text (file name, title fragment). */
export async function searchCrossref(query, { rows = 5 } = {}) {
  const cleaned = queryFromFileName(query)
  if (cleaned.length < 6) return []
  try {
    const data = await fetchJson(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(cleaned)}&rows=${rows}&select=DOI,title,author,editor,issued,container-title,short-container-title,type,volume,issue,page,publisher,ISSN,ISBN,abstract,URL`)
    const items = Array.isArray(data?.message?.items) ? data.message.items : []
    return items.map(fromCrossref).filter(Boolean)
  } catch {
    return []
  }
}

/** Token overlap score in [0,1] between a query and a candidate title. */
export function titleScore(query, candidate) {
  const tokens = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').split(/\s+/).filter(token => token.length > 2)
  const wanted = new Set(tokens(query))
  const got = new Set(tokens(candidate))
  if (wanted.size === 0 || got.size === 0) return 0
  let shared = 0
  for (const token of wanted) if (got.has(token)) shared += 1
  return shared / Math.min(wanted.size, got.size)
}

/**
 * Resolve metadata for an import.
 * @param {object} input
 * @param {string} [input.fileName] - original file name, used for identifier detection and search.
 * @param {string} [input.text] - extracted first-page text, an extra identifier source.
 * @param {string} [input.identifier] - explicit DOI/ISBN/arXiv string.
 * @returns {Promise<object|undefined>} best draft
 */
export async function resolveMetadata(input = {}) {
  const haystacks = [input.identifier, input.fileName, String(input.text ?? '').slice(0, 8000)].filter(Boolean)
  const found = {}
  for (const hay of haystacks) Object.assign(found, detectIdentifiers(hay))
  // Order matters: a DOI is the strongest signal, then arXiv, then ISBN.
  if (found.doi) {
    const draft = await lookupDoi(found.doi)
    if (draft) return draft
  }
  if (found.arxiv) {
    const draft = await lookupArxiv(found.arxiv)
    if (draft) return draft
  }
  if (found.isbn) {
    const draft = await lookupIsbn(found.isbn)
    if (draft) return draft
  }
  // Fall back to a bibliographic query built from the file name.
  const query = queryFromFileName(input.fileName)
  const candidates = await searchCrossref(query, { rows: 5 })
  let best
  let bestScore = 0
  for (const candidate of candidates) {
    const score = titleScore(query, candidate.fields.title)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  if (best && bestScore >= 0.45) return { ...best, confidence: bestScore }
  return best ? { ...best, confidence: bestScore } : undefined
}
