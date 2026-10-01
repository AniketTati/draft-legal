/**
 * docs/41 Part 17 (S1) — what a draftLegal contract looks like on its
 * Salesforce record, `DL_Contract__c`: status, stage, whose turn, dates,
 * value, counterparty, the deal it belongs to and a link back.
 *
 * `contractSyncPayload` is the one function that decides it. Stage and turn
 * come from the contract's status today, with what the core records about
 * it (docs/41 P0.6, P0.10): who an approval waits on, by name, and since when
 * the status stands (its last CONTRACT_STATUS_CHANGED event). docs/41 Part 18
 * adds a stored stage and turn to the contract; when a contract carries them
 * (`stage`, `turn`, `waitingSince`), they win, and nothing else here needs to
 * change.
 */
import { CONTRACT_EXTERNAL_ID } from './client.js'

export interface SyncContract {
  id: string
  title: string
  type: string
  status: string
  contractNumber?: string | null
  value?: { toNumber(): number } | number | string | null
  currency?: string | null
  effectiveDate?: Date | string | null
  expiryDate?: Date | string | null
  counterpartyName?: string | null
  metadata?: unknown
  updatedAt?: Date | string | null
  counterparty?: { crmId: string | null } | null
  owner?: { name: string | null } | null
  /** Approvals on the current round: decided-for and total steps, and who the current step waits on. */
  approvals?: { approved: number; total: number; waitingOn?: string[] } | null
  /** docs/41 P0.10 — when the status last changed (the latest status-change event). */
  statusSince?: Date | string | null
  /** docs/41 Part 18 — a stored stage and turn, once the core branch adds them. */
  stage?: string | null
  turn?: string | null
  waitingSince?: Date | string | null
}

/** The stage a status sits in, as Salesforce shows it on the path. */
const STAGE_BY_STATUS: Record<string, string> = {
  DRAFT:             'Draft',
  PENDING_REVIEW:    'Review',
  UNDER_NEGOTIATION: 'Negotiate',
  PENDING_APPROVAL:  'Approve',
  APPROVED:          'Approve',
  REJECTED:          'Draft',
  PENDING_SIGNATURE: 'Sign',
  EXECUTED:          'Signed',
  EXPIRED:           'Closed',
  TERMINATED:        'Closed',
  ARCHIVED:          'Closed',
}

/** The stages in order, for the path on the Salesforce record (the LWC reads it too). */
export const STAGES = ['Request', 'Draft', 'Review', 'Negotiate', 'Approve', 'Sign', 'Signed', 'Closed'] as const

export function stageFor(contract: Pick<SyncContract, 'status' | 'stage'>): string {
  if (contract.stage) return contract.stage
  return STAGE_BY_STATUS[contract.status] ?? 'Draft'
}

/**
 * Whose move it is, in words a rep understands: "Legal (Priya)", "Approvers
 * (1 of 2)", "Signers". Without a stored turn a negotiation's turn isn't
 * known (the last version could be either side's), so it says so.
 */
export function turnFor(contract: SyncContract): string | null {
  if (contract.turn) return contract.turn
  const owner = contract.owner?.name ? ` (${contract.owner.name})` : ''
  switch (contract.status) {
    case 'DRAFT':
    case 'PENDING_REVIEW':
    case 'REJECTED':          return `Legal${owner}`
    case 'UNDER_NEGOTIATION': return `Legal or counterparty${owner}`
    case 'PENDING_APPROVAL': {
      const a = contract.approvals
      if (!a) return 'Approvers'
      const who = a.waitingOn?.length ? `: ${a.waitingOn.slice(0, 3).join(', ')}${a.waitingOn.length > 3 ? ` and ${a.waitingOn.length - 3} more` : ''}` : ''
      return `Approvers${who} (${a.approved} of ${a.total})`
    }
    case 'APPROVED':          return `Legal${owner}: send for signature`
    case 'PENDING_SIGNATURE': return 'Signers'
    default:                  return null
  }
}

const day = (d: Date | string | null | undefined): string | null => {
  if (!d) return null
  const date = d instanceof Date ? d : new Date(d)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

const isoOrNull = (d: Date | string | null | undefined): string | null => {
  if (!d) return null
  const date = d instanceof Date ? d : new Date(d)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const num = (v: SyncContract['value']): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'object' ? v.toNumber() : Number(v)
  return Number.isFinite(n) ? n : null
}

/** Salesforce ids we hold for a contract (set when Salesforce asked for it). */
export function salesforceLinks(contract: Pick<SyncContract, 'metadata' | 'counterparty'>): { opportunityId?: string; accountId?: string; quoteId?: string } {
  const sf = ((contract.metadata ?? {}) as { salesforce?: Record<string, unknown> }).salesforce ?? {}
  const id = (v: unknown, prefix: string) => typeof v === 'string' && /^[A-Za-z0-9]{15,18}$/.test(v) && v.startsWith(prefix) ? v : undefined
  return {
    opportunityId: id(sf.opportunityId, '006'),
    accountId:     id(sf.accountId, '001') ?? id(contract.counterparty?.crmId, '001'),
    quoteId:       id(sf.quoteId, '0Q0'),
  }
}

export function contractLink(contractId: string): string {
  const base = (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '')
  return `${base}/contracts/${contractId}`
}

/** The `DL_Contract__c` fields for a contract (upserted by `DL_Contract_Id__c`). */
export function contractSyncPayload(contract: SyncContract, now: Date = new Date()): Record<string, unknown> {
  const links = salesforceLinks(contract)
  return {
    [CONTRACT_EXTERNAL_ID]: contract.id,
    Name:                   contract.title.slice(0, 80),
    DL_Contract_Number__c:  contract.contractNumber ?? null,
    DL_Type__c:             contract.type,
    DL_Status__c:           contract.status,
    DL_Stage__c:            stageFor(contract),
    DL_Waiting_On__c:       turnFor(contract),
    DL_Waiting_Since__c:    isoOrNull(contract.waitingSince ?? contract.statusSince),
    DL_Approvals__c:        contract.approvals ? `${contract.approvals.approved} of ${contract.approvals.total}` : null,
    DL_Effective_Date__c:   day(contract.effectiveDate),
    DL_Expiry_Date__c:      day(contract.expiryDate),
    DL_Value__c:            num(contract.value),
    DL_Currency__c:         contract.currency ?? null,
    DL_Counterparty__c:     contract.counterpartyName ?? null,
    DL_Link__c:             contractLink(contract.id),
    DL_Last_Synced__c:      now.toISOString(),
    ...(links.accountId ? { DL_Account__c: links.accountId } : {}),
    ...(links.opportunityId ? { DL_Opportunity__c: links.opportunityId } : {}),
    ...(links.quoteId ? { DL_Quote__c: links.quoteId } : {}),
  }
}
