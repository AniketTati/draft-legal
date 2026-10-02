/**
 * docs/39 H2 — a draft's variables as its Variables panel lists them: each
 * variable once, in the order the text first uses it, with its words (those
 * most of its places have, when an edit made them differ), how many places
 * it has, and whether it's still the template's blank.
 */
import { labelFromPlaceholder, type DateOrder } from '@clm/types'
import type { VariablePlace } from '@/components/editor/VariableMark'

/** GET /contracts/:id/variables — what the server knows of each variable. */
export interface DraftVariable {
  key: string
  label: string
  type: string
  /** The field it fills, as the contract holds it now; null when it fills none. */
  field: {
    key: string
    label: string
    type: string
    value: unknown
    display: string
    hasValue: boolean
    source: string | null
    /** The field holds what the text says (or holds nothing yet). */
    inStep: boolean
  } | null
}

export interface DraftVariables {
  template: { id: string; name: string } | null
  variables: DraftVariable[]
}

export interface VariableRow {
  key: string
  label: string
  /** Its words: those most of its places have (the first place's, on a tie). */
  text: string
  places: VariablePlace[]
  /** Places whose words are different. */
  differs: number
  /** Every place is still the template's blank. */
  unfilled: boolean
  info: DraftVariable | null
}

/** A variable named from its key until the server names it: customer_name → Customer name. */
export function labelOfKey(key: string): string {
  return labelFromPlaceholder(key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_+/g, ' ').trim()) || key
}

export function variableRows(places: VariablePlace[], infos: DraftVariable[] = []): VariableRow[] {
  const byKey = new Map<string, VariablePlace[]>()
  for (const p of places) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p])
  // docs/41 Part 1 — a clause choice's blank (slot_…) isn't a value to type:
  // it is chosen among approved wordings, in the Origin panel.
  return [...byKey.entries()].filter(([key]) => !key.startsWith('slot_')).map(([key, ps]) => {
    const counts = new Map<string, number>()
    for (const p of ps) counts.set(p.text, (counts.get(p.text) ?? 0) + 1)
    let text = ps[0].text
    for (const [t, n] of counts) if (n > (counts.get(text) ?? 0)) text = t
    const info = infos.find(i => i.key === key) ?? null
    return {
      key,
      label: info?.label ?? labelOfKey(key),
      text,
      places: ps,
      differs: ps.filter(p => p.text !== text).length,
      unfilled: ps.every(p => p.unfilled),
      info,
    }
  })
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const isMonth = (word: string) => word.length >= 3 && MONTHS.some(m => m.toLowerCase().startsWith(word.toLowerCase().replace(/\.$/, '').slice(0, 3)))
const ORDINAL = (d: number) => (d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th')

/**
 * The words a field's value takes in the text, written the way the text
 * already writes this variable: a date as "1 June 2026", "June 1st, 2026",
 * "2026-06-01" or "01/06/2026", as the words it replaces were — else the
 * way the org writes dates, in full. Any other value as the field shows it.
 */
export function wordsForField(current: string, field: { value: unknown; display: string }, dateOrder: DateOrder = 'MDY'): string {
  const iso = typeof field.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(field.value) ? field.value : null
  if (!iso) return field.display
  const [y, m, d] = iso.split('-').map(Number)
  const t = current.trim()
  // Its month in full ("June") or short ("Jun", "Jun."), as the words it replaces had it.
  const full = (word: string) => MONTHS.some(n => n.toLowerCase() === word.toLowerCase())
  const name = (like: string) => (full(like) ? MONTHS[m - 1] : MONTHS[m - 1].slice(0, 3))
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return iso
  let at = /^(\d{1,2})(st|nd|rd|th)?\s+([A-Za-z]+\.?),?\s+\d{4}$/.exec(t)
  if (at && isMonth(at[3])) return `${d}${at[2] ? ORDINAL(d) : ''} ${name(at[3])} ${y}`
  at = /^([A-Za-z]+\.?)\s+(\d{1,2})(st|nd|rd|th)?,?\s+\d{4}$/.exec(t)
  if (at && isMonth(at[1])) return `${name(at[1])} ${d}${at[3] ? ORDINAL(d) : ''}, ${y}`
  at = /^(\d{1,2})([/.-])(\d{1,2})\2\d{4}$/.exec(t)
  if (at) {
    const pad = (n: number) => (at![1].length === 2 || at![3].length === 2 ? String(n).padStart(2, '0') : String(n))
    return dateOrder === 'DMY' ? `${pad(d)}${at[2]}${pad(m)}${at[2]}${y}` : `${pad(m)}${at[2]}${pad(d)}${at[2]}${y}`
  }
  return dateOrder === 'DMY' ? `${d} ${MONTHS[m - 1]} ${y}` : `${MONTHS[m - 1]} ${d}, ${y}`
}

/** The words a variable's value is written with in a version's note: short, quoted. */
export function noteOf(label: string, text: string, places: number): string {
  const words = text.length > 60 ? `${text.slice(0, 57)}…` : text
  return `Changed ${label} to “${words}”${places > 1 ? ` (${places} places)` : ''}`
}
