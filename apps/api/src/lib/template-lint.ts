/**
 * docs/41 Part 2 — template lint: a template checked against the org's own
 * playbook when it is published, so a template that says what the playbook
 * only falls back to is a problem for its owner, once — not a finding on
 * every contract drafted from it.
 *
 * Deterministic; no LLM. Each section (each variant of a clause slot) is
 * compared with the playbook positions that apply to the template's type:
 *   - the same words as a position, or a slot variant a position names
 *     (PlaybookPosition.libraryItemId): the section IS that position;
 *   - a term in years (filled with the template's defaults) equal to one
 *     position's figure and not to the preferred one's, in a section about
 *     that position's subject (Confidentiality term 3 years vs 5);
 *   - a structured bound in years on a position (rules.bounds), judged by
 *     lib/playbook-rules.ts.
 * A section that is the preferred or an acceptable position is fine.
 */
import type { PositionType } from '@clm/types'
import { prisma } from './prisma.js'
import { htmlToText } from './html-text.js'
import { numeralized } from './liability-cap.js'
import { evaluateNumericBound, yearBounds, type PlaybookRules } from './playbook-rules.js'
import { normalisedKey } from './clause-category.js'
import type { TemplateSnapshot } from './template-snapshot.js'

export interface LintWarning {
  sectionId: string
  sectionTitle: string
  variantId?: string
  variantLabel?: string
  severity: 'warning' | 'error'
  code: 'fallback_position' | 'walkaway_position' | 'below_bound' | 'slot_without_wording'
  message: string
  positionId?: string
  positionType?: PositionType
}

export interface LintPosition {
  id: string
  positionType: string
  content: string
  contractTypes: string[]
  libraryItemId: string | null
  rules: unknown
  category: { id: string; name: string }
}

const OK_TYPES = new Set(['preferred', 'acceptable'])
const STOP = new Set(['and', 'the', 'with', 'from', 'other', 'miscellaneous', 'notices', 'interpretation', 'excused', 'events'])

/** Words compared as wording: tags, case, spacing and punctuation aside. */
const wording = (html: string) => htmlToText(html).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** The first term in years the words state ("3-year", "three (3) years"). */
export function yearsIn(text: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*-?\s*(?:years?|yrs?)\b/i.exec(numeralized(text))
  return m ? Number(m[1]) : null
}

/** Stems a category's subject is recognised by in a section: "Confidentiality" → confiden. */
function subjectStems(categoryName: string): string[] {
  return normalisedKey(categoryName.replace(/&/g, ' ')).split(' ').filter(w => w.length > 3 && !STOP.has(w)).map(w => w.slice(0, 8))
}

/** A section's words with the template's defaults put in, so "{{confidentialityYears}} years" reads as "3 years". */
function withDefaults(html: string, variables: unknown[]): string {
  const defaults = new Map((variables as Array<{ key?: string; defaultValue?: unknown }>).filter(v => v?.key && v.defaultValue != null && String(v.defaultValue).trim()).map(v => [v.key!, String(v.defaultValue)]))
  return html.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (m, key: string) => defaults.get(key) ?? m)
}

export function lintSnapshot(snapshot: TemplateSnapshot, positions: LintPosition[]): LintWarning[] {
  const applicable = positions.filter(p => !p.contractTypes.length || (snapshot.contractType && p.contractTypes.includes(snapshot.contractType)))
  const out: LintWarning[] = []
  for (const section of [...snapshot.sections].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (section.slot && !section.slot.variants.length) {
      out.push({
        sectionId: section.id, sectionTitle: section.title, severity: 'warning', code: 'slot_without_wording',
        message: `“${section.title}” has no approved wording yet, so every draft will ask for it.`,
      })
      continue
    }
    const texts = section.slot
      ? section.slot.variants.map(v => ({ html: v.content, variantId: v.id, variantLabel: v.label }))
      : [{ html: section.content, variantId: undefined, variantLabel: undefined }]
    for (const t of texts) {
      const html = withDefaults(t.html, snapshot.variables)
      const plain = htmlToText(html).toLowerCase()
      const where = { sectionId: section.id, sectionTitle: section.title, ...(t.variantId && { variantId: t.variantId, variantLabel: t.variantLabel }) }
      const name = t.variantLabel ? `“${section.title}” (${t.variantLabel})` : `“${section.title}”`

      // 1. The same words as a position, or the variant a position names.
      const same = applicable.find(p => (t.variantId && p.libraryItemId === t.variantId) || (p.content.trim() && wording(p.content) === wording(html)))
      if (same) {
        if (!OK_TYPES.has(same.positionType)) {
          out.push({
            ...where, severity: same.positionType === 'walkaway' ? 'error' : 'warning',
            code: same.positionType === 'walkaway' ? 'walkaway_position' : 'fallback_position',
            message: `${name} uses your ${same.positionType} position for ${same.category.name}, not your preferred one.`,
            positionId: same.id, positionType: same.positionType as PositionType,
          })
        }
        continue
      }

      // 2. A term in years, against the positions about the same subject.
      const years = yearsIn(plain)
      if (years == null) continue
      const byCategory = new Map<string, LintPosition[]>()
      for (const p of applicable) {
        if (!subjectStems(p.category.name).some(stem => new RegExp(`\\b${stem}`).test(plain))) continue
        byCategory.set(p.category.id, [...(byCategory.get(p.category.id) ?? []), p])
      }
      for (const group of byCategory.values()) {
        const figures = group.map(p => ({ p, years: yearsIn(htmlToText(p.content)) })).filter(x => x.years != null)
        const matches = figures.filter(x => x.years === years)
        const preferred = figures.find(x => x.p.positionType === 'preferred')
        if (matches.length && !matches.some(x => OK_TYPES.has(x.p.positionType))) {
          const worst = matches.find(x => x.p.positionType === 'walkaway') ?? matches[0]
          out.push({
            ...where, severity: worst.p.positionType === 'walkaway' ? 'error' : 'warning',
            code: worst.p.positionType === 'walkaway' ? 'walkaway_position' : 'fallback_position',
            message: `${worst.p.category.name} term of ${years} years is your ${worst.p.positionType} position, not your preferred one${preferred ? ` (${preferred.years} years)` : ''}.`,
            positionId: worst.p.id, positionType: worst.p.positionType as PositionType,
          })
        }
        // 3. A structured bound in years.
        for (const p of group) {
          for (const [, bound] of yearBounds(p.rules as PlaybookRules | null)) {
            const r = evaluateNumericBound(years, { ...bound, units: bound.units ?? 'years' })
            if (!r.passed) {
              out.push({
                ...where, severity: bound.severity === 'walkaway' || bound.severity === 'critical' ? 'error' : 'warning', code: 'below_bound',
                message: `${p.category.name} in ${name}: ${r.reason}${bound.description ? ` (${bound.description})` : ''}.`,
                positionId: p.id, positionType: p.positionType as PositionType,
              })
            }
          }
        }
      }
    }
  }
  // The same warning from two positions of one category is said once.
  const seen = new Set<string>()
  return out.filter(w => { const k = `${w.sectionId}|${w.variantId ?? ''}|${w.message}`; return seen.has(k) ? false : (seen.add(k), true) })
}

/** The org's positions as lint reads them. */
export async function lintPositions(orgId: string): Promise<LintPosition[]> {
  return prisma.playbookPosition.findMany({
    where: { orgId },
    select: { id: true, positionType: true, content: true, contractTypes: true, libraryItemId: true, rules: true, clauseCategory: { select: { id: true, name: true } } },
    orderBy: [{ clauseCategoryId: 'asc' }, { sortOrder: 'asc' }],
  }).then(rows => rows.map(({ clauseCategory, ...p }) => ({ ...p, category: clauseCategory })))
}

export async function lintTemplate(orgId: string, snapshot: TemplateSnapshot): Promise<LintWarning[]> {
  return lintSnapshot(snapshot, await lintPositions(orgId))
}
