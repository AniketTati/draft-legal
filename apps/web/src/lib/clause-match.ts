/**
 * docs/39 E1 — which clause type highlighted words are, best first: a clause
 * says what it is ("shall indemnify", "governed by the laws of", "not solicit").
 * Each type scores on the words of its name found in the passage.
 */
import { CLAUSE_TYPE_LABELS } from '@clm/types'

/** Words a clause uses that its type's name doesn't. */
const CUES: Record<string, RegExp> = {
  payment: /\b(invoice|payable|fees?|pay)\b/i,
  governing_law: /\bgoverned by|laws? of\b/i,
  dispute_resolution: /\b(arbitrat|mediat|courts?|disputes?)/i,
  limitation_of_liability: /\b(liab|consequential|indirect|aggregate)/i,
  indemnification: /\b(indemn|hold harmless|defend)/i,
  termination: /\b(terminat)/i,
  confidentiality: /\b(confidential)/i,
  non_solicitation: /\b(solicit|hire|employ)/i,
  non_compete: /\b(compet)/i,
  auto_renewal: /\b(automatically renew|auto-?renew|renew automatically|successive)/i,
  renewal_term: /\b(renew)/i,
  notice: /\b(notices?|in writing|addresses?)\b/i,
  assignment: /\b(assign|transfer)/i,
  force_majeure: /\b(force majeure|act of god|beyond .* control)/i,
  data_protection: /\b(personal data|gdpr|data protection|processor|controller)/i,
  ip_ownership: /\b(intellectual property|work made for hire|owns?|ownership)\b/i,
  license_grant: /\b(licen[cs]e|grants?)\b/i,
  insurance: /\b(insurance|insured|coverage)/i,
  warranty: /\b(warrant)/i,
  audit_rights: /\b(audit|inspect|records)/i,
  exclusivity: /\b(exclusiv)/i,
  change_of_control: /\b(change of control|merger|acquisition)/i,
  acceptance: /\b(accept)/i,
}

const GENERIC = new Set(['general', 'terms', 'rights', 'of', 'the', 'and', 'to'])

function stems(label: string): string[] {
  return label.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4 && !GENERIC.has(w)).map(w => w.slice(0, 6))
}

export interface ClauseTypeMatch { type: string; label: string; score: number }

/** Every clause type — docs/39 E3: the organization's own too (`extra`) — those the passage reads as first. */
export function rankClauseTypes(text: string, extra: ReadonlyArray<{ key: string; label: string }> = []): ClauseTypeMatch[] {
  const words = text.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4)
  return [...Object.entries(CLAUSE_TYPE_LABELS), ...extra.map(t => [t.key, t.label] as [string, string])]
    .map(([type, label]) => {
      let score = stems(label).filter(s => words.some(w => w.startsWith(s) || (w.length >= 5 && s.startsWith(w)))).length * 2
      if (CUES[type]?.test(text)) score += 3
      return { type, label, score }
    })
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
}
