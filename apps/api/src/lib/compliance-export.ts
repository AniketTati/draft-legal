/**
 * compliance-export.ts (Phase 09 Step 6)
 *
 * Generates a single PDF that bundles everything an auditor / regulator
 * needs to verify a contract's lifecycle:
 *   - Cover page (title, parties, status, key dates, owner)
 *   - Signers + signature timestamps
 *   - Audit trail timeline (every relevant AuditEvent on the contract)
 *   - The signed contract PDF appended (when available)
 *
 * Builds on pdf-lib (already used by pdf-signing.ts). Output is a
 * Uint8Array the caller can stream back as application/pdf.
 */
import { PDFDocument, StandardFonts, rgb, PageSizes } from 'pdf-lib'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from './prisma.js'
import { s3, S3_BUCKET } from './storage.js'
import { checkAuditEvents } from './audit.js'

const A4 = PageSizes.A4
const PAGE_W = A4[0]
const PAGE_H = A4[1]
const MARGIN_X = 50
const MARGIN_Y = 50

interface ComplianceArgs {
  contractId: string
  orgId:      string
}

const CONTRACT_AUDIT_ACTIONS = [
  'CONTRACT_CREATED', 'CONTRACT_UPDATED', 'CONTRACT_DELETED', 'CONTRACT_VIEWED',
  'CONTRACT_UPLOADED', 'CONTRACT_STATUS_CHANGED', 'STAGE_CHANGED',
  'VERSION_CREATED', 'VERSION_RESTORED',
  'APPROVAL_SUBMITTED', 'APPROVAL_DECIDED', 'APPROVAL_ESCALATED',
  'SIGNATURE_SENT', 'SIGNATURE_COMPLETED', 'SIGNATURE_VOIDED',
  'OBLIGATION_EXTRACTED', 'OBLIGATION_COMPLETED', 'OBLIGATION_OVERDUE',
  'COMMENT_ADDED', 'COMMENT_RESOLVED',
  'LINK_SHARED', 'LINK_REVOKED',
  'REDLINE_ANALYZED',
]

const ACTION_LABEL: Record<string, string> = {
  CONTRACT_CREATED:  'Contract created',
  CONTRACT_UPDATED:  'Contract updated',
  CONTRACT_VIEWED:   'Viewed',
  CONTRACT_UPLOADED: 'Document uploaded',
  CONTRACT_STATUS_CHANGED: 'Status changed',
  STAGE_CHANGED: 'Stage changed',
  VERSION_CREATED:   'New version',
  VERSION_RESTORED:  'Version restored',
  APPROVAL_SUBMITTED: 'Approval submitted',
  APPROVAL_DECIDED:  'Approval decided',
  APPROVAL_ESCALATED: 'Approval escalated',
  SIGNATURE_SENT:    'Sent for signature',
  SIGNATURE_COMPLETED: 'Signed (all parties)',
  SIGNATURE_VOIDED:  'Signature voided',
  OBLIGATION_EXTRACTED: 'Obligations extracted',
  OBLIGATION_COMPLETED: 'Obligation completed',
  OBLIGATION_OVERDUE:   'Obligation went overdue',
  COMMENT_ADDED:     'Comment added',
  COMMENT_RESOLVED:  'Comment resolved',
  LINK_SHARED:       'Share link issued',
  LINK_REVOKED:      'Share link revoked',
  REDLINE_ANALYZED:  'Redline analyzed',
}

// ASCII-only helper (PDF metadata + non-Latin text causes warnings).
function ascii(s: string): string {
  return (s ?? '').replace(/[^\x20-\x7E]/g, '').slice(0, 200)
}

export async function generateCompliancePackage({ contractId, orgId }: ComplianceArgs): Promise<Uint8Array> {
  // ── 1. Pull contract + related data ──────────────────────────────────
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, orgId, deletedAt: null },
    include: {
      org:   { select: { name: true } },
      owner: { select: { name: true, email: true } },
      counterparty: { select: { name: true } },
    },
  })
  if (!contract) throw new Error('contract_not_found')

  const versions = await prisma.contractVersion.findMany({
    where: { contractId },
    orderBy: { versionNumber: 'asc' },
    select: { id: true, versionNumber: true, s3Key: true, mimeType: true, changeNote: true, createdAt: true },
  })
  const currentVersion = versions.find(v => v.id === contract.currentVersionId) ?? versions[versions.length - 1]

  const signatureRequests = await prisma.signatureRequest.findMany({
    where: { contractId, status: 'COMPLETED' },
    include: { signers: { orderBy: { signOrder: 'asc' } } },
    orderBy: { completedAt: 'desc' },
  })

  const auditEvents = await prisma.auditEvent.findMany({
    where: {
      orgId,
      OR: [
        { resourceId: contractId },
        { metadata: { path: ['contractId'], equals: contractId } as never },
      ],
      action: { in: CONTRACT_AUDIT_ACTIONS },
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  })

  // Resolve actor names for the audit table.
  const actorIds = Array.from(new Set(auditEvents.map(e => e.userId).filter((x): x is string => !!x)))
  const actors = await prisma.user.findMany({
    where:  { id: { in: actorIds } },
    select: { id: true, name: true, email: true },
  })
  const actorById = new Map(actors.map(u => [u.id, u]))

  // ── 2. Build the cover/audit/signers PDF via pdf-lib ─────────────────
  const out = await PDFDocument.create()
  out.setTitle(ascii(`Compliance Package — ${contract.title}`))
  out.setAuthor(ascii(contract.org?.name ?? 'draftLegal'))
  out.setSubject('Contract compliance + audit evidence')
  out.setProducer('draftLegal')
  out.setCreator('draftLegal / compliance-export')
  out.setCreationDate(new Date())

  const helv = await out.embedFont(StandardFonts.Helvetica)
  const helvBold = await out.embedFont(StandardFonts.HelveticaBold)

  // ── Cover page ──
  let pageNum = 0
  let page = out.addPage([PAGE_W, PAGE_H])
  let y = PAGE_H - MARGIN_Y - 10

  // Header band — emerald accent.
  page.drawRectangle({
    x: 0, y: PAGE_H - 8, width: PAGE_W, height: 8,
    color: rgb(0.063, 0.659, 0.443),  // emerald-500
  })

  page.drawText('COMPLIANCE PACKAGE', {
    x: MARGIN_X, y, font: helvBold, size: 11, color: rgb(0.063, 0.659, 0.443),
  })
  y -= 30

  // Contract title — wrap if long.
  const titleLines = wrapText(contract.title, helvBold, 22, PAGE_W - 2 * MARGIN_X)
  for (const line of titleLines) {
    page.drawText(line, { x: MARGIN_X, y, font: helvBold, size: 22, color: rgb(0.05, 0.07, 0.1) })
    y -= 28
  }
  y -= 10

  // Subtitle row.
  page.drawText(`${ascii(contract.type)} · ${ascii(contract.status)}`, {
    x: MARGIN_X, y, font: helv, size: 11, color: rgb(0.4, 0.4, 0.4),
  })
  y -= 30

  const facts: [string, string][] = [
    ['Contract ID',       contract.id],
    ['Counterparty',      contract.counterpartyName ?? contract.counterparty?.name ?? '—'],
    ['Effective date',    contract.effectiveDate ? contract.effectiveDate.toISOString().slice(0, 10) : '—'],
    ['Expiry date',       contract.expiryDate ? contract.expiryDate.toISOString().slice(0, 10) : '—'],
    ['Value',             contract.value ? `${contract.currency ?? 'USD'} ${contract.value.toString()}` : '—'],
    ['Jurisdiction',      contract.jurisdiction ?? '—'],
    ['Owner',             `${contract.owner?.name ?? '—'} (${contract.owner?.email ?? '—'})`],
    ['Current version',   currentVersion ? `v${currentVersion.versionNumber}` : '—'],
    ['Organization',      contract.org?.name ?? '—'],
    ['Generated at',      new Date().toISOString()],
  ]

  for (const [label, value] of facts) {
    page.drawText(label, { x: MARGIN_X, y, font: helvBold, size: 9.5, color: rgb(0.4, 0.4, 0.5) })
    const lines = wrapText(ascii(value), helv, 11, PAGE_W - 2 * MARGIN_X - 130)
    let dy = 0
    for (const line of lines) {
      page.drawText(line, { x: MARGIN_X + 130, y: y - dy, font: helv, size: 11, color: rgb(0.1, 0.1, 0.15) })
      dy += 14
    }
    y -= Math.max(20, dy + 4)
  }
  pageNum = 1
  drawFooter(page, helv, pageNum, contract.org?.name ?? 'draftLegal')

  // From here on, every addPage bumps pageNum and the footer is drawn
  // when the page is done filling.
  const newPage = () => { page = out.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN_Y; return page }
  const finishPage = () => drawFooter(page, helv, ++pageNum, contract.org?.name ?? 'draftLegal')

  // ── Signers page (per signature request) ──
  if (signatureRequests.length > 0) {
    newPage()
    page.drawText('SIGNATURE EVIDENCE', { x: MARGIN_X, y, font: helvBold, size: 14 })
    y -= 24
    for (const sr of signatureRequests) {
      page.drawText(`Request ${sr.id.slice(-12)}`, { x: MARGIN_X, y, font: helvBold, size: 10, color: rgb(0.3, 0.3, 0.4) })
      y -= 14
      page.drawText(`Sent ${sr.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC · Completed ${sr.completedAt?.toISOString().slice(0, 16).replace('T', ' ')} UTC`, {
        x: MARGIN_X, y, font: helv, size: 9, color: rgb(0.5, 0.5, 0.55),
      })
      y -= 18

      for (const signer of sr.signers) {
        if (y < MARGIN_Y + 80) { finishPage(); newPage() }
        page.drawRectangle({ x: MARGIN_X, y: y - 60, width: PAGE_W - 2 * MARGIN_X, height: 60,
          borderColor: rgb(0.85, 0.88, 0.92), borderWidth: 0.5 })
        page.drawText(ascii(signer.name), { x: MARGIN_X + 12, y: y - 16, font: helvBold, size: 11 })
        if (signer.role) {
          page.drawText(ascii(signer.role), { x: MARGIN_X + 12, y: y - 30, font: helv, size: 9, color: rgb(0.4, 0.4, 0.5) })
        }
        page.drawText(ascii(signer.email), { x: MARGIN_X + 12, y: y - 44, font: helv, size: 9, color: rgb(0.3, 0.3, 0.4) })

        const status = signer.status === 'SIGNED' ? `Signed ${signer.signedAt?.toISOString().slice(0, 16).replace('T', ' ')} UTC`
          : signer.status === 'DECLINED' ? `Declined ${signer.declinedAt?.toISOString().slice(0, 16).replace('T', ' ')}`
          : 'Pending'
        page.drawText(status, { x: MARGIN_X + 270, y: y - 16, font: helv, size: 10, color: signer.status === 'SIGNED' ? rgb(0.05, 0.55, 0.40) : rgb(0.5, 0.5, 0.55) })
        if (signer.signedName) {
          page.drawText(`Typed name: ${ascii(signer.signedName)}`, { x: MARGIN_X + 270, y: y - 30, font: helv, size: 9, color: rgb(0.3, 0.3, 0.35) })
        }
        if (signer.signedIp) {
          page.drawText(`IP ${ascii(signer.signedIp)}`, { x: MARGIN_X + 270, y: y - 44, font: helv, size: 9, color: rgb(0.5, 0.5, 0.55) })
        }
        y -= 70
      }
      y -= 10
    }
    finishPage()
  }

  // ── Audit trail page(s) ──
  // Z1 — each event is checked against the organization's hash chain, and the
  // page says what was found. It used to claim "verified" without a check.
  const checks = await checkAuditEvents(orgId, auditEvents)
  const broken = auditEvents.find(e => ['hash_mismatch', 'prev_hash_mismatch'].includes(checks.get(e.id) ?? ''))
  const unhashed = auditEvents.filter(e => checks.get(e.id) === 'unhashed').length
  const summary = broken
    ? `${auditEvents.length} events recorded · CHAIN CHECK FAILED at ${broken.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC ` +
      `(${checks.get(broken.id) === 'hash_mismatch' ? 'the event was altered after it was recorded' : 'the link to the event before it is broken'})`
    : `${auditEvents.length} events recorded · each checked against the organization's hash chain: intact` +
      (unhashed ? ` (${unhashed} older events predate hashing)` : '')
  newPage()
  page.drawText('AUDIT TRAIL', { x: MARGIN_X, y, font: helvBold, size: 14 })
  y -= 8
  for (const line of wrapText(summary, helv, 9, PAGE_W - 2 * MARGIN_X)) {
    page.drawText(line, { x: MARGIN_X, y: y - 12, font: helv, size: 9, color: broken ? rgb(0.7, 0.15, 0.12) : rgb(0.5, 0.5, 0.55) })
    y -= 12
  }
  y -= 20

  // Table headers
  const colX = [MARGIN_X, MARGIN_X + 130, MARGIN_X + 290, MARGIN_X + 410]
  page.drawText('When (UTC)', { x: colX[0], y, font: helvBold, size: 9, color: rgb(0.4, 0.4, 0.5) })
  page.drawText('Action',     { x: colX[1], y, font: helvBold, size: 9, color: rgb(0.4, 0.4, 0.5) })
  page.drawText('Actor',      { x: colX[2], y, font: helvBold, size: 9, color: rgb(0.4, 0.4, 0.5) })
  page.drawText('Hash',       { x: colX[3], y, font: helvBold, size: 9, color: rgb(0.4, 0.4, 0.5) })
  y -= 4
  page.drawLine({ start: { x: MARGIN_X, y }, end: { x: PAGE_W - MARGIN_X, y }, color: rgb(0.85, 0.88, 0.92), thickness: 0.5 })
  y -= 12

  for (const e of auditEvents) {
    if (y < MARGIN_Y + 30) {
      finishPage()
      newPage()
    }
    const when  = e.createdAt.toISOString().slice(0, 16).replace('T', ' ')
    const actor = e.userId ? (actorById.get(e.userId)?.name ?? actorById.get(e.userId)?.email ?? 'system') : 'system'
    const check = checks.get(e.id)
    const hash  = e.hash
      ? `${e.hash.slice(0, 10)}… ${check === 'intact' ? 'ok' : 'FAILED'}`
      : '— (no hash)'
    const label = ACTION_LABEL[e.action] ?? e.action.replace(/_/g, ' ').toLowerCase()
    page.drawText(when,                  { x: colX[0], y, font: helv, size: 9, color: rgb(0.2, 0.2, 0.3) })
    page.drawText(ascii(label),          { x: colX[1], y, font: helv, size: 9, color: rgb(0.1, 0.1, 0.15) })
    page.drawText(ascii(actor).slice(0, 28), { x: colX[2], y, font: helv, size: 9, color: rgb(0.3, 0.3, 0.4) })
    page.drawText(hash,                  { x: colX[3], y, font: helv, size: 8.5, color: check === 'intact' || check === 'unhashed' ? rgb(0.5, 0.5, 0.55) : rgb(0.7, 0.15, 0.12) })
    y -= 14
  }
  finishPage()

  // ── 3. Append the signed contract PDF (when one exists) ─────────────
  // Prefer the most recent version's s3Key or renderedPdfKey since we
  // store the signed PDF as a new ContractVersion after the cert is
  // appended (Phase 07 Step 6).
  const lastVersion = versions[versions.length - 1]
  const sourceKey = lastVersion?.s3Key
  if (sourceKey && lastVersion?.mimeType === 'application/pdf') {
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: sourceKey }))
      const bytes = await obj.Body!.transformToByteArray()
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
      const copied = await out.copyPages(src, src.getPageIndices())
      for (const p of copied) out.addPage(p)
    } catch (err) {
      // Don't fail the whole package if the source PDF is unreadable.
      page = out.addPage([PAGE_W, PAGE_H])
      page.drawText('SIGNED CONTRACT (UNAVAILABLE)', { x: MARGIN_X, y: PAGE_H - MARGIN_Y, font: helvBold, size: 12, color: rgb(0.65, 0.2, 0.2) })
      page.drawText(`Source PDF could not be loaded: ${(err as Error).message.slice(0, 200)}`, {
        x: MARGIN_X, y: PAGE_H - MARGIN_Y - 20, font: helv, size: 10, color: rgb(0.5, 0.3, 0.3),
      })
    }
  }

  // A classic cross-reference table rather than pdf-lib's default object
  // streams: older readers (pdf.js 1.x, as pdf-parse bundles) misread the
  // compressed table at some byte offsets and reported the package corrupt,
  // about one save in forty. The file is an auditor's; any reader must open it.
  return await out.save({ useObjectStreams: false })
}

function drawFooter(page: ReturnType<PDFDocument['addPage']>, font: ReturnType<PDFDocument['embedFont']> extends Promise<infer T> ? T : never, pageNum: number, orgName: string) {
  const text = `${ascii(orgName)} · CLM Compliance Export · Page ${pageNum}`
  page.drawText(text, {
    x: MARGIN_X, y: 24,
    font, size: 8, color: rgb(0.6, 0.6, 0.65),
  })
}

function wrapText(text: string, font: Awaited<ReturnType<PDFDocument['embedFont']>>, size: number, maxWidth: number): string[] {
  const words = ascii(text).split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate
    } else {
      if (line) lines.push(line)
      line = w
    }
  }
  if (line) lines.push(line)
  return lines.length > 0 ? lines : [text]
}
