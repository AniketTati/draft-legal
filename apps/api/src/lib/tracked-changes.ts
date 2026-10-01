/**
 * docs/39 A9 — a Word file with tracked changes nobody has accepted.
 *
 * The other side's redline comes back as a .docx whose changes are still
 * tracked. Its text is read with every change accepted (mammoth reads it so),
 * and its values used to be read from that text as if agreed: their 60 days
 * replaced our 30, with nothing to say it was only proposed.
 *
 * Now the file's changes are counted when it is read (the version's
 * `metadata.trackedChanges`) and the contract page says so. The values keep
 * what the file says with the changes rejected — what is agreed — with each
 * change's proposal beside them (field-store: applyExtraction's `tracked`).
 * The document itself still shows the changes made, so Compare, the redline
 * analysis and search see what the other side proposes.
 */
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from './prisma.js'
import { s3, S3_BUCKET } from './storage.js'
import { MIME } from './file-type.js'
import { docxParagraphs, readDocxReview } from './ooxml/docx-redline.js'
import { normalizeForSearch, findQuote, type NormalizedText } from './text-span.js'
import { diffSequences } from './ooxml/sequence-diff.js'

export interface TrackedChanges {
  insertions: number
  deletions:  number
  /** Changes by who made them, as the file names them. */
  byAuthor:   Record<string, number>
  comments:   number
}

/**
 * The file's tracked changes — counted as none when it has none: kept on the
 * version either way, so a Word file never looked at (read before this
 * existed) is told from one that has none (versionTrackedViews).
 */
export async function readTrackedChanges(file: Buffer): Promise<TrackedChanges> {
  const { revisions, comments } = await readDocxReview(file)
  return { insertions: revisions.insertions, deletions: revisions.deletions, byAuthor: revisions.byAuthor, comments: comments.length }
}

/** A version's tracked changes when it has some; null when it has none, or they were never counted. */
export function trackedChangesOf(metadata: unknown): TrackedChanges | null {
  const t = (metadata as { trackedChanges?: Partial<TrackedChanges> } | null)?.trackedChanges
  if (!t || typeof t !== 'object') return null
  const insertions = Number(t.insertions) || 0, deletions = Number(t.deletions) || 0
  if (!insertions && !deletions) return null
  return { insertions, deletions, byAuthor: t.byAuthor && typeof t.byAuthor === 'object' ? t.byAuthor : {}, comments: Number(t.comments) || 0 }
}

/** The file read two ways: with every change rejected (agreed) and every change accepted (proposed). */
export interface TrackedViews {
  agreed:       string
  proposed:     string
  agreedNorm:   NormalizedText
  proposedNorm: NormalizedText
  /** The two readings' words lined up, made on first use (counterpart). */
  alignment?:   Alignment | null
}

export async function viewsOf(file: Buffer): Promise<TrackedViews> {
  const [agreed, proposed] = await Promise.all([docxParagraphs(file, 'original'), docxParagraphs(file, 'accepted')])
  return viewsFrom(agreed.join('\n\n'), proposed.join('\n\n'))
}

export function viewsFrom(agreed: string, proposed: string): TrackedViews {
  return { agreed, proposed, agreedNorm: normalizeForSearch(agreed), proposedNorm: normalizeForSearch(proposed) }
}

// ─── One reading's words in the other ───────────────────────────────────────

/** Longer than this, what stands in a quote's place isn't the same passage changed. */
const MAX_COUNTERPART = 600

interface Word { start: number; end: number; key: string }
/** A reading's words, and for each the word it is in the other reading (-1: their changes put it in or took it out). */
interface Side { words: Word[]; match: Int32Array }
export interface Alignment { agreed: Side; proposed: Side }

const words = (s: string): Word[] => [...s.matchAll(/\S+/g)].map(m => ({
  start: m.index!, end: m.index! + m[0].length,
  key: m[0].toLowerCase().replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/[–—−]/g, '-'),
}))

function align(v: TrackedViews): Alignment | null {
  const a = words(v.agreed), p = words(v.proposed)
  const ma = new Int32Array(a.length).fill(-1), mp = new Int32Array(p.length).fill(-1)
  let kept = 0
  for (const op of diffSequences(a, p, w => w.key)) {
    if (op.kind === 'equal') { ma[op.ai] = op.bi; mp[op.bi] = op.ai; kept++ }
  }
  return kept ? { agreed: { words: a, match: ma }, proposed: { words: p, match: mp } } : null
}

/**
 * What stands in the other reading where `quote` stands in this one: its
 * words kept map across, and a changed word at either end takes in what the
 * other reading has in the same place. '' — the other reading has nothing
 * there (their changes put the quote in, or took it out); null — the quote
 * isn't in this reading, or what stands in its place is too long to be it.
 */
export function counterpart(v: TrackedViews, into: 'agreed' | 'proposed', quote: string): string | null {
  if (v.alignment === undefined) v.alignment = align(v)
  if (!v.alignment) return null
  const [from, to, fromNorm, toText] = into === 'agreed'
    ? [v.alignment.proposed, v.alignment.agreed, v.proposedNorm, v.agreed]
    : [v.alignment.agreed, v.alignment.proposed, v.agreedNorm, v.proposed]
  const span = findQuote(fromNorm, quote)
  if (!span) return null
  const i0 = from.words.findIndex(w => w.end > span.start)
  if (i0 < 0) return null
  let i1 = i0
  while (i1 + 1 < from.words.length && from.words[i1 + 1].start < span.end) i1++
  let j0 = from.match[i0]
  if (j0 < 0) {
    let k = i0 - 1
    while (k >= 0 && from.match[k] < 0) k--
    j0 = k >= 0 ? from.match[k] + 1 : 0
  }
  let j1 = from.match[i1]
  if (j1 < 0) {
    let k = i1 + 1
    while (k < from.words.length && from.match[k] < 0) k++
    j1 = k < from.words.length ? from.match[k] - 1 : to.words.length - 1
  }
  if (j0 > j1) return ''
  // A kept word at either end is cut where the quote cuts it ("New York" of "York.").
  const start = to.words[j0].start + (from.match[i0] >= 0 ? Math.max(0, span.start - from.words[i0].start) : 0)
  const end = to.words[j1].end - (from.match[i1] >= 0 ? Math.max(0, from.words[i1].end - span.end) : 0)
  let passage = toText.slice(start, Math.max(start, end))
  // A changed word at an end comes whole: its sentence's stops go where the quote has none ("Delaware." for "New York").
  const q = quote.trim()
  if (/[\p{L}\p{N}]$/u.test(q)) passage = passage.replace(/[.,;:!?]+$/, '')
  if (/^[\p{L}\p{N}]/u.test(q)) passage = passage.replace(/^[.,;:!?]+/, '')
  return passage.length > MAX_COUNTERPART ? null : passage
}

/**
 * The two readings of a version's Word file when it has tracked changes;
 * null when it has none — or when the file can't be read now, and its values
 * are then read as before (the page still says the file has changes).
 */
export async function versionTrackedViews(contractId: string, versionId: string): Promise<TrackedViews | null> {
  const v = await prisma.contractVersion.findFirst({ where: { id: versionId, contractId }, select: { s3Key: true, mimeType: true, metadata: true } })
  if (!v?.s3Key || v.mimeType !== MIME.DOCX) return null
  // Counted when the file was read; a file read before that is counted now,
  // so re-analysing an older contract splits its values too (and its page says why).
  const counted = (v.metadata as { trackedChanges?: unknown } | null)?.trackedChanges !== undefined
  if (counted && !trackedChangesOf(v.metadata)) return null
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: v.s3Key }))
    const file = Buffer.from(await obj.Body!.transformToByteArray())
    if (!counted) {
      const tracked = await readTrackedChanges(file)
      await prisma.$executeRaw`UPDATE contract_versions SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{trackedChanges}', ${JSON.stringify(tracked)}::jsonb) WHERE id = ${versionId}`
      if (!tracked.insertions && !tracked.deletions) return null
    }
    return await viewsOf(file)
  } catch (err) {
    console.warn('[tracked-changes] the file of versionId=%s could not be read again; its values are read as the file shows them: %s', versionId, (err as Error).message)
    return null
  }
}
