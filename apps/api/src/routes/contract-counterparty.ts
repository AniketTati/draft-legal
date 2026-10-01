/**
 * A contract's counterparty and the directory (docs/39 A14, A8) — which
 * directory entry it links to, the entries it might be, and whether it is
 * one of our own companies. See lib/counterparty-directory.ts.
 *
 *   GET  /api/v1/contracts/:id/counterparty
 *   POST /api/v1/contracts/:id/counterparty/link     { counterpartyId }
 *
 * Adding the company to the directory is POST /counterparties, which links
 * every contract naming it.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { guardOwnScopeContractRoutes, ownContractWhere } from '../lib/own-scope-guard.js'
import {
  loadDirectory, exactEntry, similarEntries, linkContractsTo, newAliases, ourNames, isOurs,
} from '../lib/counterparty-directory.js'
import { otherParties } from '../lib/our-entities.js'
import { directoryName, isPlaceholderName } from '../lib/company-names.js'

const LinkSchema = z.object({ counterpartyId: z.string().min(1).max(64) })

async function view(orgId: string, contractId: string, where: object) {
  const c = await prisma.contract.findFirst({
    where: { id: contractId, orgId, deletedAt: null, ...where },
    select: { id: true, counterpartyName: true, counterpartyId: true, keyTerms: true },
  })
  if (!c) return null
  const [entries, ours] = await Promise.all([loadDirectory(prisma, orgId), ourNames(orgId)])
  const name = c.counterpartyName?.trim() || null
  const linked = c.counterpartyId ? entries.find(e => e.id === c.counterpartyId) ?? null : null
  const placeholder = !!name && isPlaceholderName(name)
  const same = !linked && name ? exactEntry(name, entries) : null
  return {
    name,
    placeholder,
    linked: linked ? { id: linked.id, name: linked.name } : null,
    // An entry with this very name that the contract isn't linked to yet, then the ones it might be.
    suggestions: linked || !name || placeholder ? [] : [
      ...(same ? [{ id: same.id, name: same.name, score: 1 }] : []),
      ...similarEntries(name, entries).filter(s => s.id !== same?.id),
    ],
    // What "Add to directory" would call it.
    directoryName: name && !placeholder ? directoryName(name) : null,
    ours: isOurs(name, ours.all),
    // The other parties the contract names, for "one of yours — pick the other party".
    others: otherParties(c.keyTerms, ours.all),
    // The names we sign as, so the page can ask about a name a person replaced only when it isn't one.
    ourNames: ours.all,
  }
}

export async function contractCounterpartyRoutes(app: FastifyInstance) {
  guardOwnScopeContractRoutes(app)

  app.get('/:id/counterparty', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const v = await view(req.user.orgId, id, ownContractWhere(req))
    if (!v) return reply.status(404).send({ detail: 'Contract not found' })
    return reply.send(v)
  })

  // Link to an entry a person chose: the contract's name becomes one of the
  // entry's names, so the next contract naming it links itself, and the
  // contracts already naming it are linked now.
  app.post('/:id/counterparty/link', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { counterpartyId } = LinkSchema.parse(req.body ?? {})
    const { orgId } = req.user
    const c = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null, ...ownContractWhere(req) },
      select: { id: true, counterpartyName: true },
    })
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    const entry = await prisma.counterparty.findFirst({
      where: { id: counterpartyId, orgId, deletedAt: null },
      select: { id: true, name: true, legalName: true, aliases: true },
    })
    if (!entry) return reply.status(404).send({ detail: 'Counterparty not found' })
    const add = c.counterpartyName ? newAliases(entry, [c.counterpartyName]) : []
    const linked = await prisma.$transaction(async tx => {
      const updated = add.length
        ? await tx.counterparty.update({ where: { id: entry.id }, data: { aliases: [...entry.aliases, ...add] }, select: { id: true, name: true, legalName: true, aliases: true } })
        : entry
      // This contract whatever its link was; the others only while unlinked.
      await tx.$executeRaw`UPDATE contracts SET "counterpartyId" = ${entry.id} WHERE id = ${c.id}`
      return 1 + await linkContractsTo(tx, orgId, updated)
    })
    return reply.send({ ...(await view(orgId, id, ownContractWhere(req)))!, linkedContracts: linked, aliasAdded: add[0] ?? null })
  })
}
