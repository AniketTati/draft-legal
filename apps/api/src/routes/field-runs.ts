/**
 * Runs that wrote field values in bulk, and their undo (docs/39 G1/D1) — see
 * lib/field-runs.ts.
 *
 *   GET  /api/v1/field-runs/contract/:contractId/latest   the contract's last re-analysis that changed values
 *   GET  /api/v1/field-runs/:id
 *   POST /api/v1/field-runs/:id/undo
 *
 * Undoing a re-analysis needs edit rights on its contract; undoing a field's
 * fill-in across contracts needs the right to configure fields.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { requirePermission, permissionScopeFor } from '../middleware/permissions.js'
import { ownContractWhere } from '../lib/own-scope-guard.js'
import { getRun, latestReanalysis, undoRun, type RunView } from '../lib/field-runs.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction, CORE_FIELDS, TYPE_FIELDS, formatFieldValue, type FieldValueType } from '@clm/types'

/** A run's changes with each field's name and values as people read them, for the screens. */
async function labelled(orgId: string, run: RunView) {
  const keys = [...new Set(run.changes.map(c => c.fieldKey))]
  const custom = await prisma.contractFieldDefinition.findMany({ where: { orgId, fieldKey: { in: keys } }, select: { fieldKey: true, fieldLabel: true, fieldType: true } })
  const info = new Map<string, { label: string; type: FieldValueType }>([
    // A contract type's own fields (a re-analysis or a retype reads them), named too.
    ...Object.values(TYPE_FIELDS).flat().map(f => [f.key, { label: f.label, type: f.type as FieldValueType }] as const),
    ...CORE_FIELDS.map(f => [f.key, { label: f.label, type: f.type }] as const),
    ...custom.map(c => [c.fieldKey, { label: c.fieldLabel, type: c.fieldType as FieldValueType }] as const),
  ])
  return {
    ...run,
    changes: run.changes.map(c => {
      const i = info.get(c.fieldKey)
      const type = i?.type ?? 'text'
      return {
        ...c,
        label: i?.label ?? c.fieldKey.replace(/_/g, ' '),
        beforeDisplay: c.before ? formatFieldValue(type, c.before.value) : '—',
        afterDisplay: formatFieldValue(type, c.after),
      }
    }),
  }
}

async function mayTouchContract(req: FastifyRequest, contractId: string): Promise<boolean> {
  return !!await prisma.contract.findFirst({ where: { id: contractId, orgId: req.user.orgId, deletedAt: null, ...ownContractWhere(req) }, select: { id: true } })
}

export async function fieldRunRoutes(app: FastifyInstance) {
  app.get('/contract/:contractId/latest', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { contractId } = req.params as { contractId: string }
    if (!await mayTouchContract(req, contractId)) return reply.status(404).send({ detail: 'Contract not found' })
    const run = await latestReanalysis(req.user.orgId, contractId)
    return reply.send({ run: run ? await labelled(req.user.orgId, run) : null })
  })

  app.get('/:id', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const run = await getRun(req.user.orgId, id)
    if (!run || (run.contractId && !await mayTouchContract(req, run.contractId))) return reply.status(404).send({ detail: 'Run not found' })
    return reply.send({ run: await labelled(req.user.orgId, { ...run, changes: run.changes.slice(0, 500) }), total: run.changes.length })
  })

  app.post('/:id/undo', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const run = await getRun(orgId, id)
    if (!run) return reply.status(404).send({ detail: 'Run not found' })
    if (run.kind === 'backfill' && !await permissionScopeFor(req, 'configure', 'contract')) {
      return reply.status(403).send({ detail: 'Undoing a field’s fill-in needs the right to configure fields' })
    }
    if (run.kind === 'counterparty' && !await permissionScopeFor(req, 'configure', 'contract')) {
      return reply.status(403).send({ detail: 'Undoing this needs the right to configure contracts' })
    }
    if (run.contractId && !await mayTouchContract(req, run.contractId)) return reply.status(404).send({ detail: 'Run not found' })
    const r = await undoRun({ orgId, runId: id, userId })
    if (!r.ok) return reply.status(r.status).send({ detail: r.detail })
    await createAuditEvent({
      orgId, userId, action: AuditAction.CONTRACT_UPDATED,
      resourceType: run.contractId ? 'contract' : 'field_definition', resourceId: run.contractId ?? run.fieldDefinitionId ?? id,
      metadata: { source: 'field_run', action: 'undone', kind: run.kind, runId: id, restored: r.restored, skipped: r.skipped },
      ipAddress: req.ip,
    }).catch(() => {})
    return reply.send(r)
  })
}
