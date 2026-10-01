/**
 * docs/39 B3 — which values a person must check, and how much of a contract
 * a person has checked.
 *
 * Each field says when the AI's values need a person: always (the fields a
 * wrong value costs most on), when the AI is unsure (the default), or only
 * when it is very unsure. A contract is Verified when a person set or checked
 * every value it holds, Partly verified when some, Unverified when none —
 * what someone handed the data needs to know.
 */

export const CHECK_LEVELS = ['always', 'unsure', 'rarely'] as const
export type CheckLevel = typeof CHECK_LEVELS[number]

export const CHECK_LEVEL_LABELS: Record<CheckLevel, string> = {
  always: 'Always',
  unsure: 'When unsure',
  rarely: 'Only when very unsure',
}

/** Below this computed confidence an unchecked AI value asks for a person. */
export const DEFAULT_CHECK_BELOW = 0.7
/** …for a field checked only when very unsure. */
export const RARELY_CHECK_BELOW = 0.4

/** The confidence below which a field's AI values need a person; null: every one does. */
export function checkBelow(level: CheckLevel | null | undefined, base = DEFAULT_CHECK_BELOW): number | null {
  if (level === 'always') return null
  if (level === 'rarely') return Math.min(RARELY_CHECK_BELOW, base)
  return base
}

export type VerificationState = 'verified' | 'partly' | 'unverified' | 'empty'

export const VERIFICATION_LABELS: Record<VerificationState, string> = {
  verified: 'Verified',
  partly: 'Partly verified',
  unverified: 'Unverified',
  empty: 'No values',
}

/** A contract's state from how many of its values a person set or checked. */
export function verificationState(checked: number, filled: number): VerificationState {
  if (filled <= 0) return 'empty'
  if (checked >= filled) return 'verified'
  return checked > 0 ? 'partly' : 'unverified'
}

/** A value a person set, or the AI's that a person checked. */
export function isChecked(v: { source?: string | null; verifiedAt?: string | Date | null }): boolean {
  return (v.source !== 'ai' && v.source !== 'calculated') || !!v.verifiedAt
}
