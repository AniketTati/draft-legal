/**
 * docs/41 Part 17 (S1) — draftLegal → Salesforce: keep each contract's
 * `DL_Contract__c` record current, and file the signed PDF on it (and on the
 * Opportunity) once the contract is executed.
 *
 * Run by the integration-sync worker. Every attempt is a row in
 * IntegrationSyncLog (direction, object, ids, payload hash, status, error,
 * attempt), which Integration health reads and retries from. A payload the
 * record already has (same hash as the last success) is skipped, so a burst
 * of events costs Salesforce API calls only when something visible changed.
 */
import { GetObjectCommand } from '@aws-sdk/client-s3'
import type { IntegrationConnection } from '@prisma/client'
import { AuditAction } from '@clm/types'
import { prisma } from '../prisma.js'
import { approvalProgress } from '../workflow-engine.js'
import { s3, S3_BUCKET } from '../storage.js'
import { connectionTokens, storeTokens } from '../integrations/connection.js'
import { applyOutboundMapping, mappingsForType, payloadHash, type FieldMapping } from '../integrations/mapping.js'
import { SalesforceClient, SalesforceApiError, CONTRACT_OBJECT } from './client.js'
import { refreshAccessToken, salesforceAppConfig, SalesforceAuthError } from './oauth.js'
import { contractSyncPayload, salesforceLinks, type SyncContract } from './payload.js'

type Fetch = typeof fetch

/** A failure no retry can fix (a revoked connection, a record Salesforce refuses). */
export class PermanentSyncError extends Error {
  constructor(message: string) { super(message); this.name = 'PermanentSyncError' }
}

/** A Salesforce client for a connection, refreshing (and storing) its token on a 401. */
export function clientFor(conn: IntegrationConnection, fetchImpl?: Fetch): SalesforceClient {
  const tokens = connectionTokens(conn)
  if (!conn.instanceUrl || !tokens.refreshToken) throw new PermanentSyncError('Salesforce is not connected')
  return new SalesforceClient(conn.instanceUrl, tokens.accessToken ?? '', {
    fetch: fetchImpl,
    refresh: async () => {
      const app = salesforceAppConfig()
      if (!app) throw new PermanentSyncError('Salesforce app settings are missing (SALESFORCE_CLIENT_ID / SALESFORCE_CLIENT_SECRET)')
      try {
        const t = await refreshAccessToken({ loginUrl: conn.loginUrl ?? 'https://login.salesforce.com', refreshToken: tokens.refreshToken!, clientId: app.clientId, clientSecret: app.clientSecret }, fetchImpl)
        await storeTokens(conn.id, conn.orgId, { accessToken: t.access_token, refreshToken: t.refresh_token })
        return t.access_token
      } catch (err) {
        if (err instanceof SalesforceAuthError && err.code === 'invalid_grant') {
          // The refresh token was revoked in Salesforce (or the integration
          // user lost access): only an admin reconnecting fixes that.
          await prisma.integrationConnection.updateMany({
            where: { id: conn.id, orgId: conn.orgId },
            data: { status: 'error', lastError: 'Salesforce no longer accepts this connection. Reconnect it in Settings → Integrations.' },
          })
          throw new PermanentSyncError('Salesforce access was revoked; reconnect Salesforce')
        }
        throw err
      }
    },
  })
}

const CONTRACT_SELECT = {
  id: true, orgId: true, title: true, type: true, status: true, stage: true, stageState: true, turn: true, turnSince: true, contractNumber: true,
  value: true, currency: true, effectiveDate: true, expiryDate: true, counterpartyName: true,
  metadata: true, updatedAt: true, currentVersionId: true,
  counterparty: { select: { crmId: true } },
  owner: { select: { name: true } },
} as const

/**
 * What the core records about each contract's status (docs/41 P0.6, P0.10):
 * its latest approval round (steps approved, who the current step waits on,
 * by name) and when the status last changed.
 */
export async function statusFacts(orgId: string, contractIds: string[]): Promise<Map<string, Pick<SyncContract, 'approvals' | 'statusSince'>>> {
  const out = new Map<string, Pick<SyncContract, 'approvals' | 'statusSince'>>()
  if (!contractIds.length) return out
  const [instances, changes] = await Promise.all([
    prisma.approvalInstance.findMany({
      where: { orgId, contractId: { in: contractIds } },
      orderBy: { submittedAt: 'desc' },
      select: { contractId: true, status: true, currentStepOrder: true, definition: { select: { steps: true } }, steps: { where: { kind: 'approval' }, select: { status: true, decision: true, stepOrder: true, approverId: true, approverRoleId: true } } },
    }),
    prisma.auditEvent.findMany({
      where: { orgId, resourceType: 'contract', resourceId: { in: contractIds }, action: { in: [AuditAction.STAGE_CHANGED, AuditAction.CONTRACT_STATUS_CHANGED] } },
      orderBy: { createdAt: 'desc' },
      distinct: ['resourceId'],
      select: { resourceId: true, createdAt: true },
    }),
  ])
  const waiting = instances.flatMap(i => i.steps.filter(st => st.status === 'PENDING' && st.stepOrder === i.currentStepOrder))
  const userIds = [...new Set(waiting.map(st => st.approverId).filter((x): x is string => !!x))]
  const roleIds = [...new Set(waiting.map(st => st.approverRoleId).filter((x): x is string => !!x))]
  const [users, roles] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { orgId, id: { in: userIds } }, select: { id: true, name: true, email: true } }) : Promise.resolve([]),
    roleIds.length ? prisma.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ])
  // A role's pooled step waits on the role (docs/41 Part 6).
  const nameOf = (st: { approverId: string | null; approverRoleId: string | null }) => {
    if (!st.approverId) return `any ${roles.find(r => r.id === st.approverRoleId)?.name ?? 'approver'}`
    const u = users.find(x => x.id === st.approverId); return u?.name || u?.email || 'someone'
  }
  for (const id of contractIds) {
    const latest = instances.find(i => i.contractId === id)
    const open = latest && (latest.status === 'PENDING' || latest.status === 'ESCALATED')
    out.set(id, {
      approvals: latest && latest.steps.length ? {
        ...approvalProgress(latest),
        ...(open && { waitingOn: latest.steps.filter(st => st.status === 'PENDING' && st.stepOrder === latest.currentStepOrder).map(nameOf) }),
      } : null,
      statusSince: changes.find(c => c.resourceId === id)?.createdAt ?? null,
    })
  }
  return out
}

async function loadContracts(orgId: string, ids: string[]): Promise<SyncContract[]> {
  const rows = await prisma.contract.findMany({ where: { orgId, id: { in: ids }, deletedAt: null }, select: CONTRACT_SELECT })
  const facts = await statusFacts(orgId, rows.map(r => r.id))
  return rows.map(r => ({ ...r, ...facts.get(r.id) }))
}

/** The contract's values by draftLegal field, for outbound mappings. */
function dlValues(c: SyncContract): Record<string, unknown> {
  const meta = (c.metadata ?? {}) as Record<string, unknown>
  return {
    ...Object.fromEntries(Object.entries(meta).filter(([k]) => !k.startsWith('_'))),
    title: c.title,
    value: c.value === null || c.value === undefined ? null : typeof c.value === 'object' ? c.value.toNumber() : Number(c.value),
    currency: c.currency ?? null,
    effectiveDate: c.effectiveDate ?? null,
    expiryDate: c.expiryDate ?? null,
    counterpartyName: c.counterpartyName ?? null,
  }
}

async function lastSuccessHash(orgId: string, contractId: string, object: string): Promise<string | null> {
  const row = await prisma.integrationSyncLog.findFirst({
    where: { orgId, provider: 'salesforce', contractId, object, direction: 'outbound', status: 'success' },
    orderBy: { at: 'desc' },
    select: { payloadHash: true },
  })
  return row?.payloadHash ?? null
}

async function readObject(key: string): Promise<Buffer> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }))
  return Buffer.from(await obj.Body!.transformToByteArray())
}

export interface SyncOutcome {
  synced: number
  skipped: number
  failed: number
  filesUploaded: number
  /** A failure worth retrying (Salesforce down, the signed PDF not sealed yet). */
  retry?: Error
}

/**
 * Sync `contractIds` of `orgId` to Salesforce now. Writes one log row per
 * contract (and per file); throws only when the whole call should be retried.
 */
export async function syncContractsToSalesforce(
  orgId: string,
  contractIds: string[],
  ctx: { attempt: number; event?: string; fetch?: Fetch; force?: boolean } = { attempt: 1 },
): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { synced: 0, skipped: 0, failed: 0, filesUploaded: 0 }
  const conn = await prisma.integrationConnection.findFirst({ where: { orgId, provider: 'salesforce' } })
  if (!conn || !['connected', 'error'].includes(conn.status)) return outcome
  const client = clientFor(conn, ctx.fetch)

  const contracts = await loadContracts(orgId, contractIds)
  const mappings: FieldMapping[] = await prisma.integrationFieldMapping.findMany({ where: { orgId, provider: 'salesforce' } })
  const now = new Date()

  const records: Array<{ contract: SyncContract; fields: Record<string, unknown>; hash: string }> = []
  for (const c of contracts) {
    const mapped = applyOutboundMapping(mappingsForType(mappings, c.type), dlValues(c))
    const fields = { ...contractSyncPayload(c, now), ...(mapped[CONTRACT_OBJECT] ?? {}) }
    // The sync time changes every run; it isn't what the record shows.
    const { DL_Last_Synced__c: _ignored, ...visible } = fields
    const hash = payloadHash(visible)
    if (!ctx.force && hash === await lastSuccessHash(orgId, c.id, CONTRACT_OBJECT)) {
      outcome.skipped++
      continue
    }
    records.push({ contract: c, fields, hash })
  }

  if (records.length) {
    let results
    try {
      results = await client.upsertContracts(records.map(r => r.fields))
    } catch (err) {
      await logAll(orgId, records, ctx, 'failed', (err as Error).message)
      throw err
    }
    for (const [i, r] of records.entries()) {
      const res = results[i]
      const ok = !!res?.success
      if (ok) outcome.synced++
      else outcome.failed++
      await prisma.integrationSyncLog.create({
        data: {
          orgId, provider: 'salesforce', direction: 'outbound', object: CONTRACT_OBJECT,
          externalId: res?.id ?? null, contractId: r.contract.id, event: ctx.event ?? null,
          payloadHash: r.hash, status: ok ? 'success' : 'failed', attempt: ctx.attempt,
          error: ok ? null : (res?.errors ?? []).map(e => `${e.statusCode ?? ''} ${e.message ?? ''}`.trim()).join('; ') || 'Salesforce refused the record',
          detail: ok ? { created: !!res.created } : { fields: r.fields } as never,
          completedAt: new Date(),
        },
      })
    }

    // Draftlegal owns the executed value: an outbound mapping onto the
    // Opportunity (e.g. value → Amount) is written once the contract is signed.
    for (const r of records) {
      if (r.contract.status !== 'EXECUTED') continue
      const opp = salesforceLinks(r.contract).opportunityId
      const oppFields = applyOutboundMapping(mappingsForType(mappings, r.contract.type), dlValues(r.contract)).Opportunity
      if (!opp || !oppFields || !Object.keys(oppFields).length) continue
      try {
        await client.updateRecord('Opportunity', opp, oppFields)
        await logOne(orgId, r.contract.id, 'Opportunity', opp, ctx, 'success', null, payloadHash(oppFields))
      } catch (err) {
        await logOne(orgId, r.contract.id, 'Opportunity', opp, ctx, 'failed', (err as Error).message, payloadHash(oppFields))
        if (err instanceof SalesforceApiError && (err.retryable || err.name === 'SalesforceRateLimitError')) outcome.retry ??= err
      }
    }
  }

  for (const c of contracts.filter(c => c.status === 'EXECUTED')) {
    const filed = await uploadSignedPdf(client, orgId, c, ctx)
    if (filed === 'uploaded') outcome.filesUploaded++
    if (filed instanceof Error) outcome.retry ??= filed
  }

  await prisma.integrationConnection.updateMany({
    where: { id: conn.id, orgId },
    data: { lastSyncAt: new Date(), ...(outcome.failed === 0 && conn.status === 'error' ? { status: 'connected', lastError: null } : {}) },
  })
  return outcome
}

/**
 * The executed contract's signed PDF, filed in Salesforce on the contract
 * record and the Opportunity. Once per contract: a later sync sees the success
 * in the log and does nothing.
 */
async function uploadSignedPdf(client: SalesforceClient, orgId: string, c: SyncContract, ctx: { attempt: number; event?: string }): Promise<'uploaded' | 'done' | 'none' | Error> {
  const done = await prisma.integrationSyncLog.count({ where: { orgId, provider: 'salesforce', contractId: c.id, object: 'ContentVersion', status: 'success' } })
  if (done) return 'done'

  const sealed = await prisma.contractVersion.findFirst({
    where: { contractId: c.id, s3Key: { startsWith: `signed/${c.id}/` } },
    orderBy: { versionNumber: 'desc' },
    select: { s3Key: true },
  })
  let key = sealed?.s3Key ?? null
  if (!key) {
    // Signed through draftLegal: the sealed copy comes a few seconds after
    // the last signature. Try again shortly rather than file the unsigned one.
    const signing = await prisma.signatureRequest.count({ where: { contractId: c.id, status: 'COMPLETED' } })
    if (signing) {
      const err = new Error('The signed PDF is still being sealed; trying again shortly')
      await logOne(orgId, c.id, 'ContentVersion', null, ctx, 'failed', err.message, null)
      return err
    }
    // Uploaded already signed: its own PDF is the signed copy.
    const current = (c as SyncContract & { currentVersionId?: string | null }).currentVersionId
    const version = current ? await prisma.contractVersion.findFirst({ where: { id: current, contractId: c.id }, select: { s3Key: true, mimeType: true } }) : null
    if (version?.s3Key && (version.mimeType === 'application/pdf' || /\.pdf$/i.test(version.s3Key))) key = version.s3Key
  }
  if (!key) return 'none'

  const links = salesforceLinks(c)
  const record = await prisma.integrationSyncLog.findFirst({
    where: { orgId, provider: 'salesforce', contractId: c.id, object: CONTRACT_OBJECT, status: 'success', externalId: { not: null } },
    orderBy: { at: 'desc' }, select: { externalId: true },
  })
  const linkTo = [record?.externalId, links.opportunityId].filter((x): x is string => !!x)
  if (!linkTo.length) return 'none'
  try {
    const data = await readObject(key)
    const docId = await client.uploadFile({ title: `${c.title} (signed)`.slice(0, 255), fileName: `${c.title.replace(/[^\w .-]+/g, '_').slice(0, 120)}.pdf`, data, linkTo })
    await logOne(orgId, c.id, 'ContentVersion', docId, ctx, 'success', null, null)
    return 'uploaded'
  } catch (err) {
    await logOne(orgId, c.id, 'ContentVersion', null, ctx, 'failed', (err as Error).message, null)
    return err as Error
  }
}

async function logOne(orgId: string, contractId: string, object: string, externalId: string | null, ctx: { attempt: number; event?: string }, status: string, error: string | null, hash: string | null) {
  await prisma.integrationSyncLog.create({
    data: { orgId, provider: 'salesforce', direction: 'outbound', object, externalId, contractId, event: ctx.event ?? null, payloadHash: hash, status, error, attempt: ctx.attempt, completedAt: new Date() },
  })
}

async function logAll(orgId: string, records: Array<{ contract: SyncContract; hash: string }>, ctx: { attempt: number; event?: string }, status: string, error: string) {
  await prisma.integrationSyncLog.createMany({
    data: records.map(r => ({
      orgId, provider: 'salesforce', direction: 'outbound', object: CONTRACT_OBJECT, contractId: r.contract.id,
      event: ctx.event ?? null, payloadHash: r.hash, status, error: error.slice(0, 2000), attempt: ctx.attempt, completedAt: new Date(),
    })),
  })
}

/**
 * The nightly reconcile: every contract Salesforce knows about (or asked
 * for) is upserted again where its record would differ. Contracts are found
 * by an earlier sync or a Salesforce link in their metadata.
 */
export async function reconcileOrg(orgId: string, ctx: { attempt: number; fetch?: Fetch } = { attempt: 1 }): Promise<SyncOutcome> {
  const logged = await prisma.integrationSyncLog.findMany({
    where: { orgId, provider: 'salesforce', object: CONTRACT_OBJECT, contractId: { not: null } },
    distinct: ['contractId'], select: { contractId: true },
  })
  const linked = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM contracts WHERE "orgId" = ${orgId} AND "deletedAt" IS NULL AND metadata ? 'salesforce' LIMIT 5000`
  const ids = [...new Set([...logged.map(l => l.contractId!), ...linked.map(c => c.id)])]
  if (!ids.length) return { synced: 0, skipped: 0, failed: 0, filesUploaded: 0 }
  return syncContractsToSalesforce(orgId, ids, { ...ctx, event: 'reconcile' })
}
