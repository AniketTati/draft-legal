/**
 * Features kept in the code but off unless a build turns them on
 * (VITE_* variables, read at build time).
 */
const env = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env) ?? {}

/**
 * docs/41 P0.5 — the editor's margin badges (MARKET / WEAK / AGGRESSIVE /
 * OFF). A fast model rated each paragraph "relative to common market
 * practice" with no org, no contract type, no playbook and no idea the text
 * came from the org's own template, so an untouched template clause read as
 * "weak" and junk read as "market". Hidden until it is grounded in the org's
 * playbook positions; set VITE_MARGIN_CLASSIFIER=on to see it.
 */
export const MARGIN_CLASSIFIER_ENABLED = env.VITE_MARGIN_CLASSIFIER === 'on'
