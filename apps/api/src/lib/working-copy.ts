/**
 * docs/41 Part 16 (C1) — the working copy: what someone has typed in the
 * editor since the last version.
 *
 * The editor used to save a new version five seconds after every pause in
 * typing ("Edited in browser"). Each one ran the clause carry, pushed back the
 * analysis checkpoint and was judged by the approval reset rules, so the
 * history filled with versions nobody meant, and "what changed in v6" said
 * nothing. Now typing autosaves here, and a version is made only when it means
 * something:
 *   - Save as version, with a note (POST /versions/from-working-copy);
 *   - submitting for approval, or sending to the counterparty, with draft
 *     changes still unsaved (they are what is being submitted or sent);
 *   - an idle checkpoint, when nobody has touched the draft changes for a
 *     while (default 30 minutes), so they are never stranded.
 *
 * Two editors: every save names the revision it was made on. A save on an
 * older revision is refused (409) with who saved last and when, and the
 * editor offers to load theirs or overwrite them.
 *
 * Not a Y.Doc. The Hocuspocus server (collab-server.ts) and CollabState exist,
 * but no editor is bound to them; wiring live co-editing would change how
 * every save, undo and variable command in the page works, and its state
 * would still need turning into a version at the same moments. One row per
 * contract, saved whole, is all C1 needs and can't corrupt a document.
 */
import { AuditAction } from '@clm/types'
import { prisma } from './prisma.js'
import { createAuditEvent } from './audit.js'
import { createHtmlVersion, sameDocumentHtml, type CreateHtmlVersionResult } from './version-create.js'
import type { ApprovalOverride } from './approval-reset.js'

/** The shortest version note accepted: "ok" says nothing. */
export const MIN_NOTE_LENGTH = 3

export const AUTO_NOTES = {
  submit: 'Saved before submitting for approval',
  send: 'Saved before sending to the counterparty',
  idle: 'Auto-saved after inactivity',
} as const

/** Why a version note is refused, or null. */
export function noteRefusal(note: unknown): string | null {
  if (typeof note !== 'string' || note.trim().length < MIN_NOTE_LENGTH) {
    return `Say what changed in this version (at least ${MIN_NOTE_LENGTH} characters).`
  }
  if (note.length > 2000) return 'Keep the note under 2,000 characters.'
  return null
}

/**
 * Whether a save made on `sent` would overwrite someone else's: the copy
 * moved on (another save), or is gone (saved as a version or discarded)
 * while the editor still held one.
 */
export function revisionConflict(current: { revision: number } | null, sent: number | null | undefined): boolean {
  const s = typeof sent === 'number' && Number.isFinite(sent) ? sent : 0
  return current ? current.revision !== s : s !== 0
}

/**
 * Minutes of inactivity before draft changes become a version on their own:
 * the org's `settings.workingCopyIdleMinutes`, else WORKING_COPY_IDLE_MINUTES,
 * else 30. 0 turns it off.
 */
export function idleMinutes(orgSettings: unknown, env: Record<string, string | undefined> = process.env): number {
  const read = (v: unknown): number | null => {
    if (v === undefined || v === null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  return read((orgSettings as Record<string, unknown> | null)?.workingCopyIdleMinutes) ?? read(env.WORKING_COPY_IDLE_MINUTES) ?? 30
}

export interface WorkingCopyView {
  contractId: string
  baseVersionId: string | null
  baseVersionNumber: number | null
  html: string
  revision: number
  updatedAt: Date
  updatedBy: { id: string; name: string | null }
  /** A version was made since these changes were started on another one. */
  stale: boolean
}

async function viewOf(orgId: string, row: { contractId: string; baseVersionId: string | null; html: string; revision: number; updatedAt: Date; updatedById: string }): Promise<WorkingCopyView> {
  const [user, contract, base] = await Promise.all([
    prisma.user.findFirst({ where: { id: row.updatedById, orgId }, select: { id: true, name: true } }),
    prisma.contract.findFirst({ where: { id: row.contractId, orgId }, select: { currentVersionId: true } }),
    row.baseVersionId ? prisma.contractVersion.findFirst({ where: { id: row.baseVersionId, contractId: row.contractId }, select: { versionNumber: true } }) : null,
  ])
  return {
    contractId: row.contractId,
    baseVersionId: row.baseVersionId,
    baseVersionNumber: base?.versionNumber ?? null,
    html: row.html,
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedBy: { id: row.updatedById, name: user?.name ?? null },
    stale: !!row.baseVersionId && !!contract?.currentVersionId && contract.currentVersionId !== row.baseVersionId,
  }
}

export async function getWorkingCopy(orgId: string, contractId: string): Promise<WorkingCopyView | null> {
  const row = await prisma.contractWorkingCopy.findFirst({ where: { orgId, contractId } })
  return row ? viewOf(orgId, row) : null
}

export type SaveResult =
  | { ok: true; copy: WorkingCopyView }
  | { ok: false; status: 404 | 409 | 400; body: Record<string, unknown> }

function conflictBody(current: WorkingCopyView | null): Record<string, unknown> {
  const who = current?.updatedBy.name ?? 'Someone'
  return {
    code: 'WORKING_COPY_CONFLICT',
    detail: current
      ? `${who} saved changes to this draft since you loaded it.`
      : 'These draft changes were saved as a version or discarded since you loaded them.',
    current: current && { revision: current.revision, updatedAt: current.updatedAt, updatedBy: current.updatedBy, baseVersionId: current.baseVersionId },
  }
}

/**
 * Autosave the editor's HTML. `revision` is the one the editor last had (0
 * when it had none). The write is a compare-and-set on it, so two saves on
 * the same revision can't both land.
 */
export async function saveWorkingCopy(a: { orgId: string; contractId: string; userId: string; html: string; revision?: number | null; baseVersionId?: string | null }): Promise<SaveResult> {
  if (typeof a.html !== 'string' || !a.html.trim()) return { ok: false, status: 400, body: { detail: 'html is required' } }
  const contract = await prisma.contract.findFirst({ where: { id: a.contractId, orgId: a.orgId, deletedAt: null }, select: { id: true, currentVersionId: true, org: { select: { settings: true } } } })
  if (!contract) return { ok: false, status: 404, body: { detail: 'Contract not found' } }
  const sent = typeof a.revision === 'number' ? a.revision : 0
  const current = await prisma.contractWorkingCopy.findFirst({ where: { orgId: a.orgId, contractId: a.contractId } })
  if (revisionConflict(current, sent)) {
    return { ok: false, status: 409, body: conflictBody(current ? await viewOf(a.orgId, current) : null) }
  }

  let row
  if (!current) {
    // The version the editor opened, when it says (and it is this contract's); else the one it stands on.
    const base = a.baseVersionId
      ? await prisma.contractVersion.findFirst({ where: { id: a.baseVersionId, contractId: a.contractId }, select: { id: true } })
      : null
    try {
      row = await prisma.contractWorkingCopy.create({
        data: { orgId: a.orgId, contractId: a.contractId, baseVersionId: base?.id ?? contract.currentVersionId, html: a.html, revision: 1, updatedById: a.userId },
      })
    } catch (err) {
      // Someone else's first save landed between the read and this one.
      if ((err as { code?: string }).code !== 'P2002') throw err
      const theirs = await prisma.contractWorkingCopy.findFirst({ where: { orgId: a.orgId, contractId: a.contractId } })
      return { ok: false, status: 409, body: conflictBody(theirs ? await viewOf(a.orgId, theirs) : null) }
    }
  } else {
    const done = await prisma.contractWorkingCopy.updateMany({
      where: { orgId: a.orgId, contractId: a.contractId, revision: sent },
      data: { html: a.html, revision: sent + 1, updatedById: a.userId },
    })
    if (!done.count) {
      const theirs = await prisma.contractWorkingCopy.findFirst({ where: { orgId: a.orgId, contractId: a.contractId } })
      return { ok: false, status: 409, body: conflictBody(theirs ? await viewOf(a.orgId, theirs) : null) }
    }
    row = (await prisma.contractWorkingCopy.findFirst({ where: { orgId: a.orgId, contractId: a.contractId } }))!
  }
  await scheduleIdleCheckpoint({ orgId: a.orgId, contractId: a.contractId, revision: row.revision, minutes: idleMinutes(contract.org?.settings) })
    .catch(err => console.warn('[working-copy] idle checkpoint not scheduled contractId=%s: %s', a.contractId, (err as Error).message))
  return { ok: true, copy: await viewOf(a.orgId, row) }
}

/** Throw the draft changes away. Returns whether there were any. */
export async function discardWorkingCopy(a: { orgId: string; contractId: string; userId: string }): Promise<boolean> {
  const gone = await prisma.contractWorkingCopy.deleteMany({ where: { orgId: a.orgId, contractId: a.contractId } })
  await cancelIdleCheckpoint(a.contractId).catch(() => {})
  if (gone.count) {
    await createAuditEvent({
      orgId: a.orgId, userId: a.userId, action: AuditAction.CONTRACT_UPDATED, resourceType: 'contract', resourceId: a.contractId,
      metadata: { action: 'draft_changes_discarded' },
    }).catch(() => {})
  }
  return gone.count > 0
}

export type FromCopyResult =
  | { ok: true; created: boolean; version: { id: string; versionNumber: number; [k: string]: unknown } }
  | { ok: false; status: 400 | 404 | 409; body: Record<string, unknown> }

/**
 * Make a version of the working copy, through the same path as every other
 * edit (lib/version-create.ts), and clear it.
 *
 * When a version was made since the changes were started (an applied
 * redline, the counterparty's upload, another editor's save), saving them
 * as they are would quietly undo that version's changes: refused with
 * BASE_CHANGED, unless the person says to save over it.
 */
export async function versionFromWorkingCopy(a: {
  orgId: string; contractId: string; userId: string; note: string
  approvals?: ApprovalOverride; via: 'working_copy' | 'submit' | 'send' | 'idle'
  overwriteNewer?: boolean; ipAddress?: string
  /** Only this revision (the idle checkpoint's): a newer save waits for its own. */
  onlyRevision?: number
  log?: Parameters<typeof createHtmlVersion>[0]['log']
}): Promise<FromCopyResult> {
  const copy = await prisma.contractWorkingCopy.findFirst({ where: { orgId: a.orgId, contractId: a.contractId } })
  if (!copy) return { ok: false, status: 409, body: { code: 'NO_WORKING_COPY', detail: 'There are no draft changes to save.' } }
  if (a.onlyRevision !== undefined && copy.revision !== a.onlyRevision) {
    return { ok: false, status: 409, body: { code: 'WORKING_COPY_CONFLICT', detail: 'The draft changes were saved again since.' } }
  }
  const contract = await prisma.contract.findFirst({ where: { id: a.contractId, orgId: a.orgId, deletedAt: null }, select: { currentVersionId: true } })
  if (!contract) return { ok: false, status: 404, body: { detail: 'Contract not found' } }
  if (copy.baseVersionId && contract.currentVersionId && contract.currentVersionId !== copy.baseVersionId && !a.overwriteNewer) {
    const [base, newer] = await Promise.all([
      prisma.contractVersion.findFirst({ where: { id: copy.baseVersionId, contractId: a.contractId }, select: { versionNumber: true } }),
      prisma.contractVersion.findFirst({ where: { id: contract.currentVersionId, contractId: a.contractId }, select: { versionNumber: true, createdById: true, changeNote: true } }),
    ])
    const by = newer?.createdById ? await prisma.user.findFirst({ where: { id: newer.createdById, orgId: a.orgId }, select: { name: true } }) : null
    return {
      ok: false, status: 409, body: {
        code: 'BASE_CHANGED',
        detail: `These changes were made on v${base?.versionNumber ?? '?'}, and v${newer?.versionNumber ?? '?'} was saved since${by?.name ? ` by ${by.name}` : ''}. Saving them as they are would undo v${newer?.versionNumber ?? '?'}'s changes.`,
        baseVersionNumber: base?.versionNumber ?? null, currentVersionNumber: newer?.versionNumber ?? null, currentChangeNote: newer?.changeNote ?? null,
      },
    }
  }

  const r: CreateHtmlVersionResult = await createHtmlVersion({
    orgId: a.orgId, userId: a.userId, contractId: a.contractId, htmlContent: copy.html, changeNote: a.note.trim(),
    approvals: a.approvals, via: a.via, ipAddress: a.ipAddress, log: a.log,
  })
  if (!r.ok) return r
  // Cleared only as it was saved: a save that came in meanwhile is newer
  // work, kept, now on the new version.
  const cleared = await prisma.contractWorkingCopy.deleteMany({ where: { orgId: a.orgId, contractId: a.contractId, revision: copy.revision } })
  if (!cleared.count) {
    await prisma.contractWorkingCopy.updateMany({ where: { orgId: a.orgId, contractId: a.contractId }, data: { baseVersionId: r.version.id } })
  } else {
    await cancelIdleCheckpoint(a.contractId).catch(() => {})
  }
  return { ok: true, created: r.created, version: r.version }
}

/**
 * Before the contract is submitted or sent: unsaved draft changes become a
 * version first, so what is submitted or sent is what the person sees. No
 * draft changes, or the same words as the version: nothing to do.
 */
export async function saveDraftChangesBefore(a: { orgId: string; contractId: string; userId: string; reason: 'submit' | 'send'; ipAddress?: string }): Promise<
  | { ok: true; version: { id: string; versionNumber: number } | null }
  | { ok: false; status: 400 | 404 | 409; body: Record<string, unknown> }
> {
  const copy = await prisma.contractWorkingCopy.findFirst({ where: { orgId: a.orgId, contractId: a.contractId }, select: { html: true, baseVersionId: true } })
  if (!copy || !copy.html.trim()) return { ok: true, version: null }
  const base = copy.baseVersionId ? await prisma.contractVersion.findFirst({ where: { id: copy.baseVersionId, contractId: a.contractId }, select: { htmlContent: true } }) : null
  if (base && sameDocumentHtml(base.htmlContent, copy.html)) {
    // Typed and undone: nothing to keep.
    await prisma.contractWorkingCopy.deleteMany({ where: { orgId: a.orgId, contractId: a.contractId } })
    await cancelIdleCheckpoint(a.contractId).catch(() => {})
    return { ok: true, version: null }
  }
  const r = await versionFromWorkingCopy({ orgId: a.orgId, contractId: a.contractId, userId: a.userId, note: AUTO_NOTES[a.reason], via: a.reason, ipAddress: a.ipAddress })
  if (!r.ok) {
    if (r.body.code === 'NO_WORKING_COPY') return { ok: true, version: null }
    if (r.body.code === 'BASE_CHANGED') {
      return { ok: false, status: 409, body: { ...r.body, detail: `${r.body.detail} Open the editor and save or discard the draft changes first.` } }
    }
    return r
  }
  return { ok: true, version: r.version }
}

// ─── The idle checkpoint ──────────────────────────────────────────────────────

/** One delayed job per contract, pushed back by every save. */
export const idleJobId = (contractId: string) => `working-copy-idle-${contractId}`

export async function scheduleIdleCheckpoint(a: { orgId: string; contractId: string; revision: number; minutes: number }): Promise<boolean> {
  if (a.minutes <= 0) return false
  // Imported here: the queue module opens a Redis connection when loaded.
  const { agentQueue } = await import('./queue.js')
  const jobId = idleJobId(a.contractId)
  const existing = await agentQueue.getJob(jobId)
  const data = { orgId: a.orgId, contractId: a.contractId, revision: a.revision }
  const opts = { delay: a.minutes * 60_000, removeOnComplete: true, removeOnFail: 50 }
  if (existing) {
    const removed = await existing.remove().then(() => true, () => false)
    // Running now: it checks the revision and leaves this newer save alone.
    if (!removed) { await agentQueue.add('working-copy-idle', data, { ...opts, jobId: `${jobId}-${Date.now()}` }); return true }
  }
  await agentQueue.add('working-copy-idle', data, { ...opts, jobId })
  return true
}

export async function cancelIdleCheckpoint(contractId: string): Promise<void> {
  const { agentQueue } = await import('./queue.js')
  const job = await agentQueue.getJob(idleJobId(contractId))
  if (job) await job.remove().catch(() => {})
}

/**
 * The idle checkpoint fired: the draft changes left alone become a version
 * made by whoever saved them last, noted "Auto-saved after inactivity".
 * Changes made on a version since replaced are left as they are: only a
 * person can decide which wins.
 */
export async function runIdleCheckpoint(data: { orgId: string; contractId: string; revision: number }): Promise<string> {
  const copy = await prisma.contractWorkingCopy.findFirst({ where: { orgId: data.orgId, contractId: data.contractId }, select: { revision: true, updatedById: true } })
  if (!copy) return 'no draft changes'
  if (copy.revision !== data.revision) return 'saved again since'
  const r = await versionFromWorkingCopy({ orgId: data.orgId, contractId: data.contractId, userId: copy.updatedById, note: AUTO_NOTES.idle, via: 'idle', onlyRevision: data.revision })
  if (!r.ok) return `kept as draft changes: ${String(r.body.code ?? r.body.detail)}`
  return r.created ? `saved as v${r.version.versionNumber}` : 'same as the version'
}
