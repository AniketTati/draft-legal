import {
  ContractStatus,
  ContractType,
  RequestStatus,
  ApprovalStatus,
  SignatureStatus,
  ObligationStatus,
  ObligationType,
  SystemRole,
  AuditAction,
  UserStatus,
  PermissionAction,
  PermissionResource,
  PermissionScope,
} from './enums'

export interface Organization {
  id: string
  name: string
  slug: string
  subscriptionTier: 'FREE' | 'PRO' | 'ENTERPRISE'
  brandColor?: string
  logoUrl?: string
  settings: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface User {
  id: string
  orgId: string
  email: string
  name: string
  avatarUrl?: string
  roles: SystemRole[]
  status: UserStatus
  preferences: Record<string, unknown>
  lastActiveAt?: string
  createdAt: string
  updatedAt: string
}

export interface Permission {
  action: PermissionAction | '*'
  resource: PermissionResource | '*'
  scope: PermissionScope
}

export interface Role {
  id: string
  orgId?: string
  name: string
  description?: string
  permissions: Permission[]
  isSystem: boolean
  createdAt: string
  updatedAt: string
}

export interface AuthTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

/**
 * A human's verdict on one extracted field.
 *
 * Deliberately NESTED inside the entry rather than living in a sibling map at
 * the top level of `fieldConfidence`. Two readers iterate that object's keys as
 * field names (review-queue.ts and ContractDetailPage), and review-queue.ts
 * filters rows with a Prisma `{ not: {} }` — so any top-level key would be read
 * as a field and would make every analysed contract match that filter.
 */
export interface FieldReview {
  verdict: 'verified' | 'rejected'
  at:      string
  by:      string
  /** Set only by the backfill, on rows whose extractor confidence was already
   *  destroyed and cannot be recovered. Lets those rows be excluded from a
   *  calibration curve explicitly rather than silently skewing it. */
  migrated?: boolean
}

/**
 * One field's extraction result plus, if a human has ruled on it, their verdict.
 *
 * `confidence` is the EXTRACTOR's and is never overwritten by a human action.
 * It used to be: verify wrote 1 and reject wrote 0, which destroyed the only
 * variable you would regress a human verdict against — and did so retroactively,
 * because the value is gone the moment someone clicks.
 *
 * That also collided with a real extractor output: review_agent.py is instructed
 * to emit confidence 1.0 for "certain absence" when a field is genuinely not in
 * the document, so 1 could never have distinguished AI-certain from
 * human-verified. The two are now orthogonal fields.
 *
 * `null` means unknown — used by the backfill for rows already clobbered.
 */
export interface FieldConfidenceEntry {
  confidence: number | null
  quote?:     string | null
  section?:   string | null
  issue?:     string | null
  review?:    FieldReview
}

export interface Contract {
  id: string
  orgId: string
  title: string
  type: ContractType
  status: ContractStatus
  counterpartyId?: string
  counterpartyName?: string
  value?: number
  currency?: string
  effectiveDate?: string
  expiryDate?: string
  ownerId: string
  currentVersionId?: string
  riskScore?: number
  riskFactors: string[]
  overallConfidence?: number
  summary?: string
  keyTerms: Record<string, unknown>
  fieldConfidence: Record<string, FieldConfidenceEntry>
  analysisStatus: string
  analysisError?: string
  tags: string[]
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface ContractClause {
  id: string
  clauseType: string
  content: string
  interpretation?: string
  riskRating?: string   // "favorable" | "unfavorable" | "neutral" | "unusual"
  sectionRef?: string
  sortOrder: number
}

export interface ContractVersion {
  id: string
  contractId: string
  versionNumber: number
  htmlContent: string
  plainText: string
  s3Key?: string
  createdById: string
  changeNote?: string
  createdAt: string
}

export interface ContractRequest {
  id: string
  orgId: string
  title: string
  type: ContractType
  status: RequestStatus
  requestedById: string
  assignedToId?: string
  counterpartyName?: string
  description: string
  estimatedValue?: number
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface ApprovalInstance {
  id: string
  contractId: string
  workflowDefinitionId: string
  status: ApprovalStatus
  currentStepIndex: number
  steps: ApprovalStep[]
  createdAt: string
  updatedAt: string
}

export interface ApprovalStep {
  id: string
  approvalInstanceId: string
  approverId: string
  approverName: string
  status: ApprovalStatus
  decision?: string
  comment?: string
  decidedAt?: string
}

export interface SignatureRequest {
  id: string
  contractId: string
  status: SignatureStatus
  signers: Signer[]
  dueDate?: string
  createdById: string
  createdAt: string
  updatedAt: string
}

export interface Signer {
  id: string
  signatureRequestId: string
  name: string
  email: string
  order: number
  signed: boolean
  signedAt?: string
  token: string
}

export interface Obligation {
  id: string
  contractId: string
  title: string
  description: string
  type: ObligationType
  status: ObligationStatus
  dueDate?: string
  responsiblePartyId?: string
  responsiblePartyName?: string
  evidenceUrl?: string
  completedAt?: string
  createdAt: string
  updatedAt: string
}

export interface AuditEvent {
  id: string
  orgId: string
  userId?: string
  action: AuditAction
  resourceType: string
  resourceId: string
  metadata: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
  createdAt: string
}

export interface PaginatedResponse<T> {
  data: T[]
  cursor?: string
  hasMore: boolean
  total?: number
}

export interface ApiError {
  type: string
  title: string
  status: number
  detail: string
  instance?: string
}
