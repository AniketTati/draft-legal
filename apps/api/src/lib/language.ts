/**
 * docs/39 A11 — the language a contract is written in, told by its commonest
 * words: enough to tell the extraction what it is reading (it quotes the
 * original and gives values in one format whatever the language) and to show
 * a reader that a French contract was read as French.
 *
 * Counts function words over the first few thousand words; null when there
 * are too few words, or no language stands clearly ahead of the next.
 */
export type LanguageCode = 'en' | 'fr' | 'de' | 'es' | 'it' | 'pt' | 'nl'

export const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch',
}

// Words common in contracts and rare in the other languages listed. Shared
// short words ("de", "la", "a") are left out: they tell nothing apart.
const MARKERS: Record<LanguageCode, readonly string[]> = {
  en: ['the', 'and', 'of', 'shall', 'this', 'any', 'with', 'agreement', 'party', 'parties', 'which', 'such', 'will', 'must', 'not'],
  fr: ['le', 'les', 'et', 'des', 'du', 'une', 'dans', 'pour', 'par', 'sur', 'contrat', 'est', 'sont', 'aux', 'présent', 'doit'],
  de: ['der', 'die', 'das', 'und', 'den', 'dem', 'ist', 'nicht', 'eine', 'mit', 'für', 'vertrag', 'werden', 'oder', 'auf', 'wird'],
  es: ['el', 'los', 'las', 'y', 'del', 'que', 'por', 'para', 'con', 'una', 'contrato', 'será', 'deberá', 'dicho', 'cualquier'],
  it: ['il', 'gli', 'della', 'delle', 'che', 'per', 'con', 'una', 'contratto', 'sono', 'nel', 'dal', 'ogni', 'essere', 'presente'],
  pt: ['os', 'do', 'da', 'dos', 'das', 'que', 'em', 'para', 'com', 'uma', 'contrato', 'será', 'não', 'pelo', 'deverá'],
  nl: ['het', 'een', 'en', 'van', 'dat', 'op', 'te', 'met', 'voor', 'overeenkomst', 'partij', 'zijn', 'wordt', 'niet', 'deze'],
}

const MAX_WORDS = 4000
const MIN_WORDS = 30
/** The leading language must have this many times the runner-up's share. */
const LEAD = 1.5

export function detectLanguage(text: string): { code: LanguageCode; name: string } | null {
  const words = text.toLowerCase().match(/\p{L}+/gu)?.slice(0, MAX_WORDS) ?? []
  if (words.length < MIN_WORDS) return null
  const counts = new Map<string, number>()
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1)
  const scores = (Object.keys(MARKERS) as LanguageCode[])
    .map(code => ({ code, hits: MARKERS[code].reduce((n, w) => n + (counts.get(w) ?? 0), 0) }))
    .sort((a, b) => b.hits - a.hits)
  const [first, second] = scores
  if (first.hits < words.length * 0.05 || first.hits < second.hits * LEAD) return null
  return { code: first.code, name: LANGUAGE_NAMES[first.code] }
}
