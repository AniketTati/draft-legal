/**
 * H1 — the marketing site must not claim what the product doesn't do.
 * A copy tripwire over apps/marketing: each phrase below was false when the
 * truth pass removed it (see FIX_TRACKER.md H1 for the evidence per claim).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(process.cwd(), '..', 'marketing', 'src')
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? sources(p) : /\.(tsx?|mdx?)$/.test(f) ? [p] : []
  })
}
const site = sources(ROOT).map(p => readFileSync(p, 'utf8')).join('\n')

describe('marketing claims', () => {
  it.each([
    ['JWT RS256', /RS256/],
    ['optional SAML SSO', /optional SAML SSO/i],
    ['matter-scoped permissions', /matter-scoped/i],
    ['composable roles', /Roles are composable/i],
    ['append-only, exportable audit log', /append-only and exportable/i],
    ['GDPR endpoints exist', /provides data-export and deletion endpoints/i],
    ['requests captured from Slack/email/portal', /from email, Slack, or a portal/i],
    ['Teams approvals', /Slack and Teams approvals/i],
    ['CRM pull as shipped', /^\s*'Pull data from Salesforce/m],
  ])('does not claim %s', (_name, pattern) => {
    expect(site).not.toMatch(pattern)
  })

  // X71 — every template page linked a .docx that was never in the repo;
  // hosting answered each with the site's index.html.
  it('links a template download only when the file ships, and promises none otherwise', () => {
    const links = [...site.matchAll(/downloadFile:\s*[`'"]([^`'"]+)[`'"]/g)].map(m => m[1])
    for (const href of links) expect(existsSync(join(ROOT, '..', 'public', href)), href).toBe(true)
    expect(site).not.toMatch(/download is live/i)
    expect(site).not.toMatch(/free downloads?/i)
    expect(site).not.toMatch(/lawyer-reviewed/i)
  })

  it('has no email capture that reports success without sending anything', () => {
    expect(existsSync(join(ROOT, 'components', 'sections', 'EmailCapture.tsx'))).toBe(false)
    expect(site).not.toMatch(/we sent it/i)
  })
})
