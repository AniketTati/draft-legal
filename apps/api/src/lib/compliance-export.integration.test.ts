/**
 * Z1 — the compliance package is evidence handed to an auditor. It printed
 * "tamper-evident hash chain verified per row" without checking anything. It
 * now checks each event it lists against the organization's chain and prints
 * what it found.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { AuditAction } from '@clm/types'
import { makeOrg, makeUser, makeContract, cleanupAll, prisma } from '../test-support/helpers.js'
import { createAuditEvent } from './audit.js'
import { generateCompliancePackage } from './compliance-export.js'

// pdf-parse v1 is CommonJS, as lib/document.ts loads it.
const pdfParse = createRequire(import.meta.url)('pdf-parse') as (b: Buffer) => Promise<{ text: string }>

let org: string, owner: string, contract: string

beforeAll(async () => {
  org = await makeOrg('Z1 Compliance Org')
  owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Z1 audited contract' })
  for (const action of [AuditAction.CONTRACT_CREATED, AuditAction.CONTRACT_UPDATED, AuditAction.SIGNATURE_SENT]) {
    await createAuditEvent({ orgId: org, userId: owner, action, resourceType: 'contract', resourceId: contract, metadata: { step: action } })
  }
})

afterAll(async () => { await cleanupAll() })

const packageText = async () =>
  (await pdfParse(Buffer.from(await generateCompliancePackage({ contractId: contract, orgId: org })))).text

describe('the compliance package\'s audit trail', () => {
  it('says the events it lists are intact, having checked them', async () => {
    const text = await packageText()
    expect(text).toMatch(/\d+ events recorded/)
    expect(text).toMatch(/checked against the organization's hash chain: intact/)
    expect(text).not.toMatch(/FAILED/)
  })

  it('says where the chain breaks when an event was altered afterwards', async () => {
    const [second] = await prisma.auditEvent.findMany({
      where: { orgId: org, resourceId: contract }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: 1, take: 1,
    })
    await prisma.$executeRaw`UPDATE audit_events SET metadata = '{"step":"rewritten"}' WHERE id = ${second.id}`
    const text = await packageText()
    expect(text).toMatch(/CHAIN CHECK FAILED/)
    expect(text).toContain(second.createdAt.toISOString().slice(0, 16).replace('T', ' '))
    expect(text).not.toMatch(/hash chain: intact/)
  })
})

describe('the compliance package as a file', () => {
  it('uses a classic cross-reference table, which every reader opens (pdf.js 1.x misread the compressed one about one save in forty)', async () => {
    const pdf = Buffer.from(await generateCompliancePackage({ contractId: contract, orgId: org })).toString('latin1')
    expect(pdf).toMatch(/\nxref\n0 \d+\n/)
    expect(pdf).not.toContain('/ObjStm')
    expect(pdf).not.toMatch(/\/Type\s*\/XRef/)
  })
})
