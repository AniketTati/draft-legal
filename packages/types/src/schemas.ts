import { z } from 'zod'
import { ContractType, RequestStatus, SystemRole, PermissionAction, PermissionResource, PermissionScope } from './enums'

// ─── Auth ────────────────────────────────────────────────────────────────────

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

export const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  orgName: z.string().min(1).optional(),
  orgSlug: z.string().min(1).optional(),
})

export const RefreshTokenSchema = z.object({
  refreshToken: z.string(),
})

// ─── Contracts ───────────────────────────────────────────────────────────────

export const CreateContractSchema = z.object({
  title: z.string().min(1),
  type: z.nativeEnum(ContractType),
  counterpartyName: z.string().optional(),
  value: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  effectiveDate: z.string().datetime().optional(),
  expiryDate: z.string().datetime().optional(),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
})

export const UpdateContractSchema = CreateContractSchema.partial().extend({
  status: z.string().optional(),
  summary: z.string().optional(),
  keyTerms: z.record(z.unknown()).optional(),
  riskScore: z.number().min(0).max(1).optional(),
  riskFactors: z.array(z.string()).optional(),
  overallConfidence: z.number().min(0).max(1).optional(),
  // Wave E.2 — these fields are written by the agents-service review
  // callback after extraction. Before this line landed, Zod silently
  // stripped them and they never reached Prisma — so fieldConfidence
  // stayed {}, jurisdiction stayed null, and analysisStatus transitions
  // had to be handled by the worker path alone (masking score-step
  // failures, which is the Wave E.4 bug).
  fieldConfidence:  z.record(z.unknown()).optional(),
  jurisdiction:     z.string().optional(),
  analysisStatus:   z.string().optional(),
  analysisError:    z.string().nullable().optional(),
  // P4.2 — optional matter link; null unlinks.
  matterId:         z.string().nullable().optional(),
})

export const ContractFilterSchema = z.object({
  status: z.string().optional(),
  type: z.nativeEnum(ContractType).optional(),
  ownerId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  search: z.string().optional(),
  // B.6.9 — drill-through from Counterparties. Accepts either the
  // FK (counterpartyId) or the name string; matches either column
  // so the name-only (pre-FK) contracts aren't missed.
  counterpartyId: z.string().optional(),
  counterpartyName: z.string().optional(),
  // B.6.5 — drill-through from Dashboard "Expiring Soon".
  expiryDateTo: z.string().optional(),
  // U12 audit (2026-04-29). Numeric facets backed by metadata fields.
  // The contracts list and the dashboard surface "OTD < 95%" / "SLA
  // < 99%" filters; without these, the agent had to do a 9-call
  // contract_get loop that still failed (B2 thread). Server-side filter
  // is cheap and unblocks the manual flow.
  // Range filters: read as percentage point (95 = 95%).
  otdMax:        z.coerce.number().min(0).max(100).optional(),
  otdMin:        z.coerce.number().min(0).max(100).optional(),
  uptimeSlaMax:  z.coerce.number().min(0).max(100).optional(),
  uptimeSlaMin:  z.coerce.number().min(0).max(100).optional(),
  // Risk band, 0-100 to match how riskScore is actually stored. Previously the
  // repository could only filter risk through Elasticsearch, which holds a
  // subset of contracts — so "high risk AND expiring soon", the query legal ops
  // runs every morning, returned zero rows and rendered as "nothing matches".
  // Risk is a plain numeric column, so it belongs on the Postgres path with the
  // other structural filters, where the answer is always complete.
  riskScoreMin:  z.coerce.number().min(0).max(100).optional(),
  riskScoreMax:  z.coerce.number().min(0).max(100).optional(),
})

// ─── Requests ────────────────────────────────────────────────────────────────

export const CreateRequestSchema = z.object({
  title: z.string().min(1),
  type: z.nativeEnum(ContractType),
  // P7.4.14 / F-56 — optional FK link to a Counterparty row when the
  // user picked from the typeahead. Stashed in metadata for now since
  // ContractRequest doesn't have a counterpartyId column yet.
  counterpartyId: z.string().optional(),
  counterpartyName: z.string().optional(),
  description: z.string().min(1),
  estimatedValue: z.number().nonnegative().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  metadata: z.record(z.unknown()).default({}),
})

export const UpdateRequestSchema = z.object({
  assignedToId: z.string().optional(),
  status: z.nativeEnum(RequestStatus).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
})

// ─── Users ───────────────────────────────────────────────────────────────────

export const InviteUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  roles: z.array(z.nativeEnum(SystemRole)).min(1),
})

export const UpdateUserSchema = z.object({
  name: z.string().min(1).optional(),
  avatarUrl: z.string().url().optional(),
  preferences: z.record(z.unknown()).optional(),
})

export const ChangePasswordSchema = z.object({
  oldPassword: z.string().min(8),
  newPassword: z.string().min(8),
})

export const AssignRoleSchema = z.object({
  roles: z.array(z.nativeEnum(SystemRole)).min(1),
})

export const AcceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
  name: z.string().min(1).optional(),
})

export const BulkImportUserSchema = z.array(
  z.object({
    email: z.string().email(),
    name: z.string().min(1),
    roles: z.array(z.nativeEnum(SystemRole)).min(1),
  })
)

export const PermissionSchema = z.object({
  action: z.union([z.nativeEnum(PermissionAction), z.literal('*')]),
  resource: z.union([z.nativeEnum(PermissionResource), z.literal('*')]),
  scope: z.nativeEnum(PermissionScope),
})

// ─── Search ──────────────────────────────────────────────────────────────────

export const SearchSchema = z.object({
  q: z.string().min(1),
  type: z.enum(['full_text', 'semantic', 'hybrid']).default('hybrid'),
  filters: z.record(z.string()).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).default(20),
})

// ─── Agent chat ──────────────────────────────────────────────────────────────

export const LLM_PROVIDERS = ['anthropic', 'openai', 'google'] as const
export type LLMProvider = typeof LLM_PROVIDERS[number]

export const ChatMessageSchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional(),
  contractId: z.string().optional(),
  provider: z.enum(LLM_PROVIDERS).default('anthropic'),
  modelId: z.string().default('claude-sonnet-4-6'),
  // D.1.4a — agent mode enables tool-binding + typed event stream. Legacy
  // ChatPanel callers omit this and keep receiving the flat {delta} stream.
  agentMode: z.boolean().optional(),
  pageContext: z.object({
    type:  z.string().optional(),
    id:    z.string().optional(),
    label: z.string().optional(),
  }).optional(),
  // D.4.1 — when set, the Node layer resolves the Skill row, snapshots
  // `{id, version}` into a SkillInvocation, and forwards the Skill's
  // `systemPrompt` + `allowedTools` to Python. Invalid/missing slug →
  // falls through to the default agent loop (no hard error), so a stale
  // chip in the rail never kills a chat.
  skillSlug: z.string().optional(),
  // P4.3 — structured entity mentions inserted via the composer's
  // @-picker. Node forwards to Python; the orchestrator prepends a
  // one-line hint ("The user mentioned: @contract:<id>, @matter:<id>")
  // so the agent knows to call contract_get / counterparty_get with
  // these ids instead of fishing for them.
  mentions: z.array(z.object({
    kind:  z.enum(['contract', 'matter', 'counterparty']),
    id:    z.string().min(1),
    label: z.string().min(1),
  })).max(10).optional(),
})

// Inferred types
export type LoginInput = z.infer<typeof LoginSchema>
export type RegisterInput = z.infer<typeof RegisterSchema>
export type CreateContractInput = z.infer<typeof CreateContractSchema>
export type UpdateContractInput = z.infer<typeof UpdateContractSchema>
export type ContractFilterInput = z.infer<typeof ContractFilterSchema>
export type CreateRequestInput = z.infer<typeof CreateRequestSchema>
export type UpdateRequestInput = z.infer<typeof UpdateRequestSchema>
export type SearchInput = z.infer<typeof SearchSchema>
export type ChatMessageInput = z.infer<typeof ChatMessageSchema>
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>
export type AssignRoleInput = z.infer<typeof AssignRoleSchema>
export type AcceptInviteInput = z.infer<typeof AcceptInviteSchema>
export type BulkImportUserInput = z.infer<typeof BulkImportUserSchema>
export type PermissionInput = z.infer<typeof PermissionSchema>

export interface ModelOption {
  provider: LLMProvider
  model_id: string
  display_name: string
  context_window: number
}
