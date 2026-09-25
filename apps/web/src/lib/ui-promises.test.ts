/**
 * Z-series — what a screen promises, something must do. Preparing the first
 * customer demo found screens promising features that didn't exist. These
 * checks tie each such promise to the code that keeps it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { INSTALL_PACK_PATH } from '@/components/settings/IndustryPacksTab'
import { PRIVACY_MODES } from '@/components/admin/PrivacyModeSection'
import { ContractType, TriggerRulesSchema, pickWorkflow, autoApproves } from '@clm/types'
import { draftFromRules, rulesDraftError, rulesFromDraft, describeRules } from '@/lib/workflow-rules-draft'

const web = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8')
const api = (path: string) => readFileSync(join(__dirname, '..', '..', '..', 'api', 'src', path), 'utf8')
/** Every non-test source file of the web app, with its path. */
const webSources = () => (readdirSync(join(__dirname, '..'), { recursive: true }) as string[])
  .filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
  .map(f => ({ path: f, text: web(f) }))
/** Every non-test source file of the API, as one string. */
const apiSources = () => (readdirSync(join(__dirname, '..', '..', '..', 'api', 'src'), { recursive: true }) as string[])
  .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map(api).join('\n')

describe('Z2 — "you can install one later from Settings"', () => {
  it('Settings has an industry packs tab that installs through the wizard\'s own endpoint', () => {
    const wizard = web('components/onboarding/OnboardingWizard.tsx')
    expect(wizard).toMatch(/later from Settings/)
    expect(wizard).toContain(`'${INSTALL_PACK_PATH}'`)
    const settings = web('pages/SettingsPage.tsx')
    expect(settings).toContain('<IndustryPacksTab />')
    expect(settings).toContain("'industry-packs'")
  })

  it('the dashboard checklist opens that tab', () => {
    expect(web('components/onboarding/WelcomeChecklist.tsx')).toContain("to: '/settings?tab=industry-packs'")
  })
})

describe('Z8 — privacy mode is an admin setting, not an API call', () => {
  it('offers exactly the modes the API accepts, on the AI Config tab', () => {
    const accepted = api('routes/organization.ts').match(/piiRedactionMode: \[([^\]]*)\]/)?.[1]
    expect(accepted?.match(/'(\w+)'/g)?.map(m => m.slice(1, -1))).toEqual(PRIVACY_MODES.map(m => m.value))
    expect(web('components/admin/AiConfigTab.tsx')).toContain('<PrivacyModeSection />')
  })
})

describe('Z3 — approval routing the builder can set', () => {
  it('the checklist names only what routing does: type and value, not counterparty', () => {
    const item = web('components/onboarding/WelcomeChecklist.tsx').match(/id: 'approvals',[\s\S]*?sub: '([^']*)'/)?.[1]
    expect(item).toMatch(/type/)
    expect(item).toMatch(/value/)
    expect(item).not.toMatch(/counterpart/i)
  })

  it('what the builder saves is what the API accepts, and routes as the fields say', () => {
    const draft = {
      contractTypes: [ContractType.NDA], valueThreshold: '', currency: 'USD',
      autoApprove: [{ contractType: ContractType.NDA as ContractType | 'ANY', maxValue: '10,000' }],
    }
    expect(rulesDraftError(draft)).toBeNull()
    const rules = rulesFromDraft(draft)
    expect(TriggerRulesSchema.parse(rules)).toEqual({ contractTypes: ['NDA'], currency: 'USD', autoApproveRules: [{ contractType: 'NDA', maxValue: 10_000 }] })
    expect(draftFromRules(rules)).toEqual({ ...draft, autoApprove: [{ contractType: ContractType.NDA, maxValue: '10000' }] })
    expect(autoApproves(rules, { type: 'NDA', value: 9_000, currency: 'USD' })).toBe(true)
    expect(autoApproves(rules, { type: 'NDA', value: null })).toBe(false)
    expect(describeRules(rules)).toBe('NDA · approves NDA up to USD 10,000 at once')
    // An empty field adds no rule; a limit left blank stops the save rather than vanishing.
    expect(rulesFromDraft({ ...draft, contractTypes: [], autoApprove: [] })).toEqual({})
    expect(rulesDraftError({ ...draft, autoApprove: [{ contractType: 'ANY', maxValue: '' }] })).toMatch(/limit/)
    expect(rulesDraftError({ ...draft, valueThreshold: '-1' })).toMatch(/minimum/)
  })

  it('the builder saves the rules, and Send for review preselects what the server would choose', () => {
    expect(web('components/approvals/WorkflowDefinitionList.tsx')).toContain('triggerRules: rulesFromDraft(draftRules)')
    const dialog = web('components/contracts/SendForReviewDialog.tsx')
    expect(dialog).toContain('pickWorkflow(workflows, routed)')
    for (const route of ['routes/contracts.ts', 'routes/internal-ai.ts']) expect(api(route)).toMatch(/pickWorkflow\(candidates, /)
    const at = (d: string) => new Date(d).toISOString()
    const general = { id: 'g', isDefault: true, createdAt: at('2026-01-01'), triggerRules: {} }
    const ndas = { id: 'n', isDefault: false, createdAt: at('2026-02-01'), triggerRules: { contractTypes: ['NDA'] } }
    expect(pickWorkflow([general, ndas], { type: 'NDA', value: 1 })?.id).toBe('n')
    expect(pickWorkflow([general, ndas], { type: 'MSA', value: 1 })?.id).toBe('g')
  })
})

describe('Z4 — every notification setting controls a notification the API sends', () => {
  const settings = web('pages/SettingsPage.tsx')
  const prefs = api('lib/notification-prefs.ts')
  const toggles = [...(settings.match(/const triggers[\s\S]*?\n {2}\]/)?.[0] ?? '').matchAll(/key: '(\w+)'/g)].map(m => m[1])
  const typeToPref = Object.fromEntries([...(prefs.match(/TYPE_TO_PREF[^{]*\{([^}]*)\}/)?.[1] ?? '').matchAll(/(\w+):\s*'(\w+)'/g)].map(m => [m[1], m[2]]))

  it('each toggle governs a type that some part of the API emits', () => {
    expect(toggles.length).toBeGreaterThan(0)
    const sources = apiSources()
    for (const toggle of toggles) {
      const types = Object.keys(typeToPref).filter(t => typeToPref[t] === toggle)
      expect(types, `no notification type is governed by "${toggle}"`).not.toEqual([])
      const emitted = types.filter(t => new RegExp(`type:\\s*'${t}'`).test(sources))
      expect(emitted, `nothing sends the notifications "${toggle}" controls (${types.join(', ')})`).not.toEqual([])
    }
  })

  it("the server's defaults cover exactly the toggles on the page", () => {
    const defaults = [...(prefs.match(/NOTIFICATION_PREF_DEFAULTS[^{]*\{([^}]*)\}/)?.[1] ?? '').matchAll(/(\w+):/g)].map(m => m[1])
    expect(defaults.sort()).toEqual([...toggles].sort())
  })

  it('the daily digest is sent at 9am in the timezone the page names', () => {
    expect(settings).toContain('One email at 9am, ${digestZone')
    expect(api('lib/notification-digest.ts')).toMatch(/DIGEST_HOUR = 9\b/)
    expect(api('workers/scan.worker.ts')).toContain("registerRepeatable('notification-digest'")
  })
})

describe('Z6 — "New contract" on a counterparty starts a draft for it', () => {
  it('the counterparty page links to what the contracts page opens', () => {
    const link = web('pages/CounterpartyDetailPage.tsx').match(/navigate\(`\/contracts\?([^`]*)`\)/)?.[1] ?? ''
    for (const param of ['new=1', 'counterpartyId=', 'counterpartyName=']) expect(link).toContain(param)
    const page = web('pages/ContractsPage.tsx')
    expect(page).toContain("searchParams.get('new') === '1'")
    expect(page).toContain('initialCounterparty={newFor}')
    // …and the draft is saved linked to it, which the API checks.
    expect(web('components/contracts/NewContractFlow.tsx')).toContain('counterpartyId: linkedCounterpartyId')
    expect(api('routes/agents.ts')).toContain('body.saveAs.counterpartyId')
  })
})

describe('Z7 — no internal milestone codes in what users read', () => {
  it('no screen promises a feature by an internal milestone ("coming in B.3", "post-D0")', () => {
    const milestone = /\b(?:[A-Z]\.\d+(?:\.\d+)*[a-z]?|post-[A-Z]\d+|Phase \d+|Wave \d+(?:\.\d+)?)\b/
    const found: string[] = []
    for (const { path, text } of webSources()) {
      // Code comments may cite milestones; strings and JSX text may not.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, m => '\n'.repeat(m.split('\n').length - 1))
        .replace(/(^|[\s;{}(,])\/\/.*$/gm, '$1')
      code.split('\n').forEach((line, i) => { if (milestone.test(line)) found.push(`${path}:${i + 1}: ${line.trim()}`) })
    }
    expect(found).toEqual([])
  })

  it('the review drawer shows the clause\'s own comments, and the rail opens the thread', () => {
    expect(web('components/contracts/FocusedReviewDrawer.tsx')).toMatch(/<CommentsPanel [^>]*clauseRef=/)
    expect(web('pages/ContractDetailPage.tsx')).toContain("onClick={() => setTab('comments')}")
  })
})
