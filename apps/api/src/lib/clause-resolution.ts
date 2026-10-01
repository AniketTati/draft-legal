/**
 * docs/41 Part 1 — deciding a template's clause slots for one draft.
 *
 * Each slot is decided by @clm/types resolveSlot, in a fixed order: the
 * user's choice, a value the request named (matched exactly to a variant's
 * names, with the request's words that named it), the first variant whose
 * condition holds, the family's default. A slot nothing decides is left as a
 * blank listing the approved variants — an open choice, so the draft can't
 * be sent until someone picks one (lib/open-choices.ts).
 */
import { resolveSlot, slotChoiceKey, matchKey, type ConditionFacts, type DraftOrigin, type EvidencedValue, type SlotDecision } from '@clm/types'
import type { TemplateSnapshot } from './template-snapshot.js'

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The sentence of `text` that names one of `names` (whole words, any case); null when none does. */
export function sentenceNaming(text: string | null | undefined, names: string[]): string | null {
  if (!text) return null
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?;])\s+|\n+/)
  for (const name of names.map(n => n.trim()).filter(n => n.length >= 2)) {
    const re = new RegExp(`(^|[^A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}($|[^A-Za-z0-9])`, 'i')
    const hit = sentences.find(s => re.test(s))
    if (hit) return hit.trim().slice(0, 500)
  }
  return null
}

/** Whether `quote` is in `text`, spacing and case aside. */
export function quoteIn(text: string | null | undefined, quote: string | null | undefined): boolean {
  if (!text || !quote?.trim()) return false
  const n = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase()
  return n(text).includes(n(quote))
}

export type SlotResolution = SlotDecision & { sectionId: string; options: Array<{ id: string; label: string }> }

/** The blank an undecided slot leaves in the draft: names the choice and its options. */
export function choiceBlank(familyId: string, familyName: string, options: Array<{ label: string }>): string {
  const key = slotChoiceKey(familyId)
  const list = options.length ? `: ${options.map(o => o.label).join(' · ')}` : ''
  return `<p><span class="template-variable-unfilled" data-variable="${key}" data-key="${key}" data-slot="${escapeHtml(familyId)}">[[Choose ${escapeHtml(familyName.toLowerCase())}${escapeHtml(list)}]]</span></p>`
}

export function resolveSlots(input: {
  snapshot: TemplateSnapshot
  /** familyId → variant id the user chose. */
  choices?: Record<string, string>
  /** Values the request named, by key (governingLaw), with the words that named them. */
  requestValues?: Record<string, EvidencedValue | undefined>
  facts?: ConditionFacts
  /** The request's own words: a value is matched to them to quote it. */
  requestText?: string | null
  /** A value with no words in the request to show for it is not used (the request path). */
  requireQuote?: boolean
}): {
  slots: SlotResolution[]
  slotText: Map<string, { html: string; source: string; familyId: string }>
  /** The family key's value each decided slot implies (governingLaw: "New York"), for the draft's fields. */
  impliedValues: Record<string, { value: string; familyId: string }>
} {
  const slots: SlotResolution[] = []
  const slotText = new Map<string, { html: string; source: string; familyId: string }>()
  const impliedValues: Record<string, { value: string; familyId: string }> = {}
  for (const section of input.snapshot.sections) {
    if (!section.slot) continue
    const { family, variants } = section.slot
    const options = [...variants].sort((a, b) => a.order - b.order).map(v => ({ id: v.id, label: v.label }))

    // The request's value for the family's key, quoted from the request's words.
    let asked: EvidencedValue | undefined
    const raw = family.requestKey ? input.requestValues?.[family.requestKey] : undefined
    if (raw && String(raw.value ?? '').trim()) {
      const named = variants.find(v => [v.label, ...v.matchValues].some(n => matchKey(n) === matchKey(raw.value)))
      const quote = raw.quote && (!input.requestText || quoteIn(input.requestText, raw.quote))
        ? raw.quote
        : sentenceNaming(input.requestText, [raw.value, ...(named ? [named.label, ...named.matchValues] : [])])
      if (quote || !input.requireQuote) asked = { ...raw, quote: quote ?? null }
    }

    const decision = resolveSlot({
      family, variants,
      choice: input.choices?.[family.id] ?? null,
      requestValues: family.requestKey && asked ? { [family.requestKey]: asked } : {},
      facts: input.facts,
    })
    slots.push({ ...decision, sectionId: section.id, options })
    const chosen = decision.variantId ? variants.find(v => v.id === decision.variantId) : undefined
    if (chosen) {
      slotText.set(section.id, { html: chosen.content, source: `library:${chosen.id}:${chosen.version}`, familyId: family.id })
      if (family.requestKey) impliedValues[family.requestKey] = { value: chosen.matchValues[0] ?? chosen.label, familyId: family.id }
    } else {
      slotText.set(section.id, { html: choiceBlank(family.id, family.name, options), source: `choice:${family.id}`, familyId: family.id })
    }
  }
  return { slots, slotText, impliedValues }
}

export type { DraftOrigin }
