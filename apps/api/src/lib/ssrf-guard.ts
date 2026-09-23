/**
 * SSRF guard for outbound, user-supplied URLs (webhooks) — Wave 1.5, 2026-07.
 *
 * Webhook URLs are attacker-controlled: on the hosted multi-tenant app, any
 * signup is an org admin who could point a webhook at http://169.254.169.254/
 * (cloud metadata) or an internal service and read the reflected response out
 * of the delivery log. This module blocks URLs that resolve to private /
 * loopback / link-local / metadata addresses.
 *
 * Self-host tension: a self-hosted deployment may legitimately POST to a
 * service on its own private network. So the guard can be turned off with
 * WEBHOOK_ALLOW_PRIVATE_URLS=true — which is also how to test with a local
 * receiver (localhost). It is ON everywhere else (X35: it used to be off
 * whenever NODE_ENV wasn't 'production', staging and previews included).
 *
 * Residual TOCTOU: we resolve DNS then fetch, so a rebinding attacker could in
 * theory flip the record between the two. The creation-time shape check + the
 * short window make this a low residual risk; full IP-pinning is a later
 * hardening if needed.
 */
import { lookup } from 'node:dns/promises'
import net from 'node:net'

/** Whether the guard actively blocks private targets in this environment. */
export function ssrfGuardEnabled(): boolean {
  // X35 — on in every environment unless turned off explicitly: keyed on
  // NODE_ENV it was off on staging and previews, where an org admin could
  // point a webhook at the cloud metadata address.
  return process.env.WEBHOOK_ALLOW_PRIVATE_URLS !== 'true'
}

/** True if an IP literal is in a private / loopback / link-local / ULA range. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0 || a === 127) return true             // "this host" + loopback
    if (a === 10) return true                          // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true   // RFC1918
    if (a === 192 && b === 168) return true            // RFC1918
    if (a === 169 && b === 254) return true            // link-local + 169.254.169.254 metadata
    if (a === 100 && b >= 64 && b <= 127) return true  // CGNAT 100.64/10
    return false
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase()
    if (v === '::1' || v === '::') return true
    if (v.startsWith('fc') || v.startsWith('fd')) return true // unique-local
    if (v.startsWith('fe80')) return true                     // link-local
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7)) // IPv4-mapped
    return false
  }
  return true // unrecognised → block
}

/**
 * Synchronous shape check for creation-time validation. Rejects non-http(s),
 * localhost/.internal/.local hosts, and literal private IPs. Returns the parsed
 * URL. Throws on rejection.
 */
export function assertUrlShape(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('Invalid URL')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http(s) webhook URLs are allowed')
  }
  const host = bareHost(u).toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('Webhook URL host is not allowed')
  }
  if (net.isIP(host) && isPrivateIp(host)) {
    throw new Error('Webhook URL points to a private address')
  }
  return u
}

/** True if the URL shape is acceptable (or the guard is disabled). For Zod. */
export function isUrlShapeAllowed(raw: string): boolean {
  if (!ssrfGuardEnabled()) return true
  try {
    assertUrlShape(raw)
    return true
  } catch {
    return false
  }
}

/**
 * Full fetch-time check: resolve the hostname and ensure every A/AAAA record is
 * a public address. No-op when the guard is disabled. Throws on rejection so
 * the caller can skip the fetch and mark the delivery failed.
 */
export async function assertPublicUrl(raw: string): Promise<void> {
  if (!ssrfGuardEnabled()) return
  const u = assertUrlShape(raw)
  const host = bareHost(u)
  if (net.isIP(host)) return // literal IP already validated by assertUrlShape
  const records = await lookup(host, { all: true })
  if (records.length === 0) throw new Error('Webhook URL host did not resolve')
  for (const { address } of records) {
    if (isPrivateIp(address)) {
      // X39 follow-up — not which address: the message is stored on the
      // delivery and shown to the webhook's owner, who could map the
      // internal network with it.
      throw new Error('Webhook URL resolves to a private or internal address')
    }
  }
}

/**
 * X39 follow-up — the URL's host without the brackets an IPv6 literal keeps
 * in `URL.hostname` ("[::1]"): with them net.isIP says no, so a private IPv6
 * literal went unchecked (and was stopped only because it failed to resolve).
 */
function bareHost(u: URL): string {
  return u.hostname.replace(/^\[(.*)\]$/, '$1')
}
