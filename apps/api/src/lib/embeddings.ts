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

/** Right-pad a shorter vector with zeros so it fits the schema's pgvector column. */
function padTo(vec: number[], dims: number): number[] {
  if (vec.length >= dims) return vec.slice(0, dims)
  return [...vec, ...new Array(dims - vec.length).fill(0)]
}

// ─── Voyage AI embeddings ───────────────────────────────────────────────────

async function voyageEmbed(texts: string[], inputType: 'document' | 'query'): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY!
  // Voyage caps at 128 inputs and ~10k tokens per call. Slice each
  // input down to a safe length first; chunk over the inputs as needed.
  const safe = texts.map(t => t.slice(0, 8192))
  const chunks: string[][] = []
  for (let i = 0; i < safe.length; i += 128) chunks.push(safe.slice(i, i + 128))

  const all: number[][] = []
  for (const batch of chunks) {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'voyage-law-2',
        input: batch,
        input_type: inputType,
      }),
    })
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

async function openaiEmbed(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY!
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'text-embedding-3-large',
      input: texts.map(t => t.slice(0, 8192)),
      dimensions: 1536,
    }),
  })
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

async function geminiEmbed(texts: string[], inputType: 'document' | 'query'): Promise<number[][]> {
  const apiKey = process.env.GOOGLE_API_KEY!
  const taskType = inputType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT'
  // gemini-embedding-001 cap: 2048 tokens per input. Be generous — char-trim
  // to ~8000 chars (≈ safe under 2048 tokens for English/legal text).
  const safe = texts.map(t => t.slice(0, 8000))
  const chunks: string[][] = []
  for (let i = 0; i < safe.length; i += 100) chunks.push(safe.slice(i, i + 100))

  const all: number[][] = []
  for (const batch of chunks) {
    const res = await fetch(
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

export async function embedText(text: string): Promise<number[]> {
  const provider = activeEmbedProvider()
  if (provider === 'voyage') return (await voyageEmbed([text], 'query'))[0]
  if (provider === 'google') return (await geminiEmbed([text], 'query'))[0]
  return (await openaiEmbed([text]))[0]
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const provider = activeEmbedProvider()
  if (provider === 'voyage') return voyageEmbed(texts, 'document')
  if (provider === 'google') return geminiEmbed(texts, 'document')
  return openaiEmbed(texts)
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

  const res = await fetch('https://api.voyageai.com/v1/rerank', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'rerank-2.5',
      query,
      documents: candidates.map(c => c.text.slice(0, 8192)),
      top_k: topK,
      return_documents: false,
    }),
  })
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
    select: { contractId: true },
  })

  // Batch all clause texts into a single OpenAI call (up to 2048 inputs)
  let vectors: number[][]
  try {
    vectors = await embedTexts(clauses.map(c => c.content))
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

export async function searchClauses(
  queryText: string,
  orgId: string,
  limit = 20,
  contractId?: string, // scope to a single contract for Q&A
  ownerId?: string,    // own-scope callers: filter BEFORE top-k, not after
): Promise<ClauseMatch[]> {
  const vec = await embedText(queryText)
  const vectorLiteral = `[${vec.join(',')}]`
  const ownerFilter = ownerId ? Prisma.sql`AND c."ownerId" = ${ownerId}` : Prisma.empty

  // Raw SQL: pgvector cosine similarity, join to contracts for org scoping
  const rows = contractId
    ? await prisma.$queryRaw<Array<{
        contract_id: string; version_id: string; clause_id: string
        clause_type: string; content: string; similarity: number
      }>>`
        SELECT c.id AS contract_id, cv.id AS version_id, cc.id AS clause_id,
               cc."clauseType" AS clause_type, cc.content,
               1 - (cc.embedding <=> ${vectorLiteral}::vector) AS similarity
        FROM   contract_clauses cc
        JOIN   contract_versions cv ON cv.id = cc."versionId"
        JOIN   contracts c ON c.id = cv."contractId"
        WHERE  c."orgId" = ${orgId} AND c.id = ${contractId}
               AND c."deletedAt" IS NULL AND cc.embedding IS NOT NULL
               ${ownerFilter}
        ORDER  BY cc.embedding <=> ${vectorLiteral}::vector
        LIMIT  ${limit}
      `
    : await prisma.$queryRaw<Array<{
        contract_id: string; version_id: string; clause_id: string
        clause_type: string; content: string; similarity: number
      }>>`
        SELECT c.id AS contract_id, cv.id AS version_id, cc.id AS clause_id,
               cc."clauseType" AS clause_type, cc.content,
               1 - (cc.embedding <=> ${vectorLiteral}::vector) AS similarity
        FROM   contract_clauses cc
        JOIN   contract_versions cv ON cv.id = cc."versionId"
        JOIN   contracts c ON c.id = cv."contractId"
        WHERE  c."orgId" = ${orgId}
               AND c."deletedAt" IS NULL AND cc.embedding IS NOT NULL
               ${ownerFilter}
        ORDER  BY cc.embedding <=> ${vectorLiteral}::vector
        LIMIT  ${limit}
      `

  return rows.map(r => ({
    contractId: r.contract_id,
    versionId:  r.version_id,
    clauseId:   r.clause_id,
    clauseType: r.clause_type,
    content:    r.content,
    similarity: Number(r.similarity),
  }))
}
