/**
 * docs/39 H1 — variables in a template's own paper.
 *
 * Variables were typed by hand as {{key}}, and a Word file brought in as a
 * template came with none: its placeholders — "[Customer Name]",
 * "«Effective Date»", "Fees: ________" — stayed plain text. These are found
 * here, each suggested as a variable with a name, a key, a type and the field
 * it most likely fills, and the text is rewritten with {{key}} where the
 * author takes one. A {{key}} typed before but missing from the list is
 * suggested too (a camelCase one renamed to the snake_case keys the API
 * takes). Everything works on a section's HTML, only between its tags.
 */
import { fieldKeyFromLabel } from './fields'
import type { CatalogField } from './field-query'
import type { VariableType } from './templates'
import { suggestImportTarget } from './contract-import'

export interface SuggestedVariable {
  key: string
  label: string
  type: VariableType
  /** The placeholder as the HTML has it, each spelling once ("[Customer Name]", "[CUSTOMER NAME]"). */
  matches: string[]
  /** Times it appears, across the sections. */
  count: number
  /** Only {{key}} tokens already written as the engine reads them: nothing to rewrite, only to list. */
  token: boolean
  /** The list has a variable by this name already: its placeholders are rewritten to it, nothing is added. */
  listed: boolean
  /** The field its value most likely fills (the import's header names, A16). */
  field: string | null
}

/** A {{key}} as the engine fills it; `{{ key }}` (spaces) it doesn't, so it's read too, to be tidied. */
const TOKEN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g
/** [Customer Name], [insert date] — words in square brackets. */
const BRACKETS = /\[([A-Za-z][^[\]<>]{0,60}?)\]/g
/** «Customer Name», <<Customer Name>> (as HTML writes it: &lt;&lt;…&gt;&gt;) — a Word merge field. */
const MERGE = /«([^«»<>]{1,60})»|&lt;&lt;((?:(?!&gt;).){1,60})&gt;&gt;/g
/** "Fees: ________", "Effective Date: [●]" — a blank with its label just before it. */
const BLANK = /([A-Z][A-Za-z0-9 &'’./()-]{0,60}?)\s*:\s*(_{4,}|\[\s*[•●·*_.]+\s*\])/g

/** Brackets that aren't placeholders. */
const NOT_A_PLACEHOLDER = /^(reserved|intentionally\s+(left\s+)?(blank|omitted)|sic|note|draft|n\/a|signature\s+page\s+follows?|remainder\s+of\s+page\s+intentionally\s+left\s+blank)$/i
/** Signature-block blanks are filled at signing, not when drafting. */
const SIGNING = /^(by|name|title|signature|signed|date|print\s+name|position|witness)$/i

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')

/** Words a name keeps in capitals, however a key or a placeholder spells them (po_number → PO number). */
const ACRONYMS = new Set(['po', 'id', 'ip', 'eu', 'uk', 'vat', 'gst', 'sla', 'nda', 'msa', 'sow', 'dpa', 'ceo', 'cfo', 'cto', 'hr', 'kpi', 'sku', 'crm', 'erp', 'api', 'url', 'usd', 'eur', 'gbp'])

/** "[insert the Customer's Name]" → "Customer's name": a placeholder's words as a label. */
export function labelFromPlaceholder(words: string): string {
  const w = decode(words).replace(/\s+/g, ' ').trim()
    .replace(/^(please\s+)?(insert|enter|add|state|specify|type)\s+(the\s+|a\s+|an\s+)?/i, '')
    .replace(/[.:;,]+$/, '')
  // Sentence case, acronyms (VAT, PO) kept.
  return w.split(' ').filter(Boolean).map((word, i) => {
    if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase()
    if (word.length <= 4 && word === word.toUpperCase() && /[A-Z]/.test(word)) return word
    const lower = word.toLowerCase()
    return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
  }).join(' ')
}

/** The type a variable's name suggests: a date, a number, else text. */
export function variableTypeFor(label: string): VariableType {
  if (/\b(date|dated|day|effective|commencement|commences|expir\w*|start|end|signed\s+on|deadline)\b/i.test(label)) return 'date'
  if (/\b(amount|fees?|price|value|cost|sum|number\s+of|no\.\s+of|count|quantity|days|weeks|months|years|percent(age)?|rate|cap)\b/i.test(label)) return 'number'
  return 'text'
}

/** The text runs of some HTML (between its tags), each with where it starts. */
function textRuns(html: string): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = []
  const re = /<[^>]*>/g
  let last = 0
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m.index > last) out.push({ text: html.slice(last, m.index), at: last })
    last = m.index + m[0].length
  }
  if (last < html.length) out.push({ text: html.slice(last), at: last })
  return out
}

/** A blank's label: the last few words before it, in its own sentence. */
const blankLabel = (words: string) => labelFromPlaceholder((words.split(/[.;!?]\s+/).pop() ?? words).split(' ').slice(-5).join(' '))

/**
 * The placeholders in a template's sections, as suggested variables: one per
 * key (its spellings together). One named like a listed variable is rewritten
 * to it; a {{key}} the list has, written as the engine reads it, is left alone.
 */
export function suggestTemplateVariables(
  sections: readonly string[],
  listed: ReadonlyArray<{ key: string; label?: string }>,
  catalog: readonly CatalogField[] = [],
): SuggestedVariable[] {
  const listedKey = new Map<string, string>()
  for (const v of listed) {
    listedKey.set(v.key, v.key)
    if (v.label) listedKey.set(fieldKeyFromLabel(v.label), v.key)
  }
  const byKey = new Map<string, SuggestedVariable>()
  const add = (label: string, match: string, token = false, ownKey?: string) => {
    if (!label) return
    const derived = ownKey ?? fieldKeyFromLabel(label)
    const key = listedKey.get(derived) ?? derived
    const found = byKey.get(key)
    if (found) {
      found.count++
      if (!found.matches.includes(match)) found.matches.push(match)
      found.token &&= token
      return
    }
    const target = suggestImportTarget(label, catalog)
    byKey.set(key, {
      key, label, type: variableTypeFor(label), matches: [match], count: 1, token, listed: listedKey.has(derived),
      field: target?.kind === 'field' ? target.key : null,
    })
  }
  for (const html of sections) {
    for (const run of textRuns(html)) {
      for (const m of run.text.matchAll(TOKEN)) {
        const key = m[1]
        const exact = m[0] === `{{${key}}}`
        // Listed and written as the engine reads it: nothing to do.
        if (exact && listedKey.get(key) === key) continue
        const label = labelFromPlaceholder(key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'))
        const snake = fieldKeyFromLabel(label)
        // A snake_case key written exactly only needs listing; a camelCase or spaced one is rewritten.
        add(label, m[0], exact && snake === key, snake === key ? key : snake)
      }
      for (const m of run.text.matchAll(BRACKETS)) {
        if (NOT_A_PLACEHOLDER.test(m[1].trim()) || /^[•●·*_.\s]+$/.test(m[1])) continue
        add(labelFromPlaceholder(m[1]), m[0])
      }
      for (const m of run.text.matchAll(MERGE)) add(labelFromPlaceholder(m[1] ?? m[2]), m[0])
      for (const m of run.text.matchAll(BLANK)) {
        const label = blankLabel(m[1])
        if (!label || SIGNING.test(label)) continue
        // Only the blank is the placeholder: the label stays in the text.
        add(label, m[2])
      }
    }
  }
  return [...byKey.values()]
}

/**
 * The HTML with each chosen placeholder made its variable's {{key}} (only
 * between tags), and a spaced or renamed {{key}} rewritten as the engine
 * reads it. Blanks that look alike ("____") are each one variable's: a blank
 * is rewritten only where its label (the words before it) is that variable's.
 */
export function applyTemplateVariables(html: string, picks: ReadonlyArray<Pick<SuggestedVariable, 'key' | 'label' | 'matches' | 'token'>>): string {
  let out = ''
  let last = 0
  for (const run of textRuns(html)) {
    out += html.slice(last, run.at)
    let text = run.text
    for (const p of picks) {
      if (p.token) {
        text = text.replace(TOKEN, (m, key: string) => (key === p.key ? `{{${key}}}` : m))
        continue
      }
      for (const match of p.matches) {
        if (/^(_{4,}|\[\s*[•●·*_.]+\s*\])$/.test(match)) {
          text = text.replace(BLANK, (whole, words: string, blank: string) =>
            blank === match && blankLabel(words) === p.label ? whole.slice(0, whole.length - blank.length) + `{{${p.key}}}` : whole)
        } else {
          text = text.split(match).join(`{{${p.key}}}`)
        }
      }
    }
    out += text
    last = run.at + run.text.length
  }
  return out + html.slice(last)
}

/** The {{key}} tokens a template's sections use, each once, in the order they first appear. */
export function templateTokens(sections: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const html of sections) for (const run of textRuns(html)) for (const m of run.text.matchAll(TOKEN)) seen.add(m[1])
  return [...seen]
}

/** Plain words as a section's HTML writes them (its text escaped). */
export const htmlOfText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** How many times plain words appear in a section (between its tags). */
export function countInTemplate(html: string, text: string): number {
  const needle = htmlOfText(text)
  if (!needle) return 0
  let n = 0
  for (const run of textRuns(html)) for (let i = run.text.indexOf(needle); i >= 0; i = run.text.indexOf(needle, i + needle.length)) n++
  return n
}

/** A section with plain words made a variable's {{key}} wherever they appear (between its tags). */
export const replaceInTemplate = (html: string, text: string, key: string) =>
  applyTemplateVariables(html, [{ key, label: '', matches: [htmlOfText(text)], token: false }])
