/**
 * X30 — how many proxy hops to trust when resolving `req.ip`, the client
 * address the audit log records and the rate limiter keys on.
 *
 * Fastify ran without `trustProxy`, so behind Cloud Run's front end `req.ip`
 * was the front end's address: every client shared one rate-limit bucket and
 * the audit log recorded Google's IPs. The client is the X-Forwarded-For
 * entry the front end appends last, one hop in. Trusting only the nearest
 * hop, never the whole header, means a client can't pick its own address by
 * sending X-Forwarded-For.
 *
 * TRUST_PROXY_HOPS overrides the count (e.g. 2 behind an external load
 * balancer; 0 to trust nothing). Off Cloud Run it defaults to no trust.
 */
export function trustProxyHops(env: NodeJS.ProcessEnv = process.env): number | false {
  const raw = env.TRUST_PROXY_HOPS
  if (raw !== undefined && raw !== '') return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : false
  return env.K_SERVICE ? 1 : false
}
