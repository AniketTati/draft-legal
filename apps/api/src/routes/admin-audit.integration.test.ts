/**
 * X3 — the audit log, the metrics endpoint and error reporting were empty
 * stubs. The org's audit trail is now readable by admins (and its hash chain
 * checkable), GET /api/v1/metrics serves Prometheus text to a scraper holding
 * METRICS_TOKEN, and 5xx errors reach Cloud Error Reporting on Cloud Run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getApp, closeApp, makeOrg, makeUser, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction } from '@clm/types'

let app: TestApp
let org: string, other: string, admin: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Audit Viewer Org')
  other = await makeOrg('Audit Other Org')
  admin = await makeUser(org)
  for (let i = 0; i < 5; i++) {
    await createAuditEvent({ orgId: org, userId: admin, action: AuditAction.CONTRACT_UPDATED, resourceType: 'contract', resourceId: `c-${i}`, metadata: { i } })
  }
  await createAuditEvent({ orgId: org, userId: admin, action: AuditAction.CONTRACT_CREATED, resourceType: 'contract', resourceId: 'c-new' })
  await createAuditEvent({ orgId: other, action: AuditAction.CONTRACT_UPDATED, resourceType: 'contract', resourceId: 'OTHER-ORG-ROW' })
})

afterAll(async () => {
  delete process.env.METRICS_TOKEN
  await cleanupAll()
  await closeApp()
})

const list = (query: string, roles = ['ADMIN']) =>
  app.inject({ method: 'GET', url: `/api/v1/admin/audit${query}`, headers: auth(org, roles, admin) })

describe('the org audit log', () => {
  it('lists this org\'s events newest first, with the actor', async () => {
    const res = await list('')
    expect(res.statusCode).toBe(200)
    const { events } = res.json() as { events: Array<{ action: string; resourceId: string; actor: { id: string } | null }> }
    expect(events[0]).toMatchObject({ action: 'CONTRACT_CREATED', resourceId: 'c-new', actor: { id: admin } })
    expect(res.body).not.toContain('OTHER-ORG-ROW')
  })

  it('filters, and pages with a cursor without overlap', async () => {
    const first = (await list('?action=CONTRACT_UPDATED&limit=3')).json() as { events: Array<{ id: string; resourceId: string }>; nextCursor: string }
    expect(first.events.map(e => e.resourceId)).toEqual(['c-4', 'c-3', 'c-2'])
    const second = (await list(`?action=CONTRACT_UPDATED&limit=3&cursor=${first.nextCursor}`)).json() as { events: Array<{ resourceId: string }>; nextCursor: string | null }
    expect(second.events.map(e => e.resourceId)).toEqual(['c-1', 'c-0'])
    expect(second.nextCursor).toBeNull()
  })

  it('refuses a malformed filter or cursor instead of failing (X3 follow-up)', async () => {
    for (const q of ['?cursor=%00', '?resourceType=%00', '?action=' + 'A'.repeat(300)]) {
      expect((await list(q)).statusCode, q).toBe(400)
    }
  })

  it('lists large metadata by reference and serves it per event', async () => {
    await createAuditEvent({ orgId: org, userId: admin, action: AuditAction.CONTRACT_UPDATED, resourceType: 'contract', resourceId: 'big', metadata: { blob: 'x'.repeat(20_000) } })
    const ev = (await list('?limit=1')).json().events[0]
    expect(ev).toMatchObject({ resourceId: 'big', metadata: null, metadataTruncated: true })
    const full = await app.inject({ method: 'GET', url: `/api/v1/admin/audit/${ev.id}`, headers: auth(org, ['ADMIN'], admin) })
    expect((full.json().metadata as { blob: string }).blob).toHaveLength(20_000)
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/audit/${ev.id}`, headers: auth(other, ['ADMIN'], admin) })).statusCode).toBe(404)
  })

  it('verifies a long chain in batches', async () => {
    // Legacy (unhashed) rows before the other org's one hashed event: more than one batch.
    const past = Date.now() - 86_400_000
    await prisma.auditEvent.createMany({
      data: Array.from({ length: 1_500 }, (_, i) => ({ orgId: other, action: 'LEGACY', resourceType: 'x', resourceId: `l-${i}`, createdAt: new Date(past + i) })),
    })
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/audit/verify', headers: auth(other, ['ADMIN'], admin) })
    expect(res.json()).toMatchObject({ ok: true, total: 1_501, verified: 1_501, truncated: false })
  })

  it('is for admins', async () => {
    expect((await list('', ['LEGAL_OPS'])).statusCode).toBe(403)
  })

  it('verifies the hash chain, and finds a tampered row', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/v1/admin/audit/verify', headers: auth(org, ['ADMIN'], admin) })
    expect(ok.json()).toMatchObject({ ok: true, firstBreak: null })
    await prisma.$executeRaw`UPDATE audit_events SET metadata = '{"i": 99}'::jsonb WHERE "orgId" = ${org} AND "resourceId" = 'c-2'`
    const broken = await app.inject({ method: 'GET', url: '/api/v1/admin/audit/verify', headers: auth(org, ['ADMIN'], admin) })
    expect(broken.json()).toMatchObject({ ok: false, firstBreak: { reason: 'hash_mismatch' } })
  })
})

describe('GET /api/v1/metrics', () => {
  it('is off without METRICS_TOKEN', async () => {
    delete process.env.METRICS_TOKEN
    expect((await app.inject({ method: 'GET', url: '/api/v1/metrics' })).statusCode).toBe(404)
  })

  it('serves Prometheus text to the token holder only, labelled by route pattern', async () => {
    process.env.METRICS_TOKEN = 'it-metrics-token'
    const junk = `/api/v1/no-such-route-${randomUUID()}`
    await app.inject({ method: 'GET', url: junk })
    await list('')
    expect((await app.inject({ method: 'GET', url: '/api/v1/metrics' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/v1/metrics', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401)
    // X74 — only as a bearer token, as documented: the bare token was accepted too.
    expect((await app.inject({ method: 'GET', url: '/api/v1/metrics', headers: { authorization: 'it-metrics-token' } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/v1/metrics', headers: { authorization: 'bearer it-metrics-token' } })).statusCode).toBe(200)
    const res = await app.inject({ method: 'GET', url: '/api/v1/metrics', headers: { authorization: 'Bearer it-metrics-token' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.body).toMatch(/http_requests_total\{instance_id="[^"]+",method="GET",route="\/api\/v1\/admin\/audit",status_code="200"\} \d+/)
    expect(res.body).toContain('route="unmatched"')
    expect(res.body).not.toContain(junk)   // bounded labels: never the raw URL
    expect(res.body).toMatch(/process_resident_memory_bytes\{instance_id="[^"]+"\} \d+/)
    expect(res.body).toMatch(/bullmq_jobs\{instance_id="[^"]+",queue="documents",state="waiting"\} \d+/)
  })
})
