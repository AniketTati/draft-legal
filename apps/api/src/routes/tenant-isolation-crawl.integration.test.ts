/**
 * Y1 — a crawl of every API route, looking across orgs.
 *
 * Ten cross-org defects (S2, X6, X7, X9, X10, X19–X21, X25, X44) were found
 * one route at a time. This test gives Org B one record of every kind a route
 * can name, each carrying a marker in its text, then calls every route the app
 * registers as an Org A admin with Org B's ids: in the path, in the query
 * string and in the body. Internal tools get the same ids in their body.
 * It then checks three things:
 *
 *   - no response carries an Org B marker (nothing of Org B's was read);
 *   - none of Org B's rows changed;
 *   - no row outside Org B points at an Org B record (nothing was linked).
 *
 * It runs twice: with both layers of tenant isolation off (the Prisma guard
 * and Postgres row-level security), which tests the routes' own scoping, and
 * with both on, where the guard must never have had to step in
 * (`tenant_guard_blocked`). A new route is crawled automatically; only the
 * route families in EXCLUDED, each with its reason, are left out.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'

// Hermetic: nothing leaves the test. Queues, storage and search are stubbed,
// and every outbound HTTP call is refused (the agents service, providers, the
// API's own internal endpoints).
vi.mock('../lib/queue.js', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>()
  return Object.fromEntries(Object.entries(real).map(([k, v]) => [k, typeof v === 'function' ? vi.fn(async () => ({ id: 'job' })) : v]))
})
vi.mock('../lib/storage.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/storage.js')>()),
  s3: { send: vi.fn(async () => ({})) },
}))
vi.mock('../lib/elasticsearch.js', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>()
  return Object.fromEntries(Object.entries(real).map(([k, v]) => [k, typeof v === 'function' ? vi.fn(async () => ({ results: [], total: 0, hits: { hits: [], total: { value: 0 } } })) : v]))
})

import { getApp, closeApp, makeOrg, makeUser, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { ORG_MODELS, onTenantGuardBlocked, setTenantGuardEnabled, type TenantGuardBlock } from '../lib/tenant-guard.js'
import { setTenantRlsEnabled } from '../lib/tenant-rls.js'

const MARK = `ORGB-SECRET-${randomUUID().slice(0, 8)}`

/** Route families the crawl doesn't call, and why. Everything else is called. */
const EXCLUDED: Array<[RegExp, string]> = [
  [/^\/admin\/queues/,            'Bull Board: queue operations, closed outside development (X35)'],
  [/^\/api\/v1\/auth\//,          'sign-in, registration and refresh: public, no tenant yet'],
  [/^\/api\/v1\/sign\//,          'the signer portal: authorised by the signing token, not an org'],
  [/^\/api\/v1\/portal\//,        'the share portal: authorised by the portal token, not an org'],
  [/^\/api\/v1\/inbound\//,       'inbound email webhook: authorised by its secret; routes by address'],
  [/^\/api\/v1\/slack\//,         'Slack callbacks: authorised by Slack\'s signature'],
  [/^\/api\/v1\/marketing\//,     'the marketing site\'s public contact form'],
  [/^\/api\/v1\/telemetry/,       'client telemetry: no org data'],
  [/^\/api\/v1\/metrics/,         'Prometheus metrics: token-authorised, no org data'],
  [/^\/(health|ready|live)/,      'health checks'],
]

type Ids = Record<string, string>
let app: TestApp
let orgA: string, userA: string, orgB: string
const B: Ids = {}

async function seedOrgB(): Promise<void> {
  orgB = await makeOrg(`${MARK} org`)
  const user = await prisma.user.create({ data: { orgId: orgB, email: `orgb-${randomUUID()}@test.local`, passwordHash: 'x', name: `${MARK} user` } })
  B.user = user.id
  const by = { createdById: user.id }
  B.counterparty = (await prisma.counterparty.create({ data: { orgId: orgB, name: `${MARK} counterparty` } })).id
  B.matter = (await prisma.matter.create({ data: { orgId: orgB, name: `${MARK} matter`, ownerId: user.id, ...by, counterpartyId: B.counterparty } })).id
  B.contract = (await prisma.contract.create({ data: { orgId: orgB, title: `${MARK} contract`, type: 'NDA', ownerId: user.id, createdBy: user.id, counterpartyName: `${MARK} cp`, matterId: B.matter } })).id
  const version = await prisma.contractVersion.create({ data: { contractId: B.contract, versionNumber: 1, createdById: user.id, plainText: `${MARK} text`, htmlContent: `<p>${MARK} text</p>` } })
  B.version = version.id
  await prisma.contract.update({ where: { id: B.contract }, data: { currentVersionId: version.id } })
  B.clause = (await prisma.contractClause.create({ data: { versionId: version.id, clauseType: 'confidentiality', sectionRef: '1', content: `${MARK} clause` } })).id
  B.template = (await prisma.template.create({ data: { orgId: orgB, name: `${MARK} template`, ...by, sections: { create: [{ title: `${MARK} section`, content: `${MARK} body`, sortOrder: 0 }] } }, include: { sections: true } })).id
  B.section = (await prisma.templateSection.findFirstOrThrow({ where: { templateId: B.template } })).id
  B.category = (await prisma.clauseCategory.create({ data: { orgId: orgB, name: `${MARK} category` } })).id
  B.libraryItem = (await prisma.clauseLibraryItem.create({ data: { orgId: orgB, categoryId: B.category, title: `${MARK} item`, content: `${MARK} item`, ...by } })).id
  B.position = (await prisma.playbookPosition.create({ data: { orgId: orgB, clauseCategoryId: B.category, positionType: 'preferred', content: `${MARK} position`, ...by } })).id
  B.request = (await prisma.contractRequest.create({ data: { orgId: orgB, title: `${MARK} request`, type: 'NDA', requestedById: user.id, description: `${MARK} request` } })).id
  B.workflow = (await prisma.workflowDefinition.create({ data: { orgId: orgB, name: `${MARK} workflow`, ...by } })).id
  B.instance = (await prisma.approvalInstance.create({ data: { orgId: orgB, contractId: B.contract, workflowDefinitionId: B.workflow, submittedById: user.id } })).id
  B.step = (await prisma.approvalStep.create({ data: { orgId: orgB, approvalInstanceId: B.instance, stepOrder: 0, stepName: `${MARK} step`, approverId: user.id } })).id
  B.signatureRequest = (await prisma.signatureRequest.create({ data: { orgId: orgB, contractId: B.contract, versionId: version.id, ...by, message: `${MARK} message` } })).id
  B.signer = (await prisma.signer.create({ data: { signatureRequestId: B.signatureRequest, email: `signer-${randomUUID()}@test.local`, name: `${MARK} signer`, token: `crawl-${randomUUID()}` } })).id
  B.obligation = (await prisma.obligation.create({ data: { orgId: orgB, contractId: B.contract, type: 'payment', description: `${MARK} obligation`, quote: `${MARK} quote` } })).id
  B.invoice = (await prisma.invoice.create({ data: { orgId: orgB, contractId: B.contract, vendorName: `${MARK} vendor`, amount: 1, invoiceDate: new Date(), ...by } })).id
  B.webhook = (await prisma.webhook.create({ data: { orgId: orgB, name: `${MARK} webhook`, url: 'https://example.com/orgb', secret: `${MARK}-secret`, ...by } })).id
  B.delivery = (await prisma.webhookDelivery.create({ data: { webhookId: B.webhook, event: 'contract.created', payload: { note: MARK } } })).id
  B.apiKey = (await prisma.apiKey.create({ data: { orgId: orgB, name: `${MARK} key`, keyHash: randomUUID(), prefix: 'clm_orgb', ...by } })).id
  B.thread = (await prisma.agentThread.create({ data: { orgId: orgB, userId: user.id, title: `${MARK} thread` } })).id
  B.message = (await prisma.agentMessage.create({ data: { threadId: B.thread, role: 'user', content: { text: MARK } } })).id
  B.toolCall = (await prisma.toolCall.create({ data: { threadId: B.thread, messageId: B.message, toolName: 'comment_add', input: { body: MARK }, status: 'applied' } })).id
  B.comment = (await prisma.contractComment.create({ data: { orgId: orgB, contractId: B.contract, authorId: user.id, body: `${MARK} comment` } })).id
  B.shareLink = (await prisma.contractShareLink.create({ data: { orgId: orgB, contractId: B.contract, token: `crawl-${randomUUID()}`, label: `${MARK} link`, expiresAt: new Date(Date.now() + 86_400_000), ...by } })).id
  B.notification = (await prisma.notification.create({ data: { orgId: orgB, userId: user.id, type: 'info', title: `${MARK} note`, body: `${MARK} note`, resourceType: 'contract', resourceId: B.contract } })).id
  B.fieldDef = (await prisma.contractFieldDefinition.create({ data: { orgId: orgB, fieldKey: `orgb_${randomUUID().slice(0, 6)}`, fieldLabel: `${MARK} field`, fieldType: 'text' } })).id
  B.room = (await prisma.diligenceRoom.create({ data: { orgId: orgB, name: `${MARK} room`, description: MARK, ...by } })).id
  B.skill = (await prisma.skill.create({ data: { orgId: orgB, name: `${MARK} skill`, slug: `orgb-${randomUUID().slice(0, 8)}`, description: MARK, ownerType: 'org', contextScope: 'any', systemPrompt: MARK, modelTier: 'default' } })).id
  B.role = (await prisma.role.create({ data: { orgId: orgB, name: `${MARK}-role` } })).id
  B.audit = (await prisma.auditEvent.create({ data: { orgId: orgB, action: 'CONTRACT_VIEWED', resourceType: 'contract', resourceId: B.contract, metadata: { note: MARK } } })).id
}

/** What a route can be pointed at, by the name of its parameter or the path segment before `:id`. */
const PARAM_TARGET: Record<string, string> = {
  clauseId: 'clause', instanceId: 'instance', versionId: 'version', v1Id: 'version', v2Id: 'version',
  commentId: 'comment', workflowId: 'workflow', contractId: 'contract', srId: 'signatureRequest',
  linkId: 'shareLink', userId: 'user', toolCallId: 'toolCall', deliveryId: 'delivery',
}
const SEGMENT_TARGET: Record<string, string> = {
  contracts: 'contract', matters: 'matter', counterparties: 'counterparty', templates: 'template',
  clauses: 'libraryItem', categories: 'category', playbook: 'position', positions: 'position',
  requests: 'request', approvals: 'instance', workflows: 'workflow', 'signature-requests': 'signatureRequest',
  obligations: 'obligation', invoices: 'invoice', webhooks: 'webhook', 'api-keys': 'apiKey',
  threads: 'thread', comments: 'comment', notifications: 'notification', 'field-definitions': 'fieldDef',
  diligence: 'room', rooms: 'room', skills: 'skill', users: 'user', roles: 'role', team: 'user',
  'review-queue': 'contract', audit: 'audit', renewals: 'contract', sections: 'section',
}
const LITERAL_PARAM: Record<string, string> = { index: '0', provider: 'openai' }

/** Every way to fill a route's parameters with Org B's ids. */
function fillings(url: string): string[] {
  const names = [...url.matchAll(/:(\w+)/g)].map(m => m[1])
  let urls = [url]
  for (const name of names) {
    let values: string[]
    if (LITERAL_PARAM[name]) values = [LITERAL_PARAM[name]]
    else if (PARAM_TARGET[name]) values = [B[PARAM_TARGET[name]]]
    else {
      const segment = url.split(`/:${name}`)[0].split('/').pop() ?? ''
      values = SEGMENT_TARGET[segment] ? [B[SEGMENT_TARGET[segment]]] : Object.values(B)
    }
    urls = urls.flatMap(u => values.map(v => u.replace(`:${name}`, v)))
  }
  return urls
}

/** A body that names Org B everywhere a route might take an id, with plausible values elsewhere. */
function sink(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractId: B.contract, contractIds: [B.contract], ids: [B.contract], parentContractId: B.contract,
    matterId: B.matter, counterpartyId: B.counterparty, templateId: B.template, clauseId: B.clause,
    versionId: B.version, requestId: B.request, workflowId: B.workflow, workflowDefinitionId: B.workflow,
    instanceId: B.instance, stepId: B.step, obligationId: B.obligation, matchedObligationId: B.obligation,
    invoiceId: B.invoice, threadId: B.thread, sessionId: B.thread, skillId: B.skill, roleId: B.role,
    ownerId: B.user, assigneeId: B.user, assignedToId: B.user, approverId: B.user, delegateToId: B.user,
    categoryId: B.category, clauseCategoryId: B.category, fieldId: B.fieldDef, roomId: B.room, webhookId: B.webhook,
    title: 'QA crawl', name: 'QA crawl', description: 'QA crawl', vendorName: 'QA crawl', amount: 1,
    invoiceDate: new Date().toISOString(), type: 'NDA', contractType: 'NDA', body: 'QA crawl', content: 'QA crawl',
    message: 'QA crawl', userMessage: 'QA crawl', query: 'QA crawl', question: 'QA crawl', q: 'QA crawl',
    htmlContent: '<p>QA crawl</p>', proposedText: 'QA crawl', clauseType: 'confidentiality', sectionRef: '1',
    topic: 'confidentiality', topics: ['confidentiality'], decision: 'approve', comment: 'QA crawl', reason: 'QA crawl',
    ...extra,
  }
}

interface Finding { route: string; status: number }

async function crawl(): Promise<{ calls: number; leaks: Finding[]; statuses: Record<string, number> }> {
  const leaks: Finding[] = []
  const statuses: Record<string, number> = {}
  let calls = 0
  const call = async (method: string, url: string, headers: Record<string, string>, payload?: unknown) => {
    calls++
    const res = await app.inject({ method: method as 'GET', url, headers, payload: payload as never, remoteAddress: `10.9.${(calls >> 8) & 255}.${calls & 255}` })
    statuses[res.statusCode] = (statuses[res.statusCode] ?? 0) + 1
    if (res.body.includes(MARK)) leaks.push({ route: `${method} ${url}`, status: res.statusCode })
  }
  const user = auth(orgA, ['ADMIN'], userA)
  const internal = { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-internal-service': 'agents', 'x-org-id': orgA }
  for (const { method, url } of app.registeredRoutes) {
    if (EXCLUDED.some(([rx]) => rx.test(url))) continue
    const isInternal = url.startsWith('/api/internal/')
    const headers = isInternal ? internal : user
    const body = isInternal ? sink({ orgId: orgA, userId: userA }) : sink()
    const writes = method !== 'GET' && method !== 'DELETE'
    for (const filled of fillings(url)) {
      const query = method === 'GET' ? `?${new URLSearchParams({ contractId: B.contract, matterId: B.matter, counterpartyId: B.counterparty, ownerId: B.user, orgId: orgB, q: MARK.slice(0, 12) })}` : ''
      await call(method, filled + query, headers, writes ? body : undefined)
    }
  }
  return { calls, leaks, statuses }
}

/** Org B's rows, and every row elsewhere that points at one of them. */
async function orgBState(): Promise<string> {
  const allB = Object.values(B)
  const parts: string[] = []
  for (const [model, spec] of ORG_MODELS) {
    const delegate = (prisma as unknown as Record<string, { findMany: (a: unknown) => Promise<unknown[]>; count: (a: unknown) => Promise<number> }>)[spec.delegate]
    parts.push(`${model}:${JSON.stringify(await delegate.findMany({ where: { orgId: orgB }, orderBy: { id: 'asc' } }))}`)
    const fields = Prisma.dmmf.datamodel.models.find(m => m.name === model)!.fields
      .filter(f => f.kind === 'scalar' && f.type === 'String' && /Id$/.test(f.name) && f.name !== 'orgId')
    for (const f of fields) {
      const n = await delegate.count({ where: { [f.name]: { in: allB }, NOT: { orgId: orgB } } })
      if (n) parts.push(`LINK ${model}.${f.name} -> Org B: ${n}`)
    }
  }
  const children = await Promise.all([
    prisma.contractVersion.findMany({ where: { contractId: B.contract }, orderBy: { id: 'asc' } }),
    prisma.contractClause.findMany({ where: { versionId: B.version }, orderBy: { id: 'asc' } }),
    prisma.templateSection.findMany({ where: { templateId: B.template }, orderBy: { id: 'asc' } }),
    prisma.signer.findMany({ where: { signatureRequestId: B.signatureRequest }, orderBy: { id: 'asc' } }),
    prisma.agentMessage.findMany({ where: { threadId: B.thread }, orderBy: { id: 'asc' } }),
    prisma.toolCall.findMany({ where: { threadId: B.thread }, orderBy: { id: 'asc' } }),
    prisma.webhookDelivery.findMany({ where: { webhookId: B.webhook }, orderBy: { id: 'asc' } }),
  ])
  parts.push(`children:${JSON.stringify(children)}`)
  return parts.join('\n')
}

function diff(before: string, after: string): string[] {
  const a = before.split('\n'), b = after.split('\n')
  return b.filter((line, i) => line !== a[i]).map(line => line.slice(0, 300))
}

let blocks: TenantGuardBlock[] = []
let stopListening: () => void

beforeAll(async () => {
  app = await getApp()
  orgA = await makeOrg('Crawl Org A')
  userA = await makeUser(orgA)
  await seedOrgB()
  // Refuse every outbound call: the crawl must not reach the agents service
  // (:8002/:8003), a provider, or the API's own internal endpoints.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ detail: 'crawl: no outbound calls' }), { status: 503 }))
  stopListening = onTenantGuardBlocked(b => blocks.push(b))
})

/**
 * Remove everything both orgs hold, including what the crawl's own calls
 * created in Org A. Child rows first, then every org-scoped model in passes
 * until nothing more goes (foreign keys decide the order).
 */
async function purge(orgIds: string[]): Promise<void> {
  const quietly = async (fn: () => Promise<unknown>) => { await fn().catch(() => {}) }
  const contracts = (await prisma.contract.findMany({ where: { orgId: { in: orgIds } }, select: { id: true } })).map(c => c.id)
  const versions = (await prisma.contractVersion.findMany({ where: { contractId: { in: contracts } }, select: { id: true } })).map(v => v.id)
  const requests = (await prisma.signatureRequest.findMany({ where: { orgId: { in: orgIds } }, select: { id: true } })).map(r => r.id)
  await prisma.contract.updateMany({ where: { id: { in: contracts } }, data: { currentVersionId: null } })
  await quietly(() => prisma.contractClause.deleteMany({ where: { versionId: { in: versions } } }))
  await quietly(() => prisma.versionDiffCache.deleteMany({ where: { OR: [{ v1Id: { in: versions } }, { v2Id: { in: versions } }] } } as never))
  await quietly(() => prisma.signatureEvent.deleteMany({ where: { signatureRequestId: { in: requests } } }))
  await quietly(() => prisma.signer.deleteMany({ where: { signatureRequestId: { in: requests } } }))
  await quietly(() => prisma.templateSection.deleteMany({ where: { template: { orgId: { in: orgIds } } } }))
  await quietly(() => prisma.webhookDelivery.deleteMany({ where: { webhook: { orgId: { in: orgIds } } } }))
  await quietly(() => prisma.contractVersion.deleteMany({ where: { contractId: { in: contracts } } }))
  await quietly(() => prisma.userRole.deleteMany({ where: { user: { orgId: { in: orgIds } } } }))
  for (let pass = 0; pass < 8; pass++) {
    let gone = 0
    for (const [model, spec] of ORG_MODELS) {
      if (model === 'User') continue
      const delegate = (prisma as unknown as Record<string, { deleteMany: (a: unknown) => Promise<{ count: number }> }>)[spec.delegate]
      gone += (await delegate.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => ({ count: 0 }))).count
    }
    if (!gone) break
  }
}

afterAll(async () => {
  stopListening()
  setTenantGuardEnabled(true)
  setTenantRlsEnabled(true)
  vi.restoreAllMocks()
  await purge([orgA, orgB])
  await cleanupAll()
  await closeApp()
})

describe('every route, across orgs', () => {
  it('covers the routes the app serves, apart from the listed families', () => {
    const covered = app.registeredRoutes.filter(r => !EXCLUDED.some(([rx]) => rx.test(r.url)))
    // Sanity: the crawl sees the app's routes (311 when written) and calls most of them.
    expect(app.registeredRoutes.length).toBeGreaterThan(250)
    expect(covered.length).toBeGreaterThan(200)
  })

  it('without the guard or row-level security: the routes\' own scoping leaks nothing, changes nothing, links nothing', async () => {
    setTenantGuardEnabled(false)
    setTenantRlsEnabled(false)
    const before = await orgBState()
    const { calls, leaks, statuses } = await crawl()
    const after = await orgBState()
    console.info(`[crawl] isolation off: ${calls} calls`, JSON.stringify(statuses))
    expect(statuses['429'] ?? 0).toBe(0)
    expect(leaks).toEqual([])
    expect(diff(before, after)).toEqual([])
  }, 300_000)

  it('with both: the same, and the guard never had to step in', async () => {
    setTenantGuardEnabled(true)
    setTenantRlsEnabled(true)
    blocks = []
    const before = await orgBState()
    const { calls, leaks, statuses } = await crawl()
    const after = await orgBState()
    console.info(`[crawl] isolation on: ${calls} calls`, JSON.stringify(statuses))
    expect(statuses['429'] ?? 0).toBe(0)
    expect(leaks).toEqual([])
    expect(diff(before, after)).toEqual([])
    expect(blocks).toEqual([])
  }, 300_000)
})
