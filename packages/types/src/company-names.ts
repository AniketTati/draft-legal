/**
 * docs/39 A8/A14 — company names compared the way a person reads them. Shared:
 * the API links contracts to the directory by it, the web app asks about a
 * name it replaced by it, and the agents service's counterparty picker has a
 * copy of the rules (apps/agents/app/company_names.py — a test keeps the two
 * lists of legal forms the same).
 *
 * A contract names "ACME CORPORATION, INC.", the directory has "Acme Corp."
 * and another contract says "The Acme Corporation (“Acme”)": one company. The
 * directory used to match a contract's counterparty only when the two strings
 * were identical, so a counterparty's page missed most of its contracts, and
 * the counterparty picker told us from them by a bare substring test.
 *
 * `companyKey` reduces a name to what identifies the company: case, accents,
 * punctuation, a leading "The", the defined term in brackets, "a Delaware
 * corporation", "d/b/a …" and the legal form (Inc., Ltd, GmbH, S.A., Pvt Ltd,
 * …) all go. Two names with the same key are the same company. A key keeps
 * every word that could tell companies apart ("Holdings", "Group", "UK"):
 * "Acme Holdings" is only *similar* to "Acme", offered to a person, never
 * linked on its own.
 */

/**
 * Legal forms, as the words companyKey leaves them (dots and case gone). The
 * agents service's counterparty picker has the same list (app/company_names.py).
 */
export const LEGAL_FORMS: readonly string[] = [
  // Longest first: "private limited" before "limited".
  'limited liability company', 'limited liability partnership', 'limited partnership',
  'private limited company', 'public limited company', 'private limited', 'private ltd', 'pvt limited', 'pvt ltd',
  'pte limited', 'pte ltd', 'pty limited', 'pty ltd',
  'co ltd', 'company limited', 'gmbh and co kg', 'gmbh co kg', 'ag and co kg', 'sa de cv', 'sab de cv', 'sp z oo', 'sp zoo',
  'incorporated', 'corporation', 'company', 'limited', 'l l c', 'l l p',
  'inc', 'corp', 'co', 'llc', 'llp', 'lp', 'ltd', 'plc', 'pbc', 'pc', 'pllc', 'lllp',
  'gmbh', 'mbh', 'ag', 'kg', 'kgaa', 'se', 'sa', 'sas', 'sasu', 'sarl', 'sl', 'slu', 'srl', 'spa', 'sapa',
  'bv', 'nv', 'cv', 'vof', 'pty', 'pvt', 'pte', 'kk', 'yk', 'oy', 'oyj', 'ab', 'as', 'asa', 'aps', 'a s',
  'lda', 'ltda', 'kft', 'zrt', 'nyrt', 'sro', 'as', 'ooo', 'zao', 'oao', 'pjsc', 'ojsc', 'jsc', 'ulc', 'bhd', 'sdn bhd',
]

/** The words of each legal form, longest first, for matching at the end of a name. */
const FORMS = [...new Set(LEGAL_FORMS)].map(f => f.split(' ')).sort((a, b) => b.length - a.length)

function stripAccents(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
}

/**
 * The words that identify a company: see the module note. Empty for a name
 * with nothing but punctuation or a legal form.
 */
export function companyKey(name: string | null | undefined): string {
  if (!name) return ''
  let s = stripAccents(String(name)).toLowerCase()
  // The defined term, and asides: "Acme Corp (“Acme”)", "(formerly Initech)".
  s = s.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ')
  // What follows the name: ", a Delaware corporation", "d/b/a Acme", "trading as …".
  s = s.replace(/,\s*(a|an)\s.*$/, ' ')
  s = s.replace(/\s(d\/b\/a|dba|d\.b\.a\.|t\/a|trading as|doing business as)\s.*$/, ' ')
  s = s.replace(/[“”"‘’'`]/g, '')
  s = s.replace(/[&+]/g, ' and ')
  // Initials hold together: "L.L.C." is llc, "S.A." sa, "A.B.C. Ltd" abc.
  s = s.replace(/\./g, '')
  s = s.replace(/[^a-z0-9]+/g, ' ').trim()
  let words = s.split(' ').filter(Boolean)
  if (words[0] === 'the' && words.length > 1) words = words.slice(1)
  // Legal forms at the end, repeatedly ("Holdings Co., Ltd."), never the whole name.
  for (let changed = true; changed && words.length > 1;) {
    changed = false
    for (const form of FORMS) {
      if (form.length >= words.length) continue
      if (form.every((w, i) => words[words.length - form.length + i] === w)) {
        words = words.slice(0, words.length - form.length)
        changed = true
        break
      }
    }
    // "Smith & Co" leaves "smith and".
    if (words.length > 1 && words[words.length - 1] === 'and') { words = words.slice(0, -1); changed = true }
  }
  return words.join(' ')
}

/** The key without spaces: "Face Book" and "Facebook" are one name. */
export function compactKey(name: string | null | undefined): string {
  return companyKey(name).replace(/ /g, '')
}

/** Two names for one company. */
export function sameCompany(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = compactKey(a)
  return !!ka && ka === compactKey(b)
}

/** What a template calls a party before anyone fills it in. */
const GENERIC_NAMES = new Set([
  'company', 'company name', 'party', 'party name', 'counterparty', 'counterparty name', 'name',
  'customer', 'client', 'supplier', 'vendor', 'provider', 'buyer', 'seller', 'licensee', 'licensor',
  'tbd', 'tbc', 'na', 'n a', 'none', 'unknown',
])

/** One of the names we sign as (the org's name and its entities, docs/39 A8). */
export function isOurs(name: string | null | undefined, ours: readonly string[]): boolean {
  return !!name && ours.some(o => sameCompany(o, name))
}

/** A name that stands for a company nobody has filled in: "[Company Name]", "<Party>", "___", "Buyer, Inc.". */
export function isPlaceholderName(name: string | null | undefined): boolean {
  const s = String(name ?? '').trim()
  if (!s) return true
  if (/^[[{<].*[\]}>]$/.test(s)) return true
  if (/^[_\-.\s]+$/.test(s)) return true
  return GENERIC_NAMES.has(companyKey(s))
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

const SMALL_WORDS = new Set(['and', 'of', 'the', 'for'])

/**
 * How alike two company names are, 0 to 1: 1 is the same company; from
 * SIMILAR up, one a person should be asked about — the other plus words
 * ("Acme" / "Acme Holdings"), its initials ("IBM" / "International Business
 * Machines"), or a spelling apart ("Globex" / "Globexx").
 */
export function companySimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ka = companyKey(a), kb = companyKey(b)
  if (!ka || !kb) return 0
  const ca = ka.replace(/ /g, ''), cb = kb.replace(/ /g, '')
  if (ca === cb) return 1
  const ta = ka.split(' '), tb = kb.split(' ')
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  // One is the other plus words, at the start: "acme" / "acme holdings uk".
  if (short.join('').length >= 3 && short.every((w, i) => long[i] === w)) {
    return Math.max(0.75, 0.9 - 0.05 * (long.length - short.length))
  }
  // Initials: "ibm" / "international business machines".
  const initials = long.filter(w => !SMALL_WORDS.has(w)).map(w => w[0]).join('')
  if (short.length === 1 && short[0].length >= 2 && long.length >= 2 && short[0] === initials) return 0.8
  // A spelling apart, on names long enough for that to mean something.
  if (Math.min(ca.length, cb.length) >= 5) {
    const ratio = 1 - levenshtein(ca, cb) / Math.max(ca.length, cb.length)
    if (ratio >= 0.85) return Math.round(ratio * 0.9 * 100) / 100
  }
  return 0
}

/** From here up, a name is offered as "did you mean …?". */
export const SIMILAR = 0.75

/**
 * A name as a directory entry would hold it: the defined term, the
 * "a Delaware corporation" tail and stray punctuation taken off, the words
 * and their case kept ("ACME CORPORATION, INC. (“Acme”)" → "ACME CORPORATION, INC.").
 */
export function directoryName(name: string): string {
  return String(name)
    .replace(/\s*\([^)]*\)|\s*\[[^\]]*\]/g, '')
    .replace(/,\s*(a|an)\s.*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:]+|[\s,;:]+$/g, '')
    .trim()
}
