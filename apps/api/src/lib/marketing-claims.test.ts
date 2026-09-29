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
// index.html too: its meta description is what every link preview shows (FF2).
const site = [...sources(ROOT), join(ROOT, '..', 'index.html')].map(p => readFileSync(p, 'utf8')).join('\n')

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
    expect(site).not.toMatch(/free templates?\b/i)   // X71 follow-up: the nav, footer and page badge
  })

  // X72 — H1 corrected the audit card's text but kept "append-only" in its
  // title and on the trust strip, and X3 has since shipped the viewer.
  it('calls the audit log what it is, and its viewer shipped', () => {
    expect(site).not.toMatch(/append-only audit log/i)
    expect(site).not.toMatch(/audit viewer[^.']*planned/i)
  })

  // FF2 — the 29 Sep truth pass. Each phrase below was on the live site and
  // false; FIX_TRACKER.md FF2 says what the code does instead.
  it.each([
    ['contracts never leave your network', /never leave your network/i],
    ['air-gapped deployments', /air-gapped deployments are supported|on-prem inference/i],
    ['a managed cloud', /use our managed cloud|sign up for cloud|Cloud Enterprise|cloud waitlist/i],
    ['an org-specific key for provider keys', /org-specific master key/i],
    ['PDF/A output', /PDF\/A/],
    ['a pen test or SIG-Lite', /pen-test summary|SIG-Lite/i],
    ['answers that are never wrong', /never hallucinat|no hallucinated|never invented/i],
    ['approval routing by jurisdiction or counterparty risk', /\b(route|routed|routing|approvals?)\b[^.'\n]{0,40}jurisdiction|jurisdiction, counterparty risk/i],
    ['CRM data in drafts', /data from your CRM|fills CRM data/i],
    ['every deadline extracted', /extracts every/i],
    ['portfolio answers over 150+ contracts', /150\+ contracts/i],
    ['a model choice per agent', /(provider|model|LLM)[^.'\n]{0,40}per agent/i],
    ['plant- or hub-scoped access', /(plant|hub)-scoped/i],
    ['reference customers', /our reference\b[^'\n]{0,30}(teams|portfolios)/i],
    ['a Discord or community call', /Discord|community call/i],
    ['an AGPL model shared with GitLab and Sentry', /GitLab, Mattermost/i],
  ])('does not claim %s (FF2)', (_name, pattern) => {
    expect(site).not.toMatch(pattern)
  })

  it('links nowhere dead or wrong (FF2)', () => {
    expect(site).not.toMatch(/cal\.com\/draft-legal/)      // Cal.com answers 404
    expect(site).not.toMatch(/x\.com\/draftlegal/i)        // an unrelated person's account
    expect(site).not.toMatch(/href="\/(privacy|terms)"/)  // no such routes on this site
    expect(site).not.toMatch(/free \w+ templates?\b/i)    // "Free MSA template" led to a guide
  })

  it('has no email capture that reports success without sending anything', () => {
    expect(existsSync(join(ROOT, 'components', 'sections', 'EmailCapture.tsx'))).toBe(false)
    expect(site).not.toMatch(/we sent it/i)
  })
})
