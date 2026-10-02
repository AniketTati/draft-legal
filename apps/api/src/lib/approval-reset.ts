/**
 * docs/41 Part 18 — what a change does to approvals already given.
 *
 * An approval is a decision on one version (ApprovalInstance.versionId).
 * When the contract changes while it is in Approve, each approved step's
 * reset rule (the workflow step's `resetOn`, packages/types lifecycle.ts)
 * says whether it is asked for again:
 *   - the steps that reset are marked RESET (their decision stays in the
 *     history) and asked again, from the earliest of them; the contract goes
 *     back to "waiting for approval"; their approvers are told what changed
 *     ("v6 changed Limitation of Liability — your approval was reset");
 *   - when none resets, the approval carries to the new version, on the record;
 *   - either way a "Ready to approve" recommendation written for the old
 *     version is withdrawn: the policy works it out again for the new one.
 * A counterparty's version after submission always withdraws the request
 * (docs/41 §6.5): the approvers are told, and the contract is back in
 * Negotiate with us.
 *
 * A clause exception resets only when its own clause's text changes.
 *
 * X42 used to send an approved contract back to Draft on any change; the
 * rules replace that.
 */
import { AuditAction, readResetRule, resets, clauseTypeLabel, type ChangeSet } from '@clm/types'
import { prisma } from './prisma.js'
import { createAuditEvent } from './audit.js'
import { queueNotification } from './queue.js'
import { onCounterpartyVersion, positionOf, transition, workingStageBefore } from './lifecycle.js'
import { cancelEscalation, deciderIdsOf, type WorkflowStepDef } from './workflow-engine.js'
import { normaliseText } from './fingerprint.js'

/** What an approval was always taken to cover (X42): what the auto-approval rule reads. */
const X42_FIELDS = ['type', 'value', 'currency']

export interface ChangeArgs {
  orgId: string
  contractId: string
  /** The new version, when the document changed. */
  versionId?: string | null
  /** The version it was made from (the edit's base), compared against when the approval names no version. */
  fromVersionId?: string | null
  /** Fields that changed (type, value, currency, a custom field…). */
  fields?: string[]
  source: 'edit' | 'counterparty'
  userId?: string | null
  /** For a counterparty's version: how it came. */
  via?: 'portal' | 'email'
}

export interface ChangeOutcome {
  withdrawn: boolean
  resetStepIds: string[]
  resetExceptionIds: string[]
  carried: boolean
}

/** The text of each clause type on a version (sub-chunks left out), normalised. */
async function clauseTexts(versionId: string): Promise<Map<string, { text: string; sectionRef: string | null }>> {
  const rows = await prisma.contractClause.findMany({
    where: { versionId, isSubChunk: false },
    orderBy: { sortOrder: 'asc' },
    select: { clauseType: true, content: true, sectionRef: true },
  })
  const out = new Map<string, { text: string; sectionRef: string | null }>()
  for (const r of rows) {
    const t = r.clauseType || 'other'
    const prev = out.get(t)
    out.set(t, { text: `${prev?.text ?? ''} ${normaliseText(r.content ?? '')}`.trim(), sectionRef: prev?.sectionRef ?? r.sectionRef ?? null })
  }
  return out
}

/**
 * Clause types whose text differs between two versions (added, removed or
 * reworded), with where they are now. `null` when the new version's clauses
 * aren't known yet (an upload still being read): every clause counts as
 * changed.
 */
export async function changedClauses(fromVersionId: string | null | undefined, toVersionId: string): Promise<Array<{ clauseType: string; sectionRef: string | null }> | null> {
  if (!fromVersionId || fromVersionId === toVersionId) return fromVersionId ? [] : null
  const [before, after] = await Promise.all([clauseTexts(fromVersionId), clauseTexts(toVersionId)])
  if (after.size === 0 && before.size > 0) return null
  const out: Array<{ clauseType: string; sectionRef: string | null }> = []
  for (const t of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(t)?.text !== after.get(t)?.text) out.push({ clauseType: t, sectionRef: after.get(t)?.sectionRef ?? before.get(t)?.sectionRef ?? null })
  }
  return out
}

/** "§5 Limitation of Liability", "the document", "the value": what changed, in words. */
export function changeWords(change: { clauses: Array<{ clauseType: string; sectionRef: string | null }> | null; fields: string[]; document: boolean }): string {
  const parts: string[] = []
  if (change.clauses && change.clauses.length) {
    const named = change.clauses.slice(0, 3).map(c => `${c.sectionRef ? `§${c.sectionRef.replace(/^§\s*/, '')} ` : ''}${clauseTypeLabel(c.clauseType)}`)
    parts.push(named.join(', ') + (change.clauses.length > 3 ? ` and ${change.clauses.length - 3} more` : ''))
  } else if (change.document) parts.push('the document')
  if (change.fields.length) parts.push(`the ${change.fields.slice(0, 3).join(', ')}`)
  return parts.join(' and ') || 'the contract'
}

/** What a change does to the contract's approvals. See the module comment. Never throws. */
export async function onApprovalChange(a: ChangeArgs): Promise<ChangeOutcome> {
  const out: ChangeOutcome = { withdrawn: false, resetStepIds: [], resetExceptionIds: [], carried: false }
  try {
    return await apply(a, out)
  } catch (err) {
    console.warn('[approval-reset] contractId=%s: %s', a.contractId, (err as Error).message)
    return out
  }
}

async function apply(a: ChangeArgs, out: ChangeOutcome): Promise<ChangeOutcome> {
  const contract = await prisma.contract.findFirst({
    where: { id: a.contractId, orgId: a.orgId },
    select: { id: true, title: true, stage: true, stageState: true, turn: true, status: true, currentVersionId: true },
  })
  if (!contract) return out
  const pos = positionOf(contract)
  const version = a.versionId ? await prisma.contractVersion.findFirst({ where: { id: a.versionId, contractId: a.contractId }, select: { id: true, versionNumber: true } }) : null
  const fields = a.fields ?? []
  const document = !!version

  // ── Clause exceptions: reset when their own clause's words change ─────────
  if (document) {
    const exceptions = await prisma.approvalStep.findMany({
      where: { orgId: a.orgId, contractId: a.contractId, kind: 'clause_exception', status: { in: ['PENDING', 'APPROVED'] } },
    })
    for (const ex of exceptions) {
      const changed = await changedClauses(ex.versionId, version!.id)
      if (changed !== null && !changed.some(c => c.clauseType === (ex.clauseType ?? 'other'))) continue
      const done = await prisma.approvalStep.updateMany({ where: { id: ex.id, status: ex.status }, data: { status: 'RESET' } })
      if (!done.count) continue
      out.resetExceptionIds.push(ex.id)
      await createAuditEvent({
        orgId: a.orgId, ...(a.userId && { userId: a.userId }), action: AuditAction.APPROVALS_RESET, resourceType: 'contract', resourceId: a.contractId,
        metadata: { exceptionStepId: ex.id, findingId: ex.findingId, clauseType: ex.clauseType, wasStatus: ex.status, versionId: version!.id, versionNumber: version!.versionNumber, reason: 'its clause changed' },
      }).catch(() => {})
      const who = ex.status === 'APPROVED' && ex.approverId ? [ex.approverId] : await deciderIdsOf(ex, prisma)
      for (const userId of new Set([...who, ...(ex.requestedById ? [ex.requestedById] : [])])) {
        queueNotification({
          orgId: a.orgId, userId, type: 'APPROVAL_DECIDED', title: 'Exception reset',
          body: `v${version!.versionNumber} changed ${clauseTypeLabel(ex.clauseType ?? 'the clause')} on "${contract.title}" — the exception ${ex.status === 'APPROVED' ? 'approved' : 'asked for'} on the old words was reset. Ask again if it is still needed.`,
          resourceType: 'contract', resourceId: a.contractId,
        })
      }
    }
  }

  if (pos.stage !== 'approve') return out

  // The request this change is about: the open one, or the approval that stands.
  const instance = await prisma.approvalInstance.findFirst({
    where: { orgId: a.orgId, contractId: a.contractId, status: { in: ['PENDING', 'ESCALATED', 'APPROVED', 'AUTO_APPROVED'] } },
    orderBy: { submittedAt: 'desc' },
    include: { steps: true, definition: { select: { steps: true } } },
  })
  if (!instance) {
    // Approved with no approval on record (set before approvals were kept by
    // version, or imported): there are no rules to read, so X42's stands — a
    // new document, or a change to what the auto-approval rule judges (type,
    // value, currency), sends it back to be submitted again.
    if (pos.stageState === 'approved' && a.source === 'edit' && (document || fields.some(f => X42_FIELDS.includes(f)))) {
      out.withdrawn = true
      await transition({
        orgId: a.orgId, contractId: a.contractId, source: 'edit', userId: a.userId,
        to: { stage: await workingStageBefore(a.orgId, a.contractId), state: 'drafting' }, onlyFrom: [{ stage: 'approve', state: 'approved' }],
        reason: `${changeWords({ clauses: null, fields, document })} changed after it was approved; submit it again`, versionId: version?.id,
      })
    }
    return out
  }
  const open = instance.status === 'PENDING' || instance.status === 'ESCALATED'

  // ── A counterparty's version after submission: always withdrawn ───────────
  if (a.source === 'counterparty') {
    const closed = await prisma.approvalInstance.updateMany({
      where: { id: instance.id, status: instance.status },
      data: { status: 'CANCELLED', outcome: 'withdrawn', decidedAt: new Date(), approvalRecommendation: null },
    })
    if (closed.count) {
      const pending = instance.steps.filter(s => s.status === 'PENDING')
      await prisma.approvalStep.updateMany({ where: { approvalInstanceId: instance.id, status: 'PENDING' }, data: { status: 'SKIPPED', decidedAt: new Date() } })
      await Promise.all(pending.map(s => cancelEscalation(s.id)))
      out.withdrawn = true
      await createAuditEvent({
        orgId: a.orgId, action: AuditAction.APPROVALS_RESET, resourceType: 'contract', resourceId: a.contractId,
        metadata: { instanceId: instance.id, withdrawn: true, reason: 'the counterparty sent a new version', versionId: version?.id ?? null, versionNumber: version?.versionNumber ?? null, via: a.via ?? null },
      }).catch(() => {})
      const approvers = new Set<string>()
      for (const s of instance.steps) {
        if (s.status === 'APPROVED' && s.approverId) approvers.add(s.approverId)
        if (s.status === 'PENDING') for (const id of await deciderIdsOf(s, prisma)) approvers.add(id)
      }
      for (const userId of approvers) {
        queueNotification({
          orgId: a.orgId, userId, type: 'APPROVAL_DECIDED', title: 'Approval request withdrawn',
          body: `The counterparty sent ${version ? `v${version.versionNumber}` : 'a new version'} of "${contract.title}" after it was submitted, so the request for your approval was withdrawn. It will be submitted again once the new version is reviewed.`,
          resourceType: 'contract', resourceId: a.contractId,
        })
      }
    }
    if (version) await onCounterpartyVersion({ orgId: a.orgId, contractId: a.contractId, versionId: version.id, via: a.via ?? 'portal' })
    return out
  }

  // ── An auto-approved request: its rules were judged on the old terms ──────
  if (instance.status === 'AUTO_APPROVED') {
    if (!document && !fields.length) return out
    await prisma.approvalInstance.updateMany({ where: { id: instance.id, status: 'AUTO_APPROVED' }, data: { status: 'CANCELLED', outcome: 'withdrawn', approvalRecommendation: null } })
    out.withdrawn = true
    await createAuditEvent({
      orgId: a.orgId, ...(a.userId && { userId: a.userId }), action: AuditAction.APPROVALS_RESET, resourceType: 'contract', resourceId: a.contractId,
      metadata: { instanceId: instance.id, withdrawn: true, reason: `${changeWords({ clauses: null, fields, document })} changed after it was approved automatically`, versionId: version?.id ?? null },
    }).catch(() => {})
    await transition({
      orgId: a.orgId, contractId: a.contractId, source: 'edit', userId: a.userId,
      to: { stage: await workingStageBefore(a.orgId, a.contractId), state: 'drafting' }, onlyFrom: ['approve'],
      reason: 'it changed after it was approved automatically; submit it again', versionId: version?.id,
    })
    return out
  }

  const change: ChangeSet = { document, clauseTypes: null, fields }
  let clauses: Array<{ clauseType: string; sectionRef: string | null }> | null = null
  if (document) {
    // Against the version the approvals were given on, not the edit's base:
    // several edits since add up.
    clauses = await changedClauses(instance.versionId ?? a.fromVersionId, version!.id)
    change.clauseTypes = clauses ? clauses.map(c => c.clauseType) : null
  }
  const defs = (Array.isArray(instance.definition?.steps) ? instance.definition!.steps : []) as unknown as WorkflowStepDef[]
  const ruleAt = (order: number) => readResetRule(defs.find(d => d.order === order)?.resetOn)

  const approved = instance.steps.filter(s => s.kind === 'approval' && s.status === 'APPROVED')
  const toReset = approved.filter(s => resets(ruleAt(s.stepOrder), change))
  const what = changeWords({ clauses, fields, document })

  if (!toReset.length) {
    // Nothing asked for again: the approvals given carry to the new version.
    if (document && instance.versionId !== version!.id) {
      await prisma.approvalInstance.update({ where: { id: instance.id }, data: { versionId: version!.id, ...(instance.approvalRecommendation === 'ready_to_approve' && { approvalRecommendation: null }) } })
      out.carried = true
      await createAuditEvent({
        orgId: a.orgId, ...(a.userId && { userId: a.userId }), action: AuditAction.APPROVALS_RESET, resourceType: 'contract', resourceId: a.contractId,
        metadata: { instanceId: instance.id, resetStepIds: [], carried: true, changed: what, versionId: version!.id, versionNumber: version!.versionNumber, fromVersionId: instance.versionId },
      }).catch(() => {})
    }
    return out
  }

  // Reset: the steps that reset are asked again, from the earliest of them.
  const firstOrder = Math.min(...toReset.map(s => s.stepOrder))
  await prisma.approvalStep.updateMany({ where: { id: { in: toReset.map(s => s.id) }, status: 'APPROVED' }, data: { status: 'RESET' } })
  // Steps still waiting at a later order wait for the earlier ones again.
  const laterPending = instance.steps.filter(s => s.status === 'PENDING' && s.stepOrder > firstOrder)
  if (laterPending.length) {
    await prisma.approvalStep.updateMany({ where: { id: { in: laterPending.map(s => s.id) } }, data: { status: 'SKIPPED', decidedAt: new Date() } })
    await Promise.all(laterPending.map(s => cancelEscalation(s.id)))
  }
  const again = toReset.filter(s => s.stepOrder === firstOrder)
  const recreated: Array<{ id: string; approverId: string | null; approverRoleId: string | null; orgId: string }> = []
  for (const s of again) {
    // A pooled step goes back to its role: whoever claimed it last time is one
    // of the pool again, not the step's approver.
    const pooled = !!s.approverRoleId
    const fresh = await prisma.approvalStep.create({
      data: {
        approvalInstanceId: instance.id, orgId: a.orgId, contractId: a.contractId, kind: 'approval',
        stepOrder: s.stepOrder, stepName: s.stepName, approverId: pooled ? null : s.approverId, approverRoleId: s.approverRoleId, status: 'PENDING',
        escalateAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      },
    })
    recreated.push({ id: fresh.id, approverId: fresh.approverId, approverRoleId: fresh.approverRoleId, orgId: a.orgId })
  }
  await prisma.approvalInstance.update({
    where: { id: instance.id },
    data: {
      status: 'PENDING', outcome: null, decidedAt: null, currentStepOrder: firstOrder,
      ...(document && { versionId: version!.id }),
      approvalRecommendation: null,
    },
  })
  out.resetStepIds = toReset.map(s => s.id)
  await createAuditEvent({
    orgId: a.orgId, ...(a.userId && { userId: a.userId }), action: AuditAction.APPROVALS_RESET, resourceType: 'contract', resourceId: a.contractId,
    metadata: {
      instanceId: instance.id, resetStepIds: out.resetStepIds, changed: what,
      clauseTypes: change.clauseTypes, fields, versionId: version?.id ?? null, versionNumber: version?.versionNumber ?? null,
      approvers: toReset.map(s => s.approverId),
    },
  }).catch(() => {})
  if (!open) {
    await transition({
      orgId: a.orgId, contractId: a.contractId, source: 'edit', userId: a.userId,
      to: { stage: 'approve', state: 'pending' }, onlyFrom: [{ stage: 'approve', state: 'approved' }],
      reason: `${what} changed after it was approved`, versionId: version?.id, extra: { instanceId: instance.id },
    })
  }
  const label = version ? `v${version.versionNumber} changed ${what}` : `${what[0].toUpperCase()}${what.slice(1)} changed`
  for (const s of toReset) {
    if (!s.approverId) continue
    queueNotification({
      orgId: a.orgId, userId: s.approverId, type: 'APPROVAL_REQUEST', title: 'Your approval was reset',
      body: `${label} — your approval of "${contract.title}" was reset${s.stepOrder === firstOrder ? '. Please review it again.' : ' and will be asked again after the earlier step.'}`,
      resourceType: 'contract', resourceId: a.contractId,
    })
  }
  // The rest of a pool whose step came back: any one of them can decide it.
  const told = new Set(toReset.map(s => s.approverId).filter(Boolean))
  for (const step of recreated.filter(r => r.approverRoleId)) {
    for (const userId of await deciderIdsOf(step, prisma)) {
      if (told.has(userId)) continue
      told.add(userId)
      queueNotification({
        orgId: a.orgId, userId, type: 'APPROVAL_REQUEST', title: 'Approval needed again',
        body: `${label} — "${contract.title}" needs approval again. Any one of your role can decide.`,
        resourceType: 'contract', resourceId: a.contractId,
      })
    }
  }
  return out
}
