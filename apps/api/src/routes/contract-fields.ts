/**
 * Contract fields (docs/39 B1) — every field a contract holds, who set it,
 * and the writes a person makes: set, verify, reject, take or leave the AI's
 * suggestion, move a legacy value. All of it goes through lib/field-store.ts.
 *
 *   GET  /api/v1/contracts/:id/fields
 *   PUT  /api/v1/contracts/:id/fields/:key                { value, source?, quote?, anchor? }
 *   POST /api/v1/contracts/:id/fields/:key/verify
 *   POST /api/v1/contracts/:id/fields/verify-all          every unchecked AI value (B3)
 *   POST /api/v1/contracts/:id/fields/:key/reject
 *   POST /api/v1/contracts/:id/fields/:key/suggestion     { action: 'accept' | 'dismiss' }
 *   POST /api/v1/contracts/:id/fields/:key/reassign       { to }
 *   GET  /api/v1/contracts/:id/variables                  a draft's variables and the field each fills (H2)
 *   PUT  /api/v1/contracts/:id/variables/:key             { text } — a variable's new words, into its field (H2)
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { requirePermission } from '../middleware/permissions.js'
import { guardOwnScopeContractRoutes } from '../lib/own-scope-guard.js'
import {
  getContractFields, setFieldValue, verifyFieldValue, verifyAllFieldValues, rejectFieldValue, resolveSuggestion, reassignLegacyValue,
  type FieldWriteResult,
} from '../lib/field-store.js'
import { draftVariables, setVariableField } from '../lib/draft-variables.js'
import { FIELD_GROUP_LABELS } from '@clm/types'

// A highlight says which of the passages worded like the selection it is
// (the same words can appear twice); the store places it in the version's
// text itself on the next read (field-store FieldAnchor, docs/39 B2).
const AnchorSchema = z.object({
  occurrence: z.number().int().min(0).max(10_000),
})

const SetSchema = z.object({
  value: z.unknown(),
  // docs/39 H2 — "variable": changed from the draft's Variables panel, in the document and here.
  source: z.enum(['user', 'highlight', 'variable']).default('user'),
  quote: z.string().max(4000).nullable().optional(),
  anchor: AnchorSchema.nullable().optional(),
})

function send(reply: FastifyReply, r: FieldWriteResult) {
  if (!r.ok) return reply.status(r.status).send({ detail: r.detail })
  return reply.send({ field: r.field, ...(r.statusChange ? { statusChange: r.statusChange } : {}) })
}

export async function contractFieldRoutes(app: FastifyInstance) {
  guardOwnScopeContractRoutes(app)

  app.get('/:id/fields', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = await getContractFields(req.user.orgId, id)
    if (!result) return reply.status(404).send({ detail: 'Contract not found' })
    return reply.send({
      contractId: id,
      contractType: result.contract.type,
      groups: { ...FIELD_GROUP_LABELS, type: `${result.contract.type.replace(/_/g, ' ')} terms`, custom: 'Custom fields' },
      fields: result.fields,
      // B3 — how much of it a person set or checked.
      verification: result.verification,
    })
  })

  // B3 — Check all: every AI value still unchecked, marked right by a person who read the contract.
  app.post('/:id/fields/verify-all', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const r = await verifyAllFieldValues({ orgId: req.user.orgId, contractId: id, userId: req.user.sub, audit: { source: 'fields_panel', ipAddress: req.ip } })
    if (!r.ok) return reply.status(r.status).send({ detail: r.detail })
    return reply.send({ verified: r.verified, verification: r.verification })
  })

  app.put('/:id/fields/:key', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id, key } = req.params as { id: string; key: string }
    const body = SetSchema.parse(req.body ?? {})
    if (body.source === 'highlight' && !body.quote) return reply.status(400).send({ detail: 'A value set from a highlight needs the highlighted text.' })
    return send(reply, await setFieldValue({
      orgId: req.user.orgId, contractId: id, key, raw: body.value, userId: req.user.sub,
      source: body.source, quote: body.quote ?? null, anchor: body.anchor ?? null,
      audit: { source: body.source === 'highlight' ? 'highlight' : body.source === 'variable' ? 'variables_panel' : 'fields_panel', ipAddress: req.ip },
    }))
  })

  app.post('/:id/fields/:key/verify', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id, key } = req.params as { id: string; key: string }
    return send(reply, await verifyFieldValue({ orgId: req.user.orgId, contractId: id, key, userId: req.user.sub, audit: { source: 'fields_panel', ipAddress: req.ip } }))
  })

  app.post('/:id/fields/:key/reject', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id, key } = req.params as { id: string; key: string }
    return send(reply, await rejectFieldValue({ orgId: req.user.orgId, contractId: id, key, userId: req.user.sub, audit: { source: 'fields_panel', ipAddress: req.ip } }))
  })

  app.post('/:id/fields/:key/suggestion', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id, key } = req.params as { id: string; key: string }
    const { action } = z.object({ action: z.enum(['accept', 'dismiss']) }).parse(req.body ?? {})
    return send(reply, await resolveSuggestion({ orgId: req.user.orgId, contractId: id, key, userId: req.user.sub, accept: action === 'accept', audit: { source: 'fields_panel', ipAddress: req.ip } }))
  })

  app.post('/:id/fields/:key/reassign', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id, key } = req.params as { id: string; key: string }
    const { to } = z.object({ to: z.string().min(1).max(64) }).parse(req.body ?? {})
    return send(reply, await reassignLegacyValue({ orgId: req.user.orgId, contractId: id, key, to, userId: req.user.sub, audit: { source: 'fields_panel', ipAddress: req.ip } }))
  })

  // docs/39 H2 — the variables a draft's text is marked with: the field each
  // fills, and whether that field still holds what the text says.
  app.get('/:id/variables', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = await draftVariables(req.user.orgId, id)
    if (!result) return reply.status(404).send({ detail: 'Contract not found' })
    return reply.send(result)
  })

  // docs/39 H2 — a variable's new words, changed in the text by the draft's
  // Variables panel, into the field it fills.
  app.put('/:id/variables/:key', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id, key } = req.params as { id: string; key: string }
    const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(req.body ?? {})
    const r = await setVariableField({ orgId: req.user.orgId, contractId: id, key, text, userId: req.user.sub, audit: { source: 'variables_panel', ipAddress: req.ip } })
    if (!r.ok) return reply.status(r.status).send({ detail: r.detail })
    return reply.send({ field: r.field, ...(r.unread ? { unread: r.unread } : {}), ...(r.statusChange ? { statusChange: r.statusChange } : {}) })
  })
}
