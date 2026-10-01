/**
 * docs/41 P1 (Part 2) — "this clause is our template's words, unchanged",
 * decided by comparing text, not by asking a model.
 *
 * An NDA drafted from our own template, Purpose untouched, was called weak:
 * the only verdict on screen came from a model reading the paragraph with no
 * idea it was ours. Generation now stamps each section it writes with a
 * fingerprint of its words, variables left as `{{key}}` placeholders
 * (template-engine.ts: `data-fp`, and `data-source` naming the template,
 * its version and the section, or the library item). Review checks each
 * section of the generated version against the version under review: a
 * section whose words are all still there, in order (with whatever values
 * its variables have now), is unchanged, and a clause inside it is
 * **Standard**: it isn't sent to a model for an opinion, and it isn't
 * flagged. Only the clauses that changed, or that the template never had,
 * go to the position check.
 *
 * The shared contract with drafting (the other half of Workstream B):
 *   - `data-fp` = sha256 of the normalised text with variables as `{{key}}`;
 *   - `data-source` = `template:<templateId>:<version>:<sectionId>` or
 *     `library:<itemId>:<version>`;
 *   - `metadata._origin.sections[] = { sectionId | slot, fp, source }`.
 */
import { createHash } from 'node:crypto'
import { htmlToText } from './html-text.js'
import { fold } from './ooxml/sequence-diff.js'

/** Text as compared: Unicode-folded, quotes, dashes and spaces made one kind, whitespace collapsed. */
export function normaliseText(text: string): string {
  return fold(text.normalize('NFKC'))
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The text with each variable's value put back as its `{{key}}`. Longest
 * values first, whole words only, and values under two characters are left
 * alone (a "1" would match every section number).
 */
export function withPlaceholders(text: string, variables: Record<string, unknown> = {}): string {
  const entries = Object.entries(variables)
    .map(([k, v]) => [k, v == null ? '' : normaliseText(String(v))] as const)
    .filter(([, v]) => v.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
  let out = normaliseText(text)
  for (const [key, value] of entries) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(value)}(?![\\p{L}\\p{N}])`, 'gu'), `{{${key}}}`)
  }
  return out
}

/** sha256 (hex) of the normalised text, variables as placeholders. */
export function fingerprint(text: string, variables: Record<string, unknown> = {}): string {
  return createHash('sha256').update(withPlaceholders(text, variables)).digest('hex')
}

/** The fingerprint of a template section's HTML (its `{{key}}` tokens still in it). */
export function sectionFingerprint(html: string): string {
  return fingerprint(htmlToText(html))
}

// ── Reading a generated document's sections ─────────────────────────────────

export interface OriginSection {
  /** template:<id>:<version>:<sectionId> | library:<itemId>:<version> */
  source: string
  fp: string
  /** The section's words with its variables as `{{key}}`, normalised. */
  placeholderText: string
  /** The values its variables had when it was generated. */
  variables: Record<string, string>
  /** The stamped fingerprint is what these words hash to (the HTML wasn't altered). */
  verified: boolean
}

const VARIABLE_SPAN = /<span\b[^>]*\bdata-variable="([a-zA-Z_][a-zA-Z0-9_]*)"[^>]*>([\s\S]*?)<\/span>/g

/** Each `data-variable` span as `{{key}}`, and the values they held. */
export function placeholderHtml(html: string): { html: string; variables: Record<string, string> } {
  const variables: Record<string, string> = {}
  const out = html.replace(VARIABLE_SPAN, (_m, key: string, inner: string) => {
    const value = htmlToText(inner).trim()
    // An unfilled variable reads "[[key]]": it has no value to remember.
    if (!(key in variables) && value && value !== `[[${key}]]`) variables[key] = value
    return `{{${key}}}`
  })
  return { html: out, variables }
}

/** The values the document's variables hold now (the first place each appears). */
export function variablesOf(html: string): Record<string, string> {
  return placeholderHtml(html).variables
}

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null

/**
 * Every element of a generated document stamped with a fingerprint, with
 * its text. Elements nest (a library clause inside a section); each is read
 * whole, by walking to its own closing tag.
 */
export function originSections(html: string): OriginSection[] {
  const out: OriginSection[] = []
  const open = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bdata-fp="[0-9a-f]{64}"[^>]*>/g
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const tag = m[0]
    const name = m[1].toLowerCase()
    const fp = attr(tag, 'data-fp')!
    const source = attr(tag, 'data-source') ?? ''
    // Find the matching close tag, counting nested elements of the same name.
    const scan = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi')
    scan.lastIndex = m.index + tag.length
    let depth = 1
    let end = -1
    for (let t = scan.exec(html); t; t = scan.exec(html)) {
      depth += t[1] ? -1 : 1
      if (depth === 0) { end = t.index; break }
    }
    if (end < 0) continue
    const inner = html.slice(m.index + tag.length, end)
    const { html: withKeys, variables } = placeholderHtml(inner)
    const placeholderText = normaliseText(htmlToText(withKeys))
    out.push({ source, fp, placeholderText, variables, verified: fingerprint(placeholderText) === fp })
  }
  return out
}

/** A section's words with the variables' current values in. */
export function filledText(section: Pick<OriginSection, 'placeholderText' | 'variables'>, current: Record<string, string>): string {
  return section.placeholderText.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (whole, key: string) => {
    const v = current[key] ?? section.variables[key]
    return v != null ? normaliseText(v) : whole
  })
}

export interface StandardSpan { source: string; text: string }

/**
 * The generated sections still in `currentText` word for word (with their
 * variables' values as they are now in `currentHtml`): what is still
 * standard.
 */
export function standardSpans(origin: OriginSection[], currentText: string, currentHtml: string): StandardSpan[] {
  const now = normaliseText(currentText)
  const values = variablesOf(currentHtml)
  const out: StandardSpan[] = []
  for (const s of origin) {
    if (!s.verified) continue
    const text = filledText(s, values)
    if (text.length >= 20 && now.includes(text)) out.push({ source: s.source, text })
  }
  // A library clause sits inside its section: the narrower source names it.
  return out.sort((a, b) => a.text.length - b.text.length)
}

/** The span a clause's words lie in, when they lie in one; null when the clause isn't standard. */
export function standardSourceOf(clauseText: string, spans: StandardSpan[]): string | null {
  const t = normaliseText(clauseText)
  if (t.length < 8) return null
  return spans.find(s => s.text.includes(t))?.source ?? null
}

/** `template` or `library`, from a source reference. */
export const provenanceOf = (source: string) => (source.startsWith('library:') ? 'library' : 'template')
