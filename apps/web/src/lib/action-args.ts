/**
 * X68 — the arguments an action card's Apply sends.
 *
 * An edit counts from the moment it is made, whether or not the editor is
 * still open. Apply used to read the draft only while the editor was open, so
 * editing, clicking "Review" to look the card over, then Apply sent the
 * original arguments and silently dropped the edit.
 */
export function argsJson(args: Record<string, unknown>): string {
  return JSON.stringify(args, null, 2)
}

/** Throws if an edited draft is not a JSON object. */
export function argsToApply(args: Record<string, unknown>, draftJson: string): Record<string, unknown> {
  if (draftJson === argsJson(args)) return args
  const parsed: unknown = JSON.parse(draftJson)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the arguments must be a JSON object')
  return parsed as Record<string, unknown>
}
