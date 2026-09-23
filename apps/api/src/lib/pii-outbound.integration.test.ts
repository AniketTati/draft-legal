/**
 * X23 — the org's PII policy must apply wherever contract text leaves for a
 * model: background jobs' calls to the agents service, the embedding
 * provider, and redline_propose. Where the model's output is stored or
 * spliced into the contract (extracted clause text, drafts, redlines), the
 * values go out as round-trip tokens and must come back, or a placeholder
 * would replace the real value. And a tool whose redaction fails must fail
 * closed rather than send the text raw.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const { failRedaction } = vi.hoisted(() => ({ failRedaction: { next: false } }))
vi.mock('./pii-policy.js', async importOriginal => {
  const real = await importOriginal<typeof import('./pii-policy.js')>()
  return {
    ...real,
    applyPiiPolicyBatch: vi.fn(async (...args: Parameters<typeof real.applyPiiPolicyBatch>) => {
      if (failRedaction.next) { failRedaction.next = false; throw new Error('redactor down') }
      return real.applyPiiPolicyBatch(...args)
    }),
    // X36 — the tools that cut text redact through redactCuts.
    redactCuts: vi.fn(async (...args: Parameters<typeof real.redactCuts>) => {
      if (failRedaction.next) { failRedaction.next = false; throw new Error('redactor down') }
      return real.redactCuts(...args)
    }),
  }
})

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { redactJson, restorePii, applyPiiPolicy } from './pii-policy.js'
import { embedContractVersion } from './embeddings.js'

const SSN = '123-45-6789'
const CARD = '4111 1111 1111 1111'
const CARD2 = '4012 8888 8888 1881'   // in a clause without the word "card"
const TEXT = `The Employee (SSN ${SSN}, date of birth: 1990-01-02) is paid to card ${CARD}. Notices go to legal@acme.example.`
const SCHEDULE = `Schedule A: ${CARD2}.`
const DOC = `${TEXT}\n${SCHEDULE}`
const TOKEN = /\[PII:[A-Z_]+:[0-9a-f]{16}\]/

let app: TestApp
let org: string, offOrg: string, owner: string, contract: string, versionId: string, clauseId: string, scheduleId: string
const captured: Record<string, string> = {}

const agentHeaders = () => ({
  'x-internal-service': 'agents',
  'x-internal-secret':  process.env.INTERNAL_SERVICE_SECRET as string,
  'x-org-id':           org,
})
const tool = (name: string, payload: Record<string, unknown>) => app.inject({
  method: 'POST', url: `/api/internal/ai/tools/${name}`,
  headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
  payload: { orgId: org, ...payload },
})
const setCurrent = (id: string) => prisma.contract.update({ where: { id: contract }, data: { currentVersionId: id } })

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('PII Outbound Org')
  offOrg = await makeOrg('PII Off Org')
  await prisma.organization.update({ where: { id: offOrg }, data: { settings: { piiRedactionMode: 'off' } } })
  owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Employment agreement' })
  const v = await prisma.contractVersion.create({
    data: { contractId: contract, versionNumber: 1, createdById: owner, plainText: DOC, htmlContent: `<p>${TEXT}</p><p>${SCHEDULE}</p>` },
  })
  versionId = v.id
  await setCurrent(v.id)
  clauseId = `it-x23-${v.id}`
  scheduleId = `it-x23-s-${v.id}`
  await prisma.contractClause.create({ data: { id: clauseId, versionId: v.id, clauseType: 'payment', content: TEXT } })
  await prisma.contractClause.create({ data: { id: scheduleId, versionId: v.id, clauseType: 'schedule', content: SCHEDULE } })

  process.env.OPENAI_API_KEY = 'it-openai-key'
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.includes('api.openai.com/v1/embeddings')) {
      captured.embeddings = String(init?.body)
      const n = (JSON.parse(captured.embeddings) as { input: string[] }).input.length
      return new Response(JSON.stringify({ data: Array.from({ length: n }, (_, index) => ({ index, embedding: Array.from({ length: 1536 }, () => 0) })) }))
    }
    if (url.endsWith('/redline_propose')) {
      // A model rewrites what it was given, tokens included, and may add a
      // value the user asked for.
      captured.redline = String(init?.body)
      const { clauseText, instructions } = JSON.parse(captured.redline) as { clauseText: string; instructions?: string }
      const kept = clauseText.match(TOKEN)?.[0] ?? ''
      const extra = instructions?.includes('new SSN') ? ' The new SSN is 234-56-7890.' : ''
      return new Response(JSON.stringify({
        variants: [{ aggression: 'moderate', proposedText: `${clauseText} Amended.${extra}`, rationale: `Kept ${kept}`, changes: [{ before: kept, after: kept, reason: 'kept' }] }],
      }))
    }
    return realFetch(input as never, init)
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
  delete process.env.OPENAI_API_KEY
  // Audit rows are written fire-and-forget; let them land before the org goes.
  await new Promise(r => setTimeout(r, 300))
  await prisma.contractClause.deleteMany({ where: { version: { contractId: contract } } })
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

describe('a background job\'s request and reply', () => {
  it('every text field goes out redacted, ids untouched, contacts kept, keywords readable', async () => {
    const sent = { plainText: DOC, orgId: org, contractId: contract, clauses: [{ id: 'cl1', text: SCHEDULE }] }
    const out = await redactJson(org, sent, { surface: 'test', roundTrip: contract })
    const json = JSON.stringify(out)
    for (const v of [SSN, CARD, CARD2, '1990-01-02']) expect(json).not.toContain(v)
    expect(out.plainText).toContain('legal@acme.example')
    expect(out.plainText).toMatch(/date of birth: \[PII:DOB:[0-9a-f]{16}\]/)
    // The schedule's card number is caught although its own string lacks "card".
    expect(out.clauses[0].text).toMatch(TOKEN)
    expect(out).toMatchObject({ orgId: org, contractId: contract, clauses: [{ id: 'cl1' }] })

    // What the model quotes back has the values put back…
    expect(restorePii({ quote: out.plainText }, sent, contract)).toEqual({ quote: DOC })
    // …but only for this contract's tokens.
    expect(restorePii({ quote: out.plainText }, sent, 'another-contract')).toEqual({ quote: out.plainText })
  })

  it('an org that switched redaction off sends the text as is', async () => {
    const sent = { plainText: DOC }
    expect(await redactJson(offOrg, sent, { surface: 'test', roundTrip: contract })).toEqual(sent)
  })
})

describe('the embedding provider', () => {
  it('gets redacted clause text, judged against the whole document; the stored clauses are unchanged', async () => {
    await embedContractVersion(versionId)
    expect(captured.embeddings).toBeTruthy()
    for (const v of [SSN, CARD2]) expect(captured.embeddings).not.toContain(v)
    expect((await prisma.contractClause.findUniqueOrThrow({ where: { id: clauseId } })).content).toBe(TEXT)
    expect((await prisma.contractClause.findUniqueOrThrow({ where: { id: scheduleId } })).content).toBe(SCHEDULE)
  })
})

describe('the extraction\'s callbacks store the real text', () => {
  it('clause segments and the contract fields it writes get the values back', async () => {
    const tokenized = (await redactJson(org, { t: TEXT }, { surface: 'test', roundTrip: contract })).t
    expect(tokenized).not.toContain(SSN)
    // A second version, so the seeded clauses of the first one stay put.
    const v2 = await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 2, createdById: owner, plainText: DOC } })

    const post = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${contract}/versions/${v2.id}/clauses`, headers: agentHeaders(),
      payload: { clauseSegments: [{ clauseType: 'payment', content: tokenized, sortOrder: 0, interpretation: `Pays ${tokenized}` }] },
    })
    expect(post.statusCode).toBe(201)
    const stored = await prisma.contractClause.findFirstOrThrow({ where: { versionId: v2.id } })
    expect(stored.content).toBe(TEXT)
    expect(stored.interpretation).toBe(`Pays ${TEXT}`)

    const patch = await app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: agentHeaders(),
      payload: { summary: tokenized, keyTerms: { paymentTerms: { quote: tokenized } } },
    })
    expect(patch.statusCode).toBe(200)
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: contract } })
    expect(c.summary).toBe(TEXT)
    expect(JSON.stringify(c.keyTerms)).toContain(SSN)
  })

  it('restores against the version the extraction read, not whatever is current by then', async () => {
    const tokenized = (await redactJson(org, { t: TEXT }, { surface: 'test', roundTrip: contract })).t
    const edited = await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 3, createdById: owner, plainText: 'The SSN was removed.' } })
    await setCurrent(edited.id)
    try {
      const patch = await app.inject({
        method: 'PATCH', url: `/api/v1/contracts/${contract}?versionId=${versionId}`, headers: agentHeaders(), payload: { summary: tokenized },
      })
      expect(patch.statusCode).toBe(200)
      expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract } })).summary).toBe(TEXT)
    } finally {
      await setCurrent(versionId)
    }
  })
})

describe('redline proposals', () => {
  it('the model never sees the values; the drawer shows them', async () => {
    const chat = await tool('redline_propose', { contractId: contract, clauseId })
    expect(chat.statusCode).toBe(200)
    expect(captured.redline).not.toContain(SSN)
    // The chat tool result goes back to the chat model: tokens only.
    expect(chat.body).not.toContain(SSN)
    expect(chat.json().variants[0].proposedText).toContain('[PII:SSN:')

    const drawer = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${contract}/clauses/${clauseId}/suggest`, headers: auth(org, ['LEGAL_OPS'], owner), payload: {},
    })
    expect(drawer.statusCode).toBe(200)
    expect(drawer.json().variants[0].proposedText).toBe(`${TEXT} Amended.`)
    expect(drawer.json().clause.originalText).toBe(TEXT)
  })

  it('a card number is kept from the chat model even where its sentence lacks the word "card"', async () => {
    const chat = await tool('redline_propose', { contractId: contract, clauseId: scheduleId })
    expect(chat.statusCode).toBe(200)
    expect(captured.redline).not.toContain(CARD2)
    expect(chat.body).not.toContain(CARD2)   // incl. the change list and rationale the model wrote
  })

  it('what the chat model passes on is applied with the real values; a new value the user asked for stays as written', async () => {
    const chat = await tool('redline_propose', { contractId: contract, clauseId, instructions: 'use the new SSN' })
    const proposedText = chat.json().variants[0].proposedText as string
    expect(proposedText).toContain('234-56-7890')   // not the document's: nothing to hide, and a token could never be put back
    try {
      const applied = await tool('redline_apply', { userId: owner, contractId: contract, clauseId, proposedText })
      expect(applied.statusCode).toBe(200)
      const v = await prisma.contractVersion.findUniqueOrThrow({ where: { id: applied.json().newVersionId } })
      expect(v.plainText).toContain(`${TEXT} Amended. The new SSN is 234-56-7890.`)
      expect(v.htmlContent).toContain(SSN)
      expect(v.htmlContent).not.toContain('[PII:')
    } finally {
      await setCurrent(versionId)
    }
  })

  it('no placeholder is ever written in place of a value: unknown, mangled, or redact mode\'s marker', async () => {
    for (const proposedText of [
      'SSN [PII:SSN:deadbeefdeadbeef] only.',   // resolves to nothing here
      'SSN [PII:SSN:deadbeefdeadbe only.',      // cut short, bracket lost
      'The Employee (SSN [REDACTED:SSN]) is paid.',   // what contract_get shows in redact mode
      'SSN [PII:SSN:9c8b4ca5] only.',           // a tokenize-mode pseudonym
    ]) {
      const res = await tool('redline_apply', { userId: owner, contractId: contract, clauseId, proposedText })
      expect(res.statusCode, proposedText).toBe(409)
      expect(res.json().code).toBe('PII_TOKEN_UNRESOLVED')
    }
  })

  it('a token whose hex a model upper-cased still resolves', async () => {
    const chat = await tool('redline_propose', { contractId: contract, clauseId })
    const proposedText = (chat.json().variants[0].proposedText as string).replace(TOKEN, t => t.replace(/[0-9a-f]{16}/, h => h.toUpperCase()))
    try {
      const applied = await tool('redline_apply', { userId: owner, contractId: contract, clauseId, proposedText })
      expect(applied.statusCode).toBe(200)
      const v = await prisma.contractVersion.findUniqueOrThrow({ where: { id: applied.json().newVersionId } })
      expect(v.plainText).toContain(SSN)
    } finally {
      await setCurrent(versionId)
    }
  })

  it('a proposal still applies after the word that made its value PII was edited out', async () => {
    // Tokenized while "card" was in the document…
    const chat = await tool('redline_propose', { contractId: contract, clauseId: scheduleId })
    const proposedText = chat.json().variants[0].proposedText as string
    expect(proposedText).toMatch(TOKEN)
    // …then the other clause is reworded without it (no clause rows on the new version).
    const edited = await prisma.contractVersion.create({
      data: { contractId: contract, versionNumber: 10, createdById: owner,
        plainText: `${TEXT.replace('card', 'transfer')}\n${SCHEDULE}`, htmlContent: `<p>${TEXT.replace('card', 'transfer')}</p><p>${SCHEDULE}</p>` },
    })
    await setCurrent(edited.id)
    try {
      const applied = await tool('redline_apply', { userId: owner, contractId: contract, clauseId: scheduleId, proposedText })
      expect(applied.statusCode).toBe(200)
      expect((await prisma.contractVersion.findUniqueOrThrow({ where: { id: applied.json().newVersionId } })).plainText).toContain(CARD2)
    } finally {
      await setCurrent(versionId)
    }
  })
})

describe('the round-trip details', () => {
  it('a tokenized date is restored before the update is validated', async () => {
    const dob = ((await redactJson(org, { t: TEXT }, { surface: 'test', roundTrip: contract })).t.match(/\[PII:DOB:[0-9a-f]{16}\]/) ?? [])[0]
    expect(dob).toBeTruthy()
    const patch = await app.inject({ method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: agentHeaders(), payload: { effectiveDate: dob } })
    expect(patch.statusCode).toBe(200)
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract } })).effectiveDate?.toISOString().slice(0, 10)).toBe('1990-01-02')
  })

  it('tokenize mode\'s pseudonyms don\'t link one org\'s values to another\'s', async () => {
    const a = await applyPiiPolicy(org, `SSN ${SSN}`, { surface: 'test', override: 'tokenize' })
    const b = await applyPiiPolicy(offOrg, `SSN ${SSN}`, { surface: 'test', override: 'tokenize' })
    expect(a.text).toMatch(/\[PII:SSN:[0-9a-f]{8}\]/)
    expect(a.text).not.toBe(b.text)
  })
})

describe('fail closed', () => {
  it('if redaction fails, the tool withholds the text instead of sending it raw', async () => {
    failRedaction.next = true
    const res = await tool('contract_summarize', { contractId: contract })
    expect(res.statusCode).toBe(503)
    expect(res.body).not.toContain(SSN)
  })
})
