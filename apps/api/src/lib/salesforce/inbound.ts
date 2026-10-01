/**
 * docs/41 Part 17 (S2) — Salesforce → draftLegal.
 *
 *   - A rep's "New contract" on an Opportunity (the dlNewContract LWC, or the
 *     Apex invocable from a Flow) becomes a draftLegal request, pre-filled
 *     through the org's field mappings, its counterparty linked by the
 *     Account id (`Counterparty.crmId`).
 *   - A later change to a mapped Salesforce record (a record-triggered Flow)
 *     updates the contracts made from it: written while Salesforce still owns
 *     the deal, held as a conflict for a person once the contract is out for
 *     signature or signed. Never a silent overwrite.
 *
 * Callers are authenticated by an API key with the `salesforce` scope and a
 * Salesforce org id header that must match the connected org (routes/salesforce.ts).
 */
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { AuditAction, coreField } from '@clm/types'
import { prisma } from '../prisma.js'
import { createAuditEvent } from '../audit.js'
import { queueNotification } from '../queue.js'
import { setFieldValues } from '../field-store.js'
import {
  applyInboundMapping, mappingsForType, planInboundChange, isFrozen, describeConflict, payloadHash,
  type FieldMapping, type MappedValue,
} from '../integrations/mapping.js'
import { normaliseSalesforceId } from './oauth.js'

const record = z.record(z.unknown()).refine(r => JSON.stringify(r).length <= 100_000, 'record too large')
const SF_ID = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/

export const InboundRequestSchema = z.object({
  contractType: z.string().min(1).max(64),
  title:        z.string().max(200).optional(),
  description:  z.string().max(10_000).optional(),
  records:      z.record(record).default({}),
  requestedBy:  z.object({
    email:        z.string().email().max(320).optional(),
    federationId: z.string().max(255).optional(),
    name:         z.string().max(200).optional(),
  }).optional(),
  /** Pre-approved options the rep chose on the form (special terms). */
  options:      z.record(z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
  /** Draft it now, for a self-serve type (an NDA on our paper). */
  generateNow:  z.boolean().optional(),
})
export type InboundRequest = z.infer<typeof InboundRequestSchema>

export const InboundChangeSchema = z.object({
  object: z.string().min(1).max(80),
  record: record,
  /** Related records the mappings may read (the Opportunity's Account …). */
  records: z.record(record).optional(),
})

const appBase = () => (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '')
export const requestLink = (id: string) => `${appBase()}/requests?request=${encodeURIComponent(id)}`

function sfId(v: unknown): string | undefined {
  return typeof v === 'string' && SF_ID.test(v) ? v : undefined
}

/**
 * The counterparty for a Salesforce Account: the one already linked by
 * Account id, else the one by that name (now linked), else a new one.
 * Salesforce owns the account: draftLegal edits to the name are not pushed.
 */
export async function counterpartyForAccount(orgId: string, account: Record<string, unknown> | undefined, fallbackName?: string | null): Promise<{ id: string; name: string } | null> {
  const accountId = sfId(account?.Id)
  const name = (typeof account?.Name === 'string' ? account.Name : fallbackName ?? '').trim()
  if (accountId) {
    const linked = await prisma.counterparty.findFirst({
      where: { orgId, deletedAt: null, crmId: { startsWith: normaliseSalesforceId(accountId) } },
      select: { id: true, name: true },
    })
    if (linked) return linked
  }
  if (!name) return null
  const byName = await prisma.counterparty.findFirst({
    where: { orgId, deletedAt: null, name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true, crmId: true },
  })
  if (byName) {
    if (accountId && !byName.crmId) await prisma.counterparty.updateMany({ where: { id: byName.id, orgId }, data: { crmId: accountId } })
    return { id: byName.id, name: byName.name }
  }
  const created = await prisma.counterparty.create({
    data: { orgId, name: name.slice(0, 200), crmId: accountId ?? null, metadata: { source: 'salesforce' } },
    select: { id: true, name: true },
  })
  return created
}

async function nextRequestNumber(orgId: string): Promise<string> {
  // Same numbering as routes/requests.ts: REQ-YYYYMMDD-NNN.
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const countToday = await prisma.contractRequest.count({
    where: { orgId, createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
  })
  return `REQ-${today}-${String(countToday + 1).padStart(3, '0')}`
}

function show(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return v.toLocaleString('en-US')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** What a request made from Salesforce says it needs, when the rep wrote nothing. */
function describeRequest(type: string, values: MappedValue[], records: Record<string, Record<string, unknown>>): string {
  const opp = records.Opportunity
  const lines = [`${type} requested from Salesforce${typeof opp?.Name === 'string' ? ` for the opportunity "${opp.Name}"` : ''}.`]
  for (const v of values) {
    if (v.dlField === 'description' || v.dlField === 'title') continue
    const label = coreField(v.dlField)?.label ?? v.dlField.replace(/^var:/, '')
    lines.push(`${label}: ${show(v.value)}`)
  }
  return lines.join('\n')
}

export interface InboundRequestResult {
  requestId: string
  requestNumber: string | null
  deepLink: string
  counterpartyId: string | null
  prefilled: string[]
  issues: Array<{ dlField: string; externalField: string; error: string }>
}

/**
 * Create a draftLegal request from a Salesforce launch. `actingUserId` is
 * whoever the API key acts for; the rep, when their email is a member of the
 * org, becomes the requester.
 */
export async function createRequestFromSalesforce(input: {
  orgId: string
  actingUserId: string
  salesforceOrgId: string
  body: InboundRequest
  ipAddress?: string
}): Promise<InboundRequestResult> {
  const { orgId, body } = input
  const records = body.records as Record<string, Record<string, unknown>>
  const mappings: FieldMapping[] = mappingsForType(
    await prisma.integrationFieldMapping.findMany({ where: { orgId, provider: 'salesforce' } }),
    body.contractType,
  )
  const mapped = applyInboundMapping(mappings, records)
  const value = (key: string) => mapped.values.find(v => v.dlField === key)?.value

  const counterparty = await counterpartyForAccount(orgId, records.Account, (value('counterpartyName') as string | undefined) ?? null)

  const rep = body.requestedBy?.email
    ? await prisma.user.findFirst({ where: { orgId, email: { equals: body.requestedBy.email, mode: 'insensitive' }, deletedAt: null, status: 'ACTIVE' }, select: { id: true } })
    : null

  const opp = records.Opportunity
  const title = (body.title ?? (value('title') as string | undefined)
    ?? `${body.contractType} — ${counterparty?.name ?? (typeof opp?.Name === 'string' ? opp.Name : 'Salesforce request')}`).slice(0, 200)
  const description = body.description ?? (value('description') as string | undefined) ?? describeRequest(body.contractType, mapped.values, records)
  const estimated = value('value')
  const priority = value('priority') as string | undefined

  const metadata = {
    ...(counterparty ? { counterpartyId: counterparty.id } : {}),
    salesforce: {
      orgId:          input.salesforceOrgId,
      opportunityId:  sfId(opp?.Id) ?? null,
      accountId:      sfId(records.Account?.Id) ?? null,
      quoteId:        sfId(records.Quote?.Id) ?? null,
      requestedBy:    rep ? null : body.requestedBy ?? null,
    },
    // The mapped values, by draftLegal field: the request form and the
    // drafting read them; locked ones are shown read-only.
    prefill:  Object.fromEntries(mapped.values.filter(v => !v.dlField.startsWith('var:')).map(v => [v.dlField, v.value])),
    variables: Object.fromEntries(mapped.values.filter(v => v.dlField.startsWith('var:')).map(v => [v.dlField.slice(4), v.value])),
    locked:   mapped.values.filter(v => v.locked).map(v => v.dlField),
    ...(body.options ? { options: body.options } : {}),
  }

  const request = await prisma.contractRequest.create({
    data: {
      orgId,
      requestNumber:    await nextRequestNumber(orgId),
      title,
      type:             body.contractType,
      source:           'salesforce',
      requestedById:    rep?.id ?? input.actingUserId,
      counterpartyName: counterparty?.name ?? (value('counterpartyName') as string | undefined) ?? null,
      description,
      estimatedValue:   typeof estimated === 'number' ? estimated : null,
      ...(priority ? { priority } : {}),
      metadata:         metadata as Prisma.InputJsonValue,
    },
    select: { id: true, requestNumber: true },
  })

  await createAuditEvent({
    orgId, userId: rep?.id ?? input.actingUserId,
    action: AuditAction.REQUEST_CREATED, resourceType: 'contract_request', resourceId: request.id,
    metadata: { source: 'salesforce', opportunityId: metadata.salesforce.opportunityId }, ipAddress: input.ipAddress,
  })
  await prisma.integrationSyncLog.create({
    data: {
      orgId, provider: 'salesforce', direction: 'inbound', object: 'ContractRequest',
      externalId: metadata.salesforce.opportunityId, requestId: request.id, event: 'request.created',
      payloadHash: payloadHash(body.records), status: 'success', attempt: 1, completedAt: new Date(),
      detail: mapped.issues.length ? { issues: mapped.issues } : undefined,
    },
  })

  return {
    requestId: request.id,
    requestNumber: request.requestNumber,
    deepLink: requestLink(request.id),
    counterpartyId: counterparty?.id ?? null,
    prefilled: mapped.values.map(v => v.dlField),
    issues: mapped.issues,
  }
}

/** The fields a contract holds that a mapping can compare against. */
const COLUMN_FIELDS = ['value', 'currency', 'effectiveDate', 'expiryDate', 'counterpartyName'] as const

export interface InboundChangeResult {
  contracts: Array<{ contractId: string; written: string[]; conflicts: string[]; unchanged: string[] }>
  requests: Array<{ requestId: string; updated: string[] }>
}

/**
 * A Salesforce record changed (a record-triggered Flow calls us). Every
 * contract and open request made from it is brought up to date under the
 * ownership rule: before signing Salesforce's change is written; after, it
 * becomes a conflict and the contract's owner is told.
 */
export async function applySalesforceChange(input: {
  orgId: string
  actingUserId: string
  object: string
  record: Record<string, unknown>
  records?: Record<string, Record<string, unknown>>
}): Promise<InboundChangeResult> {
  const { orgId } = input
  const recordId = sfId(input.record.Id)
  const result: InboundChangeResult = { contracts: [], requests: [] }
  if (!recordId) return result
  const key = input.object === 'Opportunity' ? 'opportunityId' : input.object === 'Account' ? 'accountId' : input.object === 'Quote' ? 'quoteId' : null
  if (!key) return result
  const records = { ...(input.records ?? {}), [input.object]: input.record }
  const id15 = normaliseSalesforceId(recordId)
  const allMappings: FieldMapping[] = await prisma.integrationFieldMapping.findMany({ where: { orgId, provider: 'salesforce' } })

  // Requests not yet converted: their pre-filled values follow Salesforce.
  const requests = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM contract_requests
     WHERE "orgId" = ${orgId} AND "deletedAt" IS NULL AND status NOT IN ('ACCEPTED', 'COMPLETED', 'REJECTED', 'CANCELLED')
       AND left(metadata->'salesforce'->>${key}, 15) = ${id15}`
  for (const { id } of requests) {
    const req = await prisma.contractRequest.findFirst({ where: { id, orgId }, select: { id: true, type: true, metadata: true } })
    if (!req) continue
    const mapped = applyInboundMapping(mappingsForType(allMappings, req.type), records)
    if (!mapped.values.length) continue
    const meta = (req.metadata ?? {}) as Record<string, unknown>
    const prefill = { ...((meta.prefill ?? {}) as Record<string, unknown>) }
    for (const v of mapped.values) if (!v.dlField.startsWith('var:')) prefill[v.dlField] = v.value
    const est = mapped.values.find(v => v.dlField === 'value')?.value
    await prisma.contractRequest.updateMany({
      where: { id, orgId },
      data: { metadata: { ...meta, prefill } as Prisma.InputJsonValue, ...(typeof est === 'number' ? { estimatedValue: est } : {}) },
    })
    result.requests.push({ requestId: id, updated: mapped.values.map(v => v.dlField) })
  }

  const contracts = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM contracts
     WHERE "orgId" = ${orgId} AND "deletedAt" IS NULL
       AND left(metadata->'salesforce'->>${key}, 15) = ${id15}`
  for (const { id } of contracts) {
    const c = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, title: true, type: true, status: true, ownerId: true, metadata: true, value: true, currency: true, effectiveDate: true, expiryDate: true, counterpartyName: true },
    })
    if (!c) continue
    const mapped = applyInboundMapping(mappingsForType(allMappings, c.type), records)
    // Only fields the contract holds: request text and template variables
    // belong to the request and the draft.
    const incoming = mapped.values.filter(v => coreField(v.dlField)?.key === v.dlField)
    const fieldRows = await prisma.contractFieldValue.findMany({ where: { orgId, contractId: c.id, fieldKey: { in: incoming.map(v => v.dlField) } }, select: { fieldKey: true, value: true } })
    const current: Record<string, unknown> = Object.fromEntries(fieldRows.map(r => [r.fieldKey, r.value]))
    for (const col of COLUMN_FIELDS) {
      if (current[col] !== undefined) continue
      const v = c[col]
      current[col] = v === null ? null : typeof v === 'object' && 'toNumber' in v ? v.toNumber() : v instanceof Date ? v.toISOString().slice(0, 10) : v
    }
    const plan = planInboundChange({ frozen: isFrozen(c), incoming, current })

    if (plan.write.length) {
      const written = await setFieldValues({
        orgId, contractId: c.id, userId: input.actingUserId,
        values: plan.write.map(v => ({ key: v.dlField, raw: v.value, source: 'import' as const })),
        audit: { source: 'salesforce' },
      })
      if (!written.ok) throw new Error(`Salesforce change not applied to ${c.id}: ${written.detail}`)
    }
    for (const k of plan.conflicts) {
      // One open conflict per field: a newer change replaces the pending one.
      const open = await prisma.integrationConflict.findFirst({ where: { orgId, contractId: c.id, dlField: k.dlField, status: 'open' }, select: { id: true } })
      const data = {
        externalObject: k.externalObject, externalField: k.externalField,
        currentValue: (k.current ?? null) as Prisma.InputJsonValue, incomingValue: (k.incoming ?? null) as Prisma.InputJsonValue,
      }
      if (open) await prisma.integrationConflict.updateMany({ where: { id: open.id, orgId }, data })
      else await prisma.integrationConflict.create({ data: { orgId, provider: 'salesforce', contractId: c.id, dlField: k.dlField, ...data } })
      queueNotification({
        orgId, userId: c.ownerId, type: 'INTEGRATION_CONFLICT',
        title: `${describeConflict(k)} — update contract?`,
        body: `"${c.title}" is out for signature or signed, so the change was not written. Open the contract to apply it or keep the contract as it is.`,
        resourceType: 'contract', resourceId: c.id,
      })
    }
    await prisma.integrationSyncLog.create({
      data: {
        orgId, provider: 'salesforce', direction: 'inbound', object: input.object, externalId: recordId, contractId: c.id,
        event: 'record.changed', payloadHash: payloadHash(input.record),
        status: plan.conflicts.length ? 'conflict' : 'success', attempt: 1, completedAt: new Date(),
        detail: { written: plan.write.map(v => v.dlField), conflicts: plan.conflicts.map(k => k.dlField), issues: mapped.issues } as Prisma.InputJsonValue,
      },
    })
    result.contracts.push({ contractId: c.id, written: plan.write.map(v => v.dlField), conflicts: plan.conflicts.map(k => k.dlField), unchanged: plan.unchanged })
  }
  return result
}

/**
 * A person decides a conflict: `apply` writes Salesforce's value to the
 * contract (as their own edit), `dismiss` keeps the contract as it is.
 */
export async function resolveConflict(input: { orgId: string; conflictId: string; userId: string; action: 'apply' | 'dismiss'; ipAddress?: string }): Promise<{ ok: true } | { ok: false; status: 400 | 404; detail: string }> {
  const k = await prisma.integrationConflict.findFirst({ where: { id: input.conflictId, orgId: input.orgId } })
  if (!k) return { ok: false, status: 404, detail: 'Conflict not found' }
  if (k.status !== 'open') return { ok: false, status: 400, detail: 'This change was already decided' }
  if (input.action === 'apply') {
    const r = await setFieldValues({
      orgId: input.orgId, contractId: k.contractId, userId: input.userId,
      values: [{ key: k.dlField, raw: k.incomingValue, source: 'user' }],
      audit: { source: 'salesforce_conflict', ipAddress: input.ipAddress },
    })
    if (!r.ok) return r
  }
  await prisma.integrationConflict.updateMany({
    where: { id: k.id, orgId: input.orgId },
    data: { status: input.action === 'apply' ? 'applied' : 'dismissed', resolvedById: input.userId, resolvedAt: new Date() },
  })
  await createAuditEvent({
    orgId: input.orgId, userId: input.userId, action: AuditAction.INTEGRATION_CONFLICT_RESOLVED,
    resourceType: 'contract', resourceId: k.contractId,
    metadata: { provider: k.provider, field: k.dlField, decision: input.action, from: k.currentValue, to: k.incomingValue }, ipAddress: input.ipAddress,
  })
  return { ok: true }
}
