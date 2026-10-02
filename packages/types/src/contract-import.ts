/**
 * docs/39 A16 — contracts imported from a spreadsheet, with their documents:
 * the one list of contract types and statuses as people write them in a
 * spreadsheet ("Master Services Agreement", "DPA", "Signed"), and the field a
 * column's header most likely names ("Vendor" is the counterparty, "End date"
 * the expiry date). The import wizard suggests with these and the API reads
 * with them, so a sheet reads the same in both.
 *
 * The CSV import had its own type list, which stored types the rest of the
 * app doesn't know (VENDOR, DPA) and read ones it does as OTHER
 * (DATA_PROCESSING, VENDOR_AGREEMENT, SLA, PARTNERSHIP).
 */
import { ContractStatus, ContractType } from './enums'
import type { CatalogField } from './field-query'

// ─── Where a column goes ──────────────────────────────────────────────────────

/** What one spreadsheet column becomes: a contract's own property, the document it goes with, or any field. */
export type ImportTarget =
  | { kind: 'title' }
  | { kind: 'type' }
  | { kind: 'status' }
  /** The name of the document file the row goes with. */
  | { kind: 'file' }
  /** The owner's email address. */
  | { kind: 'owner' }
  | { kind: 'field'; key: string }

export const IMPORT_TARGET_LABELS: Record<Exclude<ImportTarget['kind'], 'field'>, string> = {
  title: 'Title',
  type: 'Contract type',
  status: 'Status',
  file: 'Document file name',
  owner: 'Owner (email)',
}

/** A header as compared: lower case, letters and digits only ("Start Date" → "startdate"). */
export const importKey = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '')

/** Headers people use for each of a contract's own properties. */
const OWN_HEADERS: Array<[Exclude<ImportTarget['kind'], 'field'>, string[]]> = [
  ['file', ['file', 'filename', 'files', 'document', 'documentname', 'documentfile', 'pdf', 'pdfname', 'attachment', 'attachmentname', 'path', 'filepath', 'link']],
  ['title', ['title', 'name', 'contract', 'contractname', 'contracttitle', 'agreement', 'agreementname', 'agreementtitle', 'subject']],
  ['type', ['type', 'contracttype', 'agreementtype', 'category', 'documenttype', 'kind']],
  ['status', ['status', 'contractstatus', 'stage', 'state', 'lifecycle', 'lifecyclestage']],
  ['owner', ['owner', 'owneremail', 'contractowner', 'responsible', 'assignee', 'accountable', 'manager', 'businessowner']],
]

/** Other headers people use for the standard fields (their labels and keys match too). */
const FIELD_HEADERS: Record<string, string[]> = {
  counterpartyName: ['counterparty', 'counterpartyname', 'vendor', 'vendorname', 'supplier', 'suppliername', 'customer', 'customername', 'client', 'clientname', 'otherparty', 'thirdparty', 'company', 'partner'],
  effectiveDate: ['effective', 'effectivedate', 'startdate', 'start', 'commencementdate', 'commencement', 'contractstart'],
  expiryDate: ['expiry', 'expirydate', 'expiration', 'expirationdate', 'enddate', 'end', 'expires', 'contractend', 'terminationdate'],
  executionDate: ['signed', 'signeddate', 'datesigned', 'signedon', 'executiondate', 'executed', 'signaturedate'],
  value: ['value', 'contractvalue', 'totalvalue', 'tcv', 'amount', 'contractamount', 'price', 'fees', 'fee'],
  currency: ['currency', 'ccy', 'currencycode'],
  governingLaw: ['governinglaw', 'law', 'jurisdiction', 'governedby'],
  autoRenew: ['autorenew', 'autorenewal', 'autorenews', 'evergreen', 'renewsautomatically', 'automaticrenewal'],
  initialTerm: ['term', 'initialterm', 'termlength', 'contractterm'],
  renewalTerm: ['renewalterm', 'renewalperiod'],
  nonRenewalNotice: ['renewalnotice', 'nonrenewalnotice', 'noticetocancel', 'cancellationnotice', 'optoutnotice'],
  terminationNotice: ['terminationnotice', 'terminationnoticeperiod'],
  paymentTermsDays: ['paymentterms', 'paymentdays', 'netdays', 'paymentdue'],
  liabilityCapAmount: ['liabilitycap', 'capofliability', 'liabilitylimit'],
  venue: ['venue', 'disputes', 'forum'],
}

/** The target a column's header most likely names, or null to leave the column out. */
export function suggestImportTarget(header: string, catalog: readonly CatalogField[]): ImportTarget | null {
  const k = importKey(header)
  if (!k) return null
  for (const [kind, words] of OWN_HEADERS) if (words.includes(k)) return { kind }
  // A field's own label or key, then the other names people use for the standard ones.
  const byName = catalog.find(f => importKey(f.label) === k || importKey(f.key) === k)
  if (byName) return { kind: 'field', key: byName.key }
  for (const [key, words] of Object.entries(FIELD_HEADERS)) {
    if (words.includes(k) && catalog.some(f => f.key === key)) return { kind: 'field', key }
  }
  return null
}

// ─── Contract types ───────────────────────────────────────────────────────────

export const CONTRACT_TYPE_LABELS: Record<ContractType, string> = {
  NDA: 'NDA',
  MSA: 'MSA',
  SOW: 'SOW',
  SLA: 'SLA',
  VENDOR_AGREEMENT: 'Vendor agreement',
  EMPLOYMENT: 'Employment',
  PARTNERSHIP: 'Partnership',
  LICENSE: 'License',
  DATA_PROCESSING: 'Data processing',
  ORDER_FORM: 'Order form',
  OTHER: 'Other',
}

/** How people name each type, compared as importKey(): exact names first, then words a name contains. */
const TYPE_NAMES: Array<[ContractType, string[], string[]]> = [
  [ContractType.NDA, ['nda', 'mnda', 'cda', 'mutualnda', 'nondisclosure', 'nondisclosureagreement', 'confidentiality', 'confidentialityagreement'], ['nondisclosure', 'confidentiality']],
  [ContractType.DATA_PROCESSING, ['dpa', 'dataprocessing', 'dataprocessingagreement', 'dataprocessingaddendum', 'gdpr'], ['dataprocessing', 'dataprotection']],
  [ContractType.SOW, ['sow', 'statementofwork', 'workorder'], ['statementofwork']],
  [ContractType.MSA, ['msa', 'masteragreement', 'masterservicesagreement', 'masterserviceagreement', 'framework', 'frameworkagreement'], ['masterservice', 'masteragreement', 'framework']],
  [ContractType.SLA, ['sla', 'servicelevelagreement', 'servicelevel'], ['servicelevel']],
  [ContractType.ORDER_FORM, ['orderform', 'order', 'purchaseorder', 'po', 'quote', 'salesorder'], ['orderform', 'purchaseorder']],
  [ContractType.LICENSE, ['license', 'licence', 'licenseagreement', 'licenceagreement', 'eula', 'saas', 'subscription', 'subscriptionagreement'], ['license', 'licence', 'subscription']],
  [ContractType.EMPLOYMENT, ['employment', 'employmentagreement', 'employmentcontract', 'offerletter'], ['employment']],
  [ContractType.PARTNERSHIP, ['partnership', 'partner', 'partneragreement', 'reseller', 'reselleragreement', 'distribution', 'distributionagreement', 'referral', 'alliance', 'jointventure'], ['partner', 'reseller', 'distribut', 'referral']],
  [ContractType.VENDOR_AGREEMENT, ['vendor', 'vendoragreement', 'supplier', 'supplieragreement', 'supply', 'supplyagreement', 'purchase', 'purchaseagreement', 'procurement'], ['vendor', 'supplier', 'supply', 'procurement']],
  [ContractType.OTHER, ['other'], []],
]

/**
 * A spreadsheet's type as the app knows it: an exact name ("DPA", "Order
 * Form", "VENDOR_AGREEMENT"), else one it contains ("Mutual Non-Disclosure
 * Agreement"); a type none of them name is OTHER, `known: false`. Null when blank.
 */
export function readContractType(raw: string): { type: ContractType; known: boolean } | null {
  const k = importKey(raw)
  if (!k) return null
  for (const t of Object.values(ContractType)) if (importKey(t) === k) return { type: t, known: true }
  for (const [type, names] of TYPE_NAMES) if (names.includes(k)) return { type, known: true }
  for (const [type, , words] of TYPE_NAMES) if (words.some(w => k.includes(w))) return { type, known: true }
  return { type: ContractType.OTHER, known: false }
}

// ─── Statuses ─────────────────────────────────────────────────────────────────

/** Statuses only the approval workflow sets (X24): an import can't. */
export const WORKFLOW_ONLY_STATUSES: readonly string[] = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED']

/** The statuses an import can set. */
export const IMPORTABLE_STATUSES: readonly ContractStatus[] = Object.values(ContractStatus).filter(s => !WORKFLOW_ONLY_STATUSES.includes(s))

const STATUS_NAMES: Array<[string, string[]]> = [
  ['EXECUTED', ['executed', 'signed', 'fullyexecuted', 'fullysigned', 'active', 'inforce', 'live', 'effective', 'current', 'complete', 'completed', 'inplace']],
  ['PENDING_SIGNATURE', ['pendingsignature', 'outforsignature', 'sentforsignature', 'awaitingsignature', 'signing', 'forsignature']],
  ['UNDER_NEGOTIATION', ['undernegotiation', 'negotiation', 'negotiating', 'innegotiation', 'redline', 'redlining', 'redlines']],
  ['PENDING_REVIEW', ['pendingreview', 'inreview', 'underreview', 'review', 'legalreview']],
  ['EXPIRED', ['expired', 'lapsed', 'ended', 'inactive', 'endofterm']],
  ['TERMINATED', ['terminated', 'cancelled', 'canceled', 'rescinded', 'terminatedearly']],
  ['ARCHIVED', ['archived', 'archive']],
  ['DRAFT', ['draft', 'drafting', 'new', 'wip', 'inprogress', 'notstarted', 'requested']],
  ['PENDING_APPROVAL', ['pendingapproval', 'awaitingapproval', 'forapproval', 'inapproval']],
  ['APPROVED', ['approved']],
  ['REJECTED', ['rejected', 'declined']],
]

/**
 * A spreadsheet's status as the app knows it ("Signed", "Active" → EXECUTED).
 * `workflow`: only an approval sets it (X24), so the import reads it as DRAFT
 * — which the person can change for all of that value at once. Null when blank.
 */
export function readContractStatus(raw: string): { status: ContractStatus; known: boolean; workflow?: string } | null {
  const k = importKey(raw)
  if (!k) return null
  const named = STATUS_NAMES.find(([, names]) => names.includes(k))?.[0] ?? Object.values(ContractStatus).find(s => importKey(s) === k)
  if (!named) return { status: ContractStatus.DRAFT, known: false }
  if (WORKFLOW_ONLY_STATUSES.includes(named)) return { status: ContractStatus.DRAFT, known: true, workflow: named }
  return { status: named as ContractStatus, known: true }
}
