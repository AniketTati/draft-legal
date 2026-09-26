export enum ContractStatus {
  DRAFT = 'DRAFT',
  PENDING_REVIEW = 'PENDING_REVIEW',
  UNDER_NEGOTIATION = 'UNDER_NEGOTIATION',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  PENDING_SIGNATURE = 'PENDING_SIGNATURE',
  EXECUTED = 'EXECUTED',
  EXPIRED = 'EXPIRED',
  TERMINATED = 'TERMINATED',
  ARCHIVED = 'ARCHIVED',
}

export enum ContractType {
  NDA = 'NDA',
  MSA = 'MSA',
  SOW = 'SOW',
  SLA = 'SLA',
  VENDOR_AGREEMENT = 'VENDOR_AGREEMENT',
  EMPLOYMENT = 'EMPLOYMENT',
  PARTNERSHIP = 'PARTNERSHIP',
  LICENSE = 'LICENSE',
  // Wave E.3 — sync with Python's _VALID_TYPES in review_agent.py. Before
  // this line, ORDER_FORM + DATA_PROCESSING extractions were rejected by
  // Zod at the API boundary (invalid_enum_value), Python fell through to
  // its failure-retry path and wrote {analysisStatus: FAILED} — which was
  // the real root cause of the Tyrell DPA + Cyberdyne Order Form silent
  // partial-success in the audit scorecard.
  DATA_PROCESSING = 'DATA_PROCESSING',
  ORDER_FORM = 'ORDER_FORM',
  OTHER = 'OTHER',
}

export enum RequestStatus {
  SUBMITTED = 'SUBMITTED',
  IN_REVIEW = 'IN_REVIEW',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  MORE_INFO_NEEDED = 'MORE_INFO_NEEDED',
  COMPLETED = 'COMPLETED',
}

export enum ApprovalStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  DELEGATED = 'DELEGATED',
  ESCALATED = 'ESCALATED',
  AUTO_APPROVED = 'AUTO_APPROVED',
}

export enum SignatureStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  PARTIALLY_SIGNED = 'PARTIALLY_SIGNED',
  COMPLETED = 'COMPLETED',
  VOIDED = 'VOIDED',
  EXPIRED = 'EXPIRED',
}

export enum ObligationStatus {
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
  OVERDUE = 'OVERDUE',
  WAIVED = 'WAIVED',
}

export enum ObligationType {
  PAYMENT = 'PAYMENT',
  DELIVERY = 'DELIVERY',
  COMPLIANCE = 'COMPLIANCE',
  RENEWAL = 'RENEWAL',
  REPORTING = 'REPORTING',
  OTHER = 'OTHER',
}

export enum SystemRole {
  ADMIN = 'ADMIN',
  LEGAL_COUNSEL = 'LEGAL_COUNSEL',
  LEGAL_OPS = 'LEGAL_OPS',
  CONTRACT_MANAGER = 'CONTRACT_MANAGER',
  SALES_REP = 'SALES_REP',
  PROCUREMENT = 'PROCUREMENT',
  FINANCE = 'FINANCE',
  APPROVER = 'APPROVER',
  VIEWER = 'VIEWER',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  INVITED = 'INVITED',
  DEACTIVATED = 'DEACTIVATED',
}

// Permission actions per 06-SECURITY-GOVERNANCE.md
export enum PermissionAction {
  VIEW = 'view',
  EDIT = 'edit',
  CREATE = 'create',
  DELETE = 'delete',
  APPROVE = 'approve',
  SIGN = 'sign',
  CONFIGURE = 'configure',
  EXPORT = 'export',
}

// Permission resources per 06-SECURITY-GOVERNANCE.md
export enum PermissionResource {
  CONTRACT = 'contract',
  REQUEST = 'request',
  TEMPLATE = 'template',
  CLAUSE = 'clause',
  PLAYBOOK = 'playbook',
  WORKFLOW = 'workflow',
  REPORT = 'report',
  USER = 'user',
  INTEGRATION = 'integration',
}

// Permission scopes per 06-SECURITY-GOVERNANCE.md
export enum PermissionScope {
  OWN = 'own',
  TEAM = 'team',
  DEPARTMENT = 'department',
  ORG = 'org',
}

export enum AuditAction {
  // Auth
  USER_LOGIN = 'USER_LOGIN',
  USER_LOGOUT = 'USER_LOGOUT',
  USER_CREATED = 'USER_CREATED',
  // Contracts
  CONTRACT_CREATED = 'CONTRACT_CREATED',
  CONTRACT_UPDATED = 'CONTRACT_UPDATED',
  CONTRACT_DELETED = 'CONTRACT_DELETED',
  CONTRACT_VIEWED = 'CONTRACT_VIEWED',
  CONTRACT_UPLOADED = 'CONTRACT_UPLOADED',
  CONTRACT_STATUS_CHANGED = 'CONTRACT_STATUS_CHANGED',
  // Versions
  VERSION_CREATED = 'VERSION_CREATED',
  VERSION_RESTORED = 'VERSION_RESTORED',
  // BB2/BB3 — their Word file round-tripped: a working copy out to Google
  // Docs and back, and a redline sent to the counterparty.
  EXTERNAL_EDIT_STARTED = 'EXTERNAL_EDIT_STARTED',
  EXTERNAL_EDIT_PUBLISHED = 'EXTERNAL_EDIT_PUBLISHED',
  EXTERNAL_EDIT_DISCARDED = 'EXTERNAL_EDIT_DISCARDED',
  REDLINE_EXPORTED = 'REDLINE_EXPORTED',
  // Requests
  REQUEST_CREATED = 'REQUEST_CREATED',
  REQUEST_ASSIGNED = 'REQUEST_ASSIGNED',
  REQUEST_STATUS_CHANGED = 'REQUEST_STATUS_CHANGED',
  // Approvals
  APPROVAL_SUBMITTED = 'APPROVAL_SUBMITTED',
  APPROVAL_DECIDED = 'APPROVAL_DECIDED',
  APPROVAL_ESCALATED = 'APPROVAL_ESCALATED',
  // Signatures
  SIGNATURE_SENT = 'SIGNATURE_SENT',
  SIGNATURE_COMPLETED = 'SIGNATURE_COMPLETED',
  SIGNATURE_VOIDED = 'SIGNATURE_VOIDED',
  // Obligations
  OBLIGATION_EXTRACTED = 'OBLIGATION_EXTRACTED',
  OBLIGATION_COMPLETED = 'OBLIGATION_COMPLETED',
  OBLIGATION_OVERDUE = 'OBLIGATION_OVERDUE',
  // Compliance (Phase 10)
  COMPLIANCE_CHECKED = 'COMPLIANCE_CHECKED',
  // Agent
  AGENT_ACTION = 'AGENT_ACTION',
  // Negotiation (Phase 05)
  COMMENT_ADDED = 'COMMENT_ADDED',
  COMMENT_RESOLVED = 'COMMENT_RESOLVED',
  LINK_SHARED = 'LINK_SHARED',
  LINK_REVOKED = 'LINK_REVOKED',
  PORTAL_VIEWED = 'PORTAL_VIEWED',
  REDLINE_ANALYZED = 'REDLINE_ANALYZED',
  // User management (Phase 6.5)
  USER_INVITED = 'USER_INVITED',
  USER_DEACTIVATED = 'USER_DEACTIVATED',
  USER_REACTIVATED = 'USER_REACTIVATED',
  ROLE_CHANGED = 'ROLE_CHANGED',
  PASSWORD_CHANGED = 'PASSWORD_CHANGED',
  PASSWORD_RESET_REQUESTED = 'PASSWORD_RESET_REQUESTED',
  // API keys (X43)
  API_KEY_CREATED = 'API_KEY_CREATED',
  API_KEY_REVOKED = 'API_KEY_REVOKED',
  // AI admin (D.0.6) — model overrides, cost cap, BYOK key lifecycle
  AI_SETTINGS_UPDATED = 'AI_SETTINGS_UPDATED',
  AI_KEY_CREATED = 'AI_KEY_CREATED',
  AI_KEY_UPDATED = 'AI_KEY_UPDATED',
  AI_KEY_DELETED = 'AI_KEY_DELETED',
  AI_KEY_TESTED = 'AI_KEY_TESTED',
  // Agent tool invocations (D.3.6) — every write the agent does, every undo.
  // Captured on top of the ToolCall row so org admins can see "the agent
  // wrote X comments + undid Y" in the same audit log as user-initiated
  // actions.
  AGENT_TOOL_APPLIED = 'AGENT_TOOL_APPLIED',
  AGENT_TOOL_UNDONE = 'AGENT_TOOL_UNDONE',
  // Security / governance (P7.5)
  PII_REDACTED = 'PII_REDACTED',
  // Y2 — the model boundary replaced a value a call site's own redaction missed.
  PII_BOUNDARY_REDACTED = 'PII_BOUNDARY_REDACTED',
  // Portal-side actions (P7.6.2) — counterparty does something via the
  // tokenized share link.
  PORTAL_UPLOADED_VERSION = 'PORTAL_UPLOADED_VERSION',
  PORTAL_COMMENTED        = 'PORTAL_COMMENTED',
  // Email-redline inbound (P7.6.3) — counterparty emails a redline PDF
  // back to the per-contract inbound address.
  EMAIL_REDLINE_RECEIVED  = 'EMAIL_REDLINE_RECEIVED',
}
