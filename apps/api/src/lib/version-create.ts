/**
 * A text version made from HTML: what `POST /contracts/:id/html-version` has
 * always done, shared with the paths that make a version from the editor's
 * working copy (docs/41 Part 16, C1: Save as version, submitting for
 * approval, sending, the idle checkpoint).
 *
 * Every one of them gets the same follow-up: a rendered PDF, the clauses
 * followed into the new text and the analysis checkpoint (afterEdit), the
 * approval reset rules (onApprovalChange) and an audit event. Keeping that in
 * one place is what stops a version made one way from skipping a step.
 */
import { AuditAction } from '@clm/types'
import { prisma } from './prisma.js'
import { createAuditEvent } from './audit.js'
import { lockOf, lockedBody } from './external-edit.js'
import { afterEdit } from './version-refresh.js'
import { onApprovalChange, type ApprovalOverride } from './approval-reset.js'
import { htmlToText } from './html-text.js'
import { acceptedHtml } from './suggestions.js'
import { renderHtmlToPdfAndStore } from './gotenberg.js'

/**
 * X47 — whether a saved HTML body is the document already stored. Line
 * breaks between tags don't count: the extractor writes them and the editor
 * never does. Any other difference is an edit, a single space included.
 */
export function sameDocumentHtml(stored: string, saved: string): boolean {
  const norm = (html: string) => html.replace(/>\s*\n\s*</g, '><').trim()
  return norm(stored) === norm(saved)
}

export interface CreateHtmlVersionArgs {
  orgId: string
  userId: string
  contractId: string
  htmlContent: string
  changeNote: string
  ipAddress?: string
  /** docs/41 Part 16 — set only for someone allowed to configure workflows (the caller checks). */
  approvals?: ApprovalOverride
  /** What made it, for the audit trail: 'editor' (html-version), 'working_copy', 'submit', 'send', 'idle'. */
  via?: string
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }
}

export type CreateHtmlVersionResult =
  | { ok: true; created: boolean; version: { id: string; versionNumber: number; [k: string]: unknown }; fromVersionId: string | null }
  | { ok: false; status: 400 | 404 | 409; body: Record<string, unknown> }

/** Make a version from HTML, unless it is the document the contract already stands on. */
export async function createHtmlVersion(a: CreateHtmlVersionArgs): Promise<CreateHtmlVersionResult> {
  const { orgId, userId, contractId: id, htmlContent, changeNote } = a
  if (!htmlContent?.trim()) return { ok: false, status: 400, body: { detail: 'htmlContent is required' } }

  const contract = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null } })
  if (!contract) return { ok: false, status: 404, body: { detail: 'Contract not found' } }
  // BB3 — read-only while a Google Docs copy is out.
  const lock = lockOf(contract.externalEdit)
  if (lock) return { ok: false, status: 409, body: lockedBody(lock) as unknown as Record<string, unknown> }

  const lastVersion = await prisma.contractVersion.findFirst({
    where: { contractId: id },
    orderBy: { versionNumber: 'desc' },
  })
  // X47 — a save that changes nothing makes nothing. Opening a contract made
  // the web editor report a change, and the page saves every change: each
  // view added a version, moved the current version off the uploaded PDF,
  // rendered a PDF and, since X42, sent an approved contract back to DRAFT.
  // "Nothing" is judged against the version the contract stands on — the
  // latest, unless an undo moved it back, when saving the latest again is
  // a real change.
  const standing = contract.currentVersionId && contract.currentVersionId !== lastVersion?.id
    ? await prisma.contractVersion.findFirst({ where: { id: contract.currentVersionId, contractId: id } })
    : lastVersion
  if (standing && sameDocumentHtml(standing.htmlContent, htmlContent)) {
    return { ok: true, created: false, version: standing, fromVersionId: standing.id }
  }

  // C4 — the text the analysis reads: pending suggestions as if accepted (lib/suggestions).
  const plainText = htmlToText(acceptedHtml(htmlContent))
  const version = await prisma.contractVersion.create({
    data: {
      contractId: id,
      versionNumber: (lastVersion?.versionNumber ?? 0) + 1,
      htmlContent,
      plainText,
      s3Key: null,
      mimeType: 'text/html',
      fileSize: Buffer.byteLength(htmlContent),
      changeNote,
      createdById: userId,
    },
  })

  // A.5 — render a canonical PDF from this HTML and attach it to the
  // version so approvers, signers, and counterparties see the latest
  // edits. Fire-and-forget: a slow Gotenberg call must not block the save.
  // The version exists without renderedPdfKey until Gotenberg finishes.
  void (async () => {
    try {
      const { s3Key: pdfKey } = await renderHtmlToPdfAndStore({
        html: htmlContent,
        keyPrefix: `${orgId}/contracts/${id}/rendered`,
        filename: `v${version.versionNumber}.pdf`,
      })
      await prisma.contractVersion.update({
        where: { id: version.id },
        data:  { renderedPdfKey: pdfKey, renderedAt: new Date() },
      })
      a.log?.info({ contractId: id, versionId: version.id, pdfKey }, 'A.5: rendered canonical PDF')
    } catch (err) {
      a.log?.warn({ err, contractId: id, versionId: version.id }, 'A.5: Gotenberg render failed — canonical will fall back to source')
    }
  })()

  await prisma.contract.update({
    where: { id },
    data: { currentVersionId: version.id, updatedAt: new Date() },
  })
  // DD2 — the edit keeps the clauses of the version it was made on, and the
  // search index follows the new text.
  await afterEdit({ contractId: id, orgId, versionId: version.id, fromVersionId: standing?.id })
  // X42, docs/41 Part 18 — approvals given are asked again as their reset rules say.
  await onApprovalChange({ orgId, contractId: id, versionId: version.id, fromVersionId: standing?.id, source: 'edit', userId, override: a.approvals })
  const status = (await prisma.contract.findUnique({ where: { id }, select: { status: true } }))?.status
  // X47 follow-up — the document changed, and perhaps its approval with it:
  // on the record, as any other change to the contract is.
  await createAuditEvent({
    orgId, userId,
    action: AuditAction.CONTRACT_UPDATED,
    resourceType: 'contract',
    resourceId: id,
    metadata: {
      action: 'document_edited', versionNumber: version.versionNumber, changeNote,
      ...(a.via && { via: a.via }), ...(a.approvals && { approvals: a.approvals }),
      ...(status && status !== contract.status && { statusFrom: contract.status, statusTo: status }),
    },
    ipAddress: a.ipAddress,
  })
  return { ok: true, created: true, version, fromVersionId: standing?.id ?? null }
}
