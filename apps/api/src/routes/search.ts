import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { searchContracts, advancedSearch, getContractFacets } from '../lib/elasticsearch.js'
import { searchClauses, rerankClauses } from '../lib/embeddings.js'
import { fuseRRF } from '../lib/rrf.js'

const SearchSchema = z.object({
  q: z.string().min(1).max(500),
  type: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

const AdvancedSearchSchema = z.object({
  q: z.string().max(500).optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  jurisdiction: z.string().optional(),
  riskScoreMin: z.number().min(0).max(1).optional(),
  riskScoreMax: z.number().min(0).max(1).optional(),
  clauseFlags: z.record(z.boolean()).optional(),
  effectiveDateFrom: z.string().optional(),
  effectiveDateTo: z.string().optional(),
  expiryDateFrom: z.string().optional(),
  expiryDateTo: z.string().optional(),
  // B.6.9 — Counterparty drill-through. Either form is accepted;
  // combined they match the FK or the denormalised name.
  counterpartyId: z.string().optional(),
  counterpartyName: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  mode: z.enum(['keyword', 'semantic', 'hybrid']).default('keyword'),
})

const FacetsSchema = z.object({
  type: z.string().optional(),
  status: z.string().optional(),
  jurisdiction: z.string().optional(),
})

const AskSchema = z.object({
  question: z.string().min(1).max(1000),
  contractId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(8),
})

const PortfolioQuerySchema = z.object({
  query: z.string().min(1).max(1000),
})

export async function searchRoutes(app: FastifyInstance) {
  // ── POST /api/v1/search  — full-text via Elasticsearch ────────────────────
  app.post('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const body = SearchSchema.parse(req.body)
    const { orgId } = req.user

    let esResults: Awaited<ReturnType<typeof searchContracts>> = []

    try {
      esResults = await searchContracts(orgId, body.q, body.limit)
    } catch {
      app.log.warn('Elasticsearch unavailable, falling back to DB search')
    }

    if (esResults.length > 0) {
      const ids = esResults.map(r => r.id!)
      const contracts = await prisma.contract.findMany({
        where: { id: { in: ids }, orgId, deletedAt: null },
        include: { counterparty: { select: { id: true, name: true } } },
      })
      const byId = Object.fromEntries(contracts.map(c => [c.id, c]))
      const ordered = ids.map(id => byId[id]).filter(Boolean)
      return reply.send({
        data: ordered,
        highlights: Object.fromEntries(esResults.map(r => [r.id, r.highlights])),
        total: ordered.length,
        source: 'elasticsearch',
      })
    }

    // Postgres fallback
    const contracts = await prisma.contract.findMany({
      where: {
        orgId,
        deletedAt: null,
        OR: [
          { title: { contains: body.q, mode: 'insensitive' } },
          { counterpartyName: { contains: body.q, mode: 'insensitive' } },
          { summary: { contains: body.q, mode: 'insensitive' } },
        ],
        ...(body.status && { status: body.status }),
        ...(body.type && { type: body.type }),
      },
      include: { counterparty: { select: { id: true, name: true } } },
      take: body.limit,
      orderBy: { updatedAt: 'desc' },
    })

    return reply.send({ data: contracts, highlights: {}, total: contracts.length, source: 'postgres' })
  })

  // ── POST /api/v1/search/advanced  — structured filters + optional keyword ─
  app.post('/advanced', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const body = AdvancedSearchSchema.parse(req.body)
    const { orgId } = req.user
    const { limit, mode, q, ...filters } = body

    try {
      if (mode === 'semantic' || mode === 'hybrid') {
        if (!q) return reply.status(400).send({ detail: 'q is required for semantic/hybrid mode' })

        // Semantic: clause-level similarity search
        const clauseMatches = await searchClauses(q, orgId, limit)

        if (mode === 'semantic') {
          const contractIds = [...new Set(clauseMatches.map(m => m.contractId))]
          const contracts = await prisma.contract.findMany({
            where: { id: { in: contractIds }, orgId, deletedAt: null },
            include: { counterparty: { select: { id: true, name: true } } },
          })
          const byId = Object.fromEntries(contracts.map(c => [c.id, c]))
          return reply.send({
            data: contractIds.map(id => byId[id]).filter(Boolean),
            clauseMatches,
            total: contractIds.length,
            source: 'pgvector',
          })
        }

        // Hybrid: RRF merge of ES + pgvector results
        let esHits: { id?: string; score?: number | null }[] = []
        try {
          const esResult = await advancedSearch(orgId, { q, ...filters }, limit * 2)
          esHits = esResult.hits
        } catch { /* ES down — fall back to semantic only */ }

        // Fuse the two ranked lists (ES title/metadata hits + pgvector
        // clause matches). fuseRRF de-dupes a repeated contractId within
        // the clause list to its first-seen rank, matching what this did
        // by hand before the fusion core was extracted to lib/rrf.
        const fused = fuseRRF([
          esHits.map(h => h.id),
          clauseMatches.map(m => m.contractId),
        ])
        const rrfScores: Record<string, number> = Object.fromEntries(
          fused.map(f => [f.id, f.score]),
        )
        const sortedIds = fused.slice(0, limit).map(f => f.id)

        const contracts = await prisma.contract.findMany({
          where: { id: { in: sortedIds }, orgId, deletedAt: null },
          include: { counterparty: { select: { id: true, name: true } } },
        })
        const byId = Object.fromEntries(contracts.map(c => [c.id, c]))
        return reply.send({
          data: sortedIds.map(id => byId[id]).filter(Boolean),
          clauseMatches: clauseMatches.filter(m => sortedIds.includes(m.contractId)),
          rrfScores,
          total: sortedIds.length,
          source: 'hybrid_rrf',
        })
      }

      // Keyword / structured filter mode (ES)
      const esResult = await advancedSearch(orgId, { q, ...filters }, limit)
      const ids = esResult.hits.map(h => h.id!)
      const contracts = await prisma.contract.findMany({
        where: { id: { in: ids }, orgId, deletedAt: null },
        include: { counterparty: { select: { id: true, name: true } } },
      })
      const byId = Object.fromEntries(contracts.map(c => [c.id, c]))
      return reply.send({
        data: ids.map(id => byId[id]).filter(Boolean),
        highlights: Object.fromEntries(esResult.hits.map(h => [h.id, h.highlights])),
        total: esResult.total,
        source: 'elasticsearch',
      })
    } catch (err) {
      app.log.error({ err }, 'Advanced search failed')
      return reply.status(500).send({ detail: 'Search unavailable' })
    }
  })

  // ── GET /api/v1/search/facets  — aggregations for filter sidebar ──────────
  app.get('/facets', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const params = FacetsSchema.parse(req.query)
    const { orgId } = req.user

    try {
      const facets = await getContractFacets(orgId, params)
      return reply.send(facets)
    } catch (err) {
      app.log.warn({ err }, 'ES facets unavailable, returning empty')
      return reply.send({
        types: [], statuses: [], jurisdictions: [], counterparties: [],
        riskRanges: [], expiringSoon: [], clauseFlags: {}, total: 0,
      })
    }
  })

  // ── POST /api/v1/search/ask  — portfolio-wide RAG Q&A ────────────────────
  app.post('/ask', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { question, contractId, limit } = AskSchema.parse(req.body)
    const { orgId } = req.user

    // Retrieve relevant clause chunks via pgvector. We over-fetch here
    // (4×) so the reranker has more material to choose from.
    const overfetch = Math.min(limit * 4, 60)
    const dense = await searchClauses(question, orgId, overfetch, contractId)

    if (!dense.length) {
      return reply.send({ answer: null, sources: [], message: 'No relevant clauses found' })
    }

    // P7.7.1 — voyage-rerank-2.5 over the dense candidates. Falls back
    // to identity ordering when no Voyage key is set.
    const reranked = await rerankClauses(
      question,
      dense.map(d => ({ ref: d, text: d.content })),
      limit,
    )
    const clauseMatches = reranked.map((r, i) => ({
      ...(r.ref as typeof dense[number]),
      // Replace the cosine similarity with the reranker's relevance score
      // so the UI shows the more meaningful number.
      similarity: r.score,
      rerankRank: i + 1,
    }))

    // Forward to agents for LLM answer generation
    const agentRes = await fetch(
      `${process.env.AGENTS_URL ?? 'http://localhost:8000'}/agent/ask`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
        body: JSON.stringify({ question, orgId, clauseMatches }),
      },
    ).catch(() => null)

    if (!agentRes?.ok) {
      // Return raw clause matches as fallback (client can render them)
      return reply.send({ answer: null, sources: clauseMatches, message: 'Agent unavailable — showing relevant clauses' })
    }

    const agentData = await agentRes.json()
    return reply.send({ ...agentData, sources: clauseMatches })
  })

  // ── POST /api/v1/search/portfolio-query  — NL portfolio query via agents ──
  app.post('/portfolio-query', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { query } = PortfolioQuerySchema.parse(req.body)
    const { orgId, sub: userId } = req.user

    const agentRes = await fetch(
      `${process.env.AGENTS_URL ?? 'http://localhost:8000'}/agent/portfolio-query`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
        body: JSON.stringify({ query, orgId, userId }),
      },
    ).catch(() => null)

    if (!agentRes?.ok) {
      return reply.status(503).send({ detail: 'Agent service unavailable' })
    }

    return reply.send(await agentRes.json())
  })
}
