/**
 * Suggested fields (docs/39 C3) — a field someone asks for from words they
 * highlighted in a contract, when they can't add fields themselves.
 *
 * Only admins could add a field, and only from Settings: a lawyer who spotted
 * a term the AI doesn't track had no way to say so from the contract. Now the
 * selection menu's "New field" adds it for someone who may (the field
 * definitions route) and suggests it for anyone else. Whoever can add fields
 * is told; they add it — with the value it was asked with, saved on the
 * contract it came from — or decline it, and the person who asked is told.
 *
 *   POST /api/v1/field-suggestions                 { label, fieldType, contractType?, helpText?, options?, example? }
 *   GET  /api/v1/field-suggestions?status=PENDING
 *   POST /api/v1/field-suggestions/:id/add         { label?, fieldKey?, fieldType?, contractType?, helpText?, options? }
 *   POST /api/v1/field-suggestions/:id/decline     { reason? }
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { ownContractWhere } from '../lib/own-scope-guard.js'
import { usersWhoCan } from '../lib/permissions.js'
import { queueNotification } from '../lib/queue.js'
import { setFieldValue } from '../lib/field-store.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction, fieldKeyFromLabel } from '@clm/types'
import { FIELD_TYPES, CreateFieldSchema, createFieldDefinition } from './field-definitions.js'

/** "PO number" → "po_number" (packages/types fieldKeyFromLabel). */
export const keyFromLabel = fieldKeyFromLabel

const SuggestSchema = z.object({
  label: z.string().trim().min(1).max(128),
  fieldType: z.enum(FIELD_TYPES),
  contractType: z.string().max(64).nullable().optional(),
  helpText: z.string().max(512).optional(),
  options: z.array(z.string().max(128)).max(50).default([]),
  example: z.object({
    contractId: z.string().min(1),
    quote: z.string().max(4000),
    value: z.unknown().optional(),
    /** Which of the passages worded like the quote it is (B2). */
    occurrence: z.number().int().min(0).max(10_000).optional(),
  }).optional(),
})

const AddSchema = CreateFieldSchema.partial()

export async function fieldSuggestionRoutes(app: FastifyInstance) {
  // Anyone who can read contracts may ask for a field.
  app.post('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const body = SuggestSchema.parse(req.body)
    const fieldKey = keyFromLabel(body.label)
    if (body.example) {
      // X7 — an example from a contract the caller can see.
      const c = await prisma.contract.findFirst({ where: { id: body.example.contractId, orgId, deletedAt: null, ...ownContractWhere(req) }, select: { id: true } })
      if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    }
    const existing = await prisma.contractFieldDefinition.findFirst({ where: { orgId, fieldKey, deletedAt: null }, select: { id: true, fieldLabel: true } })
    if (existing) return reply.status(409).send({ detail: `There is already a field called ${existing.fieldLabel}.`, fieldDefinitionId: existing.id })
    // Asked twice for the same field: one suggestion, not two.
    const pending = await prisma.fieldSuggestion.findFirst({ where: { orgId, fieldKey, status: 'PENDING' } })
    if (pending) return reply.send({ suggestion: pending, duplicate: true })

    const suggestion = await prisma.fieldSuggestion.create({
      data: {
        orgId, label: body.label, fieldKey, fieldType: body.fieldType,
        contractType: body.contractType ?? null, helpText: body.helpText ?? null,
        exampleContractId: body.example?.contractId ?? null, exampleQuote: body.example?.quote ?? null,
        exampleValue: body.example ? ({ value: body.example.value ?? null, occurrence: body.example.occurrence ?? 0, options: body.options } as object) : { options: body.options },
        suggestedById: userId,
      },
    })
    const who = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } })
    for (const admin of await usersWhoCan(orgId, 'configure', 'contract', { exclude: userId })) {
      queueNotification({
        orgId, userId: admin.id, email: admin.email,
        type: 'FIELD_SUGGESTED',
        title: `Field suggested: ${body.label}`,
        body: `${who?.name ?? 'Someone'} asked for a field "${body.label}"${body.contractType ? ` on ${body.contractType.replace(/_/g, ' ')} contracts` : ''}. Add or decline it in Settings → Custom Fields.`,
        resourceType: 'field_suggestion',
        resourceId: suggestion.id,
      })
    }
    return reply.status(201).send({ suggestion })
  })

  app.get('/', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { status } = z.object({ status: z.enum(['PENDING', 'ADDED', 'DECLINED']).default('PENDING') }).parse(req.query)
    const rows = await prisma.fieldSuggestion.findMany({ where: { orgId: req.user.orgId, status }, orderBy: { createdAt: 'desc' }, take: 200 })
    const people = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map(r => r.suggestedById))] } }, select: { id: true, name: true } })
    const contracts = await prisma.contract.findMany({ where: { id: { in: rows.map(r => r.exampleContractId).filter((id): id is string => !!id) }, deletedAt: null }, select: { id: true, title: true } })
    const nameOf = new Map(people.map(p => [p.id, p.name]))
    const titleOf = new Map(contracts.map(c => [c.id, c.title]))
    return reply.send({
      data: rows.map(r => ({
        ...r,
        suggestedBy: nameOf.get(r.suggestedById) ?? null,
        exampleContractTitle: r.exampleContractId ? titleOf.get(r.exampleContractId) ?? null : null,
      })),
    })
  })

  app.post('/:id/add', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id } = req.params as { id: string }
    const overrides = AddSchema.parse(req.body ?? {})
    const s = await prisma.fieldSuggestion.findFirst({ where: { id, orgId } })
    if (!s) return reply.status(404).send({ detail: 'Suggestion not found' })
    if (s.status !== 'PENDING') return reply.status(409).send({ detail: `This suggestion was already ${s.status === 'ADDED' ? 'added' : 'declined'}.` })
    const ex = (s.exampleValue ?? {}) as { value?: unknown; occurrence?: number; options?: string[] }
    const input = CreateFieldSchema.parse({
      fieldKey: s.fieldKey, fieldLabel: s.label, fieldType: s.fieldType, contractType: s.contractType,
      helpText: s.helpText ?? undefined, options: ex.options ?? [],
      ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
    })
    const created = await createFieldDefinition(orgId, input)
    if (!created.ok) return reply.status(created.status).send({ detail: created.detail })

    // The value it was asked with, on the contract it came from, as picked from its text.
    let exampleSaved = false
    if (s.exampleContractId && s.exampleQuote && ex.value !== undefined && ex.value !== null) {
      const r = await setFieldValue({
        orgId, contractId: s.exampleContractId, key: created.def.fieldKey, raw: ex.value, userId,
        source: 'highlight', quote: s.exampleQuote, anchor: { occurrence: ex.occurrence ?? 0 },
        audit: { source: 'field_suggestion', ipAddress: req.ip },
      }).catch(() => null)
      exampleSaved = !!r?.ok
    }
    const updated = await prisma.fieldSuggestion.update({
      where: { id }, data: { status: 'ADDED', resolvedById: userId, resolvedAt: new Date(), fieldDefinitionId: created.def.id },
    })
    await createAuditEvent({
      orgId, userId, action: AuditAction.CONTRACT_UPDATED, resourceType: 'field_definition', resourceId: created.def.id,
      metadata: { source: 'field_suggestion', action: 'added', field: created.def.fieldKey, suggestionId: id },
      ipAddress: req.ip,
    }).catch(() => {})
    const asker = await prisma.user.findUnique({ where: { id: s.suggestedById }, select: { email: true } })
    queueNotification({
      orgId, userId: s.suggestedById, email: asker?.email,
      type: 'FIELD_SUGGESTION_RESOLVED',
      title: `Field added: ${created.def.fieldLabel}`,
      body: `The field you asked for is now on ${created.def.contractType ? `${created.def.contractType.replace(/_/g, ' ')} contracts` : 'every contract'}${exampleSaved ? ', with the value you picked' : ''}.`,
      resourceType: s.exampleContractId ? 'contract' : 'field_definition',
      resourceId: s.exampleContractId ?? created.def.id,
    })
    return reply.send({ suggestion: updated, field: created.def, exampleSaved })
  })

  app.post('/:id/decline', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id } = req.params as { id: string }
    const { reason } = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {})
    const s = await prisma.fieldSuggestion.findFirst({ where: { id, orgId } })
    if (!s) return reply.status(404).send({ detail: 'Suggestion not found' })
    if (s.status !== 'PENDING') return reply.status(409).send({ detail: `This suggestion was already ${s.status === 'ADDED' ? 'added' : 'declined'}.` })
    const updated = await prisma.fieldSuggestion.update({
      where: { id }, data: { status: 'DECLINED', resolvedById: userId, resolvedAt: new Date(), reason: reason || null },
    })
    const asker = await prisma.user.findUnique({ where: { id: s.suggestedById }, select: { email: true } })
    queueNotification({
      orgId, userId: s.suggestedById, email: asker?.email,
      type: 'FIELD_SUGGESTION_RESOLVED',
      title: `Field not added: ${s.label}`,
      body: reason ? `The field you asked for wasn't added: ${reason}` : 'The field you asked for wasn’t added.',
      resourceType: 'field_suggestion',
      resourceId: s.id,
    })
    return reply.send({ suggestion: updated })
  })
}
