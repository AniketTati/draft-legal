/**
 * Defined terms (docs/41 Part 10) — deterministic drafting checks on one
 * version's text. No model call: the same text always gives the same result.
 *
 * It reads where terms are defined:
 *   - `"Affiliate" means …`, `"Affiliate" shall mean …`, `"Affiliate": …`
 *   - `Acme Inc. ("Supplier")`, `(each a "Party" and together the "Parties")`
 *   - `hereinafter referred to as "Customer"`
 *   - `Affiliate means …` on its own line inside a Definitions section
 *   - a bolded term in the HTML (`<strong>Affiliate</strong> means …`)
 * with straight AND curly quotes (“ ” ‘ ’), which is what DOCX files carry:
 * the old browser check matched straight quotes only and missed most terms.
 *
 * Then where each is used, and five problems:
 *   - undefined_term        a capitalised term used like a defined one, never defined
 *   - unused_definition     defined but never used (often a deleted clause)
 *   - duplicate_definition  defined twice, the same way or differently
 *   - used_before_defined   first used above its definition
 *   - capitalisation_drift  "confidential information" where "Confidential Information" is defined
 *
 * "Capitalised like a defined term" is where false positives come from, so
 * a term is only suspected after a determiner ("the Deliverables", "such
 * Losses"), never at a sentence start or in a heading, and never when it is
 * a party's or a place's name, a month, a statute, an all-caps word or one
 * of the words every contract capitalises (Section, Schedule, Agreement…).
 *
 * Offsets are into the text given (the version's plainText).
 */

export type DraftingIssueKind =
  | 'undefined_term'
  | 'unused_definition'
  | 'duplicate_definition'
  | 'used_before_defined'
  | 'capitalisation_drift'

export type DraftingSeverity = 'low' | 'medium' | 'high'

export interface DraftingEvidence {
  /** The words around the problem, as the text has them. */
  quote: string
  /** Where the term sits in the text. */
  offset: number
}

export interface DefinedTermIssue {
  kind: DraftingIssueKind
  term: string
  severity: DraftingSeverity
  /** One plain sentence for the reader. */
  message: string
  evidence: DraftingEvidence
  /** How many times it happens, when more than once matters. */
  count?: number
  /** The other place involved: the definition, or the second definition. */
  related?: DraftingEvidence
}

export interface GlossaryEntry {
  term: string
  /** The definition as the text writes it (shortened when long). */
  definition: string
  /** Where the term is written in its (first) definition. */
  offset: number
  uses: number
  firstUseOffset: number | null
}

export interface DefinedTermsResult {
  glossary: GlossaryEntry[]
  issues: DefinedTermIssue[]
}

export interface DefinedTermsOptions {
  /** The version's HTML, for terms marked by bold rather than quotes. */
  html?: string | null
  /** Names the contract already knows (parties, its title): never "undefined terms". */
  knownNames?: string[]
}

interface Definition {
  /** How the text defines it: a parenthesis or "referred to as" names something written just before. */
  form: 'means' | 'paren' | 'section' | 'bold'
  term: string
  offset: number
  /** End of the quoted term, so its own mention isn't counted as a use. */
  end: number
  definition: string
  /** "has the meaning given in Section 2": a pointer, not a second definition. */
  byReference: boolean
  /** A parenthesis: where the words it names start ("Acme Corporation, a Delaware corporation"). */
  namedFrom?: number
}

// ─── Patterns ────────────────────────────────────────────────────────────────

const QO = '["“„«‘]'
const QC = '["”»’]'
// A term: starts with a capital, then words, digits, hyphens, ampersands; up to 60 chars.
const TERM = "[A-Z][A-Za-z0-9&/\\- ]{0,60}?"
const QUOTED_TERM = new RegExp(`${QO}(${TERM})${QC}`, 'g')

const MEANS_RX = new RegExp(
  `${QO}(${TERM})${QC}\\s*,?\\s*(?:(?:shall|will|does|is to)\\s+)?(?:means?|has the meaning|have the meaning|shall have the meaning|is defined as|refers? to|includes?)\\b`,
  'g',
)
// `"Affiliate": any entity …` — a definitions list, at the start of a line.
const COLON_RX = new RegExp(`(?:^|\\n)[ \\t]*(?:\\(?[0-9a-zA-Z]{1,3}(?:\\.[0-9]{1,3})*[.)]?[ \\t]+)?${QO}(${TERM})${QC}[ \\t]*[:–—][ \\t]`, 'g')
const REFERRED_RX = new RegExp(`(?:referred\\s+to\\s+as|called|known\\s+as)\\s+(?:the\\s+|a\\s+|an\\s+)?${QO}(${TERM})${QC}`, 'g')
// A parenthesis holding a quoted, capitalised term: `(the "Agreement")`, `(each a "Party")`.
const PAREN_RX = /\(([^()]{1,220})\)/g
const MARKED_AS = /(?:marked|label(?:l)?ed|stamped|legend|designated|words?|phrase)\s*(?:as\s*)?$/i
const PAREN_REFERENCE = /^\s*(?:as\s+defined|see\b|defined\s+in|within\s+the\s+meaning|as\s+such\s+term)/i
const BY_REFERENCE = /^[\s,]*(?:shall\s+)?ha(?:s|ve)\s+the\s+meaning\s+(?:given|set\s+(?:forth|out)|ascribed|assigned|attributed|provided)/i

const DEFINITIONS_HEADING = /^[ \t]*(?:(?:article|section|clause|part)\s+)?(?:[0-9]{1,2}(?:\.[0-9]{1,2})*\.?|[IVX]{1,5}\.)?[ \t]*(?:definitions(?:\s+and\s+interpretation)?|defined\s+terms|interpretation(?:\s+and\s+definitions)?)[ \t]*\.?[ \t]*$/im
// A new top-level heading ends the definitions section: "2. Services", "ARTICLE 3".
const TOP_HEADING = /^[ \t]*(?:(?:article|section)\s+[0-9IVX]+|[0-9]{1,2}\.|[IVX]{1,5}\.)[ \t]+[A-Z][^\n.]{0,80}$/i
const SECTION_LINE = /^[ \t]*(?:\(?[0-9a-zA-Z]{1,3}(?:\.[0-9]{1,3})*[.)]?[ \t]+)?([A-Z][A-Za-z0-9\- ]{1,50}?),?[ \t]+(?:means|shall mean|has the meaning)\b/

// Defined capitalised words every contract uses without defining them.
const KNOWN_WORDS = new Set([
  'agreement', 'agreements', 'party', 'parties', 'section', 'sections', 'clause', 'clauses', 'article', 'articles',
  'schedule', 'schedules', 'exhibit', 'exhibits', 'annex', 'annexes', 'appendix', 'appendices', 'attachment',
  'attachments', 'recital', 'recitals', 'paragraph', 'paragraphs', 'sub-clause', 'subsection', 'part', 'page',
  'court', 'courts', 'state', 'states', 'government', 'internet', 'board', 'directors', 'officer', 'chief',
  'name', 'title', 'date', 'signature', 'signed', 'address', 'email', 'phone', 'witness', 'whereof', 'by', 'its',
  'dollar', 'dollars', 'euro', 'euros', 'pound', 'pounds', 'sterling', 'rupees', 'god', 'act', 'acts', 'law', 'laws',
  'mr', 'mrs', 'ms', 'dr', 'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'gmbh', 'plc', 'llp',
  'north', 'south', 'east', 'west', 'central', 'federal', 'national', 'international', 'republic', 'kingdom', 'union',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
])
// Places and nationalities: "a Delaware corporation", "the English courts".
const PLACES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia',
  'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland',
  'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'hampshire',
  'jersey', 'mexico', 'york', 'carolina', 'dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode', 'island',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'wisconsin', 'wyoming', 'columbia', 'new',
  'united', 'america', 'american', 'england', 'english', 'wales', 'welsh', 'scotland', 'scottish', 'ireland', 'irish',
  'britain', 'british', 'europe', 'european', 'germany', 'german', 'france', 'french', 'spain', 'spanish', 'italy',
  'italian', 'netherlands', 'dutch', 'belgium', 'belgian', 'switzerland', 'swiss', 'india', 'indian', 'china', 'chinese',
  'japan', 'japanese', 'canada', 'canadian', 'australia', 'australian', 'singapore', 'singaporean', 'brazil',
  'brazilian', 'israel', 'israeli', 'sweden', 'swedish', 'norway', 'denmark', 'finland', 'poland', 'austria', 'luxembourg',
  'portugal', 'greece', 'dubai', 'emirates', 'london', 'paris', 'berlin', 'mumbai', 'delhi', 'bangalore', 'bengaluru',
  'tokyo', 'sydney', 'toronto', 'san', 'francisco', 'los', 'angeles', 'chicago', 'boston', 'seattle', 'nations',
])
// Phrases that end in one of these name a statute or another document, not a term.
const NAMED_THING_END = /\b(?:Act|Acts|Code|Regulations?|Directive|Convention|Treaty|Rules|Statute|Agreement|Addendum|Amendment|Policy|Constitution|Index|Bank|Court|Office|Department|Commission|Authority|Bureau|Agency|Ministry|Council|Tribunal|Exchange|Association|Institute|University|Division)$/
// "this Statement of Work", "This Order Form": the document speaking of itself.
const DOCUMENT_NOUN = /\b(?:Agreement|Contract|Work|Order|Form|Addendum|Amendment|Deed|Lease|Letter|Memorandum|Terms|Statement|Proposal|Quote|Quotation|Licence|License)$/
// A numbered caption run into the text ("4.1 Customer Materials. …", "5.4 No Set-Off Customer shall"):
// the capitalised words right after a clause number are its title.
const CAPTION_BEFORE = /(?:^|\s)(?:\d{1,2}(?:\.\d{1,2})*\.?|\([a-z0-9]{1,3}\)|[A-Z]\.)[ \t]+(?:(?:[A-Z][A-Za-z'’\-]*|of|and|or|for|in|on|&)[ \t]+){0,5}$/
// The capitalised name goes on: "Arbitration and Conciliation Act", "Engineering, Procurement and Construction".
const NAME_GOES_ON = /^(?:[ \t]+(?:and|of|for|&|the|on|in)|,)[ \t]+(?:the[ \t]+)?[A-Z]/
const COMPANY_SUFFIX = /^\s*,?\s*(?:Inc|LLC|L\.L\.C|Ltd|Limited|Corp|Corporation|Co|GmbH|AG|plc|PLC|LLP|LP|S\.A|SA|B\.V|BV|N\.V|Pvt|Pty|SAS|SARL|KG)\b/
const DETERMINERS = ['the', 'this', 'such', 'any', 'each', 'all', 'said', 'these', 'those', 'its', 'their', 'our', 'your', 'every', 'either', 'neither', 'a', 'an', 'no', 'other', 'applicable', 'relevant']
const DET_ALT = DETERMINERS.map(d => `[${d[0].toUpperCase()}${d[0]}]${d.slice(1)}`).join('|')
const TITLE_WORD = "[A-Z][a-z][A-Za-z\\-]*"
const CANDIDATE_RX = new RegExp(`(?<![A-Za-z])(?:${DET_ALT})\\s+(${TITLE_WORD}(?:[ \\t]+(?:of[ \\t]+)?${TITLE_WORD}){0,3})(?:['’]s)?(?![A-Za-z])`, 'g')
// "Capitalised terms not defined here have the meaning in the MSA": used-before is expected.
const DEFINED_ELSEWHERE = /capitali[sz]ed\s+terms[^.]{0,160}(?:meaning|defined)/i
const DEFINED_LATER = /^[^.\n]{0,60}?\b(?:as\s+defined|defined\s+(?:below|herein|in)|see\s+(?:section|clause))/i
const SINGLE_WORD_DRIFT_CUE = /(?:^|[^A-Za-z])(?:the|this|such|said|that|each)\s+$/i

// ─── Text helpers ────────────────────────────────────────────────────────────

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const normTerm = (s: string) => s.replace(/\s+/g, ' ').replace(/[\s,.;:-]+$/, '').trim()
const isAllCaps = (s: string) => /[A-Z]/.test(s) && !/[a-z]/.test(s)

interface Line { start: number; end: number; text: string; heading: boolean }

/** Lines with their offsets; a short, capitalised line with no closing punctuation is a heading. */
function linesOf(text: string): Line[] {
  const out: Line[] = []
  let start = 0
  for (const raw of text.split('\n')) {
    const end = start + raw.length
    const t = raw.trim()
    let heading = false
    if (t && t.length <= 100 && !/[.;,:?!]["”’)]?$/.test(t)) {
      const words = t.replace(/^[(]?[0-9a-zA-Z]{1,3}(?:\.[0-9]{1,3})*[.)]\s*/, '').split(/\s+/).filter(w => /[A-Za-z]/.test(w))
      const minor = new Set(['of', 'and', 'or', 'the', 'to', 'in', 'for', 'on', 'a', 'an', 'by', 'with', '&'])
      const capped = words.filter(w => /^[A-Z("“]/.test(w) || minor.has(w.toLowerCase()))
      heading = words.length > 0 && words.length <= 12 && (isAllCaps(t) || capped.length / words.length >= 0.8)
    }
    out.push({ start, end, text: raw, heading })
    start = end + 1
  }
  return out
}

function lineAt(lines: Line[], offset: number): Line | undefined {
  let lo = 0, hi = lines.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offset < lines[mid].start) hi = mid - 1
    else if (offset > lines[mid].end) lo = mid + 1
    else return lines[mid]
  }
  return undefined
}

/** The words around [from, to): the sentence it is in, at most ~160 chars. */
export function quoteAround(text: string, from: number, to: number, max = 160): string {
  const side = Math.max(20, Math.floor((max - (to - from)) / 2))
  const a0 = Math.max(0, from - side)
  const b0 = Math.min(text.length, to + side)
  let a = a0
  const nl = text.lastIndexOf('\n', from - 1)
  if (nl >= a0) a = nl + 1
  else {
    const stop = /[.;]\s+(?=[^.;]*$)/.exec(text.slice(a0, from))
    if (stop) a = a0 + stop.index + stop[0].length
  }
  let b = b0
  const after = text.slice(to, b0)
  const end = after.search(/\n|[.;](?=\s|$)/)
  if (end >= 0) b = to + end + (after[end] === '\n' ? 0 : 1)
  return text.slice(a, b).replace(/\s+/g, ' ').trim()
}

function shorten(s: string, max = 300): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

/** From the term to the end of its definition: the line, or the sentence when the line runs on. */
function meansBody(text: string, termStart: number): string {
  const rest = text.slice(termStart, termStart + 600)
  const nl = rest.indexOf('\n')
  const unit = nl >= 0 ? rest.slice(0, nl) : rest
  const stop = unit.search(/[.;](?=\s+[A-Z“"(]|\s*$)/)
  return shorten(stop >= 0 ? unit.slice(0, stop + 1) : unit)
}

/** Where the words a parenthetical definition names start: back to the sentence start. */
function parenHeadStart(text: string, parenStart: number): number {
  const from = Math.max(0, parenStart - 240)
  const back = text.slice(from, parenStart)
  const cut = Math.max(back.lastIndexOf('\n'), back.search(/[.;:]\s+[^.;:]*$/))
  if (cut < 0) return from
  const lead = /^[.;:\s]+/.exec(back.slice(cut))
  return from + cut + (lead ? lead[0].length : 1)
}

/** What a parenthetical definition names: the words before the parenthesis, and the parenthesis. */
function parenBody(text: string, parenStart: number, parenEnd: number): string {
  return shorten(`${text.slice(parenHeadStart(text, parenStart), parenStart).trim()} ${text.slice(parenStart, parenEnd)}`)
}

// ─── Definitions ─────────────────────────────────────────────────────────────

function definitionsSectionRange(text: string): [number, number] | null {
  const m = DEFINITIONS_HEADING.exec(text)
  if (!m) return null
  const start = m.index + m[0].length
  let end = Math.min(text.length, start + 20_000)
  let at = start
  for (const raw of text.slice(start, end).split('\n')) {
    if (at > start + 1 && TOP_HEADING.test(raw) && !SECTION_LINE.test(raw)) { end = at; break }
    at += raw.length + 1
  }
  return [start, end]
}

function findDefinitions(text: string, html?: string | null): Definition[] {
  const defs: Definition[] = []
  const add = (form: Definition['form'], term: string, offset: number, definition: string, namedFrom?: number) => {
    const t = normTerm(term)
    if (t.length < 2 || (isAllCaps(t) && /\s/.test(t))) return    // "AS IS", "LIMITATION OF LIABILITY"
    if (defs.some(d => d.term === t && Math.abs(d.offset - offset) <= 3)) return
    const after = text.slice(offset + term.length, offset + term.length + 80).replace(/^["”»’]/, '')
    defs.push({ form, term: t, offset, end: offset + term.length + 1, definition, byReference: BY_REFERENCE.test(after), namedFrom })
  }

  for (const m of text.matchAll(MEANS_RX)) {
    const termAt = m.index! + 1
    add('means', m[1], termAt, meansBody(text, m.index!))
  }
  for (const m of text.matchAll(COLON_RX)) {
    const termAt = m.index! + m[0].indexOf(m[1])
    add('means', m[1], termAt, meansBody(text, termAt - 1))
  }
  for (const m of text.matchAll(PAREN_RX)) {
    const inner = m[1]
    if (PAREN_REFERENCE.test(inner)) continue
    const innerAt = m.index! + 1
    for (const q of inner.matchAll(QUOTED_TERM)) {
      // `(marked "Confidential")` quotes a label; it doesn't define one.
      if (MARKED_AS.test(inner.slice(0, q.index!))) continue
      add('paren', q[1], innerAt + q.index! + 1, parenBody(text, m.index!, m.index! + m[0].length), parenHeadStart(text, m.index!))
    }
  }
  for (const m of text.matchAll(REFERRED_RX)) {
    const termAt = m.index! + m[0].lastIndexOf(m[1])
    add('paren', m[1], termAt, parenBody(text, m.index!, m.index! + m[0].length), parenHeadStart(text, m.index!))
  }

  // Unquoted `Affiliate means …` lines inside a Definitions section.
  const range = definitionsSectionRange(text)
  if (range) {
    let at = range[0]
    for (const raw of text.slice(range[0], range[1]).split('\n')) {
      const m = SECTION_LINE.exec(raw)
      if (m && !new RegExp(`^${QO}`).test(raw.trim().replace(/^\(?[0-9a-zA-Z.]{1,8}[.)]?\s+/, ''))) {
        const termAt = at + raw.indexOf(m[1])
        add('section', m[1], termAt, shorten(raw.trim()))
      }
      at += raw.length + 1
    }
  }

  // A bolded term in the HTML, where the plain text lost the marking.
  if (html) {
    for (const m of html.matchAll(/<(strong|b)\b[^>]{0,200}>([^<]{1,80})<\/\1>/gi)) {
      const inner = m[2].replace(/&nbsp;/g, ' ').trim()
      const term = normTerm(inner.replace(new RegExp(`^${QO}|${QC}$`, 'g'), ''))
      if (!/^[A-Z]/.test(term) || term.length > 60 || defs.some(d => d.term === term)) continue
      const next = html.slice(m.index! + m[0].length, m.index! + m[0].length + 200).replace(/<[^>]{0,200}>/g, '')
      if (!/^\s*["”’]?\s*(?:,\s*)?(?:means|shall mean|has the meaning|:)/.test(next)) continue
      const at = new RegExp(`(?<![A-Za-z])${escapeRx(term)}${QC}?\\s*(?:,\\s*)?(?:means|shall mean|has the meaning|:)`).exec(text)
      if (at) add('bold', term, at.index, meansBody(text, at.index))
    }
  }
  return defs.sort((a, b) => a.offset - b.offset)
}

// ─── Uses ────────────────────────────────────────────────────────────────────

/** The forms a term takes: plural or singular, and the possessive. */
function variantsOf(term: string): string[] {
  const out = new Set([term])
  if (/[^aeiou]y$/.test(term)) out.add(`${term.slice(0, -1)}ies`)
  else if (/(?:s|x|ch|sh)$/.test(term)) out.add(`${term}es`)
  else out.add(`${term}s`)
  if (/ies$/.test(term)) out.add(`${term.slice(0, -3)}y`)
  else if (/[^s]s$/.test(term)) out.add(term.slice(0, -1))
  return [...out].sort((a, b) => b.length - a.length)
}

/** A term's uses. A form that is itself another defined term ("Party" / "Parties") is that term's. */
const termRx = (term: string, flags: string, others: Set<string> = new Set()) =>
  new RegExp(`(?<![A-Za-z0-9])(?:${variantsOf(term).filter(v => v === term || !others.has(v.toLowerCase())).map(escapeRx).join('|')})(?:['’]s)?(?![A-Za-z0-9])`, flags)

const CAP_WORD_BEFORE = /(?:^|[^.;:!?\n(“"‘\s])\s*(?<![A-Za-z])([A-Z][a-z][A-Za-z\-]*)[ \t]+$/
const CAP_WORD_AFTER = /^[ \t]+([A-Z][a-z][A-Za-z\-]*)/

interface Span { from: number; to: number }
const inside = (spans: Span[], from: number, to: number) => spans.some(s => from >= s.from && to <= s.to)

// ─── The checks ──────────────────────────────────────────────────────────────

export function analyseDefinedTerms(text: string, opts: DefinedTermsOptions = {}): DefinedTermsResult {
  const issues: DefinedTermIssue[] = []
  if (!text?.trim()) return { glossary: [], issues }
  const lines = linesOf(text)
  const inCaption = (offset: number) => CAPTION_BEFORE.test(text.slice(Math.max(0, offset - 60), offset))
  // Headings, and numbered captions run into the text, are titles: neither uses nor problems.
  const inHeading = (offset: number) => (lineAt(lines, offset)?.heading ?? false) || inCaption(offset)
  const defs = findDefinitions(text, opts.html)
  const realDefs = defs.filter(d => !d.byReference)

  // Each term once, as first written (case kept); its definitions in order.
  const byKey = new Map<string, Definition[]>()
  for (const d of defs) {
    const k = d.term.toLowerCase()
    byKey.set(k, [...(byKey.get(k) ?? []), d])
  }
  const terms = [...byKey.values()].map(ds => ds[0].term)
  const defMarks: Span[] = defs.map(d => ({ from: d.offset - 1, to: d.end + 1 }))
  // A definition's own wording ("“Services” means the services in Schedule 1").
  const defBodies: Array<Span & { term: string }> = defs.filter(d => d.form !== 'paren')
    .map(d => ({ term: d.term, from: d.offset - 1, to: d.offset - 1 + d.definition.length }))
  // What a parenthesis names ("Reserve Bank of India (the “Lender”)"): a description, not term uses.
  const namedSpans: Span[] = defs.filter(d => d.namedFrom !== undefined).map(d => ({ from: d.namedFrom!, to: d.offset }))
  const termSet = new Set(terms.map(t => t.toLowerCase()))
  const others = (term: string) => new Set([...termSet].filter(t => t !== term.toLowerCase()))
  // Inside a longer name ("Master Services Agreement"): part of a title, not a use of "Services".
  const DET_ONLY = new RegExp(`^(?:${DET_ALT})$`)
  const inName = (from: number, to: number) => {
    const before = CAP_WORD_BEFORE.exec(text.slice(Math.max(0, from - 40), from))
    const after = CAP_WORD_AFTER.exec(text.slice(to, to + 40))
    return !!((before && !DET_ONLY.test(before[1])) || (after && !DET_ONLY.test(after[1])))
  }

  // Exact uses, longest term first, so "Customer" inside "Customer Data" is not a use of "Customer".
  const covered: Span[] = []
  const exactUses = new Map<string, Span[]>()
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    const spans: Span[] = []
    for (const m of text.matchAll(termRx(term, 'g', others(term)))) {
      const from = m.index!, to = from + m[0].length
      if (inside(defMarks, from, to) || inside(covered, from, to) || inHeading(from) || inName(from, to)) continue
      spans.push({ from, to })
    }
    exactUses.set(term, spans)
    covered.push(...spans, ...defs.filter(d => d.term === term).map(d => ({ from: d.offset, to: d.end - 1 })))
  }

  // Uses written in another case ("confidential information" for "Confidential Information").
  const driftUses = new Map<string, Span[]>()
  for (const term of terms) {
    const exact = termRx(term, 'g', others(term))
    const single = !/\s/.test(term)
    const drifts: Span[] = []
    for (const m of text.matchAll(termRx(term, 'gi', others(term)))) {
      const from = m.index!, to = from + m[0].length
      exact.lastIndex = 0
      const e = exact.exec(m[0])
      if (e && e.index === 0 && e[0].length === m[0].length) continue      // written as defined
      if (isAllCaps(m[0]) || inHeading(from) || inside(defMarks, from, to) || inside(covered, from, to)) continue
      // "an initial term of two years (the “Initial Term”)": the words being defined.
      if (inside(namedSpans, from, to)) continue
      if (single) {
        // One word ("Services", "Term"): lower case is only drift where the sentence
        // points at the defined thing ("the services"), not "the terms", "the term “X”",
        // or the ordinary word inside a definition ("“Fees” means the charges").
        if (m[0].toLowerCase() !== term.toLowerCase()) continue
        if (!SINGLE_WORD_DRIFT_CUE.test(text.slice(Math.max(0, from - 12), from))) continue
        if (/^\s*["“‘]/.test(text.slice(to, to + 3))) continue
        if (inside(defBodies, from, to)) continue
      } else if (inside(defBodies.filter(b => b.term === term), from, to)) continue
      drifts.push({ from, to })
    }
    driftUses.set(term, drifts)
  }

  // Glossary.
  const glossary: GlossaryEntry[] = terms.map(term => {
    const ds = byKey.get(term.toLowerCase())!
    const main = ds.find(d => !d.byReference) ?? ds[0]
    const uses = exactUses.get(term) ?? []
    return { term, definition: main.definition, offset: main.offset, uses: uses.length, firstUseOffset: uses[0]?.from ?? null }
  }).sort((a, b) => a.offset - b.offset)

  // 1. Defined but never used, in any case.
  for (const g of glossary) {
    if (g.uses > 0 || (driftUses.get(g.term)?.length ?? 0) > 0) continue
    // A singular/plural pair defined together: either form's use counts for both.
    const sibling = glossary.find(o => o !== g && o.uses > 0 && variantsOf(o.term).includes(g.term))
    if (sibling) continue
    issues.push({
      kind: 'unused_definition', term: g.term, severity: 'low',
      message: `“${g.term}” is defined but not used.`,
      evidence: { quote: quoteAround(text, g.offset, g.offset + g.term.length), offset: g.offset },
    })
  }

  // 2. Defined twice.
  for (const ds of byKey.values()) {
    const own = ds.filter(d => !d.byReference)
    if (own.length < 2) continue
    const body = (d: Definition) => d.definition.toLowerCase().replace(/["“”‘’«»„]/g, '').replace(/\s+/g, ' ')
      .replace(d.term.toLowerCase(), '').replace(/[.;\s]+$/, '').trim()
    const differs = own.some(d => body(d) !== body(own[0]))
    issues.push({
      kind: 'duplicate_definition', term: own[0].term, severity: differs ? 'medium' : 'low',
      message: differs ? `“${own[0].term}” is defined twice, in different ways.` : `“${own[0].term}” is defined twice.`,
      evidence: { quote: own[1].definition, offset: own[1].offset },
      related: { quote: own[0].definition, offset: own[0].offset },
      count: own.length,
    })
  }

  // 3. Used before it is defined.
  if (!DEFINED_ELSEWHERE.test(text)) {
    for (const g of glossary) {
      const first = realDefs.find(d => d.term.toLowerCase() === g.term.toLowerCase())
      // A use inside another definition ("“Charges” means the Linehaul Charges, …") is the
      // definitions list in its own order, not a use in the body of the contract.
      const use = (exactUses.get(g.term) ?? []).find(u => !inside(namedSpans, u.from, u.to) && !inside(defBodies, u.from, u.to))
      if (!first || !use || use.from >= first.offset) continue
      // In the same sentence as its own definition: "Acme Services Agreement (the “Agreement”)".
      const between = text.slice(use.to, first.offset)
      if (between.length < 300 && !/[.;]\s|\n/.test(between)) continue
      if (DEFINED_LATER.test(text.slice(use.to, use.to + 100))) continue
      issues.push({
        kind: 'used_before_defined', term: g.term, severity: 'low',
        message: `“${g.term}” is used before it is defined.`,
        evidence: { quote: quoteAround(text, use.from, use.to), offset: use.from },
        related: { quote: first.definition, offset: first.offset },
      })
    }
  }

  // 4. Capitalisation drift.
  for (const term of terms) {
    const drifts = driftUses.get(term) ?? []
    if (!drifts.length) continue
    const found = text.slice(drifts[0].from, drifts[0].to)
    issues.push({
      kind: 'capitalisation_drift', term, severity: 'low',
      message: `“${found}” should be written “${term}”, its defined form${drifts.length > 1 ? ` (${drifts.length} places)` : ''}.`,
      evidence: { quote: quoteAround(text, drifts[0].from, drifts[0].to), offset: drifts[0].from },
      count: drifts.length,
    })
  }

  // 5. Used like a defined term, never defined.
  const definedLower = new Set(terms.flatMap(t => variantsOf(t).map(v => v.toLowerCase())))
  const names = new Set<string>()
  // Who a parenthesis defines is a name: "Acme Corporation, a Delaware corporation (“Supplier”)".
  // A capitalised word after a determiner there ("the Deliverables (the “Work”)") isn't.
  const DET_BEFORE = new RegExp(`(?:^|[^A-Za-z])(?:${DET_ALT})\\s+$`)
  const nameSources = [...(opts.knownNames ?? []), ...defs.filter(d => d.form === 'paren').map(d => d.definition.replace(/\([^)]*\)\s*$/, ''))]
  for (const n of nameSources) {
    for (const w of n.matchAll(/(?<![A-Za-z])[A-Z][A-Za-z\-]+/g)) {
      if (DET_BEFORE.test(n.slice(Math.max(0, w.index! - 12), w.index!))) continue
      names.add(w[0].toLowerCase())
    }
  }
  const isNameWord = (w: string) => KNOWN_WORDS.has(w.toLowerCase()) || PLACES.has(w.toLowerCase()) || names.has(w.toLowerCase())
  const headings = new Set(lines.filter(l => l.heading).map(l => l.text.trim().replace(/^[(]?[0-9a-zA-Z]{1,3}(?:\.[0-9]{1,3})*[.)]\s*/, '').toLowerCase()))
  const quotedSpans: Span[] = [...text.matchAll(/["“‘][^"“”‘’\n]{1,80}["”’]/g)].map(m => ({ from: m.index!, to: m.index! + m[0].length }))
  const undefinedTerms = new Map<string, Span[]>()
  for (const m of text.matchAll(CANDIDATE_RX)) {
    const phrase = m[1].replace(/[ \t]+No$/, '')            // "Statement of Work No. 3"
    const from = m.index! + m[0].indexOf(m[1])
    const to = from + phrase.length
    const det = m[0].slice(0, m[0].indexOf(m[1])).trim()
    const lower = phrase.toLowerCase()
    if (inHeading(m.index!) || inside(quotedSpans, from, to) || inside(namedSpans, from, to)) continue
    // A capitalised determiner mid-sentence is part of a name ("Contractor's All Risk policy", "Any Facility").
    if (/^[A-Z]/.test(det) && !/(?:^|[.;:!?\n]|\(\w{1,3}\))\s*$/.test(text.slice(Math.max(0, m.index! - 8), m.index!))) continue
    if (definedLower.has(lower)) continue
    // "Statement of Work" may be defined while "Statement" isn't; a defined head makes it a use.
    const head = phrase.split(/[ \t]+of[ \t]+/)[0]
    if (/\sof\s/.test(phrase) && definedLower.has(head.toLowerCase())) continue
    // A defined term followed by an ordinary capitalised word ("Customer Shall").
    if (terms.some(t => lower.startsWith(`${t.toLowerCase()} `))) continue
    const words = phrase.split(/\s+/).filter(w => w !== 'of')
    if (words.every(isNameWord)) continue
    if (KNOWN_WORDS.has(head.toLowerCase()) || isNameWord(words[0]) || PLACES.has(words[words.length - 1].toLowerCase())) continue
    if (NAMED_THING_END.test(phrase) || /^\s+(?:of\s+)?\d{4}\b/.test(text.slice(to, to + 10))) continue
    if (/^this$/i.test(det) && DOCUMENT_NOUN.test(phrase)) continue
    if (NAME_GOES_ON.test(text.slice(to, to + 30)) || COMPANY_SUFFIX.test(text.slice(to, to + 12))) continue
    // "an Excused Event (as defined in Schedule 3)": defined in another document.
    if (/^\s*\(?\s*(?:as\s+defined|as\s+such\s+term|within\s+the\s+meaning)/i.test(text.slice(to, to + 40))) continue
    if (headings.has(lower)) continue
    undefinedTerms.set(phrase, [...(undefinedTerms.get(phrase) ?? []), { from, to }])
  }
  for (const [term, spans] of undefinedTerms) {
    issues.push({
      kind: 'undefined_term', term, severity: 'medium',
      message: `“${term}” is capitalised like a defined term but is never defined.`,
      evidence: { quote: quoteAround(text, spans[0].from, spans[0].to), offset: spans[0].from },
      count: spans.length,
    })
  }

  issues.sort((a, b) => a.evidence.offset - b.evidence.offset)
  return { glossary, issues }
}
