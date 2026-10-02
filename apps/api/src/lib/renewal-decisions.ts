/**
 * docs/41 Part 14 — a renewal decision, and the action it starts.
 *
 *   | Decision    | What happens                                                    |
 *   |-------------|-----------------------------------------------------------------|
 *   | renew       | Active · Renewing (not Expiring), and then:                     |
 *   |             | Renews on its own: recorded, and on the calendar feed; nothing  |
 *   |             | drafted. Otherwise: a renewal letter extending the term, from   |
 *   |             | the org's "Renewal letter" template, as a renewal child.        |
 *   | renegotiate | A renewal draft from the agreement's effective text (its words  |
 *   |             | as signed amendments left them), linked as a renewal; its first |
 *   |             | version is reviewed against the agreement (review-findings      |
 *   |             | parentBaseline). No clauses read yet: the type's template.      |
 *   | let_lapse / | A notice of non-renewal from the org's template. The contract   |
 *   | terminate   | shows as Expiring; once the notice is marked sent, the date job |
 *   |             | closes it at its end date as Expired or Terminated instead of   |
 *   |             | letting it renew (lifecycle-dates.ts).                          |
 *
 * The decision is a RenewalDecision row: who, why, when against the notice
 * deadline, and the contract it drafted. A new decision supersedes the last
 * (it stays on the record). Children are made through child-contract.ts, so
 * each starts on the record and is reviewed like any draft.
 */
import {
  addDuration, renewalDecisionEffect, renewalDecisionOf, familyLabel, RENEWAL_DECISIONS, RENEWAL_DECISION_LABEL,
  type RenewalDecisionKind, type RenewalType,
} from '@clm/types'
import { orgDateOrder } from './org-date-order.js'
import { prisma } from './prisma.js'
import { generateDocument, type TemplateWithSections } from './template-engine.js'
import { UNIVERSAL_TEMPLATES } from './org-seed/universal/templates.js'
import { effectiveView, nextFamilyNumber } from './family.js'
import { createChildContract } from './child-contract.js'
import { syncRenewalTerms } from './renewal-terms.js'
import { transition } from './lifecycle.js'
import { createAuditEvent } from './audit.js'
import { AuditAction } from '@clm/types'

/** The template types a decision drafts from (the org seed's "Renewal letter" and "Notice of non-renewal"). */
export const RENEWAL_LETTER_TYPE = 'RENEWAL_LETTER'
export const NON_RENEWAL_NOTICE_TYPE = 'NON_RENEWAL_NOTICE'
const BUILT_IN: Record<string, string> = { [RENEWAL_LETTER_TYPE]: 'Renewal letter', [NON_RENEWAL_NOTICE_TYPE]: 'Notice of non-renewal' }

const day = (d: Date | null | undefined) => d ? d.toISOString().slice(0, 10) : null
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The org's published template of a type, the default first; an org seeded
 * before these templates existed gets the seed's own words, so the action
 * never fails for want of a template.
 */
async function letterTemplate(orgId: string, contractType: string): Promise<{ template: TemplateWithSections; id: string | null }> {
  const t = await prisma.template.findFirst({
    where: { orgId, deletedAt: null, isPublished: true, contractType },
    orderBy: [{ isDefaultForType: 'desc' }, { updatedAt: 'desc' }],
    include: { sections: true },
  })
  if (t) return { template: t, id: t.id }
  const seed = UNIVERSAL_TEMPLATES.find(x => x.name === BUILT_IN[contractType])!
  const template = {
    id: `builtin:${contractType}`, orgId, name: seed.name, description: seed.description, contractType: seed.contractType,
    variables: seed.variables, isPublished: true,
    sections: seed.sections.map((s, i) => ({ id: `builtin-${i}`, templateId: `builtin:${contractType}`, title: s.title, sortOrder: s.sortOrder, content: s.content, conditionalLogic: null, clauseRefs: [], slotFamilyId: null })),
  }
  return { template: template as unknown as TemplateWithSections, id: null }
}

/** The contract as a decision reads it. */
const CONTRACT_SELECT = {
  id: true, orgId: true, title: true, type: true, ownerId: true, stage: true, stageState: true, status: true,
  counterpartyId: true, counterpartyName: true, currency: true, value: true, matterId: true, diligenceRoomId: true,
  effectiveDate: true, expiryDate: true, currentVersionId: true,
  renewalType: true, renewalTermMonths: true, noticeDays: true, noticeDeadline: true, optOutWindowStart: true, priceUpliftCap: true, renewalConfirmed: true,
} as const

type Decided = NonNullable<Awaited<ReturnType<typeof loadContract>>>

async function loadContract(orgId: string, contractId: string, ownerId?: string) {
  return prisma.contract.findFirst({ where: { id: contractId, orgId, deletedAt: null, ...(ownerId ? { ownerId } : {}) }, select: CONTRACT_SELECT })
}

/** The decision standing for a contract: its latest not superseded. */
export async function currentDecision(orgId: string, contractId: string) {
  return prisma.renewalDecision.findFirst({
    where: { orgId, contractId, supersededAt: null },
    orderBy: { createdAt: 'desc' },
  })
}

/** Our side's name, for the letters. */
async function orgName(orgId: string): Promise<string> {
  return (await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }))?.name ?? ''
}

/** The term a renewal adds: the contract's renewal term, else a year. */
const termOf = (c: Decided) => ({ value: c.renewalTermMonths ?? 12, unit: 'months' as const })

async function renewalLetter(c: Decided) {
  const { template, id } = await letterTemplate(c.orgId, RENEWAL_LETTER_TYPE)
  const term = termOf(c)
  const newExpiry = c.expiryDate ? addDuration(c.expiryDate, term) : null
  const { html } = generateDocument({
    template,
    // Dates as the org writes them: the letter said "dated 2025-03-01".
    style: { dateOrder: await orgDateOrder(c.orgId) },
    variables: {
      senderName: await orgName(c.orgId), recipientName: c.counterpartyName ?? '', agreementName: c.title,
      agreementDate: day(c.effectiveDate) ?? '', currentExpiryDate: day(c.expiryDate) ?? '',
      renewalTerm: `${term.value} months`, newExpiryDate: day(newExpiry) ?? '',
    },
  })
  return { html, templateId: id, effectiveDate: c.expiryDate, expiryDate: newExpiry }
}

async function nonRenewalNotice(c: Decided) {
  const { template, id } = await letterTemplate(c.orgId, NON_RENEWAL_NOTICE_TYPE)
  const { html } = generateDocument({
    template,
    style: { dateOrder: await orgDateOrder(c.orgId) },
    variables: {
      senderName: await orgName(c.orgId), recipientName: c.counterpartyName ?? '', agreementName: c.title,
      agreementDate: day(c.effectiveDate) ?? '', currentExpiryDate: day(c.expiryDate) ?? '',
      noticeDays: c.noticeDays != null ? String(c.noticeDays) : '',
    },
  })
  return { html, templateId: id }
}

/**
 * The renegotiation draft's words: the agreement as it stands (its clauses,
 * each as the signed amendments left it; a deleted one left out), else its
 * current version's words, else the type's default template.
 */
async function renegotiationDraft(c: Decided) {
  const view = await effectiveView(c.orgId, c.id)
  const sections = (view?.sections ?? []).filter(s => !s.deleted && s.text.trim())
  if (sections.length) {
    const html = sections.map(s => `<p>${s.sectionRef ? `${escapeHtml(s.sectionRef)}. ` : ''}${escapeHtml(s.text)}</p>`).join('\n')
    return { html: `<div class="contract-document">\n${html}\n</div>`, baselineVersionId: c.currentVersionId, source: 'effective' as const }
  }
  const current = c.currentVersionId
    ? await prisma.contractVersion.findUnique({ where: { id: c.currentVersionId }, select: { htmlContent: true, plainText: true } })
    : null
  if (current?.htmlContent?.trim() || current?.plainText?.trim()) {
    const html = current.htmlContent?.trim() || current.plainText!.split(/\n{2,}/).map(p => `<p>${escapeHtml(p)}</p>`).join('\n')
    return { html, baselineVersionId: c.currentVersionId, source: 'current' as const }
  }
  const t = await prisma.template.findFirst({
    where: { orgId: c.orgId, deletedAt: null, isPublished: true, contractType: c.type },
    orderBy: [{ isDefaultForType: 'desc' }, { updatedAt: 'desc' }],
    include: { sections: true },
  })
  if (t) return { html: generateDocument({ template: t, variables: {} }).html, baselineVersionId: null, source: 'template' as const, templateId: t.id }
  return { html: '<p></p>', baselineVersionId: null, source: 'empty' as const }
}

export interface DecideInput {
  orgId: string
  contractId: string
  /** Who decided (audit, the row). */
  userId: string
  /** Who owns what it drafts (the acting user). */
  ownerId: string
  decision: unknown
  reason?: string | null
  /** An own-scope caller decides only for contracts they own. */
  ownOnly?: boolean
  ipAddress?: string
  log?: { warn: (o: unknown, msg: string) => void }
  now?: Date
}

export type DecideResult =
  | { ok: true; unchanged: boolean; decision: Awaited<ReturnType<typeof currentDecision>> & {}; actionContract: { id: string; title: string; status: string } | null }
  | { ok: false; status: 400 | 404 | 409; detail: string }

/** Record a renewal decision and start what it does. See the module comment. */
export async function decideRenewal(a: DecideInput): Promise<DecideResult> {
  const kind = renewalDecisionOf(a.decision)
  if (!kind) return { ok: false, status: 400, detail: `The decision must be one of ${RENEWAL_DECISIONS.join(', ')}.` }
  const scope = a.ownOnly ? a.userId : undefined
  if (!await loadContract(a.orgId, a.contractId, scope)) return { ok: false, status: 404, detail: 'Contract not found' }
  // The deadline as the contract's values stand now.
  await syncRenewalTerms(a.orgId, a.contractId)
  const c = (await loadContract(a.orgId, a.contractId, scope))!
  if (c.stage !== 'active') {
    return { ok: false, status: 409, detail: 'Only a signed contract that is still running can be renewed or ended. Make a new contract instead.' }
  }
  // The same decision twice (a double click, a second tab) starts nothing new.
  const standing = await currentDecision(a.orgId, c.id)
  if (standing && standing.decision === kind) {
    const action = standing.actionContractId
      ? await prisma.contract.findFirst({ where: { id: standing.actionContractId, orgId: a.orgId, deletedAt: null }, select: { id: true, title: true, status: true } })
      : null
    return { ok: true, unchanged: true, decision: standing, actionContract: action }
  }

  const now = a.now ?? new Date()
  const action = await startAction(kind, c, a)
  const decision = await prisma.$transaction(async tx => {
    await tx.renewalDecision.updateMany({ where: { orgId: a.orgId, contractId: c.id, supersededAt: null }, data: { supersededAt: now } })
    return tx.renewalDecision.create({
      data: {
        orgId: a.orgId, contractId: c.id, decision: kind, decidedById: a.userId, reason: a.reason?.trim() || null,
        actionContractId: action?.id ?? null, noticeDeadline: c.noticeDeadline,
        decidedInTime: c.noticeDeadline ? now.getTime() <= c.noticeDeadline.getTime() : null,
        createdAt: now,
      },
    })
  })
  // Not renewing: it shows as expiring from now (the date job ends it at its end date).
  // Fix-up 18 — renewing (or renegotiating): Active · Renewing, no longer
  // "Expiring soon", and the date job leaves it there until its end date.
  await transition({
    orgId: a.orgId, contractId: c.id, source: 'system', userId: a.userId, onlyFrom: ['active'],
    to: { stage: 'active', state: kind === 'let_lapse' || kind === 'terminate' ? 'expiring' : 'renewing' },
    reason: kind === 'terminate' ? 'we decided to end it' : kind === 'let_lapse' ? 'we decided to let it lapse'
      : kind === 'renew' ? 'we decided to renew it' : 'we decided to renegotiate it',
  })
  await createAuditEvent({
    orgId: a.orgId, userId: a.userId, action: AuditAction.RENEWAL_DECIDED, resourceType: 'contract', resourceId: c.id,
    metadata: {
      decision: kind, label: RENEWAL_DECISION_LABEL[kind], decisionId: decision.id, actionContractId: action?.id ?? null,
      noticeDeadline: day(c.noticeDeadline), decidedInTime: decision.decidedInTime, ...(standing ? { replaces: standing.decision } : {}),
    },
    ipAddress: a.ipAddress,
  })
  return { ok: true, unchanged: false, decision, actionContract: action ? { id: action.id, title: action.title, status: action.status } : null }
}

/** The child a decision drafts, or null when it drafts none (an automatic renewal). */
async function startAction(kind: RenewalDecisionKind, c: Decided, a: DecideInput) {
  const parent = { id: c.id, counterpartyId: c.counterpartyId, counterpartyName: c.counterpartyName, currency: c.currency, diligenceRoomId: c.diligenceRoomId }
  const common = { orgId: a.orgId, userId: a.userId, ownerId: a.ownerId, parent, matterId: c.matterId, source: 'renewal_decision', ipAddress: a.ipAddress, log: a.log }
  if (kind === 'renew') {
    if (c.renewalType === 'auto') return null
    const n = await nextFamilyNumber(a.orgId, c.id, 'renewal')
    const letter = await renewalLetter(c)
    return createChildContract({
      ...common, relationshipType: 'renewal', amendmentNumber: n, type: 'OTHER',
      title: `${familyLabel('renewal', n) ?? 'Renewal'} to ${c.title} (renewal letter)`,
      effectiveDate: letter.effectiveDate, expiryDate: letter.expiryDate,
      metadata: { _renewal: { kind: 'renewal_letter', decision: kind, templateId: letter.templateId, newExpiryDate: day(letter.expiryDate) } },
      html: letter.html, drafted: false, changeNote: 'Renewal letter drafted from the template',
    })
  }
  if (kind === 'renegotiate') {
    const n = await nextFamilyNumber(a.orgId, c.id, 'renewal')
    const draft = await renegotiationDraft(c)
    return createChildContract({
      ...common, relationshipType: 'renewal', amendmentNumber: n, type: c.type,
      title: `${familyLabel('renewal', n) ?? 'Renewal'} of ${c.title}`,
      value: c.value != null ? Number(c.value) : null,
      effectiveDate: c.expiryDate, expiryDate: c.expiryDate ? addDuration(c.expiryDate, termOf(c)) : null,
      metadata: { _renewal: { kind: 'renegotiation', decision: kind, baselineVersionId: draft.baselineVersionId, from: draft.source } },
      html: draft.html, drafted: draft.source !== 'empty', changeNote: 'Renewal draft from the agreement as it stands',
    })
  }
  const notice = await nonRenewalNotice(c)
  return createChildContract({
    ...common, relationshipType: 'other', amendmentNumber: null, type: 'OTHER',
    title: `Notice of non-renewal: ${c.title}`,
    metadata: { _renewal: { kind: 'non_renewal_notice', decision: kind, templateId: notice.templateId } },
    html: notice.html, drafted: false, changeNote: 'Notice of non-renewal drafted from the template',
  })
}

/**
 * The notice of non-renewal went out: when (today unless said), and whether
 * that was by the notice deadline. Only for a standing decision not to renew.
 */
export async function markNoticeSent(a: { orgId: string; contractId: string; userId: string; sentAt?: Date | null; ownOnly?: boolean; ipAddress?: string; now?: Date }) {
  if (!await loadContract(a.orgId, a.contractId, a.ownOnly ? a.userId : undefined)) return { ok: false as const, status: 404 as const, detail: 'Contract not found' }
  const d = await currentDecision(a.orgId, a.contractId)
  if (!d || (d.decision !== 'let_lapse' && d.decision !== 'terminate')) {
    return { ok: false as const, status: 409 as const, detail: 'Only a decision not to renew has a notice to send.' }
  }
  const now = a.now ?? new Date()
  const sentAt = a.sentAt ?? now
  if (sentAt.getTime() > now.getTime() + 86_400_000) return { ok: false as const, status: 400 as const, detail: 'The notice can’t be sent in the future.' }
  const updated = await prisma.renewalDecision.update({
    where: { id: d.id },
    data: { noticeSentAt: sentAt, noticeSentInTime: d.noticeDeadline ? sentAt.getTime() <= d.noticeDeadline.getTime() + 86_399_999 : null },
  })
  await createAuditEvent({
    orgId: a.orgId, userId: a.userId, action: AuditAction.RENEWAL_NOTICE_SENT, resourceType: 'contract', resourceId: a.contractId,
    metadata: { decisionId: d.id, sentAt: day(sentAt), noticeDeadline: day(d.noticeDeadline), inTime: updated.noticeSentInTime },
    ipAddress: a.ipAddress,
  })
  return { ok: true as const, decision: updated }
}

/** How long before the notice deadline the renewal window opens, when the contract sets no earliest notice. */
export const RENEWAL_WINDOW_DAYS = 90

/** Whether a contract is in its renewal window: from its earliest notice (or 90 days before the deadline) until it ends. Pure. */
export function inRenewalWindow(c: { stage: string; expiryDate: Date | null; noticeDeadline: Date | null; optOutWindowStart: Date | null }, now = new Date()): boolean {
  if (c.stage !== 'active' || !c.expiryDate || c.expiryDate.getTime() < now.getTime()) return false
  const anchor = c.noticeDeadline ?? c.expiryDate
  const opens = c.optOutWindowStart ?? new Date(anchor.getTime() - RENEWAL_WINDOW_DAYS * 86_400_000)
  return now.getTime() >= opens.getTime()
}

/** The contract's renewal as its page and the decision dialog show it. */
export async function renewalState(orgId: string, contractId: string, opts: { ownerId?: string; now?: Date } = {}) {
  if (!await loadContract(orgId, contractId, opts.ownerId)) return null
  // A contract whose values predate the columns is caught up on first look (a no-op once in step).
  await syncRenewalTerms(orgId, contractId)
  const c = (await loadContract(orgId, contractId, opts.ownerId))!
  const now = opts.now ?? new Date()
  const decisions = await prisma.renewalDecision.findMany({ where: { orgId, contractId }, orderBy: { createdAt: 'desc' }, take: 20 })
  const standing = decisions.find(d => !d.supersededAt) ?? null
  const [people, action] = await Promise.all([
    prisma.user.findMany({ where: { orgId, id: { in: [...new Set(decisions.map(d => d.decidedById))] } }, select: { id: true, name: true, email: true } }),
    standing?.actionContractId
      ? prisma.contract.findFirst({ where: { id: standing.actionContractId, orgId, deletedAt: null }, select: { id: true, title: true, status: true, stage: true } })
      : Promise.resolve(null),
  ])
  const who = (id: string) => { const u = people.find(p => p.id === id); return u ? u.name || u.email : null }
  const auto = c.renewalType === 'auto'
  return {
    contractId: c.id,
    stage: c.stage,
    expiryDate: day(c.expiryDate),
    terms: {
      renewalType: (c.renewalType as RenewalType | null) ?? null, renewalTermMonths: c.renewalTermMonths, noticeDays: c.noticeDays,
      noticeDeadline: day(c.noticeDeadline), optOutWindowStart: day(c.optOutWindowStart), priceUpliftCap: c.priceUpliftCap, confirmed: c.renewalConfirmed,
    },
    daysToDeadline: c.noticeDeadline ? Math.ceil((c.noticeDeadline.getTime() - now.getTime()) / 86_400_000) : null,
    inWindow: inRenewalWindow(c, now),
    canDecide: c.stage === 'active',
    decision: standing ? {
      id: standing.id, decision: standing.decision, label: RENEWAL_DECISION_LABEL[standing.decision as RenewalDecisionKind] ?? standing.decision,
      reason: standing.reason, decidedBy: who(standing.decidedById), decidedAt: standing.createdAt.toISOString(),
      decidedInTime: standing.decidedInTime, noticeSentAt: day(standing.noticeSentAt), noticeSentInTime: standing.noticeSentInTime,
      actionContract: action,
    } : null,
    choices: RENEWAL_DECISIONS.map(d => ({ decision: d, label: RENEWAL_DECISION_LABEL[d], effect: renewalDecisionEffect(d, auto) })),
    history: decisions.filter(d => d !== standing).map(d => ({ decision: d.decision, decidedBy: who(d.decidedById), decidedAt: d.createdAt.toISOString(), reason: d.reason })),
  }
}

/** The standing decision of each of these contracts, by contract id (for lists). */
export async function standingDecisions(orgId: string, contractIds: string[]) {
  if (!contractIds.length) return new Map<string, { decision: string; createdAt: Date; noticeSentAt: Date | null; actionContractId: string | null }>()
  const rows = await prisma.renewalDecision.findMany({
    where: { orgId, contractId: { in: contractIds }, supersededAt: null },
    orderBy: { createdAt: 'asc' },
    select: { contractId: true, decision: true, createdAt: true, noticeSentAt: true, actionContractId: true },
  })
  return new Map(rows.map(r => [r.contractId, r]))
}
