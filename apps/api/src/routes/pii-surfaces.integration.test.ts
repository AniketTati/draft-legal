/**
 * X27 — contract text still reached models raw outside X23's paths: the Q&A
 * routes (and their reranker), the editor's AI assist routes, key terms in
 * the chat's contract tools, and the text the agents service fetches itself
 * for redline analysis and approval summaries. Each now goes out under the
 * org's PII policy, and whatever is shown back to the user, or stored, has the
 * values put back.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, makeWorkflow, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { redactJson } from '../lib/pii-policy.js'

const SSN = '123-45-6789'
const TEXT = `The Employee (SSN ${SSN}) is paid monthly.`
const DIM = 1536
const UNIT = `[${Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`
const TOKEN = /\[PII:[A-Z_]+:[0-9a-f]{16}\]/

let app: TestApp
let org: string, user: string, contract: string, v1: string, v2: string, clauseId: string
const sent: Record<string, string> = {}

const as = () => auth(org, ['ADMIN'], user)
const agentHeaders = () => ({ 'x-internal-service': 'agents', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-org-id': org })

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('PII Surfaces Org')
  user = await makeUser(org)
  contract = await makeContract(org, user, { title: 'Employment' })
  await prisma.contract.update({ where: { id: contract }, data: { keyTerms: { parties: [{ name: 'Employee', quote: `SSN ${SSN}` }] } } })
  v1 = (await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 1, createdById: user, plainText: 'The Employee is paid.', htmlContent: '<p>The Employee is paid.</p>' } })).id
  v2 = (await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 2, createdById: user, plainText: TEXT, htmlContent: `<p>${TEXT}</p>` } })).id
  await prisma.contract.update({ where: { id: contract }, data: { currentVersionId: v2 } })
  clauseId = `it-x27-${v2}`
  await prisma.contractClause.create({ data: { id: clauseId, versionId: v2, clauseType: 'payment', content: TEXT } })
  await prisma.$executeRawUnsafe(`UPDATE contract_clauses SET embedding = '${UNIT}'::vector, "embeddedAt" = now() WHERE id = '${clauseId}'`)

  process.env.OPENAI_API_KEY = 'it-openai-key'
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    const body = typeof init?.body === 'string' ? init.body : ''
    if (url.includes('api.openai.com/v1/embeddings')) {
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0)) }] }))
    }
    const route = url.replace(/^https?:\/\/[^/]+/, '')
    sent[route] = body
    const echo = (JSON.stringify(JSON.parse(body || '{}')).match(TOKEN) ?? [''])[0]
    if (route === '/agent/ask') return new Response(JSON.stringify({ answer: `The SSN is ${echo}.` }))
    if (route === '/assist') return new Response(JSON.stringify({ result: `Revised: ${JSON.parse(body).selected_text}` }))
    if (route === '/complete') return new Response(JSON.stringify({ completion: ` (see ${echo})` }))
    if (route === '/classify_clause') return new Response(JSON.stringify({ category: 'payment', position: 'standard', reasoning: `Mentions ${echo}` }))
    if (route === '/assist_stream') {
      // The token split across two deltas, as a model streams it.
      const cut = Math.floor(echo.length / 2)
      const lines = [
        { type: 'start' }, { type: 'delta', text: 'Paid to ' }, { type: 'delta', text: echo.slice(0, cut) },
        { type: 'delta', text: `${echo.slice(cut)} monthly.` }, { type: 'done' },
      ].map(l => JSON.stringify(l) + '\n').join('')
      return new Response(lines, { headers: { 'content-type': 'application/x-ndjson' } })
    }
    return realFetch(input as never, init)
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
  delete process.env.OPENAI_API_KEY
  await new Promise(r => setTimeout(r, 300))   // fire-and-forget audit rows
  await prisma.approvalInstance.deleteMany({ where: { orgId: org } })
  await prisma.workflowDefinition.deleteMany({ where: { orgId: org } })
  await prisma.contractClause.deleteMany({ where: { id: { startsWith: 'it-x27-' } } })
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

describe('Q&A', () => {
  it('portfolio and per-contract ask send tokens and answer with the value', async () => {
    for (const [url, route] of [['/api/v1/search/ask', '/agent/ask'], [`/api/v1/contracts/${contract}/ask`, '/agent/ask']] as const) {
      const res = await app.inject({ method: 'POST', url, headers: as(), payload: { question: 'What is the SSN?' } })
      expect(res.statusCode, url).toBe(200)
      expect(sent[route]).not.toContain(SSN)
      expect(res.json().answer).toBe(`The SSN is ${SSN}.`)
    }
  })
})

describe('the editor\'s AI', () => {
  it('assist, complete and classify send tokens and return the values', async () => {
    const assist = await app.inject({ method: 'POST', url: '/api/v1/agent/assist', headers: as(), payload: { selectedText: TEXT, action: 'rewrite' } })
    expect(sent['/assist']).not.toContain(SSN)
    expect(assist.json().result).toBe(`Revised: ${TEXT}`)

    const complete = await app.inject({ method: 'POST', url: '/api/v1/agent/complete', headers: as(), payload: { contextBefore: TEXT } })
    expect(sent['/complete']).not.toContain(SSN)
    expect(complete.json().completion).toBe(` (see ${SSN})`)

    const classify = await app.inject({ method: 'POST', url: '/api/v1/agent/classify-clause', headers: as(), payload: { clauseText: TEXT } })
    expect(sent['/classify_clause']).not.toContain(SSN)
    expect(classify.json().reasoning).toBe(`Mentions ${SSN}`)
  })

  it('the streamed rewrite puts back a token split across chunks', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/agent/assist-stream', headers: as(), payload: { selectedText: TEXT } })
    expect(sent['/assist_stream']).not.toContain(SSN)
    const events = res.body.trim().split('\n').map(l => JSON.parse(l) as { type: string; text?: string })
    const text = events.filter(e => e.type === 'delta').map(e => e.text).join('')
    expect(text).toBe(`Paid to ${SSN} monthly.`)
    expect(events.at(-1)?.type).toBe('done')
  })
})

describe('what the agents service reads and writes back', () => {
  it('the chat\'s contract tools keep key terms from the model', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/internal/ai/tools/contract_get',
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string }, payload: { orgId: org, contractId: contract },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.stringify(res.json().keyTerms)).not.toContain(SSN)
  })

  it('diffs and clauses read by the agents service are tokenized; users still see the text', async () => {
    const diffUrl = `/api/v1/contracts/${contract}/versions/${v1}/diff/${v2}`
    expect((await app.inject({ method: 'GET', url: diffUrl, headers: agentHeaders() })).body).not.toContain(SSN)
    expect((await app.inject({ method: 'GET', url: diffUrl, headers: as() })).body).toContain(SSN)
    const clausesUrl = `/api/v1/contracts/${contract}/clauses`
    const forAgents = await app.inject({ method: 'GET', url: clausesUrl, headers: agentHeaders() })
    expect(forAgents.body).not.toContain(SSN)
    expect(forAgents.body).toMatch(TOKEN)
    expect((await app.inject({ method: 'GET', url: clausesUrl, headers: as() })).body).toContain(SSN)
  })

  it('an approval summary written from those clauses is stored with the value', async () => {
    const wf = await makeWorkflow(org, user, user)
    const instance = await prisma.approvalInstance.create({ data: { orgId: org, contractId: contract, workflowDefinitionId: wf, submittedById: user } })
    const token = ((await redactJson(org, { t: TEXT }, { surface: 'test', roundTrip: contract })).t.match(TOKEN) ?? [''])[0]
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/approvals/${instance.id}/summary`,
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string }, payload: { aiSummary: `Employee ${token} is paid.` },
    })
    expect(res.statusCode).toBe(200)
    expect((await prisma.approvalInstance.findUniqueOrThrow({ where: { id: instance.id } })).aiSummary).toBe(`Employee ${SSN} is paid.`)
  })
})
