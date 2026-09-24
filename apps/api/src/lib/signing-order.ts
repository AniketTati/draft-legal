/**
 * Wave 3.7 — the signers a sequential signature has just given their turn:
 * the next group, once the signer's own group has finished. Parallel siblings
 * still pending in the signer's group were emailed when that group opened.
 *
 * X65 review — none once the request is no longer PENDING. A void or decline
 * that landed after this signature still emailed the next group their
 * signing links and logged a SENT event on the voided request.
 */
export function nextSignersToNotify<S extends { status: string; signOrder: number }>(
  request: { status: string; signers: S[] },
  signedOrder: number,
): S[] {
  if (request.status !== 'PENDING') return []
  const pending = request.signers.filter(s => s.status === 'PENDING')
  if (pending.length === 0) return []
  const next = Math.min(...pending.map(s => s.signOrder))
  return next > signedOrder ? pending.filter(s => s.signOrder === next) : []
}
