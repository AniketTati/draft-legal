/**
 * docs/41 Part 20 — when an integration sync tries again. The webhook
 * worker's policy (exponential: 15 s, 30 s, 1 min … capped at 30 min), with
 * one rule the plan adds: when Salesforce says the org's API limit is
 * reached, never sooner than Salesforce asked (and at least a minute).
 */
const BASE_DELAY_MS = 15_000
const MAX_DELAY_MS = 30 * 60_000

export function syncBackoff(attemptsMade: number, err?: Error | null): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attemptsMade - 1))
  if ((err as { name?: string } | null | undefined)?.name === 'SalesforceRateLimitError') {
    return Math.max(exp, (err as { retryAfterMs?: number }).retryAfterMs ?? 60_000, 60_000)
  }
  return exp
}
