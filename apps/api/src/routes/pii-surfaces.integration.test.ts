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
    // A selection marked MANGLE gets its token back without the brackets (a
    // model that "tidied" it); one marked CUTOFF, a stream that just stops.
    const selection: string = JSON.parse(body || '{}').selected_text ?? ''
    const reply = selection.includes('MANGLE') ? echo.replace(/[[\]]/g, '') : echo
    if (route === '/agent/ask') return new Response(JSON.stringify({ answer: `The SSN is ${echo}.` }))
    if (route === '/assist') return new Response(JSON.stringify({ result: `Revised: ${selection.includes('MANGLE') ? selection.replace(/[[\]]/g, '') : selection}` }))
    if (route === '/complete') return new Response(JSON.stringify({ completion: ` (see ${echo})` }))
    if (route === '/classify_clause') return new Response(JSON.stringify({ category: 'payment', position: 'standard', reasoning: `Mentions ${echo}` }))
    if (route === '/compare') return new Response(JSON.stringify({ analysis: `Matches ${echo}` }))
    if (route === '/assist_stream' && selection.includes('RESET')) {
      // The connection drops after the first delta.
      const lines = [{ type: 'start' }, { type: 'delta', text: 'Paid to ' }].map(l => JSON.stringify(l) + '\n').join('')
      let pulls = 0
      return new Response(new ReadableStream({
        pull(c) { if (pulls++ === 0) c.enqueue(new TextEncoder().encode(lines)); else c.error(new Error('connection reset')) },
      }), { headers: { 'content-type': 'application/x-ndjson' } })
    }
    if (route === '/assist_stream') {
      // The token split across two deltas, as a model streams it.
      const cut = Math.floor(reply.length / 2)
      const lines = [
        { type: 'start' }, { type: 'delta', text: 'Paid to ' }, { type: 'delta', text: reply.slice(0, cut) },
        ...(selection.includes('CUTOFF') ? [] : [{ type: 'delta', text: `${reply.slice(cut)} monthly.` }, { type: 'done' }]),
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
  // Rows cleanupAll doesn't know about.
  const contracts = (await prisma.contract.findMany({ where: { orgId: org }, select: { id: true } })).map(c => c.id)
  await prisma.versionDiffCache.deleteMany({ where: { contractId: { in: contracts } } })
  await prisma.obligation.deleteMany({ where: { orgId: org } })
  await prisma.playbookPosition.deleteMany({ where: { orgId: org } })
  await prisma.clauseCategory.deleteMany({ where: { orgId: org } })
  await prisma.approvalStep.deleteMany({ where: { orgId: org } })
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

describe('the review of the first cut', () => {
  const internal = () => ({ 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string })

  it('a value changed between versions reaches the redline analysis as two whole tokens', async () => {
    const OTHER = '123-45-6780'
    const version = (n: number, text: string, html = `<p>${text}</p>`) => prisma.contractVersion.create({
      data: { contractId: contract, versionNumber: n, createdById: user, plainText: text, htmlContent: html },
    })
    const diff = async (x: string, y: string) => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/versions/${x}/diff/${y}`, headers: agentHeaders() })
      expect(res.statusCode).toBe(200)
      return res.json().diffHtml as string
    }
    const [a, b] = [await version(3, `Employee SSN ${SSN}.`), await version(4, `Employee SSN ${OTHER}.`)]
    const html = await diff(a.id, b.id)
    // Diffed after tokenizing, not tokenized after diffing: no digits of
    // either value (`123-45-<del>6789</del>` before)…
    expect(html).not.toMatch(/\d-\d/)
    // …and each token whole on its side of the change (htmldiff splits at ':').
    expect(html).toMatch(/<del[^>]*>[^<]*\[PII:SSN:[0-9a-f]{16}\][^<]*<\/del>/)
    expect(html).toMatch(/<ins[^>]*>[^<]*\[PII:SSN:[0-9a-f]{16}\][^<]*<\/ins>/)

    // Markup that splits a value can't take a token: the plain text's diff instead.
    const [c, d] = [
      await version(6, `Employee SSN ${SSN}.`, '<p>Employee SSN 123-45-<b>6789</b>.</p>'),
      await version(7, `Employee SSN ${OTHER}.`, '<p>Employee SSN 123-45-<b>6780</b>.</p>'),
    ]
    const split = await diff(c.id, d.id)
    expect(split).not.toMatch(/\d-\d|<b>/)
    expect(split).toMatch(/<del[^>]*>[^<]*\[PII:SSN:[0-9a-f]{16}\][^<]*<\/del>/)

    // A card number Word wrote with non-breaking spaces…
    const card = '4111 1111 1111 1111'
    const [e, f] = [
      await version(8, `Paid by credit card ${card}.`, `<p>Paid by credit card ${card.replace(/ /g, '&nbsp;')}.</p>`),
      await version(9, `Paid by credit card ${card} monthly.`, `<p>Paid by credit card ${card.replace(/ /g, '\u00a0')} monthly.</p>`),
    ]
    expect(await diff(e.id, f.id)).not.toMatch(/4111|1111/)
    // …or with the double, thin or figure spaces HTML keeps and plainText collapses.
    const [g, h] = [
      await version(10, `Paid by credit card ${card}.`, '<p>Paid by credit card 4111  1111\u20091111\u202f1111.</p>'),
      await version(11, `Paid by credit card ${card} monthly.`, '<p>Paid by credit card 4111\t1111 1111\u20071111 monthly.</p>'),
    ]
    expect(await diff(g.id, h.id)).not.toMatch(/4111|1111/)

    // A version still being extracted is refused, as it is for users.
    const pending = await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 5, createdById: user } })
    const refused = await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/versions/${a.id}/diff/${pending.id}`, headers: agentHeaders() })
    expect(refused.statusCode).toBe(409)
  })

  it('the playbook tester sends tokens and shows the comparison with the value', async () => {
    const category = await prisma.clauseCategory.create({ data: { orgId: org, name: 'Payment' } })
    await prisma.playbookPosition.create({ data: { orgId: org, clauseCategoryId: category.id, positionType: 'preferred', content: 'Paid monthly.', createdById: user } })
    const res = await app.inject({ method: 'POST', url: '/api/v1/playbook/test', headers: as(), payload: { clauseText: TEXT, clauseCategoryId: category.id } })
    expect(res.statusCode).toBe(200)
    expect(sent['/compare']).not.toContain(SSN)
    expect(sent['/compare']).toMatch(TOKEN)
    expect(res.json().analysis).toBe(`Matches ${SSN}`)
  })

  it('the completion and classifier windows are cut after redaction, so no part of a value goes out', async () => {
    // The last 1,400 characters begin inside the SSN: cut first, its tail went out raw.
    const before = `${'a '.repeat(1000)}SSN ${SSN} ${'b'.repeat(1395)}`
    await app.inject({ method: 'POST', url: '/api/v1/agent/complete', headers: as(), payload: { contextBefore: before } })
    const window = JSON.parse(sent['/complete']).contextBefore as string
    expect(window).not.toMatch(/\d|PII/)
    expect(window.length).toBeGreaterThan(1300)

    // The first 2,400 characters end inside it.
    const clause = `${'c'.repeat(2395)} ${SSN} is the Employee's number.`
    await app.inject({ method: 'POST', url: '/api/v1/agent/classify-clause', headers: as(), payload: { clauseText: clause } })
    expect(JSON.parse(sent['/classify_clause']).clauseText).not.toMatch(/\d|PII/)

    // The cursor is a cut too: inside a value, nothing goes out…
    delete sent['/complete']
    const inside = await app.inject({ method: 'POST', url: '/api/v1/agent/complete', headers: as(), payload: { contextBefore: 'The Employee SSN is 123-45-', contextAfter: '6789 on file.' } })
    expect(inside.json().completion).toBe('')
    expect(sent['/complete']).toBeUndefined()
    // …and a value whose keyword is on the other side of it is still found.
    await app.inject({ method: 'POST', url: '/api/v1/agent/complete', headers: as(), payload: { contextBefore: 'The Employee is described below. Date of birth: ', contextAfter: '1980-05-12, in Ohio.' } })
    expect(sent['/complete'] ?? '').not.toContain('1980-05-12')
  })

  it('the editor\'s HTML is read as text: labels in other tags still mark their values', async () => {
    const labelled = '<p><strong>Date of birth:</strong> 1980-05-12</p><table><tr><td>Passport No.</td><td>A1234567</td></tr></table>'
    const res = await app.inject({ method: 'POST', url: '/api/v1/agent/assist', headers: as(), payload: { selectedText: labelled, action: 'rewrite' } })
    expect(res.statusCode).toBe(200)
    expect(sent['/assist']).not.toMatch(/1980-05-12|A1234567/)
    expect(res.json().result).toContain('1980-05-12')
    expect(res.json().result).toContain('A1234567')

    // A value its formatting splits can't take a token: refused, with the reason.
    const split = await app.inject({ method: 'POST', url: '/api/v1/agent/assist', headers: as(), payload: { selectedText: '<p>SSN 123-45-<b>6789</b></p>', action: 'rewrite' } })
    expect(split.statusCode).toBe(422)
    expect(split.json().detail).toMatch(/formatting/)
  })

  it('per-contract ask finds values in the version its clauses come from', async () => {
    // The clauses are an older version's (the current one, an editor save, has none).
    const c3 = await makeContract(org, user, { title: 'Card on file' })
    const old = await prisma.contractVersion.create({
      data: { contractId: c3, versionNumber: 1, createdById: user, plainText: 'Payment is by credit card. Charged monthly to 4111 1111 1111 1111.' },
    })
    const current = await prisma.contractVersion.create({ data: { contractId: c3, versionNumber: 2, createdById: user, plainText: 'Edited text.' } })
    await prisma.contract.update({ where: { id: c3 }, data: { currentVersionId: current.id } })
    const id = `it-x27-${old.id}`
    await prisma.contractClause.create({ data: { id, versionId: old.id, clauseType: 'payment', content: 'Charged monthly to 4111 1111 1111 1111.' } })
    await prisma.$executeRawUnsafe(`UPDATE contract_clauses SET embedding = '${UNIT}'::vector, "embeddedAt" = now() WHERE id = '${id}'`)

    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${c3}/ask`, headers: as(), payload: { question: 'How is it paid?' } })
    expect(res.statusCode).toBe(200)
    expect(sent['/agent/ask']).not.toContain('4111 1111')
    expect(res.json().answer).toBe('The SSN is 4111 1111 1111 1111.')
  })

  it('a reply whose placeholder the model mangled is refused, not applied', async () => {
    const assist = await app.inject({ method: 'POST', url: '/api/v1/agent/assist', headers: as(), payload: { selectedText: `MANGLE ${TEXT}`, action: 'rewrite' } })
    expect(assist.statusCode).toBe(502)

    const stream = async (selectedText: string) => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/agent/assist-stream', headers: as(), payload: { selectedText } })
      return res.body.trim().split('\n').map(l => JSON.parse(l) as { type: string; text?: string })
    }
    const mangled = await stream(`MANGLE ${TEXT}`)
    expect(mangled.at(-1)?.type).toBe('error')
    expect(mangled.some(e => e.type === 'done')).toBe(false)

    // A stream that stops without done or error was cut off: it ends in an
    // error, and the half token it held back is never sent.
    const cut = await stream(`CUTOFF ${TEXT}`)
    expect(cut.at(-1)?.type).toBe('error')
    expect(cut.filter(e => e.type === 'delta').map(e => e.text).join('')).toBe('Paid to ')
    // So does one whose connection resets.
    const reset = await stream(`RESET ${TEXT}`)
    expect(reset.at(-1)?.type).toBe('error')
    expect(reset.filter(e => e.type === 'delta').map(e => e.text).join('')).toBe('Paid to ')
  })

  it('key terms the approval summary reads are tokenized, and put back when the summary is stored', async () => {
    const ONLY_IN_TERMS = '234-56-7891'   // in the key terms and summary, in no version's text
    const c2 = await makeContract(org, user, { title: 'Key terms only' })
    const v = await prisma.contractVersion.create({ data: { contractId: c2, versionNumber: 1, createdById: user, plainText: 'No values here.', htmlContent: '<p>No values here.</p>' } })
    await prisma.contract.update({
      where: { id: c2 },
      data: { currentVersionId: v.id, keyTerms: { parties: [{ name: 'Employee', quote: `SSN ${ONLY_IN_TERMS}` }] }, summary: `Employs the holder of SSN ${ONLY_IN_TERMS}.` },
    })
    const read = await app.inject({ method: 'GET', url: `/api/v1/contracts/${c2}`, headers: agentHeaders() })
    expect(read.statusCode).toBe(200)
    expect(read.body).not.toContain(ONLY_IN_TERMS)
    const token = (JSON.stringify(read.json().keyTerms).match(TOKEN) ?? [''])[0]
    expect(token).toMatch(TOKEN)
    expect((await app.inject({ method: 'GET', url: `/api/v1/contracts/${c2}`, headers: as() })).body).toContain(ONLY_IN_TERMS)

    const wf = await makeWorkflow(org, user, user)
    const instance = await prisma.approvalInstance.create({ data: { orgId: org, contractId: c2, workflowDefinitionId: wf, submittedById: user } })
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/approvals/${instance.id}/summary`, headers: internal(), payload: { aiSummary: `Employee ${token} is paid.` },
    })
    expect(res.statusCode).toBe(200)
    expect((await prisma.approvalInstance.findUniqueOrThrow({ where: { id: instance.id } })).aiSummary).toBe(`Employee ${ONLY_IN_TERMS} is paid.`)
  })

  it('with no current version, the latest one is what the key terms were read against, and what restores them', async () => {
    const CARD = '4111 1111 1111 1111'   // a card number only because the text says "credit card"
    const c4 = await makeContract(org, user, { title: 'No current version' })
    await prisma.contractVersion.create({ data: { contractId: c4, versionNumber: 1, createdById: user, plainText: `Paid by credit card ${CARD}.` } })
    await prisma.contract.update({ where: { id: c4 }, data: { keyTerms: { payment: CARD } } })
    const read = await app.inject({ method: 'GET', url: `/api/v1/contracts/${c4}`, headers: agentHeaders() })
    const token = (JSON.stringify(read.json().keyTerms).match(TOKEN) ?? [''])[0]
    expect(token).toMatch(TOKEN)

    const wf = await makeWorkflow(org, user, user)
    const instance = await prisma.approvalInstance.create({ data: { orgId: org, contractId: c4, workflowDefinitionId: wf, submittedById: user } })
    await app.inject({ method: 'PATCH', url: `/api/v1/approvals/${instance.id}/summary`, headers: internal(), payload: { aiSummary: `Paid by ${token}.` } })
    expect((await prisma.approvalInstance.findUniqueOrThrow({ where: { id: instance.id } })).aiSummary).toBe(`Paid by ${CARD}.`)
  })

  it('X33 — the approval summary gets the version text it asks for, tokenized', async () => {
    // approval.py reads plainText from this list; it never had any.
    const forAgents = await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/versions`, headers: agentHeaders() })
    expect(forAgents.statusCode).toBe(200)
    const latest = forAgents.json().data.find((v: { id: string }) => v.id === v2)
    expect(latest.plainText).toContain('The Employee (SSN ')
    expect(latest.plainText).toMatch(TOKEN)
    expect(forAgents.body).not.toContain(SSN)
    // Users' version list is as before: metadata only.
    const forUser = await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/versions`, headers: as() })
    expect(forUser.json().data[0].plainText).toBeUndefined()

    // A summary quoting the excerpt is stored with the value.
    const token = (latest.plainText.match(TOKEN) ?? [''])[0]
    const wf = await makeWorkflow(org, user, user)
    const instance = await prisma.approvalInstance.create({ data: { orgId: org, contractId: contract, workflowDefinitionId: wf, submittedById: user } })
    await app.inject({ method: 'PATCH', url: `/api/v1/approvals/${instance.id}/summary`, headers: agentHeaders(), payload: { aiSummary: `Covers SSN ${token}.` } })
    expect((await prisma.approvalInstance.findUniqueOrThrow({ where: { id: instance.id } })).aiSummary).toBe(`Covers SSN ${SSN}.`)
  })

  it('the chat\'s obligation and approval lists redact the text they quote', async () => {
    await prisma.obligation.create({
      data: { orgId: org, contractId: contract, type: 'payment', description: `Pay the holder of SSN ${SSN}.`, quote: TEXT },
    })
    const obligations = await app.inject({ method: 'POST', url: '/api/internal/ai/tools/obligations_list', headers: internal(), payload: { orgId: org, contractId: contract } })
    expect(obligations.statusCode).toBe(200)
    expect(obligations.json().items).toHaveLength(1)
    expect(obligations.body).not.toContain(SSN)

    const role = await prisma.role.upsert({ where: { orgId_name: { orgId: org, name: 'ADMIN' } }, create: { orgId: org, name: 'ADMIN', isSystem: true }, update: {} })
    await prisma.userRole.create({ data: { userId: user, roleId: role.id } })
    const wf = await makeWorkflow(org, user, user)
    const instance = await prisma.approvalInstance.create({
      data: { orgId: org, contractId: contract, workflowDefinitionId: wf, submittedById: user, aiSummary: `Pays the employee with SSN ${SSN}.` },
    })
    await prisma.approvalStep.create({ data: { orgId: org, approvalInstanceId: instance.id, stepName: 'Legal', stepOrder: 0, approverId: user } })
    // A long summary whose SSN crosses the 400-character cut: redacted whole, then cut.
    const long = await prisma.approvalInstance.create({
      data: { orgId: org, contractId: contract, workflowDefinitionId: wf, submittedById: user, aiSummary: `${'P'.repeat(394)} ${SSN} is on file.` },
    })
    await prisma.approvalStep.create({ data: { orgId: org, approvalInstanceId: long.id, stepName: 'Legal', stepOrder: 0, approverId: user } })
    const approvals = await app.inject({ method: 'POST', url: '/api/internal/ai/tools/approval_list', headers: internal(), payload: { orgId: org, userId: user, scope: 'all' } })
    expect(approvals.statusCode).toBe(200)
    expect(approvals.body).toContain('Pays the employee')
    expect(approvals.body).not.toContain(SSN)
    expect(approvals.body).not.toContain('123-4')
  })
})
