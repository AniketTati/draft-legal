/**
 * Which compliance frameworks apply, and why (docs/41 Part 9) — see
 * lib/compliance-facts.ts and lib/compliance-policy.ts.
 *
 * Under /api/v1/contracts:
 *   GET  /:id/compliance/applicability     facts, yes/no/unsure per framework with quotes, the one question, results
 *   POST /:id/compliance/facts/extract     read the facts now ({ force? }), then check what applies
 *   POST /:id/compliance/facts/confirm     answer the question ({ key, value }), then check what applies
 *   POST /:id/compliance/frameworks        add a framework by hand ({ framework }) and check it
 *
 * Under /api/v1/compliance-policy (the org's rules from facts to frameworks):
 *   GET / · PUT / { rules } · DELETE / (back to the default rules)
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { AuditAction, COMPLIANCE_FACT_KEYS, COMPLIANCE_FACTS, COMPLIANCE_FRAMEWORK_IDS, COMPLIANCE_FRAMEWORK_LABELS, CompliancePolicyRulesSchema } from '@clm/types'
import { requirePermission } from '../middleware/permissions.js'
import { guardOwnScopeContractRoutes } from '../lib/own-scope-guard.js'
import { actingUserId } from '../lib/acting-user.js'
import { prisma } from '../lib/prisma.js'
import { createAuditEvent } from '../lib/audit.js'
import { CostCapExceededError } from '../lib/costCap.js'
import { DEFAULT_COMPLIANCE_POLICY } from '../lib/compliance-policy.js'
import {
  addComplianceFramework, answerValue, complianceApplicability, confirmComplianceFact,
  extractComplianceFacts, loadCompliancePolicy, runApplicableChecks,
} from '../lib/compliance-facts.js'
import { storeComplianceFindings } from '../lib/compliance-findings.js'

function costCapped(reply: FastifyReply, err: unknown) {
  if (!(err instanceof CostCapExceededError)) throw err
  return reply.status(429).send({
    detail: `Daily AI cost cap reached ($${err.usedUsd.toFixed(2)} of $${err.capUsd.toFixed(2)}). Try again tomorrow or raise the cap in Admin → AI Config.`,
    retryAfter: 86400,
  })
}

export async function complianceApplicabilityRoutes(app: FastifyInstance) {
  // X7 — own scope reads and answers only for the contracts it owns.
  guardOwnScopeContractRoutes(app)

  app.get('/:id/compliance/applicability', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = await complianceApplicability(req.user.orgId, id)
    if (!result) return reply.status(404).send({ detail: 'Contract not found' })
    return reply.send(result)
  })

  app.post('/:id/compliance/facts/extract', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { force } = z.object({ force: z.boolean().optional() }).parse(req.body ?? {})
    const { orgId } = req.user
    try {
      const r = await extractComplianceFacts({ orgId, contractId: id, userId: req.user.sub, force })
      if (r.skipped === 'not found') return reply.status(404).send({ detail: 'Contract not found' })
      if (r.skipped === 'no text') return reply.status(400).send({ detail: 'This contract has no text to read yet' })
      if (!r.ok) return reply.status(502).send({ detail: 'Could not read the facts', upstream: r.error })
      const checks = await runApplicableChecks({ orgId, contractId: id, userId: req.user.sub })
      await storeComplianceFindings(orgId, id)
      return reply.send({ ...(await complianceApplicability(orgId, id)), checksRan: checks.ran, checkError: checks.error ?? null })
    } catch (err) {
      return costCapped(reply, err)
    }
  })

  app.post('/:id/compliance/facts/confirm', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z.object({ key: z.enum(COMPLIANCE_FACT_KEYS), value: z.unknown() }).parse(req.body)
    const answer = answerValue(body.key, body.value)
    if (!answer.ok) return reply.status(422).send({ detail: answer.detail })
    const { orgId } = req.user
    const userId = actingUserId(req.user)
    if (!await confirmComplianceFact({ orgId, contractId: id, userId, key: body.key, value: answer.value })) {
      return reply.status(404).send({ detail: 'Contract not found' })
    }
    await createAuditEvent({
      orgId, userId: userId ?? undefined, action: AuditAction.COMPLIANCE_FACT_CONFIRMED,
      resourceType: 'contract', resourceId: id, ipAddress: req.ip,
      metadata: { key: body.key, value: answer.value as never },
    })
    // The answer may make a framework apply: check it now. A failed check
    // doesn't undo the answer; the rail shows it and offers a retry.
    let checks: { ran: string[]; error?: string }
    try {
      checks = await runApplicableChecks({ orgId, contractId: id, userId: req.user.sub })
    } catch (err) {
      if (!(err instanceof CostCapExceededError)) throw err
      checks = { ran: [], error: 'Daily AI cost cap reached' }
    }
    // What applies may have changed: the review's compliance findings follow it.
    await storeComplianceFindings(orgId, id)
    return reply.send({ ...(await complianceApplicability(orgId, id)), checksRan: checks.ran, checkError: checks.error ?? null })
  })

  app.post('/:id/compliance/frameworks', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { framework } = z.object({ framework: z.enum(COMPLIANCE_FRAMEWORK_IDS) }).parse(req.body)
    const { orgId } = req.user
    try {
      const r = await addComplianceFramework({ orgId, contractId: id, userId: req.user.sub, framework })
      if (!r) return reply.status(404).send({ detail: 'Contract not found' })
      if (r.skippedReason) return reply.status(400).send({ detail: 'This contract has no text to check yet' })
      if (!r.ok) return reply.status(502).send({ detail: 'compliance agent failed', upstream: r.error })
      await storeComplianceFindings(orgId, id)
      return reply.send(await complianceApplicability(orgId, id))
    } catch (err) {
      if (err instanceof CostCapExceededError) return costCapped(reply, err)
      // The agents service is down: the framework is added; checking it can be retried.
      req.log.warn({ err }, '[compliance] framework check failed')
      return reply.status(502).send({ detail: 'The compliance check could not run. Try again shortly.' })
    }
  })
}

export async function compliancePolicyRoutes(app: FastifyInstance) {
  // The catalogue the admin table is built from, with the rules in force.
  const catalogue = {
    frameworks: COMPLIANCE_FRAMEWORK_IDS.map(id => ({ id, label: COMPLIANCE_FRAMEWORK_LABELS[id] })),
    facts: COMPLIANCE_FACT_KEYS.map(key => ({ key, ...COMPLIANCE_FACTS[key] })),
    defaults: DEFAULT_COMPLIANCE_POLICY,
  }

  app.get('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    return reply.send({ ...(await loadCompliancePolicy(req.user.orgId)), ...catalogue })
  })

  app.put('/', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const parsed = CompliancePolicyRulesSchema.safeParse((req.body as { rules?: unknown } | null)?.rules)
    if (!parsed.success) return reply.status(422).send({ detail: 'Invalid rules', issues: parsed.error.issues.slice(0, 5) })
    const ids = parsed.data.map(r => r.id)
    if (new Set(ids).size !== ids.length) return reply.status(422).send({ detail: 'Each rule needs its own id' })
    const { orgId } = req.user
    const updatedById = actingUserId(req.user)
    await prisma.compliancePolicy.upsert({
      where: { orgId },
      create: { orgId, rules: parsed.data as never, updatedById },
      update: { rules: parsed.data as never, updatedById },
    })
    await createAuditEvent({
      orgId, userId: updatedById ?? undefined, action: AuditAction.COMPLIANCE_POLICY_UPDATED,
      resourceType: 'organization', resourceId: orgId, ipAddress: req.ip,
      metadata: { rules: parsed.data.length, enabled: parsed.data.filter(r => r.enabled).length },
    })
    return reply.send({ ...(await loadCompliancePolicy(orgId)), ...catalogue })
  })

  app.delete('/', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    await prisma.compliancePolicy.deleteMany({ where: { orgId } })
    await createAuditEvent({
      orgId, userId: actingUserId(req.user) ?? undefined, action: AuditAction.COMPLIANCE_POLICY_UPDATED,
      resourceType: 'organization', resourceId: orgId, ipAddress: req.ip, metadata: { reset: true },
    })
    return reply.send({ ...(await loadCompliancePolicy(orgId)), ...catalogue })
  })
}
