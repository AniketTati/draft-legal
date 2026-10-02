// Use the OpenSearch JS client instead of @elastic/elasticsearch. Bonsai's
// free sandbox runs OpenSearch 2.x, which rejects the ES-8-specific
// `application/vnd.elasticsearch+json; compatible-with=8` Content-Type
// header. The OpenSearch client sends plain JSON, so indexing works against
// either Elasticsearch or OpenSearch. Their API surface for index/search/
// indices.{exists,create}/aggs is identical for everything this codebase
// uses, so the swap is import-only.
import { Client } from '@opensearch-project/opensearch'
import { normalizeRiskScore } from '@clm/types'
import { prisma } from './prisma.js'
import { withExhibits } from './exhibit-text.js'

export const es = new Client({
  node: process.env.ELASTICSEARCH_URL ?? 'http://localhost:9200',
})

// ES_INDEX_PREFIX lets a second local stack share one Elasticsearch without
// writing into the other stack's indexes. Unset everywhere else.
export const ES_INDEX_PREFIX = process.env.ES_INDEX_PREFIX ?? ''
export const CONTRACT_INDEX = `${ES_INDEX_PREFIX}contracts`

// ─── Index mapping ────────────────────────────────────────────────────────────

export async function ensureContractIndex() {
  // @opensearch-project/opensearch wraps every response in { body, statusCode, ... }.
  // For boolean ops like indices.exists, the real value lives at `.body`.
  const exists = await es.indices.exists({ index: CONTRACT_INDEX })
  if (exists.body === true) return

  await es.indices.create({
    index: CONTRACT_INDEX,
    body: {
      settings: {
        analysis: {
          analyzer: {
            legal_english: {
              type: 'custom',
              tokenizer: 'standard',
              filter: ['lowercase', 'english_stop', 'english_stemmer'],
            },
          },
          filter: {
            english_stop:    { type: 'stop',    stopwords: '_english_' },
            english_stemmer: { type: 'stemmer', language: 'english' },
          },
        },
      },
      mappings: {
      dynamic_templates: [
        {
          keyterms_as_keyword: {
            path_match: 'keyTerms.*',
            mapping: { type: 'keyword' },
          },
        },
        {
          clause_flags_as_bool: {
            path_match: 'clauseFlags.*',
            mapping: { type: 'boolean' },
          },
        },
        {
          metadata_dynamic: {
            path_match: 'metadata.*',
            mapping: { type: 'keyword' },
          },
        },
      ],
      properties: {
        orgId:            { type: 'keyword' },
        title:            { type: 'text', analyzer: 'legal_english', fields: { keyword: { type: 'keyword' } } },
        type:             { type: 'keyword' },
        status:           { type: 'keyword' },
        counterpartyName: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        jurisdiction:     { type: 'keyword' },
        plainText:        { type: 'text', analyzer: 'legal_english' },
        summary:          { type: 'text', analyzer: 'legal_english' },
        tags:             { type: 'keyword' },
        riskScore:        { type: 'float' },
        effectiveDate:    { type: 'date' },
        expiryDate:       { type: 'date' },
        createdAt:        { type: 'date' },
        keyTerms:         { type: 'object', dynamic: true },
        clauseFlags:      { type: 'object', dynamic: true },
        metadata:         { type: 'object', dynamic: true },
        diligenceRoomId:  { type: 'keyword' },
        },
      },
    },
  })
}

// ─── Document type ────────────────────────────────────────────────────────────

export interface ContractDoc {
  orgId: string
  title: string
  type: string
  status: string
  counterpartyName?: string
  jurisdiction?: string
  plainText: string
  summary?: string
  tags: string[]
  riskScore?: number
  effectiveDate?: string
  expiryDate?: string
  createdAt: string
  keyTerms?: Record<string, unknown>
  clauseFlags?: Record<string, boolean>
  metadata?: Record<string, unknown>
  /** Set for diligence-room documents (diligence.ts). */
  diligenceRoomId?: string
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Fields every search doc needs but most callers can't supply: clause flags
 * live on the contract's version (the Review agent writes them) — the current
 * version's, else the latest one's — and diligenceRoomId decides whether the
 * doc belongs in ordinary search at all (C11).
 */
async function docExtrasFor(contractId: string): Promise<{ clauseFlags?: Record<string, boolean>; diligenceRoomId?: string; exhibits?: Array<{ label: string; text: string }> }> {
  const c = await prisma.contract.findUnique({
    where:  { id: contractId },
    select: {
      currentVersionId: true,
      diligenceRoomId: true,
      versions: { orderBy: { versionNumber: 'desc' }, take: 1, select: { id: true, clauseFlags: true } },
      // docs/39 A12 — its exhibits' words are found with it.
      exhibits: { where: { text: { not: '' } }, select: { label: true, text: true } },
    },
  })
  if (!c) return {}
  const version = c.currentVersionId && c.currentVersionId !== c.versions[0]?.id
    ? await prisma.contractVersion.findUnique({ where: { id: c.currentVersionId }, select: { clauseFlags: true } })
    : c.versions[0]
  const flags = version?.clauseFlags
  return {
    ...(flags && typeof flags === 'object' && !Array.isArray(flags) ? { clauseFlags: flags as Record<string, boolean> } : {}),
    ...(c.diligenceRoomId ? { diligenceRoomId: c.diligenceRoomId } : {}),
    ...(c.exhibits.length ? { exhibits: c.exhibits } : {}),
  }
}

export async function indexContract(id: string, doc: ContractDoc) {
  // The index's dynamic template maps keyTerms.* / metadata.* to keyword —
  // nested objects (e.g. an SLA's serviceCreditTiers: {"<99.9%": "10%"})
  // blow up with document_parsing_exception and the contract silently
  // never lands in ES (found in the 2026-06-10 screen review: Umbrella
  // SLA missing from search). Flatten non-scalar values to JSON strings
  // so they stay text-searchable without fighting the mapping.
  const scalarize = (obj?: Record<string, unknown>) => {
    if (!obj) return obj
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = (v === null || ['string', 'number', 'boolean'].includes(typeof v))
        ? v
        : JSON.stringify(v)
    }
    return out
  }
  // C7 — no caller passed clauseFlags, so every doc lacked them and the
  // clause-flag facets/filters counted 0. Fill them from the version unless
  // the caller supplied them, so every index path (and the backfill) carries them.
  //
  // C11 — likewise diligenceRoomId: only diligence.ts passed it, so a later
  // re-index dropped it and the doc leaked back into ordinary search.
  // Fail closed: if this lookup fails, don't write a doc that might be
  // missing diligenceRoomId (it would surface in ordinary search).
  const extras = await docExtrasFor(id)
  const clauseFlags = doc.clauseFlags ?? extras.clauseFlags
  const diligenceRoomId = doc.diligenceRoomId ?? extras.diligenceRoomId
  await es.index({
    index: CONTRACT_INDEX,
    id,
    body: {
      ...doc,
      // docs/39 A12 — the contract's text, then its exhibits'.
      ...(extras.exhibits && { plainText: withExhibits(doc.plainText ?? '', extras.exhibits) }),
      ...(clauseFlags ? { clauseFlags } : {}),
      ...(diligenceRoomId ? { diligenceRoomId } : {}),
      keyTerms: scalarize(doc.keyTerms),
      metadata: scalarize(doc.metadata),
    },
  })
}

/**
 * Rebuild a contract's whole search document from Postgres and index it.
 * indexContract is a full-document overwrite, so a partial doc would blank
 * fields; use this when something other than a create or PATCH changed
 * what is searchable (clause flags arriving, a review-queue correction).
 */
export async function reindexContract(contractId: string): Promise<void> {
  const c = await prisma.contract.findUnique({ where: { id: contractId } })
  if (!c || c.deletedAt) return
  const version = c.currentVersionId
    ? await prisma.contractVersion.findUnique({ where: { id: c.currentVersionId }, select: { plainText: true } })
    : await prisma.contractVersion.findFirst({ where: { contractId }, orderBy: { versionNumber: 'desc' }, select: { plainText: true } })
  await indexContract(c.id, {
    orgId: c.orgId,
    title: c.title,
    type: c.type,
    status: c.status,
    counterpartyName: c.counterpartyName ?? undefined,
    jurisdiction: c.jurisdiction ?? undefined,
    plainText: version?.plainText ?? '',
    summary: c.summary ?? undefined,
    tags: c.tags,
    riskScore: normalizeRiskScore(c.riskScore) ?? undefined,
    effectiveDate: c.effectiveDate?.toISOString(),
    expiryDate: c.expiryDate?.toISOString(),
    createdAt: c.createdAt.toISOString(),
    keyTerms: c.keyTerms as Record<string, unknown>,
    metadata: c.metadata as Record<string, unknown>,
    ...(c.diligenceRoomId ? { diligenceRoomId: c.diligenceRoomId } : {}),
  })
}

export async function deleteContractFromIndex(id: string) {
  await es.delete({ index: CONTRACT_INDEX, id }).catch(() => {})
}

// ─── Query builder ────────────────────────────────────────────────────────────

export interface SearchFilters {
  q?: string
  type?: string
  status?: string
  jurisdiction?: string
  riskScoreMin?: number
  riskScoreMax?: number
  clauseFlags?: Record<string, boolean>   // e.g. { forceMajeure: true }
  effectiveDateFrom?: string
  effectiveDateTo?: string
  expiryDateFrom?: string
  expiryDateTo?: string
  counterpartyId?: string
  counterpartyName?: string
  /** Restrict to these contract ids (own-scope callers; docs carry no ownerId). */
  ids?: string[]
  /** Search one diligence room's documents (excluded from ordinary search otherwise). */
  diligenceRoomId?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildESQuery(orgId: string, filters: SearchFilters): any {
  const must: any[] = []
  const filter: any[] = [{ term: { orgId } }]

  // Full-text keyword search
  if (filters.q) {
    must.push({
      multi_match: {
        query: filters.q,
        fields: ['title^4', 'counterpartyName^2', 'summary^2', 'plainText', 'tags'],
        type: 'best_fields',
        fuzziness: 'AUTO',
      },
    })
  }

  // Structured filters
  if (filters.type)         filter.push({ term: { type: filters.type } })
  if (filters.status)       filter.push({ term: { status: filters.status } })
  if (filters.jurisdiction) filter.push({ term: { jurisdiction: filters.jurisdiction } })

  // B.6.9 — Counterparty drill-through. Match on id OR name so
  // pre-FK contracts (which only have counterpartyName indexed)
  // still show up for the right counterparty.
  if (filters.counterpartyId || filters.counterpartyName) {
    const should: Array<Record<string, unknown>> = []
    if (filters.counterpartyId)   should.push({ term: { counterpartyId: filters.counterpartyId } })
    if (filters.counterpartyName) should.push({ term: { 'counterpartyName.keyword': filters.counterpartyName } })
    filter.push({ bool: { should, minimum_should_match: 1 } })
  }

  if (filters.riskScoreMin != null || filters.riskScoreMax != null) {
    const range: Record<string, number> = {}
    if (filters.riskScoreMin != null) range.gte = filters.riskScoreMin
    if (filters.riskScoreMax != null) range.lte = filters.riskScoreMax
    filter.push({ range: { riskScore: range } })
  }

  if (filters.effectiveDateFrom || filters.effectiveDateTo) {
    const range: Record<string, string> = {}
    if (filters.effectiveDateFrom) range.gte = filters.effectiveDateFrom
    if (filters.effectiveDateTo)   range.lte = filters.effectiveDateTo
    filter.push({ range: { effectiveDate: range } })
  }

  if (filters.expiryDateFrom || filters.expiryDateTo) {
    const range: Record<string, string> = {}
    if (filters.expiryDateFrom) range.gte = filters.expiryDateFrom
    if (filters.expiryDateTo)   range.lte = filters.expiryDateTo
    filter.push({ range: { expiryDate: range } })
  }

  if (filters.ids) filter.push({ ids: { values: filters.ids } })

  // C11 — diligence-room documents stay out of ordinary search.
  const mustNot: any[] = []
  if (filters.diligenceRoomId) filter.push({ term: { diligenceRoomId: filters.diligenceRoomId } })
  else mustNot.push({ exists: { field: 'diligenceRoomId' } })

  if (filters.clauseFlags) {
    for (const [flag, val] of Object.entries(filters.clauseFlags)) {
      filter.push({ term: { [`clauseFlags.${flag}`]: val } })
    }
  }

  return {
    bool: {
      ...(must.length ? { must } : { must: [{ match_all: {} }] }),
      filter,
      ...(mustNot.length ? { must_not: mustNot } : {}),
    },
  }
}

// ─── Full-text search ─────────────────────────────────────────────────────────

export async function searchContracts(orgId: string, query: string, size = 20, ids?: string[]) {
  const raw = await es.search({
    index: CONTRACT_INDEX,
    body: {
      size,
      query: buildESQuery(orgId, { q: query, ...(ids ? { ids } : {}) }),
      highlight: {
        fields: {
          title:            { number_of_fragments: 1 },
          counterpartyName: { number_of_fragments: 1 },
          plainText:        { number_of_fragments: 2, fragment_size: 200 },
          summary:          { number_of_fragments: 1, fragment_size: 150 },
        },
      },
    },
  })
  const result = raw.body

  return result.hits.hits.map((h: any) => ({
    id: h._id,
    score: h._score,
    source: h._source as ContractDoc,
    highlights: h.highlight,
  }))
}

// ─── Advanced search (filters + optional keyword) ────────────────────────────

export async function advancedSearch(orgId: string, filters: SearchFilters, size = 20) {
  const raw = await es.search({
    index: CONTRACT_INDEX,
    body: {
      size,
      query: buildESQuery(orgId, filters),
      sort: filters.q
        ? [{ _score: { order: 'desc' } }, { createdAt: { order: 'desc' } }]
        : [{ createdAt: { order: 'desc' } }],
      highlight: filters.q ? {
        fields: {
          title:            { number_of_fragments: 1 },
          // U3 audit (2026-04-29) — counterpartyName matches needed in
          // the highlight set so the list page can show "matched in
          // counterparty" when the row title doesn't visibly contain
          // the searched term ("Iowa" → "Iora Health").
          counterpartyName: { number_of_fragments: 1 },
          plainText:        { number_of_fragments: 2, fragment_size: 200 },
          summary:          { number_of_fragments: 1, fragment_size: 150 },
        },
      } : undefined,
    },
  })
  const result = raw.body

  return {
    hits: result.hits.hits.map((h: any) => ({
      id: h._id,
      score: h._score,
      source: h._source as ContractDoc,
      highlights: h.highlight,
    })),
    total: typeof result.hits.total === 'number'
      ? result.hits.total
      : result.hits.total?.value ?? 0,
  }
}

// ─── Facets aggregation ───────────────────────────────────────────────────────

export async function getContractFacets(orgId: string, baseFilters: Omit<SearchFilters, 'q'> = {}) {
  const raw = await es.search({
    index: CONTRACT_INDEX,
    body: {
      size: 0,
      query: buildESQuery(orgId, baseFilters),
      aggs: {
      by_type: { terms: { field: 'type', size: 20 } },
      by_status: { terms: { field: 'status', size: 10 } },
      by_jurisdiction: { terms: { field: 'jurisdiction', size: 30, missing: 'Unknown' } },
      by_counterparty: { terms: { field: 'counterpartyName.keyword', size: 20 } },
      risk_ranges: {
        range: {
          field: 'riskScore',
          ranges: [
            { key: 'low',    from: 0,    to: 0.34 },
            { key: 'medium', from: 0.34, to: 0.67 },
            { key: 'high',   from: 0.67, to: 1.01 },
          ],
        },
      },
      expiring_soon: {
        date_range: {
          field: 'expiryDate',
          ranges: [
            { key: '30d',  from: 'now', to: 'now+30d/d' },
            { key: '90d',  from: 'now', to: 'now+90d/d' },
            { key: '180d', from: 'now', to: 'now+180d/d' },
          ],
        },
      },
      force_majeure:          { filter: { term: { 'clauseFlags.forceMajeure': true } } },
      mfn:                    { filter: { term: { 'clauseFlags.mfn': true } } },
      change_of_control:      { filter: { term: { 'clauseFlags.changeOfControl': true } } },
      audit_rights:           { filter: { term: { 'clauseFlags.auditRights': true } } },
      assignment_restriction: { filter: { term: { 'clauseFlags.assignmentRestriction': true } } },
      limitation_of_liability:{ filter: { term: { 'clauseFlags.limitationOfLiability': true } } },
      indemnification:        { filter: { term: { 'clauseFlags.indemnification': true } } },
      },
    },
  })
  const result = raw.body
  const aggs = result.aggregations as Record<string, any>

  return {
    types:        aggs.by_type?.buckets ?? [],
    statuses:     aggs.by_status?.buckets ?? [],
    jurisdictions:aggs.by_jurisdiction?.buckets ?? [],
    counterparties:aggs.by_counterparty?.buckets ?? [],
    riskRanges:   aggs.risk_ranges?.buckets ?? [],
    expiringSoon: aggs.expiring_soon?.buckets ?? [],
    clauseFlags: {
      forceMajeure:          aggs.force_majeure?.doc_count ?? 0,
      mfn:                   aggs.mfn?.doc_count ?? 0,
      changeOfControl:       aggs.change_of_control?.doc_count ?? 0,
      auditRights:           aggs.audit_rights?.doc_count ?? 0,
      assignmentRestriction: aggs.assignment_restriction?.doc_count ?? 0,
      limitationOfLiability: aggs.limitation_of_liability?.doc_count ?? 0,
      indemnification:       aggs.indemnification?.doc_count ?? 0,
    },
    total: typeof result.hits.total === 'number'
      ? result.hits.total
      : result.hits.total?.value ?? 0,
  }
}
