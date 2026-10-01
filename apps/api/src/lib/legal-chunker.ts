/**
 * Legal Chunker — SOTA clause-level chunking + Elasticsearch indexing.
 *
 * Algorithm:
 *  1. Use AI-extracted clauseSegments as primary chunk boundaries (already typed)
 *  2. For clauses with content.length > MAX_CLAUSE_LEN: sliding-window sub-chunks
 *  3. snapToSentence(): snap cut points to nearest `. ` within ±SNAP_WINDOW chars
 *  4. Upsert ContractClause rows (with isSubChunk, windowIndex, charStart, charEnd)
 *  5. Bulk index into ES `clauses` index with denormalized contract metadata
 */
import { prisma } from './prisma.js'
import { es } from './elasticsearch.js'

const MAX_CLAUSE_LEN  = 2_000   // chars — clauses over this get sliding-window sub-chunks
const SUB_CHUNK_LEN   = 1_800   // max chars per sub-chunk
const SUB_CHUNK_OVERLAP = 360   // chars — ~10% overlap to prevent boundary loss
const SNAP_WINDOW     = 100     // chars to search left/right for a sentence boundary

export const CLAUSES_INDEX = `${process.env.ES_INDEX_PREFIX ?? ''}clauses`

// ─── Sentence boundary snapping ──────────────────────────────────────────────

function snapToSentence(text: string, pos: number): number {
  const lo = Math.max(0, pos - SNAP_WINDOW)
  const hi = Math.min(text.length, pos + SNAP_WINDOW)
  const window = text.slice(lo, hi)

  // Look for `. ` or `.\n` nearest to the target position
  let bestDist = Infinity
  let bestPos  = pos

  for (let i = 0; i < window.length - 1; i++) {
    if (window[i] === '.' && (window[i + 1] === ' ' || window[i + 1] === '\n')) {
      const absPos = lo + i + 2  // +2: start after `. `
      const dist   = Math.abs(absPos - pos)
      if (dist < bestDist) {
        bestDist = dist
        bestPos  = absPos
      }
    }
  }
  return bestPos
}

// ─── Sliding window sub-chunks ────────────────────────────────────────────────

interface SubChunk {
  content:     string
  charStart:   number
  charEnd:     number
  windowIndex: number
}

export function slidingWindowChunks(text: string, baseOffset = 0): SubChunk[] {
  if (text.length <= MAX_CLAUSE_LEN) {
    return [{
      content:     text,
      charStart:   baseOffset,
      charEnd:     baseOffset + text.length,
      windowIndex: 0,
    }]
  }

  const chunks: SubChunk[] = []
  let start = 0
  let windowIndex = 0

  while (start < text.length) {
    let end = Math.min(start + SUB_CHUNK_LEN, text.length)

    if (end < text.length) {
      end = snapToSentence(text, end)
    }

    const content = text.slice(start, end).trim()
    if (content.length > 0) {
      chunks.push({
        content,
        charStart:   baseOffset + start,
        charEnd:     baseOffset + end,
        windowIndex: windowIndex++,
      })
    }

    // Advance with overlap. Z9 — stop once a window reaches the end: the
    // last window stepped back by the overlap and was cut again, forever, so
    // any clause over MAX_CLAUSE_LEN ran the worker out of memory.
    if (end >= text.length) break
    start = Math.max(end - SUB_CHUNK_OVERLAP, start + 1)
  }

  return chunks
}

// ─── ES clauses index ────────────────────────────────────────────────────────

export async function ensureClausesIndex() {
  // @opensearch-project/opensearch wraps every response in { body, ... }
  const exists = await es.indices.exists({ index: CLAUSES_INDEX })
  if (exists.body === true) return

  await es.indices.create({
    index: CLAUSES_INDEX,
    body: {
      settings: {
        analysis: {
          analyzer: {
            legal_english: {
              type:      'custom',
              tokenizer: 'standard',
              filter:    ['lowercase', 'english_stop', 'english_stemmer'],
            },
          },
          filter: {
            english_stop:    { type: 'stop',    stopwords: '_english_' },
            english_stemmer: { type: 'stemmer', language: 'english'   },
          },
        },
      },
      mappings: {
        properties: {
          contractId:    { type: 'keyword' },
          versionId:     { type: 'keyword' },
          orgId:         { type: 'keyword' },
          clauseType:    { type: 'keyword' },
          content:       { type: 'text', analyzer: 'legal_english' },
          sortOrder:     { type: 'integer' },
          isSubChunk:    { type: 'boolean' },
          windowIndex:   { type: 'integer' },
          charStart:     { type: 'integer' },
          charEnd:       { type: 'integer' },
          // Denormalized scalar contract fields for filtering
          contractTitle: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          contractType:  { type: 'keyword' },
          jurisdiction:  { type: 'keyword' },
        },
      },
    },
  })
}

// ─── Main export ─────────────────────────────────────────────────────────────

interface RawClause {
  id:         string
  clauseType: string
  content:    string
  sortOrder:  number
}

interface ContractMeta {
  title:        string | null
  type:         string | null
  jurisdiction: string | null
}

export async function legalChunkAndStore(
  versionId:   string,
  contractId:  string,
  orgId:       string,
  rawClauses:  RawClause[],
  contractMeta: ContractMeta | null,
): Promise<void> {
  if (rawClauses.length === 0) return

  await ensureClausesIndex()

  // Build all final chunks (primary clauses + sub-chunks for long ones)
  type FinalChunk = {
    dbId:        string   // cuid from DB — becomes ES doc id too
    clauseType:  string
    content:     string
    sortOrder:   number
    isSubChunk:  boolean
    windowIndex: number | null
    charStart:   number | null
    charEnd:     number | null
  }

  const finalChunks: FinalChunk[] = []

  for (const clause of rawClauses) {
    const subs = slidingWindowChunks(clause.content)

    if (subs.length === 1) {
      // Primary chunk — fits within limits, no sub-chunking needed
      finalChunks.push({
        dbId:        clause.id,
        clauseType:  clause.clauseType,
        content:     subs[0].content,
        sortOrder:   clause.sortOrder,
        isSubChunk:  false,
        windowIndex: null,
        charStart:   subs[0].charStart,
        charEnd:     subs[0].charEnd,
      })
    } else {
      // Sub-chunks — update the primary row with sub-chunk 0, create new rows for rest
      for (let i = 0; i < subs.length; i++) {
        finalChunks.push({
          dbId:        i === 0 ? clause.id : '',   // placeholder — will be set after upsert
          clauseType:  clause.clauseType,
          content:     subs[i].content,
          sortOrder:   clause.sortOrder,
          isSubChunk:  i > 0,
          windowIndex: subs[i].windowIndex,
          charStart:   subs[i].charStart,
          charEnd:     subs[i].charEnd,
        })
      }
    }
  }

  // Upsert DB rows
  for (const chunk of finalChunks) {
    if (chunk.dbId) {
      // Update existing row (primary / sub-chunk 0)
      await prisma.contractClause.update({
        where: { id: chunk.dbId },
        data: {
          content:     chunk.content,
          isSubChunk:  chunk.isSubChunk,
          windowIndex: chunk.windowIndex,
          charStart:   chunk.charStart,
          charEnd:     chunk.charEnd,
        },
      })
    } else {
      // Create new sub-chunk row
      const created = await prisma.contractClause.create({
        data: {
          versionId:   versionId,
          clauseType:  chunk.clauseType,
          content:     chunk.content,
          sortOrder:   chunk.sortOrder,
          isSubChunk:  true,
          windowIndex: chunk.windowIndex,
          charStart:   chunk.charStart,
          charEnd:     chunk.charEnd,
        },
      })
      chunk.dbId = created.id
    }
  }

  // Bulk index into ES clauses index
  const body: object[] = []
  const meta = contractMeta ?? { title: null, type: null, jurisdiction: null }

  for (const chunk of finalChunks) {
    body.push({ index: { _index: CLAUSES_INDEX, _id: chunk.dbId } })
    body.push({
      contractId,
      versionId,
      orgId,
      clauseType:    chunk.clauseType,
      content:       chunk.content,
      sortOrder:     chunk.sortOrder,
      isSubChunk:    chunk.isSubChunk,
      windowIndex:   chunk.windowIndex,
      charStart:     chunk.charStart,
      charEnd:       chunk.charEnd,
      // Denormalized contract fields (scalar only — keyTerms is not indexed at clause level)
      contractTitle: meta.title,
      contractType:  meta.type,
      jurisdiction:  meta.jurisdiction,
    })
  }

  if (body.length > 0) {
    // @opensearch-project/opensearch wraps every response in { body, statusCode, … }
    const raw = await es.bulk({ body, refresh: false })
    const result = raw.body
    const errors = (result?.items ?? []).filter((i: any) => i.index?.error)
    if (errors.length > 0) {
      console.error('[legal-chunker] ES bulk errors=%d sample=%j', errors.length, errors[0])
      throw new Error(`ES bulk index failed: ${errors.length} error(s) — sample: ${JSON.stringify(errors[0]?.index?.error)}`)
    } else {
      console.info('[legal-chunker] ES bulk indexed clauses=%d contractId=%s', body.length / 2, contractId)
    }
  }
}
