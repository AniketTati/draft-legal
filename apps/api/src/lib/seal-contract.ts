/**
 * Seal an executed contract — generate the certified/signed PDF and store it
 * as the contract's new canonical version.
 *
 * Extracted out of the signing route so it can run as a RETRYABLE queue job.
 * It previously ran as a fire-and-forget async IIFE with swallowed errors,
 * which meant a transient S3 / Gotenberg / signing-cert failure left the
 * contract flipped to EXECUTED with no signed version at all, and no retry or
 * repair path — a legally significant artefact silently missing.
 *
 * Idempotent by design: the sealed object key is deterministic
 * (`signed/<contractId>/<signatureRequestId>.pdf`), so a retry that runs after
 * a previous attempt already succeeded detects the existing version and exits
 * instead of creating a duplicate.
 *
 * Throws on failure so BullMQ can retry. Conditions that can never succeed
 * (request voided, contract deleted, nothing to seal) return a 'skipped'
 * outcome rather than throwing, so they don't burn retries.
 */
import { prisma } from './prisma.js'
import { generateAndStoreSignedPdf } from './pdf-signing.js'
import { renderHtmlToPdfAndStore } from './gotenberg.js'
import { createAuditEvent } from './audit.js'
import { AuditAction } from '@clm/types'
import { afterEdit } from './version-refresh.js'

export type SealOutcome =
  | { status: 'sealed';         versionId: string; signedKey: string }
  | { status: 'already_sealed'; versionId: string }
  | { status: 'skipped';        reason: string }

export async function sealSignedContract(signatureRequestId: string): Promise<SealOutcome> {
  const sr = await prisma.signatureRequest.findUnique({
    where:   { id: signatureRequestId },
    include: { signers: true },
  })
  if (!sr) return { status: 'skipped', reason: 'signature request no longer exists' }
  // Only a completed request should be sealed — a voided/expired one must not
  // produce an executed artefact even if a stale job is retried.
  if (sr.status !== 'COMPLETED') {
    return { status: 'skipped', reason: `signature request is ${sr.status}, not COMPLETED` }
  }

  const signedKey = `signed/${sr.contractId}/${sr.id}.pdf`

  const existing = await prisma.contractVersion.findFirst({
    where:  { contractId: sr.contractId, s3Key: signedKey },
    select: { id: true, versionNumber: true },
  })
  if (existing) {
    // A previous attempt already produced the sealed version — but it may have
    // died before repointing the contract at it, because the create / audit /
    // pointer-update below are three separate awaits rather than one
    // transaction. Simply returning here would leave the contract EXECUTED
    // while every "current version" reader (download, portal, compare, index)
    // serves the UNSIGNED pre-seal document, and the worker would log success
    // so nothing would alert. So reconcile the pointer instead of bailing.
    //
    // Only ever move the pointer FORWARD: a legitimately newer version (e.g. a
    // counterparty upload after execution) must not be clobbered by a late retry.
    const contractNow = await prisma.contract.findUnique({
      where:  { id: sr.contractId },
      select: { currentVersionId: true },
    })
    if (contractNow && contractNow.currentVersionId !== existing.id) {
      const currentVer = contractNow.currentVersionId
        ? await prisma.contractVersion.findUnique({
            where:  { id: contractNow.currentVersionId },
            select: { versionNumber: true },
          })
        : null
      if ((currentVer?.versionNumber ?? -1) < existing.versionNumber) {
        await prisma.contract.update({
          where: { id: sr.contractId },
          data:  { currentVersionId: existing.id },
        })
      }
    }
    return { status: 'already_sealed', versionId: existing.id }
  }

  const ver = await prisma.contractVersion.findUnique({
    where:  { id: sr.versionId },
    select: {
      id: true, versionNumber: true, s3Key: true, mimeType: true,
      renderedPdfKey: true, plainText: true, htmlContent: true,
    },
  })
  if (!ver) return { status: 'skipped', reason: 'signed version no longer exists' }

  // Canonical source: renderedPdfKey wins (A.5), else the original upload
  // when it is a PDF. DD8 — a Word or text upload is not one: its bytes,
  // stamped as a PDF, failed every retry ("No PDF header found"), so a
  // contract signed on their Word file never got its sealed copy. Its text is
  // rendered instead, as an AI draft's is and as every editor save is.
  const uploadIsPdf = ver.mimeType ? ver.mimeType === 'application/pdf' : /\.pdf$/i.test(ver.s3Key ?? '')
  let sourceKey = ver.renderedPdfKey ?? (uploadIsPdf ? ver.s3Key : null)

  // AI-drafted HTML contracts never went through the editor's render-on-save
  // path, so there's no PDF to stamp yet — render one now. Unlike before, a
  // failure here propagates and the job retries rather than silently giving up.
  if (!sourceKey && ver.htmlContent?.trim()) {
    const { s3Key: rendered } = await renderHtmlToPdfAndStore({
      html:      ver.htmlContent,
      keyPrefix: `${sr.orgId}/contracts/${sr.contractId}/rendered`,
    })
    await prisma.contractVersion.update({
      where: { id: ver.id },
      data:  { renderedPdfKey: rendered, renderedAt: new Date() },
    })
    sourceKey = rendered
  }
  if (!sourceKey) {
    return { status: 'skipped', reason: 'no source PDF or HTML content to seal' }
  }

  const contract = await prisma.contract.findUnique({
    where:  { id: sr.contractId },
    select: { title: true, type: true, org: { select: { name: true } } },
  })
  if (!contract) return { status: 'skipped', reason: 'contract no longer exists' }

  const completedAt = sr.completedAt ?? new Date()

  const { documentHash } = await generateAndStoreSignedPdf({
    sourceKey,
    signedKeyPrefix: `signed/${sr.contractId}`,
    contractTitle:   contract.title,
    contractType:    contract.type,
    orgName:         contract.org?.name ?? 'draftLegal',
    signatureRequestId: sr.id,
    completedAt,
    signers: sr.signers
      .map(s => ({
        name: s.name, role: s.role, email: s.email,
        signedName: s.signedName, signedAt: s.signedAt,
        signedIp: s.signedIp, signOrder: s.signOrder,
      }))
      .sort((a, b) =>
        (a.signOrder - b.signOrder) ||
        ((a.signedAt?.getTime() ?? 0) - (b.signedAt?.getTime() ?? 0)),
      ),
  })

  const nSigners = sr.signers.length
  const newVersion = await prisma.contractVersion.create({
    data: {
      contractId:    sr.contractId,
      versionNumber: (ver.versionNumber ?? 0) + 1,
      htmlContent:   ver.htmlContent ?? '',
      plainText:     ver.plainText ?? '',
      s3Key:         signedKey,
      mimeType:      'application/pdf',
      changeNote:    `Signed by ${nSigners} signer${nSigners === 1 ? '' : 's'} — sealed with PAdES/X.509 (SHA-256 ${documentHash.slice(0, 12)}…)`,
      // Wave 2.7 — tamper-evidence hash of the sealed PDF, so the executed
      // document can be independently verified later.
      metadata: {
        _signature: {
          sha256:    documentHash,
          algorithm: 'SHA-256',
          format:    'PAdES/X.509 (adbe.pkcs7.detached)',
          sealedAt:  completedAt.toISOString(),
          signatureRequestId: sr.id,
        },
      },
      createdById: sr.createdById,
    },
  })

  // Anchor the seal hash in the tamper-evident audit chain too.
  await createAuditEvent({
    orgId:        sr.orgId,
    userId:       sr.createdById,
    action:       AuditAction.SIGNATURE_COMPLETED,
    resourceType: 'contract',
    resourceId:   sr.contractId,
    metadata:     { event: 'document_sealed', sha256: documentHash, algorithm: 'SHA-256', signatureRequestId: sr.id },
  }).catch(() => { /* audit best-effort; the seal is already stored on the version */ })

  await prisma.contract.update({
    where: { id: sr.contractId },
    data:  { currentVersionId: newVersion.id },
  })
  // DD2 — the signed copy has the same words, and keeps the clauses (the
  // executed contract's obligations and renewal terms are read from them).
  await afterEdit({ contractId: sr.contractId, orgId: sr.orgId, versionId: newVersion.id, fromVersionId: ver.id })

  return { status: 'sealed', versionId: newVersion.id, signedKey }
}
