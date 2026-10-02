/**
 * docs/41 Parts 13 and 14 — the one way a flow creates a child of a contract
 * (an amendment, a renewal, a renewal letter, a notice of non-renewal).
 *
 * The amendment route made its child inline, at the stage DRAFT stands for,
 * with no stage event; the renewal actions need the same child. Both come
 * here so each child starts the same way: its first version, the stage it
 * starts in on the record (lifecycle.ts recordCreatedStage), the review
 * queued for drafted words (a drafted child is read like any draft, P0.1),
 * found by search, and announced (CONTRACT_CREATED, `amendment.created`).
 */
import type { Prisma } from '@prisma/client'
import { AuditAction, type RelationshipType } from '@clm/types'
import { prisma } from './prisma.js'
import { initialStage, positionOf, recordCreatedStage } from './lifecycle.js'
import { NOT_ANALYSED, onVersionCreated } from './analysis-trigger.js'
import { indexContract } from './elasticsearch.js'
import { createAuditEvent } from './audit.js'
import { fireWebhook } from './webhook-events.js'
import { htmlToText } from './html-text.js'

export interface ChildParent {
  id: string
  counterpartyId: string | null
  counterpartyName: string | null
  currency: string | null
  diligenceRoomId: string | null
}

export interface CreateChildArgs {
  orgId: string
  /** Who made it (audit, version author). */
  userId: string
  ownerId: string
  parent: ChildParent
  title: string
  type: string
  relationshipType: RelationshipType
  amendmentNumber: number | null
  matterId?: string | null
  value?: number | null
  currency?: string | null
  effectiveDate?: Date | null
  expiryDate?: Date | null
  metadata?: Record<string, unknown>
  /** The first version's words. */
  html: string
  plainText?: string
  changeNote?: string
  /** The words were drafted (a template, the parent's text): queue the review. */
  drafted: boolean
  /** What made it, for the audit trail ('amendment_flow', 'renewal_decision'). */
  source: string
  ipAddress?: string
  log?: { warn: (o: unknown, msg: string) => void }
}

export async function createChildContract(a: CreateChildArgs) {
  const plainText = a.plainText ?? htmlToText(a.html)
  const created = await prisma.contract.create({
    data: {
      orgId: a.orgId, ownerId: a.ownerId,
      title: a.title,
      type: a.type,
      ...initialStage('DRAFT'),
      // docs/41 P0.1 — nothing read yet; a drafted child is queued below.
      analysisStatus: NOT_ANALYSED,
      parentContractId: a.parent.id,
      relationshipType: a.relationshipType,
      amendmentNumber: a.amendmentNumber,
      counterpartyId: a.parent.counterpartyId,
      counterpartyName: a.parent.counterpartyName,
      currency: a.currency ?? a.parent.currency ?? 'USD',
      value: a.value ?? null,
      effectiveDate: a.effectiveDate ?? undefined,
      expiryDate: a.expiryDate ?? undefined,
      matterId: a.matterId ?? undefined,
      // C11 — a child of a diligence-room document stays in that room.
      diligenceRoomId: a.parent.diligenceRoomId ?? undefined,
      metadata: (a.metadata ?? {}) as Prisma.InputJsonValue,
      versions: {
        create: {
          versionNumber: 1,
          htmlContent: a.html,
          plainText,
          changeNote: a.changeNote ?? `Initial ${a.relationshipType} draft`,
          createdById: a.userId,
        },
      },
    },
    include: { versions: { select: { id: true } } },
  })
  const versionId = created.versions[0]?.id ?? null
  if (versionId) {
    await prisma.contract.update({ where: { id: created.id }, data: { currentVersionId: versionId } })
  }
  await recordCreatedStage({
    orgId: a.orgId, contractId: created.id, position: positionOf(created), source: 'system', userId: a.userId, versionId,
    extra: { parentContractId: a.parent.id, relationshipType: a.relationshipType, via: a.source },
  })
  if (versionId && a.drafted) {
    await onVersionCreated(created.id, versionId, 'generated')
      .catch(err => a.log?.warn({ err }, `analysis of a drafted ${a.relationshipType} was not queued`))
  }

  // P81 — children are found by portfolio search with their family.
  indexContract(created.id, {
    orgId: a.orgId,
    title: created.title,
    type: created.type,
    status: created.status,
    counterpartyName: created.counterpartyName ?? undefined,
    plainText,
    tags: [],
    createdAt: created.createdAt.toISOString(),
    effectiveDate: created.effectiveDate?.toISOString(),
    expiryDate: created.expiryDate?.toISOString(),
  }).catch(err => a.log?.warn({ err }, `ES index on ${a.relationshipType} failed`))

  await createAuditEvent({
    orgId: a.orgId, userId: a.userId,
    action: AuditAction.CONTRACT_CREATED,
    resourceType: 'contract', resourceId: created.id,
    metadata: { relationshipType: a.relationshipType, parentContractId: a.parent.id, source: a.source },
    ipAddress: a.ipAddress,
  })
  // H2 — every related document announces itself; subscribers filter by relationship.
  fireWebhook(a.orgId, 'amendment.created', {
    contractId: created.id, parentContractId: a.parent.id, relationshipType: a.relationshipType,
    title: created.title, type: created.type,
  })
  return { id: created.id, title: created.title, type: created.type, status: created.status, versionId }
}
