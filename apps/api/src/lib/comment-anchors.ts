/**
 * Where each comment thread sits in a version of the contract (docs/41 Part 16).
 *
 * A thread keeps the words it was left on ({ quote, start, end, versionId }).
 * Read against a later version, the words are looked for again — exactly, then
 * with whitespace ignored — and a thread whose words are gone is orphaned
 * ("Text no longer in the document") rather than pinned to the wrong place.
 */
import { prisma } from './prisma.js'
import { htmlToText } from './html-text.js'
import { parseCommentAnchor, resolveCommentAnchor, type AnchorState } from '@clm/types'

export interface AnchoredView {
  anchorState: AnchorState | null
  anchorStart: number | null
  anchorEnd: number | null
}

/** The version a thread list is read against: the one asked for, or the newest. */
async function versionText(orgId: string, contractId: string, versionId?: string | null) {
  const v = versionId
    ? await prisma.contractVersion.findFirst({ where: { id: versionId, contractId, contract: { orgId } }, select: { id: true, plainText: true, htmlContent: true } })
    : await prisma.contractVersion.findFirst({ where: { contractId, contract: { orgId } }, orderBy: { versionNumber: 'desc' }, select: { id: true, plainText: true, htmlContent: true } })
  if (!v) return null
  return { id: v.id, text: v.plainText?.trim() ? v.plainText : htmlToText(v.htmlContent ?? '') }
}

/** Add each thread's place in the version (anchorState/anchorStart/anchorEnd). */
export async function withAnchors<T extends { anchor: unknown }>(
  orgId: string, contractId: string, threads: T[], versionId?: string | null,
): Promise<Array<T & AnchoredView>> {
  const none: AnchoredView = { anchorState: null, anchorStart: null, anchorEnd: null }
  if (!threads.some(t => parseCommentAnchor(t.anchor))) return threads.map(t => ({ ...t, ...none }))
  const v = await versionText(orgId, contractId, versionId)
  return threads.map(t => {
    const a = parseCommentAnchor(t.anchor)
    if (!a || !v) return { ...t, ...none }
    const r = resolveCommentAnchor(a, v.text, v.id)
    return { ...t, anchorState: r.state, anchorStart: r.start, anchorEnd: r.end }
  })
}
