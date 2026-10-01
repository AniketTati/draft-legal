/**
 * docs/41 Part 2 — a section's fingerprint: what its words say once its
 * variables' values are set aside.
 *
 * Generation stamps each section with the sha256 of its normalised text, the
 * values it was filled with turned back into `{{key}}` placeholders. Review
 * computes the same over a clause and the draft's recorded values: equal
 * fingerprints mean the clause is the approved template (or library) text,
 * unchanged, whatever was filled in.
 *
 * Normalised: tags dropped, entities decoded, quotes straightened, an unfilled
 * blank (`[[key]]`) read as its placeholder, case and spacing (also before
 * punctuation) ignored.
 */
import { createHash } from 'node:crypto'

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' }

export type FingerprintVariables = Record<string, string | number | boolean | null | undefined>

/** The text a fingerprint is taken of: placeholders for values, everything else as words. */
export function normaliseForFingerprint(text: string, variables: FingerprintVariables = {}): string {
  let s = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e])
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\[\[([A-Za-z_][A-Za-z0-9_]*)\]\]/g, '{{$1}}')
  // Longest values first, so "New York, New York" isn't half-replaced by "New York".
  const values = Object.entries(variables)
    .map(([key, v]) => [key, v == null ? '' : String(v).trim()] as const)
    .filter(([, v]) => v.length > 0)
    .sort((a, b) => b[1].length - a[1].length)
  for (const [key, value] of values) s = s.split(value).join(`{{${key}}}`)
  // A tag stands for a space; one around a value's mark isn't a word break.
  return s.replace(/\s+/g, ' ').replace(/\s+([.,;:!?)\]])/g, '$1').replace(/([([])\s+/g, '$1').trim().toLowerCase()
}

/** sha256 (hex) of the normalised text. */
export function fingerprint(text: string, variables: FingerprintVariables = {}): string {
  return createHash('sha256').update(normaliseForFingerprint(text, variables)).digest('hex')
}
