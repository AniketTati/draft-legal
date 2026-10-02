/**
 * docs/41 Part 13 — drafting an amendment from what changes.
 *
 *   1. A person picks the parent's clauses (replace or delete) and key terms
 *      (a new value) that change.
 *   2. For a clause, the AI may draft the new words from the person's
 *      instruction (lib/clause-propose.ts, the redline proposer); the parent's
 *      words go with it as the evidence, and the person edits it before the
 *      amendment is made. A term's change is written deterministically.
 *   3. The amendment's operative language is built here, deterministically,
 *      around those words ("Section 5.1 of the Agreement is deleted and
 *      replaced with the following: …"), inside the org's amendment template
 *      when it has one ({{amendment_changes}} marks where), else on its own.
 *   4. Its changes are kept (metadata._amendment) for the amendment redline,
 *      the parent's effective view and the roll-up.
 */
import { z } from 'zod'
import { familyLabel, type AmendmentChangeSpec, type DateOrder } from '@clm/types'
import { documentDate, documentValue, type DocumentStyle } from './document-values.js'
import { prisma } from './prisma.js'
import { generateDocument, type TemplateWithSections } from './template-engine.js'
import { redactJson, restorePii } from './pii-policy.js'
import { modelFetch } from './model-boundary.js'
import { effectiveView } from './family.js'
import { diffSequences } from './ooxml/sequence-diff.js'
import { acceptedHtml } from './suggestions.js'

/**
 * What a person picked to change, as the create route takes it. A clause's
 * own words (parentText, type, section) are read from the parent, never
 * taken from the request.
 */
export const AmendmentChangesSchema = z.array(z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('clause'),
    clauseId: z.string().min(1).max(64),
    action: z.enum(['replace', 'delete']),
    newText: z.string().max(20000).optional(),
    source: z.enum(['ai', 'user']).default('user'),
    instruction: z.string().max(2000).nullable().optional(),
  }),
  z.object({
    kind: z.literal('term'),
    key: z.string().min(1).max(64),
    label: z.string().min(1).max(200),
    from: z.string().max(2000).nullable().optional(),
    to: z.string().min(1).max(2000),
  }),
])).max(40)

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** "Section 5.1", "§5" → "Section 5.1"; a clause with no number is named by its type. */
export function sectionName(sectionRef: string | null, clauseType: string): string {
  const ref = sectionRef?.trim()
  if (ref) return /^(section|clause|article|§)/i.test(ref) ? ref.replace(/^§\s*/, 'Section ') : `Section ${ref}`
  return `the ${clauseType.replace(/_/g, ' ')} clause`
}

/**
 * A term's new (and old) value as the amendment writes it: "USD 300,000",
 * not "300000" (lib/document-values.ts). Done once, when the amendment is
 * made, so its sentence, its redline and the stored change say the same.
 */
export function termChangeAsWritten<T extends { key: string; to: string; from?: string | null }>(ch: T, style: DocumentStyle): T {
  return { ...ch, to: documentValue(ch.key, ch.to, style), from: ch.from ? documentValue(ch.key, ch.from, style) : ch.from ?? null }
}

/** One change as operative words, plain text (pure). */
export function changeSentence(ch: AmendmentChangeSpec): string {
  if (ch.kind === 'term') return `The ${ch.label} is amended to read: ${ch.to}.`
  const where = sectionName(ch.sectionRef, ch.clauseType)
  if (ch.action === 'delete') return `${where[0].toUpperCase()}${where.slice(1)} of the Agreement is deleted in its entirety.`
  return `${where[0].toUpperCase()}${where.slice(1)} of the Agreement is deleted in its entirety and replaced with the following:`
}

/** The changes as an ordered list of operative paragraphs (pure). */
export function changesHtml(changes: AmendmentChangeSpec[]): string {
  const items = changes.map((ch, i) => {
    const head = `<p data-amendment-change="${i}"><strong>${i + 1}.</strong> ${esc(changeSentence(ch))}</p>`
    if (ch.kind === 'clause' && ch.action === 'replace') {
      // An AI draft a person kept says so: suggestion mode can pick it up.
      const ai = ch.source === 'ai' ? ' data-ai-suggested="true"' : ''
      const body = ch.newText.split(/\n{2,}/).map(p => `<p>${esc(p.trim())}</p>`).join('')
      return `${head}<blockquote data-amendment-text="${i}"${ai}>${body}</blockquote>`
    }
    return head
  })
  return items.join('\n')
}

const fmtDate = (d: string | null, order: DateOrder = 'MDY') => d ? documentDate(d.slice(0, 10), order) : '[effective date]'

/**
 * The amendment's document (pure): recitals naming the agreement, the
 * changes, and the usual closing (everything else stays in force).
 */
export function amendmentHtml(input: {
  label: string; parentTitle: string; parentEffectiveDate: string | null; counterpartyName: string | null
  effectiveDate: string | null; changes: AmendmentChangeSpec[]
  /** How the org writes dates. */
  dateOrder?: DateOrder
}): string {
  return [
    `<h1>${esc(input.label)} to ${esc(input.parentTitle)}</h1>`,
    `<p>This ${esc(input.label)} (the “Amendment”) is made effective as of ${esc(fmtDate(input.effectiveDate, input.dateOrder))} and amends the ${esc(input.parentTitle)}`
      + `${input.parentEffectiveDate ? ` dated ${esc(fmtDate(input.parentEffectiveDate, input.dateOrder))}` : ''}`
      + `${input.counterpartyName ? ` between the parties, including ${esc(input.counterpartyName)}` : ''} (the “Agreement”).</p>`,
    `<p>The parties agree to amend the Agreement as follows:</p>`,
    changesHtml(input.changes),
    `<p>Except as amended by this Amendment, the Agreement remains in full force and effect. If this Amendment and the Agreement conflict, this Amendment governs. Capitalised terms not defined here have the meanings given in the Agreement.</p>`,
  ].join('\n')
}

/** The amendment inside the org's template: its sections, with the changes where {{amendment_changes}} is. */
export function amendmentFromTemplate(template: TemplateWithSections, vars: Record<string, string | null>, changes: AmendmentChangeSpec[], style?: DocumentStyle): string {
  const MARK = 'AMENDMENTCHANGESMARK'
  const { html } = generateDocument({ template, variables: { ...vars, amendment_changes: MARK }, style })
  const list = changesHtml(changes)
  const placed = html.replace(new RegExp(`<span data-variable="amendment_changes">${MARK}</span>`, 'g'), list)
  // A template without the marker gets the changes after its last section.
  return placed.includes(list) ? placed : placed.replace(/<\/div>\s*$/, `${list}\n</div>`)
}

/** The org's amendment templates: published ones of type AMENDMENT, the default first. */
export async function amendmentTemplates(orgId: string) {
  return prisma.template.findMany({
    where: { orgId, deletedAt: null, isPublished: true, contractType: 'AMENDMENT' },
    orderBy: [{ isDefaultForType: 'desc' }, { updatedAt: 'desc' }],
    select: { id: true, name: true, isDefaultForType: true },
    take: 20,
  })
}

export interface DraftedLanguage {
  clauseId: string
  sectionRef: string | null
  clauseType: string
  /** The parent's words in effect: the evidence the draft is of. */
  parentText: string
  /** The words of the parent the draft changes, as the model quoted them; only when the clause holds them. */
  quote: string | null
  proposedText: string | null
  rationale: string | null
  error: string | null
}

const AGENTS_URL = process.env.AGENTS_URL ?? 'http://localhost:8002'

/**
 * The AI's draft of new words for each clause a person wants changed, from
 * their instruction (agents /amendment_language) — to be edited before the
 * amendment is made. Each comes back with the parent's words in effect and
 * the part it changes, quoted; a clause it can't draft comes back with its
 * error and no text: the person writes it. The clause goes to the model
 * under the org's PII policy and its values are put back.
 */
export async function draftAmendmentLanguage(orgId: string, parentId: string, items: Array<{ clauseId: string; instruction: string }>): Promise<DraftedLanguage[]> {
  const parent = await prisma.contract.findFirst({ where: { id: parentId, orgId, deletedAt: null }, select: { id: true, type: true, currentVersionId: true } })
  if (!parent) return []
  const view = await effectiveView(orgId, parentId)
  const rows = await prisma.contractClause.findMany({
    where: { id: { in: items.map(i => i.clauseId) }, version: { contractId: parentId, contract: { orgId } } },
    select: { id: true, clauseType: true, sectionRef: true, content: true },
  })
  const picked = items.flatMap(it => {
    const c = rows.find(r => r.id === it.clauseId)
    if (!c) return []
    const text = view?.sections.find(x => x.clauseId === c.id)?.text || c.content
    return [{ ...it, clause: c, text }]
  })
  const out: DraftedLanguage[] = picked.map(p => ({
    clauseId: p.clauseId, sectionRef: p.clause.sectionRef, clauseType: p.clause.clauseType, parentText: p.text,
    quote: null, proposedText: null, rationale: null, error: 'No draft came back',
  }))
  if (!picked.length) return out
  const document = parent.currentVersionId
    ? (await prisma.contractVersion.findUnique({ where: { id: parent.currentVersionId }, select: { plainText: true } }))?.plainText ?? ''
    : ''
  const source = [...picked.map(p => p.text), document]
  const redacted = await redactJson(orgId, { texts: picked.map(p => p.text) }, {
    surface: 'amendment_language', contractId: parentId, roundTrip: parentId, valuesFrom: source,
  })
  const res = await modelFetch(`${AGENTS_URL}/amendment_language`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body: JSON.stringify({
      orgId, contractType: parent.type,
      items: picked.map((p, i) => ({ clauseId: p.clauseId, clauseText: redacted.texts[i], clauseType: p.clause.clauseType, sectionRef: p.clause.sectionRef, instruction: p.instruction })),
    }),
  }, { orgId, surface: 'amendment_language', contractId: parentId }).catch(() => null)
  if (!res?.ok) return out.map(o => ({ ...o, error: 'The drafting service didn’t answer: write the new words yourself' }))
  const body = restorePii(await res.json() as { drafts?: Array<{ clauseId: string; proposedText: string | null; rationale: string | null; quote: string | null; error: string | null }> }, source, parentId)
  return out.map(o => {
    const d = body.drafts?.find(x => x.clauseId === o.clauseId)
    if (!d) return o
    // The quote is the evidence: kept only when the parent's words hold it.
    const quote = d.quote && o.parentText.replace(/\s+/g, ' ').includes(d.quote.replace(/\s+/g, ' ')) ? d.quote : null
    return { ...o, proposedText: d.proposedText, rationale: d.rationale, quote, error: d.proposedText ? null : d.error ?? 'No draft came back' }
  })
}

/** The label an amendment is shown and drafted under. */
export const amendmentTitle = (type: string, n: number | null, parentTitle: string) =>
  `${familyLabel(type, n) ?? 'Amendment'} to ${parentTitle}`

/**
 * Pure: the parent's obligations that came from a clause an amendment
 * replaces or deletes — by section number, or their quote inside the
 * clause's words. The person confirms which are superseded.
 */
export function obligationsReplaced<T extends { id: string; sectionRef: string | null; quote: string }>(
  obligations: T[], changes: AmendmentChangeSpec[],
): T[] {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const refKey = (r: string | null) => (r ?? '').toLowerCase().replace(/^(?:§+|sections?|clauses?|articles?)\s*/, '').replace(/[\s.:)]+$/g, '').trim()
  const clauses = changes.filter((c): c is Extract<AmendmentChangeSpec, { kind: 'clause' }> => c.kind === 'clause')
  return obligations.filter(o => clauses.some(c =>
    (c.sectionRef && o.sectionRef && refKey(o.sectionRef) === refKey(c.sectionRef))
    || (o.quote.trim().length >= 20 && norm(c.parentText).includes(norm(o.quote)))))
}

// ─── Amendment redline ───────────────────────────────────────────────────────

export interface RedlineSegment { op: 'equal' | 'delete' | 'insert'; text: string }

/** Pure: word-level marks from the parent's words to the proposed ones, runs merged. */
export function redlineSegments(from: string, to: string): RedlineSegment[] {
  // A word keeps the space after it: a change reads "thirty (30) days" → "forty-five (45) days", not word by word.
  const tok = (s: string) => s.match(/^\s+|\S+\s*/g) ?? []
  const ops = diffSequences(tok(from), tok(to), x => x)
  const out: RedlineSegment[] = []
  for (const o of ops) {
    const seg: RedlineSegment = o.kind === 'equal' ? { op: 'equal', text: o.b } : o.kind === 'delete' ? { op: 'delete', text: o.a } : { op: 'insert', text: o.b }
    const last = out[out.length - 1]
    if (last && last.op === seg.op) last.text += seg.text
    else out.push(seg)
  }
  return out
}

/**
 * Pure: the words a person has since written for each change, read from the
 * amendment's current document (the blockquote the draft put each one in),
 * so the redline shows what is being signed, not the first draft.
 */
export function proposedTextsFromHtml(html: string): Map<number, string> {
  const out = new Map<number, string>()
  const re = /<blockquote[^>]*data-amendment-text="(\d+)"[^>]*>([\s\S]*?)<\/blockquote>/g
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const text = m[2].replace(/<\/p>\s*<p[^>]*>/g, '\n\n').replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    out.set(Number(m[1]), text.trim())
  }
  return out
}

// ─── Finding each change's words without the marker (fix-up 14) ──────────────
//
// The editor's save (working copy → version) keeps a blockquote but not its
// data-amendment-text attribute, may turn it into plain paragraphs, and a
// suggestion wraps words in <ins>/<del>. So the words are found from the
// text as well: after the change's own operative sentence ("Section 5 of the
// Agreement is deleted … and replaced with the following:"), which is built
// from the stored change, up to the next change or the block that followed
// the changes when it was drafted (kept on the record as `endsBefore`).

const decodeEntities = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')

/** Pure: a document's blocks (paragraphs, quotes, list items, headings) as plain text, in order. */
export function documentBlocks(html: string): string[] {
  return decodeEntities(html.replace(/<\/(?:p|blockquote|li|h[1-6]|div|tr|td)>|<br\s*\/?>/gi, '\n\n').replace(/<[^>]+>/g, ''))
    .split(/\n{2,}/).map(b => b.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

/** "1. Section 5 of the Agreement … following:" → "section 5 of the agreement … following". */
const normBlock = (s: string) => s.toLowerCase().replace(/^\s*\d+\s*[.)]\s*/, '').replace(/[“”"‘’']/g, '')
  .replace(/\s+/g, ' ').replace(/[\s:.]+$/, '').trim()

/** A numbered operative line ("2. The Expiry date is amended …"), even one a person reworded. */
const looksLikeChange = (block: string) => /^\d+\s*[.)]\s/.test(block) && /of the agreement|is amended to read/i.test(block)

/** Where each change's operative sentence is among the blocks (-1: not found). */
function changeHeadings(changes: AmendmentChangeSpec[], norms: string[]): number[] {
  return changes.map(ch => {
    const head = normBlock(changeSentence(ch))
    let k = norms.indexOf(head)
    if (k < 0) k = norms.findIndex(n => n.includes(head))
    if (k < 0 && ch.kind === 'clause' && ch.action === 'replace') {
      // A reworded sentence still names the section and says it is replaced.
      const where = `${normBlock(sectionName(ch.sectionRef, ch.clauseType))} of the agreement`
      k = norms.findIndex(n => n.includes(where) && n.includes('replace'))
    }
    return k
  })
}

/**
 * Pure: the first words of the block after the changes as drafted, kept on
 * the amendment's record so a later read knows where the last change's words
 * end in a template that has no "Except as amended" closing.
 */
export function closingAfterChanges(html: string, changes: AmendmentChangeSpec[]): string | null {
  const blocks = documentBlocks(html)
  const at = changeHeadings(changes, blocks.map(normBlock))
  const last = Math.max(...at, -1)
  if (last < 0) return null
  const ch = changes[at.indexOf(last)]
  const body = ch.kind === 'clause' && ch.action === 'replace' ? ch.newText.split(/\n{2,}/).filter(p => p.trim()).length : 0
  const next = blocks[last + 1 + body]
  return next ? normBlock(next).slice(0, 80) : null
}

/**
 * Pure: the words a person has since written for each replaced clause, read
 * from the amendment's current document with every suggestion read as
 * accepted — by the marker while the document keeps it, else by the text.
 * A change found neither way is left out (the redline then shows the words
 * as drafted).
 */
export function proposedTextsFromDocument(
  changes: AmendmentChangeSpec[], html: string | null | undefined, opts: { plainText?: string | null; endsBefore?: string | null } = {},
): Map<number, string> {
  const accepted = acceptedHtml(html ?? '')
  const out = proposedTextsFromHtml(accepted)
  const blocks = accepted.trim()
    ? documentBlocks(accepted)
    : (opts.plainText ?? '').split(/\n{2,}/).map(b => b.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const norms = blocks.map(normBlock)
  const at = changeHeadings(changes, norms)
  const stops = new Set(at.filter(k => k >= 0))
  const closing = opts.endsBefore ? normBlock(opts.endsBefore) : null
  const ends = (k: number) => stops.has(k) || looksLikeChange(blocks[k])
    || (!!closing && norms[k].startsWith(closing))
    || norms[k].startsWith('except as amended by this amendment') || norms[k].startsWith('in witness whereof')
  changes.forEach((ch, i) => {
    if (out.has(i) || ch.kind !== 'clause' || ch.action !== 'replace' || at[i] < 0) return
    const body: string[] = []
    for (let k = at[i] + 1; k < blocks.length && !ends(k); k++) body.push(blocks[k])
    if (body.length) out.set(i, body.join('\n\n'))
  })
  return out
}

export interface AmendmentRedlineItem {
  index: number
  kind: 'clause' | 'term'
  /** "Section 5.1", or the term's name. */
  name: string
  action: 'replace' | 'delete' | 'set'
  /** The parent's words (or value) in effect now, without this amendment. */
  current: string
  proposed: string
  segments: RedlineSegment[]
}

/** Pure: each change as the parent's effective words against the proposed ones. */
export function amendmentRedlineItems(
  changes: AmendmentChangeSpec[], effectiveText: (clauseId: string, sectionRef: string | null) => string | null, edited: Map<number, string>,
): AmendmentRedlineItem[] {
  return changes.map((ch, index) => {
    if (ch.kind === 'term') {
      const current = ch.from ?? ''
      return { index, kind: 'term', name: ch.label, action: 'set', current, proposed: ch.to, segments: redlineSegments(current, ch.to) }
    }
    const current = effectiveText(ch.clauseId, ch.sectionRef) ?? ch.parentText
    const proposed = ch.action === 'delete' ? '' : edited.get(index) ?? ch.newText
    const name = sectionName(ch.sectionRef, ch.clauseType)
    return { index, kind: 'clause', name: name[0].toUpperCase() + name.slice(1), action: ch.action, current, proposed, segments: redlineSegments(current, proposed) }
  })
}

// ─── Obligations an amendment replaced ───────────────────────────────────────

export interface ReplacedBy { contractId: string; label: string }

/**
 * Fix-up 13 — each superseded obligation with the amendment that replaced it
 * ("Amendment No. 2"), so a list shows "Replaced by Amendment No. 2" rather
 * than Open. Obligations still owed get `replacedBy: null`.
 */
export async function withReplacedBy<T extends { supersededById: string | null }>(orgId: string, items: T[]): Promise<Array<T & { replacedBy: ReplacedBy | null }>> {
  const ids = [...new Set(items.map(o => o.supersededById).filter((x): x is string => !!x))]
  const rows = ids.length
    ? await prisma.contract.findMany({ where: { id: { in: ids }, orgId }, select: { id: true, relationshipType: true, amendmentNumber: true } })
    : []
  const label = new Map(rows.map(r => [r.id, familyLabel(r.relationshipType, r.amendmentNumber) ?? 'an amendment']))
  return items.map(o => ({
    ...o,
    replacedBy: o.supersededById ? { contractId: o.supersededById, label: label.get(o.supersededById) ?? 'an amendment' } : null,
  }))
}

/** Fix-up 13 — the status a list or export shows for an obligation an amendment replaced. */
export const replacedStatus = (r: ReplacedBy | null, status: string) => r ? `Replaced by ${r.label}` : status
