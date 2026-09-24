/**
 * Embeddings pipeline — Phase 2.1 + P7.7.1.
 *
 * Clause-level embeddings (not document-level).
 * Each contract clause is embedded individually so similarity search
 * finds the specific clause that matches, not just the contract.
 *
 * Provider routing (P7.7.1):
 *   1. If VOYAGE_API_KEY is set → voyage-law-2 (1024 dims, legal-fine-tuned)
 *   2. Else if OPENAI_API_KEY → text-embedding-3-large (1536 dims)
 *   3. Else throw with a helpful error.
 *
 * The dimension difference is real — pgvector columns must match. We
 * pad the smaller vector with zeros at the end so a Voyage vector can
 * coexist with the existing OpenAI 1536-dim column. (Cosine similarity
 * is unchanged because the zero entries contribute 0 to the dot product.)
 *
 * Reranker (P7.7.1):
 *   rerankClauses() takes a query + initial result list and returns the
 *   top-N reordered by voyage-rerank-2.5 cross-attention. Use after
 *   searchClauses() to lift precision. Falls through to identity
 *   ordering when no Voyage key is configured.
 */

import { redactJson } from './pii-policy.js'
import { modelFetch, type ModelCall } from './model-boundary.js'
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'

// ─── Provider routing ───────────────────────────────────────────────────────

export type EmbedProvider = 'voyage' | 'openai' | 'google'

// Sentinel values that operators seed when a real key isn't set. Treat them
// as missing so this function never picks a provider whose key would 401.
// (The same set is filtered out by aiRouter.platformKey.)
const PLACEHOLDER_VALUES = new Set(['', 'placeholder', 'REPLACE', 'TODO', 'unset'])
function realKey(v: string | undefined): boolean {
  return !!v && !PLACEHOLDER_VALUES.has(v.trim())
}

export function activeEmbedProvider(): EmbedProvider {
  if (realKey(process.env.VOYAGE_API_KEY)) return 'voyage'
  if (realKey(process.env.OPENAI_API_KEY)) return 'openai'
  // Gemini embeddings (gemini-embedding-001). Matryoshka — we request
  // exactly 1536 dims so it slots into the existing pgvector column with
  // no padding. Task types map 1:1 onto our document/query split.
  if (realKey(process.env.GOOGLE_API_KEY)) return 'google'
  throw new Error('No embedding provider configured — set VOYAGE_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY')
}

const PG_VECTOR_DIMS = 1536

/**
 * Y2 — the org and surface an embedding or rerank call is made for: the text
 * goes to a model provider, through the model boundary. A query is the
 * user's own words, sent as typed; a clause was redacted by its caller.
 */
export type EmbedCall = Pick<ModelCall, 'orgId' | 'surface'>

/** Right-pad a shorter vector with zeros so it fits the schema's pgvector column. */
function padTo(vec: number[], dims: number): number[] {
  if (vec.length >= dims) return vec.slice(0, dims)
  return [...vec, ...new Array(dims - vec.length).fill(0)]
}

// ─── Voyage AI embeddings ───────────────────────────────────────────────────

async function voyageEmbed(texts: string[], inputType: 'document' | 'query', call: EmbedCall): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY!
  // Voyage caps at 128 inputs and ~10k tokens per call. Slice each
  // input down to a safe length first; chunk over the inputs as needed.
  const safe = texts.map(t => t.slice(0, 8192))
  const chunks: string[][] = []
  for (let i = 0; i < safe.length; i += 128) chunks.push(safe.slice(i, i + 128))

  const all: number[][] = []
  for (const batch of chunks) {
    const res = await modelFetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'voyage-law-2',
        input: batch,
        input_type: inputType,
      }),
    }, { ...call, userAuthored: inputType === 'query' ? ['input'] : [] })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Voyage embeddings error: ${res.status} ${err}`)
    }
    const data = await res.json() as { data: Array<{ index: number; embedding: number[] }> }
    const sorted = data.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
    // Voyage returns 1024-dim by default; pad to fit the schema.
    all.push(...sorted.map(v => padTo(v, PG_VECTOR_DIMS)))
  }
  return all
}

// ─── OpenAI embeddings (legacy default) ─────────────────────────────────────

async function openaiEmbed(texts: string[], inputType: 'document' | 'query', call: EmbedCall): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY!
  const res = await modelFetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'text-embedding-3-large',
      input: texts.map(t => t.slice(0, 8192)),
      dimensions: 1536,
    }),
  }, { ...call, userAuthored: inputType === 'query' ? ['input'] : [] })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenAI embeddings error: ${res.status} ${err}`)
  }
  const data = await res.json() as { data: Array<{ index: number; embedding: number[] }> }
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
}

// ─── Gemini embeddings (single GOOGLE_API_KEY covers the whole stack) ───────
// Uses gemini-embedding-001 with Matryoshka outputDimensionality=1536 so the
// vectors drop straight into the pgvector(1536) column. taskType matches our
// document/query split: RETRIEVAL_DOCUMENT for indexing, RETRIEVAL_QUERY for
// search. Endpoint caps batches at 100 inputs per call.

async function geminiEmbed(texts: string[], inputType: 'document' | 'query', call: EmbedCall): Promise<number[][]> {
  const apiKey = process.env.GOOGLE_API_KEY!
  const taskType = inputType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT'
  // gemini-embedding-001 cap: 2048 tokens per input. Be generous — char-trim
  // to ~8000 chars (≈ safe under 2048 tokens for English/legal text).
  const safe = texts.map(t => t.slice(0, 8000))
  const chunks: string[][] = []
  for (let i = 0; i < safe.length; i += 100) chunks.push(safe.slice(i, i + 100))

  const all: number[][] = []
  for (const batch of chunks) {
    const res = await modelFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: batch.map(text => ({
            model: 'models/gemini-embedding-001',
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: PG_VECTOR_DIMS,
          })),
        }),
      },
      { ...call, userAuthored: inputType === 'query' ? ['requests'] : [] },
    )
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Gemini embeddings error: ${res.status} ${err}`)
    }
    const data = await res.json() as { embeddings: Array<{ values: number[] }> }
    all.push(...data.embeddings.map(e => e.values))
  }
  return all
}

// ─── Public embed API — routes to the active provider ───────────────────────

export async function embedText(text: string, call: EmbedCall): Promise<number[]> {
  const provider = activeEmbedProvider()
  if (provider === 'voyage') return (await voyageEmbed([text], 'query', call))[0]
  if (provider === 'google') return (await geminiEmbed([text], 'query', call))[0]
  return (await openaiEmbed([text], 'query', call))[0]
}

async function embedTexts(texts: string[], call: EmbedCall): Promise<number[][]> {
  const provider = activeEmbedProvider()
  if (provider === 'voyage') return voyageEmbed(texts, 'document', call)
  if (provider === 'google') return geminiEmbed(texts, 'document', call)
  return openaiEmbed(texts, 'document', call)
}

// ─── Voyage reranker (P7.7.1) ───────────────────────────────────────────────

export interface RerankInput {
  text: string
  // Free-form passthrough so the caller can attach IDs / metadata.
  ref?: unknown
}

export interface RerankOutput<T> {
  ref: T
  text: string
  score: number
}

/**
 * Rerank a candidate list using voyage-rerank-2.5. Returns the top-N
 * by relevance to the query. Falls back to identity ordering when no
 * Voyage key is configured.
 */
export async function rerankClauses<T = unknown>(
  query: string,
  candidates: Array<RerankInput & { ref: T }>,
  call: EmbedCall,
  topK = candidates.length,
): Promise<Array<RerankOutput<T>>> {
  if (candidates.length === 0) return []
  const apiKey = process.env.VOYAGE_API_KEY
  if (!apiKey) {
    // No reranker available — return as-is, capped to topK.
    return candidates.slice(0, topK).map((c, i) => ({
      ref: c.ref,
      text: c.text,
      score: 1 - i / candidates.length,
    }))
  }

  const res = await modelFetch('https://api.voyageai.com/v1/rerank', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'rerank-2.5',
      query,
      documents: candidates.map(c => c.text.slice(0, 8192)),
      top_k: topK,
      return_documents: false,
    }),
  }, { ...call, userAuthored: ['query'] })
  if (!res.ok) {
    const err = await res.text()
    // Don't blow up the search — log + fall back to identity.
    console.warn('[rerank] voyage error, falling back to identity:', res.status, err.slice(0, 200))
    return candidates.slice(0, topK).map((c, i) => ({
      ref: c.ref,
      text: c.text,
      score: 1 - i / candidates.length,
    }))
  }
  const data = await res.json() as {
    data: Array<{ index: number; relevance_score: number }>
  }
  return data.data
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, topK)
    .map(r => ({
      ref: candidates[r.index].ref,
      text: candidates[r.index].text,
      score: r.relevance_score,
    }))
}

// ─── Store clause segments from Review Agent ─────────────────────────────────

export interface ClauseSegment {
  clauseType: string
  content: string
  sortOrder: number
  interpretation?: string
  riskRating?: string
  sectionRef?: string
}

export async function storeClauseSegments(
  versionId: string,
  segments: ClauseSegment[],
): Promise<void> {
  if (!segments.length) return

  // Atomic upsert — delete + insert in a single transaction so a failed
  // insert never leaves the version with zero clauses
  await prisma.$transaction([
    prisma.contractClause.deleteMany({ where: { versionId } }),
    prisma.contractClause.createMany({
      data: segments.map(s => ({
        versionId,
        clauseType: s.clauseType,
        content: s.content,
        sortOrder: s.sortOrder,
        interpretation: s.interpretation ?? null,
        riskRating: s.riskRating ?? null,
        sectionRef: s.sectionRef ?? null,
      })),
    }),
  ])
}

// ─── Embed all clauses for a version (BullMQ job body) ───────────────────────

export async function embedContractVersion(versionId: string): Promise<void> {
  const clauses = await prisma.contractClause.findMany({
    where: { versionId, embeddedAt: null },
    select: { id: true, content: true },
  })

  if (!clauses.length) return

  // Look up contractId for failure reporting
  const version = await prisma.contractVersion.findUnique({
    where: { id: versionId },
    select: { contractId: true, plainText: true, contract: { select: { orgId: true } } },
  })

  // Batch all clause texts into a single OpenAI call (up to 2048 inputs)
  let vectors: number[][]
  try {
    // X23 — the embedding provider is outside our trust zone too: the org's
    // PII policy applies to what it is sent (the stored clause stays as is),
    // judged against the whole document — a clause alone can lack the word
    // that makes its card number one. No org, no call.
    if (!version?.contract?.orgId) throw new Error('contract of this version not found')
    const texts = clauses.map(c => c.content)
    const outbound = await redactJson(version.contract.orgId, texts, {
      surface: 'embeddings', contractId: version.contractId, roundTrip: version.contractId, valuesFrom: [texts, version.plainText ?? ''],
    })
    vectors = await embedTexts(outbound, { orgId: version.contract.orgId, surface: 'embeddings' })
  } catch (err) {
    console.error('[embeddings] batch embed failed for versionId=%s:', versionId, (err as Error).message)
    if (version?.contractId) {
      await prisma.contract.update({
        where: { id: version.contractId },
        data: { analysisStatus: 'FAILED', analysisError: `Embedding failed: ${(err as Error).message}` },
      })
    }
    throw err
  }

  let failures = 0
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i]
    const vec = vectors[i]
    try {
      const vectorLiteral = `[${vec.join(',')}]`
      await prisma.$executeRaw`
        UPDATE contract_clauses
        SET    embedding  = ${vectorLiteral}::vector,
               "embeddedAt" = NOW()
        WHERE  id = ${clause.id}
      `
    } catch (err) {
      failures++
      console.warn(`[embeddings] failed to store embedding for clause ${clause.id}:`, (err as Error).message)
    }
  }

  if (failures > clauses.length / 2 && version?.contractId) {
    const msg = `Embedding storage failed for ${failures}/${clauses.length} clauses — RAG search may not work`
    console.error('[embeddings] %s versionId=%s', msg, versionId)
    await prisma.contract.update({
      where: { id: version.contractId },
      data: { analysisStatus: 'FAILED', analysisError: msg },
    })
  }
}

// ─── Cosine similarity search over contract_clauses ──────────────────────────

export interface ClauseMatch {
  contractId: string
  versionId: string
  clauseId: string
  clauseType: string
  content: string
  similarity: number
}

/**
 * The version each contract's clauses should be read from (C11): the current
 * version if it has clauses, else the latest version that does. Contracts
 * with no extracted clauses at all yield nothing.
 */
export function effectiveVersionsSql(orgId: string, contractId?: string, contractFilter: Prisma.Sql = Prisma.empty) {
  return Prisma.sql`
    SELECT DISTINCT ON (v."contractId") v.id
    FROM   contract_versions v
    JOIN   contracts c2 ON c2.id = v."contractId"
    WHERE  c2."orgId" = ${orgId}
           ${contractId ? Prisma.sql`AND c2.id = ${contractId}` : Prisma.empty}
           ${contractFilter}
           AND EXISTS (SELECT 1 FROM contract_clauses x WHERE x."versionId" = v.id AND x."isSubChunk" = false)
    ORDER  BY v."contractId", COALESCE(v.id = c2."currentVersionId", false) DESC, v."versionNumber" DESC`
}

/** Effective clause version ids for these contracts (see effectiveVersionsSql). */
export async function effectiveClauseVersionIds(orgId: string, contractIds: string[]): Promise<string[]> {
  if (contractIds.length === 0) return []
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT ON (v."contractId") v.id
    FROM   contract_versions v
    JOIN   contracts c2 ON c2.id = v."contractId"
    WHERE  c2."orgId" = ${orgId} AND c2.id = ANY(${contractIds})
           AND EXISTS (SELECT 1 FROM contract_clauses x WHERE x."versionId" = v.id AND x."isSubChunk" = false)
    ORDER  BY v."contractId", COALESCE(v.id = c2."currentVersionId", false) DESC, v."versionNumber" DESC`
  return rows.map(r => r.id)
}

/** X17 — pgvector 0.8 added iterative index scans; earlier versions reject the setting. Checked once (a failed check is retried). */
let iterativeScan: Promise<boolean> | null = null
function iterativeScanSupported(): Promise<boolean> {
  iterativeScan ??= prisma.$queryRaw<Array<{ v: string }>>`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`
    .then(rows => {
      const [major, minor] = (rows[0]?.v ?? '0.0').split('.').map(Number)
      return major > 0 || minor >= 8
    }, () => {
      iterativeScan = null
      return false
    })
  return iterativeScan
}

export async function searchClauses(
  queryText: string,
  orgId: string,
  limit = 20,
  contractId?: string, // scope to a single contract for Q&A
  ownerId?: string,    // own-scope callers: filter BEFORE top-k, not after
  opts: {
    /** Include superseded versions' clauses (default: the current version only). */
    allVersions?: boolean
    /** Search one diligence room's documents (they are excluded otherwise). */
    diligenceRoomId?: string
  } = {},
): Promise<ClauseMatch[]> {
  const vec = await embedText(queryText, { orgId, surface: 'clause_search' })
  const vectorLiteral = `[${vec.join(',')}]`
  const ownerFilter = ownerId ? Prisma.sql`AND c."ownerId" = ${ownerId}` : Prisma.empty
  // C11 — one version per contract: its current version, or — when that has
  // no extracted clauses yet (sealing, redline_apply and editor saves create
  // clause-less versions) — the latest version that does (the B.5.6 rule in
  // GET /contracts/:id/clauses). Superseded text is never cited as the terms.
  // Computed once per query (not per candidate row) so it stays cheap.
  const versionJoin = opts.allVersions ? Prisma.empty : Prisma.sql`
        JOIN   (${effectiveVersionsSql(orgId, contractId)}) ev ON ev.id = cv.id`
  // C11 — diligence-room documents are a target's contracts, not the org's:
  // out of ordinary search unless a room is named, or one contract is asked
  // about by id (room-scoped access).
  const diligenceFilter = opts.diligenceRoomId
    ? Prisma.sql`AND c."diligenceRoomId" = ${opts.diligenceRoomId}`
    : contractId ? Prisma.empty : Prisma.sql`AND c."diligenceRoomId" IS NULL`

  // Raw SQL: pgvector cosine similarity, join to contracts for org scoping.
  // X17 — the HNSW index covers every org's clauses and the org, version and
  // room filters apply after it, so a plain index scan can come back with
  // fewer than `limit` rows (its ef_search candidates, mostly other orgs').
  // pgvector 0.8+ keeps scanning until enough rows pass; relaxed_order may
  // return them slightly out of order, hence the sort below.
  type Row = {
    contract_id: string; version_id: string; clause_id: string
    clause_type: string; content: string; similarity: number
  }
  const query = contractId
    ? Prisma.sql`
        SELECT c.id AS contract_id, cv.id AS version_id, cc.id AS clause_id,
               cc."clauseType" AS clause_type, cc.content,
               1 - (cc.embedding <=> ${vectorLiteral}::vector) AS similarity
        FROM   contract_clauses cc
        JOIN   contract_versions cv ON cv.id = cc."versionId"
        JOIN   contracts c ON c.id = cv."contractId"
        ${versionJoin}
        WHERE  c."orgId" = ${orgId} AND c.id = ${contractId}
               AND c."deletedAt" IS NULL AND cc.embedding IS NOT NULL
               ${ownerFilter} ${diligenceFilter}
        ORDER  BY cc.embedding <=> ${vectorLiteral}::vector
        LIMIT  ${limit}
      `
    : Prisma.sql`
        SELECT c.id AS contract_id, cv.id AS version_id, cc.id AS clause_id,
               cc."clauseType" AS clause_type, cc.content,
               1 - (cc.embedding <=> ${vectorLiteral}::vector) AS similarity
        FROM   contract_clauses cc
        JOIN   contract_versions cv ON cv.id = cc."versionId"
        JOIN   contracts c ON c.id = cv."contractId"
        ${versionJoin}
        WHERE  c."orgId" = ${orgId}
               AND c."deletedAt" IS NULL AND cc.embedding IS NOT NULL
               ${ownerFilter} ${diligenceFilter}
        ORDER  BY cc.embedding <=> ${vectorLiteral}::vector
        LIMIT  ${limit}
      `
  // One contract's clauses are few enough to scan exactly: no transaction.
  // Otherwise wait for a connection as long as a plain query would (the pool
  // timeout), not an interactive transaction's 2 s default.
  const rows = await (!contractId && await iterativeScanSupported()
    ? prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL hnsw.iterative_scan = relaxed_order`
        return tx.$queryRaw<Row[]>(query)
      }, { maxWait: 10_000, timeout: 20_000 })
    : prisma.$queryRaw<Row[]>(query))
  rows.sort((a, b) => Number(b.similarity) - Number(a.similarity))

  return rows.map(r => ({
    contractId: r.contract_id,
    versionId:  r.version_id,
    clauseId:   r.clause_id,
    clauseType: r.clause_type,
    content:    r.content,
    similarity: Number(r.similarity),
  }))
}
