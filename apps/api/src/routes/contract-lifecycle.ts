/**
 * docs/41 Parts 12, 18 — a contract's stage, its moves, and its history.
 *
 *   GET  /api/v1/contracts/:id/stage     the status banner: stage progress,
 *        state and turn in words, the one next action, approvals x/y,
 *        signatures x/y, why it came back, and the moves a person may make
 *   POST /api/v1/contracts/:id/stage     a move by hand ({ stage, state, reason })
 *   POST /api/v1/contracts/:id/cancel    cancelled, with a reason (before it is signed)
 *   POST /api/v1/contracts/:id/uncancel  an admin brings it back, with a reason
 *   GET  /api/v1/contracts/:id/history   one timeline: stage moves, versions
 *        (with the version to compare against), approvals with reasons,
 *        exceptions, signatures, comments resolved, assistant actions
 *        applied or undone, Salesforce syncs. ?filter=all|negotiation|
 *        approvals|signatures|system
 *
 * The page read the stage from four places (the strip, the Approval tab, the
 * rail, the Activity tab) and each worked it out its own way. These are the
 * one place.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  AuditAction, PROGRESS_STAGES, STAGE_LABEL, STATE_LABEL, TURN_LABEL, CANCELLABLE, stageLine, sinceWords,
  isStage, isStateOf, type Stage, type StageState, type StagePoint,
} from '@clm/types'
import { prisma } from '../lib/prisma.js'
import { requirePermission, permissionScopeFor } from '../middleware/permissions.js'
import { guardOwnScopeContractRoutes } from '../lib/own-scope-guard.js'
import { positionOf, transition } from '../lib/lifecycle.js'
import { manualRefusal, manualSource } from '../lib/contract-status.js'
import { approvalProgress, roleIdsOf, isNegative } from '../lib/workflow-engine.js'
import { openExceptions } from '../lib/approval-flow.js'
import { counterpartySummary } from '../lib/change-advice.js'

interface Move { to: StagePoint; label: string; needsReason: boolean; tone?: 'danger' }

/** The moves offered by hand from a stage, before the rules filter them. */
function candidateMoves(from: StagePoint): Move[] {
  const m = (stage: Stage, state: StageState, label: string, needsReason = false, tone?: 'danger'): Move => ({ to: { stage, state }, label, needsReason, ...(tone && { tone }) })
  switch (from.stage) {
    case 'draft': return [m('negotiate', 'with_counterparty', 'Mark as sent to the counterparty'), m('negotiate', 'with_us', 'Start negotiating')]
    case 'negotiate': return from.state === 'with_counterparty'
      ? [m('negotiate', 'with_us', 'It’s our turn'), m('draft', 'drafting', 'Back to drafting', true)]
      : [m('negotiate', 'with_counterparty', 'Mark as sent to the counterparty'), m('draft', 'drafting', 'Back to drafting', true)]
    case 'approve': return from.state === 'approved' ? [m('active', 'active', 'Mark as signed outside draftLegal')] : []
    case 'active': return [m('closed', 'terminated', 'Terminate', true, 'danger'), m('closed', 'archived', 'Archive')]
    case 'closed': return from.state === 'expired' ? [m('closed', 'archived', 'Archive')] : []
    default: return []
  }
}

const HISTORY_FILTERS = ['all', 'negotiation', 'approvals', 'signatures', 'system'] as const
type HistoryFilter = (typeof HISTORY_FILTERS)[number]
type Group = Exclude<HistoryFilter, 'all'>

export interface HistoryItem {
  id: string
  at: string
  group: Group
  kind: string
  /** "Priya returned it for changes", in plain words. */
  title: string
  detail?: string | null
  actor: { id: string | null; name: string | null } | null
  /** Versions: the version and the one before it, to compare. */
  version?: { id: string; number: number; previousId: string | null; previousNumber: number | null; fromCounterparty: boolean }
  meta?: Record<string, unknown>
}

/** Audit actions the history reads from another source (versions, signatures, comments), or doesn't show. */
const SHOWN_ELSEWHERE = new Set<string>([
  AuditAction.VERSION_CREATED, AuditAction.SIGNATURE_SENT, AuditAction.SIGNATURE_COMPLETED, AuditAction.SIGNATURE_VOIDED,
  AuditAction.COMMENT_RESOLVED, AuditAction.CONTRACT_VIEWED, AuditAction.PORTAL_VIEWED,
])

/** Stored state that isn't a term a person reads ("metadata", "fieldConfidence"): left out of History. */
const UNSHOWN_FIELDS = new Set(['metadata', 'overallConfidence', 'fieldConfidence', 'analysisStatus', 'analysisError', 'currentVersionId', 'updatedAt'])
const FIELD_WORDS: Record<string, string> = { counterpartyName: 'counterparty', keyTerms: 'key terms', riskScore: 'risk score', riskFactors: 'risks', jurisdiction: 'governing law' }
const ACTION_WORDS: Record<string, string> = {
  document_edited: 'edited the document', set_from_template: 'filled in', set_from_highlight: 'filled in from the document',
  set_from_import: 'imported', corrected: 'corrected', verified: 'checked', verified_all: 'checked every field',
}
const fieldWords = (k: string) => FIELD_WORDS[k] ?? k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase()

/**
 * "Legal Counsel changed set_from_template", "Someone changed title, metadata,
 * fieldConfidence…": History showed the stored names. In words now, and a
 * change with no person is the analysis's.
 */
function updatedTitle(who: string | null, m: Record<string, unknown>): string {
  const changes = Array.isArray(m.changes) ? (m.changes as string[]).filter(k => !UNSHOWN_FIELDS.has(k)) : null
  const actor = who ?? (changes ? 'The analysis' : 'Someone')
  if (changes) return changes.length ? `${actor} updated ${changes.map(fieldWords).join(', ')}` : `${actor} updated it`
  const action = typeof m.action === 'string' ? m.action : null
  const field = typeof m.field === 'string' ? m.field : null
  if (action && ACTION_WORDS[action]) return `${actor} ${ACTION_WORDS[action]}${field && action !== 'document_edited' && action !== 'verified_all' ? ` ${fieldWords(field)}` : ''}`
  return `${actor} changed ${action ? action.replace(/_/g, ' ') : 'it'}`
}

/** Pure: an audit event of the contract as a history item, or null when it isn't shown. */
export function historyItemOf(e: { id: string; action: string; createdAt: Date; userId: string | null; metadata: unknown }, name: (id: string | null) => string | null): HistoryItem | null {
  if (SHOWN_ELSEWHERE.has(e.action)) return null
  const m = (e.metadata ?? {}) as Record<string, unknown>
  const who = name(e.userId)
  const actor = e.userId ? { id: e.userId, name: who } : null
  const base = { id: `audit:${e.id}`, at: e.createdAt.toISOString(), actor }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  switch (e.action) {
    case AuditAction.STAGE_CHANGED:
    case AuditAction.CONTRACT_STATUS_CHANGED: {
      const toStage = str(m.toStage)
      const toState = str(m.toState)
      const fromStage = str(m.fromStage)
      const label = toStage && isStage(toStage) && toState && isStateOf(toStage, toState)
        ? `${STAGE_LABEL[toStage]}${STATE_LABEL[toState].toLowerCase() !== STAGE_LABEL[toStage].toLowerCase() ? ` · ${STATE_LABEL[toState]}` : ''}`
        : `${str(m.to) ?? 'a new status'}`.replace(/_/g, ' ').toLowerCase()
      const turnOnly = fromStage === toStage && str(m.fromState) === toState && m.fromTurn !== m.toTurn
      const source = str(m.source)
      const group: Group = source === 'approval' ? 'approvals' : source === 'signature' ? 'signatures'
        : source === 'counterparty' || source === 'send' ? 'negotiation' : source === 'dates' || source === 'system' ? 'system' : 'negotiation'
      return {
        ...base, group, kind: 'stage',
        title: m.created === true ? `Created in ${label}` : turnOnly ? `${TURN_LABEL[(m.toTurn as keyof typeof TURN_LABEL)] ?? 'Turn changed'}` : `Moved to ${label}`,
        detail: str(m.reason),
        meta: { from: m.from, to: m.to, fromStage, toStage, fromState: m.fromState, toState, fromTurn: m.fromTurn, toTurn: m.toTurn, source },
      }
    }
    case AuditAction.APPROVAL_SUBMITTED:
      return { ...base, group: 'approvals', kind: 'approval_submitted', title: m.autoApproved ? 'Approved automatically by your rules' : `${who ?? 'Someone'} submitted it for approval`, detail: str(m.comment), meta: { instanceId: m.instanceId, versionId: m.versionId } }
    case AuditAction.APPROVAL_DECIDED: {
      const d = str(m.decision)
      const verb = d === 'APPROVED' ? 'approved' : d === 'DECLINED' ? 'declined' : d === 'DELEGATED' ? 'delegated' : 'returned it for changes'
      return {
        ...base, group: 'approvals', kind: 'approval_decided',
        title: `${who ?? 'An approver'} ${verb}${str(m.stepName) ? ` (${m.stepName})` : ''}${m.via === 'slack' ? ' via Slack' : m.via === 'agent' ? ' with the assistant' : ''}`,
        detail: str(m.reason) ?? str(m.comment),
        meta: { decision: d, instanceId: m.instanceId, stepId: m.stepId, linkedFindingIds: m.linkedFindingIds, linkedClauseIds: m.linkedClauseIds },
      }
    }
    case AuditAction.APPROVALS_RESET:
      return {
        ...base, group: 'approvals', kind: 'approvals_reset',
        title: m.withdrawn ? 'Request for approval withdrawn' : m.carried ? 'Approvals carried to the new version' : m.exceptionStepId ? 'Exception reset' : 'Approvals asked for again',
        detail: str(m.reason) ?? (str(m.changed) ? `${m.versionNumber != null ? `v${m.versionNumber} changed ` : ''}${m.changed}` : null),
        meta: m,
      }
    case AuditAction.EXCEPTION_REQUESTED:
      return { ...base, group: 'approvals', kind: 'exception_requested', title: `${who ?? 'Someone'} asked for an exception: ${str(m.title) ?? 'a clause'}`, detail: str(m.reason), meta: { stepId: m.stepId, findingId: m.findingId } }
    case AuditAction.EXCEPTION_DECIDED:
      return { ...base, group: 'approvals', kind: 'exception_decided', title: `${who ?? 'An approver'} ${m.decision === 'APPROVED' ? 'approved' : 'declined'} the exception: ${str(m.title) ?? 'a clause'}`, detail: str(m.reason), meta: { stepId: m.stepId, findingId: m.findingId } }
    case AuditAction.APPROVAL_ESCALATED:
      return { ...base, group: 'approvals', kind: 'approval_escalated', title: 'Approval overdue — escalated', meta: m }
    case AuditAction.CLAUSE_REVIEWED:
      return { ...base, group: 'negotiation', kind: 'clause_reviewed', title: `${who ?? 'Someone'} marked ${str(m.clauseType)?.replace(/_/g, ' ') ?? 'a clause'} ${m.state === 'rejected' ? 'not acceptable' : m.state === 'unreviewed' ? 'as not reviewed' : 'as reviewed'}`, meta: m }
    case AuditAction.REVIEW_FINDING_DECIDED:
      return { ...base, group: 'negotiation', kind: 'finding_decided', title: `${who ?? 'Someone'} ${m.decision === 'reopened' ? 'reopened' : m.decision === 'standard_inserted' ? 'inserted your standard language for' : `marked ${m.decision ?? 'decided'}`}: ${str(m.title) ?? 'a finding'}`, detail: str(m.note), meta: m }
    case AuditAction.LINK_SHARED:
      return { ...base, group: 'negotiation', kind: 'shared', title: m.emailedTo ? `Sent to ${m.emailedTo}` : `${who ?? 'Someone'} made a link for the counterparty`, meta: m }
    case AuditAction.REDLINE_EXPORTED:
      return { ...base, group: 'negotiation', kind: 'redline_exported', title: `${who ?? 'Someone'} downloaded a redline for the counterparty`, meta: m }
    case AuditAction.AGENT_ACTION:
      return { ...base, group: 'system', kind: 'agent', title: `Assistant: ${str(m.tool) ?? str(m.action) ?? 'an action'}`, meta: m }
    case AuditAction.CONTRACT_CREATED:
      return { ...base, group: 'system', kind: 'created', title: `${who ?? 'Someone'} created it`, meta: m }
    case AuditAction.CONTRACT_UPDATED:
      return { ...base, group: 'system', kind: 'updated', title: updatedTitle(who, m), meta: m }
    default:
      return { ...base, group: 'system', kind: e.action.toLowerCase(), title: e.action.replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase()), meta: m }
  }
}

export async function contractLifecycleRoutes(app: FastifyInstance) {
  guardOwnScopeContractRoutes(app)

  async function contractOf(orgId: string, id: string) {
    return prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      select: {
        id: true, orgId: true, title: true, status: true, stage: true, stageState: true, turn: true, turnSince: true, turnOwnerId: true,
        ownerId: true, currentVersionId: true, counterpartyName: true,
      },
    })
  }

  // ── The banner ────────────────────────────────────────────────────────────
  app.get('/:id/stage', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const c = await contractOf(orgId, id)
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    const p = positionOf(c)
    const from: StagePoint = { stage: p.stage, state: p.stageState }

    const [instance, signature, exceptions, people, history, versions, canEdit, canSign, canApprove] = await Promise.all([
      prisma.approvalInstance.findFirst({
        where: { orgId, contractId: id }, orderBy: { submittedAt: 'desc' },
        include: { steps: { where: { kind: 'approval' } }, definition: { select: { steps: true } } },
      }),
      prisma.signatureRequest.findFirst({ where: { orgId, contractId: id }, orderBy: { createdAt: 'desc' }, include: { signers: { select: { status: true, userId: true, name: true, signOrder: true } } } }),
      openExceptions(orgId, id),
      prisma.user.findMany({ where: { orgId, id: { in: [c.turnOwnerId, c.ownerId].filter((x): x is string => !!x) } }, select: { id: true, name: true, email: true } }),
      // Which stages it has been through (the progress bar's "done").
      prisma.auditEvent.findMany({ where: { orgId, resourceType: 'contract', resourceId: id, action: AuditAction.STAGE_CHANGED }, select: { metadata: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 200 }),
      prisma.contractVersion.findMany({ where: { contractId: id }, orderBy: { versionNumber: 'desc' }, take: 1, select: { id: true, versionNumber: true, createdById: true, createdAt: true } }),
      permissionScopeFor(req, 'edit', 'contract'),
      permissionScopeFor(req, 'sign', 'contract'),
      permissionScopeFor(req, 'approve', 'workflow'),
    ])
    const nameOf = (uid: string | null) => { const u = uid ? people.find(x => x.id === uid) : null; return u ? u.name || u.email : null }
    const isOwner = c.ownerId === userId
    const editable = !!canEdit && (canEdit !== 'own' || isOwner)

    // Progress: done up to the current stage; Request only when it began as one.
    const visited = new Set<string>(history.flatMap(h => [(h.metadata as { fromStage?: string }).fromStage, (h.metadata as { toStage?: string }).toStage]).filter((x): x is string => !!x))
    const current = p.stage === 'closed' ? (visited.has('active') ? 'active' : [...PROGRESS_STAGES].reverse().find(s => visited.has(s)) ?? 'draft') : p.stage
    const idx = PROGRESS_STAGES.indexOf(current as Stage)
    const progress = PROGRESS_STAGES.filter(s => s !== 'request' || visited.has('request') || p.stage === 'request').map(s => ({
      stage: s, label: STAGE_LABEL[s],
      status: PROGRESS_STAGES.indexOf(s) < idx ? (s === 'negotiate' && !visited.has('negotiate') ? 'skipped' : 'done') : PROGRESS_STAGES.indexOf(s) === idx ? (p.stage === 'closed' ? 'done' : 'current') : 'todo',
    }))

    // Approvals and signatures, x of y.
    const openInstance = instance && (instance.status === 'PENDING' || instance.status === 'ESCALATED')
    const approvals = instance && (p.stage === 'approve' || p.stage === 'sign' || instance.status !== 'CANCELLED') ? {
      ...approvalProgress(instance),
      status: instance.status, outcome: instance.outcome,
      instanceId: instance.id,
    } : null
    const signatures = signature ? {
      signed: signature.signers.filter(s => s.status === 'SIGNED').length, total: signature.signers.length, status: signature.status, id: signature.id,
    } : null
    const roles = await roleIdsOf(userId, prisma)
    const myStep = openInstance ? instance!.steps.find(s => s.status === 'PENDING' && s.stepOrder === instance!.currentStepOrder && (s.approverId === userId || (!s.approverId && !!s.approverRoleId && roles.includes(s.approverRoleId)))) : undefined
    const iSign = signature?.status === 'PENDING' && signature.signers.some(s => s.userId === userId && s.status === 'PENDING')

    // Why it came back (a return or a decline), while it stands.
    const back = instance && instance.status === 'REJECTED' && (p.stageState === 'returned' || (p.stage === 'approve' && p.stageState === 'declined'))
      ? instance.steps.find(s => isNegative(s.decision)) : undefined
    const backBy = back?.approverId ? await prisma.user.findFirst({ where: { id: back.approverId, orgId }, select: { name: true, email: true } }) : null
    const returned = back ? {
      outcome: instance!.outcome === 'declined' ? 'declined' : 'returned',
      by: back.approverId ? { id: back.approverId, name: backBy?.name || backBy?.email || 'An approver' } : null,
      reason: back.comment, at: back.decidedAt, instanceId: instance!.id,
      linkedFindingIds: back.linkedFindingIds, linkedClauseIds: back.linkedClauseIds,
    } : null

    // The one next action.
    const latest = versions[0]
    const theirs = !!latest && /^(portal|email):/.test(latest.createdById)
    type Next = { kind: string; label: string; enabled: boolean; why?: string }
    let next: Next | null
    switch (p.stage) {
      case 'request': next = editable ? { kind: 'accept_request', label: 'Accept and draft', enabled: true } : null; break
      case 'draft':
      case 'negotiate':
        if (p.stageState === 'returned') next = { kind: 'resubmit', label: 'Fix and resubmit', enabled: editable }
        else if (p.stage === 'negotiate' && p.stageState === 'with_counterparty') next = null
        else if (p.stage === 'negotiate' && theirs) next = { kind: 'review_changes', label: 'Review changes', enabled: true }
        else next = { kind: 'submit', label: 'Submit for approval', enabled: editable }
        break
      case 'approve':
        if (p.stageState === 'pending') next = myStep ? { kind: 'decide', label: 'Approve or return', enabled: !!canApprove } : null
        else if (p.stageState === 'approved') next = exceptions.length
          ? { kind: 'send_for_signature', label: 'Send for signature', enabled: false, why: `${exceptions.length} exception${exceptions.length === 1 ? '' : 's'} still to decide` }
          : { kind: 'send_for_signature', label: 'Send for signature', enabled: !!canSign }
        else next = { kind: 'declined', label: 'Decide: rework or cancel', enabled: editable }
        break
      case 'sign':
        if (p.stageState === 'out_for_signature') next = iSign ? { kind: 'sign', label: 'Sign', enabled: true } : null
        else next = { kind: 'revert_signature', label: 'Take it back', enabled: !!canSign }
        break
      default: next = null
    }

    // docs/41 Part 15 — what the counterparty's version brought: its changes and what they need.
    const counterparty = theirs && latest ? await counterpartySummary(c.id, latest) : null

    const isAdmin = (req.user.roles ?? []).includes('ADMIN')
    const moves = editable
      ? candidateMoves(from).filter(mv => !manualRefusal(from, mv.to, { reason: mv.needsReason ? 'x' : null }))
      : []
    const canCancel = editable && CANCELLABLE.includes(p.stage)
    const canUndoCancel = isAdmin && p.stage === 'closed' && p.stageState === 'cancelled'

    return reply.send({
      contractId: c.id,
      stage: p.stage, stageState: p.stageState, turn: p.turn, status: c.status,
      stageLabel: STAGE_LABEL[p.stage], stateLabel: STATE_LABEL[p.stageState], turnLabel: TURN_LABEL[p.turn] || null,
      turnSince: c.turnSince, turnSinceWords: sinceWords(c.turnSince),
      turnOwner: p.turn === 'internal' && c.turnOwnerId ? { id: c.turnOwnerId, name: nameOf(c.turnOwnerId), isMe: c.turnOwnerId === userId } : null,
      line: stageLine({ stage: p.stage, stageState: p.stageState, turn: p.turn, turnSince: c.turnSince }),
      progress,
      next,
      approvals: approvals ? { ...approvals, myStepId: myStep?.id ?? null } : null,
      signatures,
      exceptions: { open: exceptions.length },
      returned,
      latestVersion: latest ? { id: latest.id, number: latest.versionNumber, fromCounterparty: theirs, at: latest.createdAt } : null,
      counterparty,
      moves,
      canCancel,
      canUndoCancel,
    })
  })

  // ── A move by hand ────────────────────────────────────────────────────────
  const MoveBody = z.object({ stage: z.string(), state: z.string(), reason: z.string().trim().max(2000).optional() })
  app.post('/:id/stage', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const body = MoveBody.safeParse(req.body ?? {})
    if (!body.success) return reply.status(400).send({ detail: 'Name the stage and state to move to.' })
    const { stage, state, reason } = body.data
    if (!isStage(stage) || !isStateOf(stage, state)) return reply.status(400).send({ detail: `“${stage}/${state}” is not a stage and state a contract can be in.` })
    if (stage === 'closed' && state === 'cancelled') return reply.status(400).send({ detail: 'Cancel a contract with POST /contracts/:id/cancel.' })
    const c = await contractOf(orgId, id)
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    const p = positionOf(c)
    const from: StagePoint = { stage: p.stage, state: p.stageState }
    const to: StagePoint = { stage, state }
    const refusal = manualRefusal(from, to, { reason })
    if (refusal) return reply.status(409).send({ detail: refusal })
    const moved = await transition({ orgId, contractId: id, to: { stage, state }, source: manualSource(from, to), userId, reason, versionId: c.currentVersionId })
    if (!moved.ok) return reply.status(moved.status).send({ detail: moved.refusal })
    return reply.send({ ok: true, changed: moved.changed, stage: moved.to.stage, stageState: moved.to.stageState, turn: moved.to.turn, status: moved.to.status })
  })

  // ── Cancel, and bring back ────────────────────────────────────────────────
  const ReasonBody = z.object({ reason: z.string().trim().min(3).max(2000) })
  app.post('/:id/cancel', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const body = ReasonBody.safeParse(req.body ?? {})
    if (!body.success) return reply.status(400).send({ detail: 'Say why the contract is cancelled (at least 3 characters).' })
    const c = await contractOf(orgId, id)
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    const envelope = await prisma.signatureRequest.count({ where: { orgId, contractId: id, status: 'PENDING' } })
    if (envelope) return reply.status(409).send({ code: 'SIGNATURE_PENDING', detail: 'Its signature request is still open. Void it first, then cancel the contract.' })
    const moved = await transition({ orgId, contractId: id, to: { stage: 'closed', state: 'cancelled' }, source: 'cancel', userId, reason: body.data.reason, versionId: c.currentVersionId })
    if (!moved.ok) return reply.status(moved.status).send({ detail: moved.refusal })
    // A request for approval in flight goes with it.
    const open = await prisma.approvalInstance.findMany({ where: { orgId, contractId: id, status: { in: ['PENDING', 'ESCALATED'] } }, select: { id: true } })
    if (open.length) {
      await prisma.approvalInstance.updateMany({ where: { id: { in: open.map(o => o.id) } }, data: { status: 'CANCELLED', outcome: 'cancelled', decidedAt: new Date() } })
      await prisma.approvalStep.updateMany({ where: { approvalInstanceId: { in: open.map(o => o.id) }, status: 'PENDING' }, data: { status: 'SKIPPED', decidedAt: new Date() } })
    }
    await prisma.approvalStep.updateMany({ where: { orgId, contractId: id, kind: 'clause_exception', status: 'PENDING' }, data: { status: 'SKIPPED', decidedAt: new Date() } })
    return reply.send({ ok: true, stage: moved.to.stage, stageState: moved.to.stageState, status: moved.to.status })
  })

  app.post('/:id/uncancel', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    if (!(req.user.roles ?? []).includes('ADMIN')) return reply.status(403).send({ detail: 'Only an admin can bring a cancelled contract back.' })
    const body = ReasonBody.safeParse(req.body ?? {})
    if (!body.success) return reply.status(400).send({ detail: 'Say why the contract is brought back (at least 3 characters).' })
    const c = await contractOf(orgId, id)
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    if (c.stage !== 'closed' || c.stageState !== 'cancelled') return reply.status(409).send({ detail: 'This contract is not cancelled.' })
    // Back where it was cancelled from; an approval or a signature in flight
    // was stopped, so those come back as the stage they were worked in.
    const cancelled = await prisma.auditEvent.findFirst({
      where: { orgId, resourceType: 'contract', resourceId: id, action: AuditAction.STAGE_CHANGED },
      orderBy: { createdAt: 'desc' }, select: { metadata: true },
    })
    const m = (cancelled?.metadata ?? {}) as { fromStage?: string; fromState?: string; toState?: string }
    let to: StagePoint = { stage: 'draft', state: 'drafting' }
    if (m.toState === 'cancelled' && m.fromStage && isStage(m.fromStage) && m.fromState && isStateOf(m.fromStage, m.fromState)) to = { stage: m.fromStage, state: m.fromState }
    if (to.stage === 'approve' && to.state === 'pending') to = { stage: 'draft', state: 'drafting' }
    if (to.stage === 'sign') to = { stage: 'approve', state: 'approved' }
    const moved = await transition({ orgId, contractId: id, to: { stage: to.stage, state: to.state }, source: 'undo_cancel', isAdmin: true, userId, reason: body.data.reason, versionId: c.currentVersionId })
    if (!moved.ok) return reply.status(moved.status).send({ detail: moved.refusal })
    return reply.send({ ok: true, stage: moved.to.stage, stageState: moved.to.stageState, status: moved.to.status })
  })

  // ── History ───────────────────────────────────────────────────────────────
  app.get('/:id/history', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const q = req.query as { filter?: string }
    const filter: HistoryFilter = (HISTORY_FILTERS as readonly string[]).includes(q.filter ?? '') ? q.filter as HistoryFilter : 'all'
    const c = await contractOf(orgId, id)
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })

    const instances = await prisma.approvalInstance.findMany({ where: { orgId, contractId: id }, select: { id: true, steps: { select: { id: true } } } })
    const instanceIds = instances.map(i => i.id)
    const stepIds = instances.flatMap(i => i.steps.map(s => s.id))
    const [events, approvalEvents, versions, signatureEvents, comments, toolCalls, syncs] = await Promise.all([
      prisma.auditEvent.findMany({ where: { orgId, resourceType: 'contract', resourceId: id }, orderBy: { createdAt: 'desc' }, take: 500 }),
      // Approval resources: only what the contract's own events don't say
      // (a delegation, an escalation); each decision is on the contract.
      prisma.auditEvent.findMany({
        where: {
          orgId,
          OR: [
            { resourceType: 'approval_instance', resourceId: { in: instanceIds }, action: AuditAction.APPROVAL_ESCALATED },
            { resourceType: 'approval_step', resourceId: { in: stepIds }, action: AuditAction.APPROVAL_DECIDED },
          ],
        },
        orderBy: { createdAt: 'desc' }, take: 200,
      }),
      prisma.contractVersion.findMany({ where: { contractId: id }, orderBy: { versionNumber: 'asc' }, select: { id: true, versionNumber: true, createdById: true, createdAt: true, changeNote: true } }),
      prisma.signatureEvent.findMany({
        where: { signatureRequest: { is: { orgId, contractId: id } } }, orderBy: { createdAt: 'desc' }, take: 200,
        include: { signatureRequest: { select: { id: true, signers: { select: { id: true, name: true, email: true } } } } },
      }),
      prisma.contractComment.findMany({ where: { orgId, contractId: id, resolved: true, resolvedAt: { not: null }, deletedAt: null }, select: { id: true, body: true, resolvedAt: true, resolvedById: true } }),
      prisma.toolCall.findMany({
        where: { entityType: 'contract', entityId: id, status: 'success', reversible: true, thread: { is: { orgId } } },
        select: { id: true, toolName: true, createdAt: true, rolledBackAt: true, rolledBackById: true, thread: { select: { userId: true } } },
        orderBy: { createdAt: 'desc' }, take: 100,
      }),
      prisma.integrationSyncLog.findMany({ where: { orgId, contractId: id, status: { in: ['success', 'failed', 'conflict'] } }, orderBy: { at: 'desc' }, take: 50, select: { id: true, provider: true, direction: true, status: true, error: true, at: true, event: true } }),
    ])

    const userIds = new Set<string>()
    for (const e of [...events, ...approvalEvents]) if (e.userId) userIds.add(e.userId)
    for (const v of versions) if (!/^(portal|email):/.test(v.createdById)) userIds.add(v.createdById)
    for (const cm of comments) if (cm.resolvedById) userIds.add(cm.resolvedById)
    for (const t of toolCalls) { userIds.add(t.thread.userId); if (t.rolledBackById) userIds.add(t.rolledBackById) }
    const users = await prisma.user.findMany({ where: { id: { in: [...userIds] }, orgId }, select: { id: true, name: true, email: true } })
    const name = (uid: string | null) => { const u = uid ? users.find(x => x.id === uid) : null; return u ? u.name || u.email : null }

    const items: HistoryItem[] = []
    for (const e of events) { const it = historyItemOf(e, name); if (it) items.push(it) }
    for (const e of approvalEvents) {
      const m = (e.metadata ?? {}) as Record<string, unknown>
      if (e.action === AuditAction.APPROVAL_DECIDED && m.decision !== 'DELEGATED') continue
      const it = e.action === AuditAction.APPROVAL_DECIDED
        ? { id: `audit:${e.id}`, at: e.createdAt.toISOString(), group: 'approvals' as const, kind: 'approval_delegated', title: `${name(e.userId) ?? 'An approver'} delegated their approval to ${name(typeof m.delegateTo === 'string' ? m.delegateTo : null) ?? 'someone'}`, actor: e.userId ? { id: e.userId, name: name(e.userId) } : null }
        : historyItemOf(e, name)
      if (it) items.push(it)
    }
    versions.forEach((v, i) => {
      const prev = i > 0 ? versions[i - 1] : null
      const fromCounterparty = /^(portal|email):/.test(v.createdById)
      items.push({
        id: `version:${v.id}`, at: v.createdAt.toISOString(), group: 'negotiation', kind: 'version',
        title: fromCounterparty ? `The counterparty sent v${v.versionNumber}` : `${name(v.createdById) ?? 'Someone'} saved v${v.versionNumber}`,
        detail: v.changeNote, actor: fromCounterparty ? { id: null, name: c.counterpartyName ?? 'Counterparty' } : { id: v.createdById, name: name(v.createdById) },
        version: { id: v.id, number: v.versionNumber, previousId: prev?.id ?? null, previousNumber: prev?.versionNumber ?? null, fromCounterparty },
      })
    })
    for (const s of signatureEvents) {
      if (s.kind === 'VIEWED') continue
      const signer = s.signatureRequest.signers.find(x => x.id === s.signerId)
      const who = signer?.name ?? signer?.email ?? null
      const title = s.kind === 'SENT' ? 'Sent for signature'
        : s.kind === 'SIGNED' ? `${who ?? 'A signer'} signed`
        : s.kind === 'DECLINED' ? `${who ?? 'A signer'} declined to sign`
        : s.kind === 'VOIDED' ? 'Signature request voided'
        : s.kind === 'COMPLETED' ? 'Everyone signed'
        : s.kind === 'REMINDED' ? 'Signers reminded'
        : s.kind.toLowerCase()
      const m = (s.metadata ?? {}) as Record<string, unknown>
      items.push({ id: `signature:${s.id}`, at: s.createdAt.toISOString(), group: 'signatures', kind: `signature_${s.kind.toLowerCase()}`, title, detail: typeof m.reason === 'string' ? m.reason : null, actor: who ? { id: null, name: who } : null, meta: { signatureRequestId: s.signatureRequest.id } })
    }
    for (const cm of comments) {
      items.push({ id: `comment:${cm.id}`, at: cm.resolvedAt!.toISOString(), group: 'negotiation', kind: 'comment_resolved', title: `${name(cm.resolvedById) ?? 'Someone'} resolved a comment`, detail: cm.body.slice(0, 200), actor: { id: cm.resolvedById, name: name(cm.resolvedById) } })
    }
    for (const t of toolCalls) {
      const tool = t.toolName.replace(/_/g, ' ')
      items.push({ id: `tool:${t.id}`, at: t.createdAt.toISOString(), group: 'system', kind: 'ai_applied', title: `The assistant applied “${tool}” for ${name(t.thread.userId) ?? 'someone'}`, actor: { id: t.thread.userId, name: name(t.thread.userId) } })
      if (t.rolledBackAt) items.push({ id: `tool-undo:${t.id}`, at: t.rolledBackAt.toISOString(), group: 'system', kind: 'ai_undone', title: `${name(t.rolledBackById) ?? 'Someone'} undid the assistant’s “${tool}”`, actor: { id: t.rolledBackById, name: name(t.rolledBackById) } })
    }
    for (const s of syncs) {
      items.push({ id: `sync:${s.id}`, at: s.at.toISOString(), group: 'system', kind: 'sync', title: `${s.provider === 'salesforce' ? 'Salesforce' : s.provider} ${s.direction === 'inbound' ? 'update received' : 'updated'}${s.status === 'success' ? '' : ` — ${s.status}`}`, detail: s.error, actor: null })
    }

    items.sort((a, b) => b.at.localeCompare(a.at))
    const counts: Record<HistoryFilter, number> = { all: items.length, negotiation: 0, approvals: 0, signatures: 0, system: 0 }
    for (const it of items) counts[it.group]++
    const data = filter === 'all' ? items : items.filter(i => i.group === filter)
    return reply.send({ data, total: data.length, counts, filter })
  })
}
