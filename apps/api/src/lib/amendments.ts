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
import { familyLabel, type AmendmentChangeSpec } from '@clm/types'
import { prisma } from './prisma.js'
import { generateDocument, type TemplateWithSections } from './template-engine.js'
import { proposeClauseAlternatives } from './clause-propose.js'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** "Section 5.1", "§5" → "Section 5.1"; a clause with no number is named by its type. */
export function sectionName(sectionRef: string | null, clauseType: string): string {
  const ref = sectionRef?.trim()
  if (ref) return /^(section|clause|article|§)/i.test(ref) ? ref.replace(/^§\s*/, 'Section ') : `Section ${ref}`
  return `the ${clauseType.replace(/_/g, ' ')} clause`
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

const fmtDate = (d: string | null) => d
  ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  : '[effective date]'

/**
 * The amendment's document (pure): recitals naming the agreement, the
 * changes, and the usual closing (everything else stays in force).
 */
export function amendmentHtml(input: {
  label: string; parentTitle: string; parentEffectiveDate: string | null; counterpartyName: string | null
  effectiveDate: string | null; changes: AmendmentChangeSpec[]
}): string {
  return [
    `<h1>${esc(input.label)} to ${esc(input.parentTitle)}</h1>`,
    `<p>This ${esc(input.label)} (the “Amendment”) is made effective as of ${esc(fmtDate(input.effectiveDate))} and amends the ${esc(input.parentTitle)}`
      + `${input.parentEffectiveDate ? ` dated ${esc(fmtDate(input.parentEffectiveDate))}` : ''}`
      + `${input.counterpartyName ? ` between the parties, including ${esc(input.counterpartyName)}` : ''} (the “Agreement”).</p>`,
    `<p>The parties agree to amend the Agreement as follows:</p>`,
    changesHtml(input.changes),
    `<p>Except as amended by this Amendment, the Agreement remains in full force and effect. If this Amendment and the Agreement conflict, this Amendment governs. Capitalised terms not defined here have the meanings given in the Agreement.</p>`,
  ].join('\n')
}

/** The amendment inside the org's template: its sections, with the changes where {{amendment_changes}} is. */
export function amendmentFromTemplate(template: TemplateWithSections, vars: Record<string, string | null>, changes: AmendmentChangeSpec[]): string {
  const MARK = 'AMENDMENTCHANGESMARK'
  const { html } = generateDocument({ template, variables: { ...vars, amendment_changes: MARK } })
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
  /** The parent's words: the evidence the draft is of. */
  parentText: string
  proposedText: string | null
  rationale: string | null
  error: string | null
}

/**
 * The AI's draft of new words for each clause a person wants changed, from
 * their instruction — to be edited before the amendment is made. A clause
 * the proposer can't draft comes back with its error and no text: the
 * person writes it.
 */
export async function draftAmendmentLanguage(orgId: string, parentId: string, items: Array<{ clauseId: string; instruction: string }>): Promise<DraftedLanguage[]> {
  const out: DraftedLanguage[] = []
  for (const it of items) {
    const r = await proposeClauseAlternatives({ contractId: parentId, orgId, clauseId: it.clauseId, instructions: it.instruction })
    if (!r.ok) {
      const clause = await prisma.contractClause.findFirst({ where: { id: it.clauseId, version: { contractId: parentId } }, select: { content: true, sectionRef: true, clauseType: true } })
      out.push({ clauseId: it.clauseId, sectionRef: clause?.sectionRef ?? null, clauseType: clause?.clauseType ?? 'other', parentText: clause?.content ?? '', proposedText: null, rationale: null, error: r.detail })
      continue
    }
    // The middle variant when there are three (the balanced one), else the first.
    const v = r.data.variants.find(x => /balanced|moderate/i.test(x.aggression)) ?? r.data.variants[0]
    out.push({
      clauseId: it.clauseId, sectionRef: r.data.clause.sectionRef, clauseType: r.data.clause.clauseType,
      parentText: r.data.clause.originalText, proposedText: v?.proposedText ?? null, rationale: v?.rationale ?? null,
      error: v ? null : (r.data.error ?? 'No draft came back'),
    })
  }
  return out
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
