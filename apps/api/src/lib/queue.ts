import { Queue, type Job } from 'bullmq'
import { redis } from './redis.js'

// ─── Queue definitions ───────────────────────────────────────────────────────

export const documentQueue    = new Queue('documents',     { connection: redis })
export const notificationQueue = new Queue('notifications', { connection: redis })
export const agentQueue       = new Queue('agents',        { connection: redis })
// P8 Step 6 — daily obligation + renewal scan (BullMQ repeatable job).
export const scanQueue        = new Queue('scans',         { connection: redis })
// P10A — webhook delivery queue
export const webhookQueue     = new Queue('webhooks',      { connection: redis })
// Sealing an executed contract into a signed PDF. Its own queue so a slow or
// failing seal can't hold up document parsing, and so retries are visible
// separately in Bull Board.
export const signingQueue     = new Queue('signing',       { connection: redis })

// ─── Event bus (Redis Streams) ───────────────────────────────────────────────

export async function publishEvent(
  stream: string,
  event: { type: string; orgId: string; payload: Record<string, unknown> }
): Promise<void> {
  await redis.xadd(stream, '*',
    'type',      event.type,
    'orgId',     event.orgId,
    'payload',   JSON.stringify(event.payload),
    'timestamp', new Date().toISOString()
  )
}

// ─── Job payload types ───────────────────────────────────────────────────────

export interface ParseDocumentJob {
  contractId: string
  versionId:  string
  s3Key:      string
  mimeType:   string
  orgId:      string
  filename:   string
}

export interface ExtractAiJob {
  contractId:    string
  versionId:     string
  orgId:         string
  contractType?: string            // injected when user corrects type
  triggeredBy?:  'upload' | 'retype' | 'manual'
}

export interface ChunkAndIndexJob {
  contractId: string
  versionId:  string
  orgId:      string
}

export interface DetectBinderJob {
  contractId: string
  versionId:  string
  orgId:      string
}

export interface ClassifyDocumentJob {
  contractId:    string
  versionId:     string
  orgId:         string
  contractType?: string   // pre-known type (e.g. from user correction)
}

export interface SplitBinderJob {
  contractId: string
  orgId:      string
  userId:     string
  splits:     Array<{ pageStart: number; pageEnd: number; title?: string; type?: string }>
}

export interface ClassifyRequestJob {
  requestId: string
  orgId:     string
}

// P10A — webhook delivery
export interface WebhookDeliveryJob {
  webhookId: string
  event:     string
  payload:   Record<string, unknown>
}

export function queueWebhookDelivery(payload: WebhookDeliveryJob): Promise<unknown> {
  return webhookQueue.add('deliver', payload, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: 200,
    removeOnFail:     500,
  }) as unknown as Promise<unknown>
}

// ─── Queue helpers ───────────────────────────────────────────────────────────

/** Service 1 — Parse PDF/DOCX and extract text (full, no char limit). */
export function queueParseDocument(payload: ParseDocumentJob): void {
  documentQueue.add('parse-document', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 8000 },
  }).catch(err => console.warn('[queue] failed to enqueue parse-document:', err.message))
}

/** Service 2 — AI extraction: custom fields + open-ended + validate + score. */
export function queueExtractAi(payload: ExtractAiJob): void {
  agentQueue.add('extract-ai', payload, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 15000 },
  }).catch(err => console.warn('[queue] failed to enqueue extract-ai:', err.message))
}

/** Service 3 — SOTA legal chunking + pgvector + Elasticsearch index. */
export function queueChunkAndIndex(payload: ChunkAndIndexJob): void {
  documentQueue.add('chunk-and-index', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  }).catch(err => console.warn('[queue] failed to enqueue chunk-and-index:', err.message))
}

/** LLM binder detection — runs after parse-document, before classify. */
export function queueDetectBinder(payload: DetectBinderJob): void {
  agentQueue.add('detect-binder', payload, {
    attempts: 2,
    backoff: { type: 'fixed', delay: 10000 },
  }).catch(err => console.warn('[queue] failed to enqueue detect-binder:', err.message))
}

/** LLM contract type classification — runs after detect-binder (non-binder path). */
export function queueClassifyDocument(payload: ClassifyDocumentJob): void {
  agentQueue.add('classify-document', payload, {
    attempts: 2,
    backoff: { type: 'fixed', delay: 10000 },
  }).catch(err => console.warn('[queue] failed to enqueue classify-document:', err.message))
}

/** PDF binder splitting — queued from POST /:id/split, runs in documentQueue. */
export function queueSplitBinder(payload: SplitBinderJob): void {
  documentQueue.add('split-binder', payload, {
    attempts: 2,
    backoff: { type: 'fixed', delay: 5000 },
  }).catch(err => console.warn('[queue] failed to enqueue split-binder:', err.message))
}

/** Embed clause segments for pgvector RAG (fires after chunk-and-index). */
export function queueEmbedContract(versionId: string): void {
  documentQueue.add(
    'embed-contract',
    { versionId },
    { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
  ).catch(err => console.warn('[queue] failed to enqueue embed-contract:', err.message))
}

/** Intake AI classification — classify request type + extract key terms. */
export function queueClassifyRequest(payload: ClassifyRequestJob): void {
  agentQueue.add('classify-request', payload, {
    attempts: 2,
    backoff: { type: 'fixed', delay: 10000 },
  }).catch(err => console.warn('[queue] failed to enqueue classify-request:', err.message))
}

export interface RedlineAnalysisJob {
  contractId:    string
  v1Id:          string   // baseline (our version)
  v2Id:          string   // counterparty redlines
  orgId:         string
  userId:        string
  contractType?: string
}

/** AI-powered redline analysis — 3-step LangGraph pipeline comparing two contract versions. */
export function queueRedlineAnalysis(payload: RedlineAnalysisJob): void {
  agentQueue.add('redline-analysis', payload, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 15000 },
  }).catch(err => console.warn('[queue] failed to enqueue redline-analysis:', err.message))
}

// ─── Phase 06 — Approval Workflow Jobs ───────────────────────────────────────

/** Triggers the Python approval agent to generate an AI executive summary for approvers. */
export interface ApprovalSummaryJob {
  instanceId:  string
  contractId:  string
  versionId:   string
  orgId:       string
  approverIds: string[]
}

/** Escalation timer — BullMQ delayed job; fires if approver hasn't decided in time. */
export interface EscalationJob {
  instanceId:  string
  stepId:      string
  orgId:       string
  escalateTo?: string  // userId — if set, reassign rather than just flag
}

/** In-app notification + optional email — written to Notification table by notification worker. */
export interface NotificationJob {
  orgId:        string
  userId:       string  // recipient
  type:         string  // APPROVAL_REQUEST | APPROVAL_DECIDED | ESCALATION | DELEGATION
  title:        string
  body:         string
  resourceType: string
  resourceId:   string
  email?:       string  // recipient email address — only used if SMTP_HOST is configured
}

/**
 * Playbook review of a SINGLE contract, queued automatically once extraction
 * finishes. Redline analysis needs two versions to diff, so a contract received
 * from a counterparty (one version) could never be scored against the playbook;
 * this is the single-document counterpart.
 */
export interface PlaybookReviewJob {
  contractId: string
  orgId:      string
  /** The version that was just extracted — also scopes the job identity. */
  versionId:  string
}
export function queuePlaybookReview(payload: PlaybookReviewJob): void {
  agentQueue.add('playbook-review', payload, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 15000 },
    // Keyed on the VERSION, not the contract. BullMQ silently drops an add with
    // a duplicate jobId (it returns the existing job rather than throwing, so a
    // .catch here would never see it), and completed jobs are retained, so a
    // contract-scoped id would claim that key forever: the contract would be
    // reviewed once and every later version — including the counterparty's
    // returned redline, the case this feature exists for — would be dropped in
    // silence while the stored result still pointed at v1.
    jobId: `playbook-review-${payload.contractId}-${payload.versionId}`,
    // Don't accumulate keys indefinitely either.
    removeOnComplete: 100,
    removeOnFail:     50,
  }).catch(err => console.warn('[queue] failed to enqueue playbook-review:', err.message))
}

/**
 * Phase 3 — whole-document redline against the org's playbook.
 *
 * Chains playbook_check -> batch propose -> STAGE. It deliberately does not
 * apply: the markup is a proposal a lawyer reviews, and writing it into the
 * contract first would make it an unreviewed edit.
 */
export interface PlaybookRedlineJob {
  contractId: string
  orgId:      string
  userId:     string
  versionId:  string
  aggression: 'least' | 'moderate' | 'aggressive'
}
export function queuePlaybookRedline(payload: PlaybookRedlineJob): void {
  agentQueue.add('playbook-redline', payload, {
    // One attempt. A retry re-runs every LLM call in the batch, and the job is
    // user-initiated — they can see it failed and press the button again.
    attempts: 1,
    // Version-scoped like playbook-review, so a re-run against the SAME version
    // is a no-op but the counterparty's next version gets its own run. Note
    // BullMQ returns the existing job rather than throwing on a duplicate id,
    // so the .catch below would never see that case.
    jobId: `playbook-redline-${payload.contractId}-${payload.versionId}`,
    removeOnComplete: 100,
    removeOnFail:     50,
  }).catch(err => console.warn('[queue] failed to enqueue playbook-redline:', err.message))
}

/** Approval AI summary — fetches contract, runs 3-step LangGraph pipeline, patches result back. */
export function queueApprovalSummary(payload: ApprovalSummaryJob): void {
  agentQueue.add('approval-summary', payload, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 10000 },
  }).catch(err => console.warn('[queue] failed to enqueue approval-summary:', err.message))
}

/**
 * Escalation delayed job — fires after delayMs if the step has not been decided.
 * Uses deterministic jobId 'escalate-${stepId}' so the job can be cancelled on decision
 * via notificationQueue.remove('escalate-${stepId}').
 * Returns the Job so the caller can store its ID.
 */
export function queueEscalation(payload: EscalationJob, delayMs: number): Promise<Job> {
  return notificationQueue.add('escalate', payload, {
    delay:    delayMs,
    attempts: 3,
    backoff:  { type: 'fixed', delay: 30000 },
    jobId:    `escalate-${payload.stepId}`,  // deterministic — enables cancellation
  })
}

/** Auto-draft a contract from request context using the Draft Agent. */
interface DraftContractJob {
  contractId: string
  orgId: string
  userId: string
  requestTitle: string
  requestDescription: string
  contractType: string
  counterpartyName?: string
  estimatedValue?: number
}
export function queueDraftContract(payload: DraftContractJob): void {
  agentQueue.add('draft-contract', payload, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  }).catch(err => console.warn('[queue] failed to enqueue draft-contract:', err.message))
}

/**
 * Seal an executed contract into its signed PDF and store it as a new version.
 *
 * Deliberately retried: this used to be a fire-and-forget IIFE, so a transient
 * S3/Gotenberg/cert failure left the contract EXECUTED with no signed document
 * and no way to recover. The handler is idempotent (deterministic signed key),
 * so re-running a succeeded job is a no-op.
 *
 * Only the id is carried — the worker re-reads current state rather than
 * trusting a payload snapshot that may be stale by the time it runs.
 */
export interface SealSignedPdfJob {
  signatureRequestId: string
}
export function queueSealSignedPdf(payload: SealSignedPdfJob): void {
  signingQueue.add('seal-signed-pdf', payload, {
    attempts: 5,
    backoff:  { type: 'exponential', delay: 15000 },
    // Deterministic id: two concurrent seals would each create a version
    // carrying the same signed s3Key under different versionNumbers (the unique
    // constraint is on [contractId, versionNumber], not the key), so dedupe at
    // enqueue rather than relying on the handler's idempotency alone.
    // Trade-off: once a job has exhausted its retries it keeps this id, so
    // re-enqueueing is a no-op — recovery is an operator retry from Bull Board,
    // where the signing queue is registered.
    jobId:    `seal-${payload.signatureRequestId}`,
  }).catch(err =>
    // Loud: the contract is already EXECUTED by this point, so a dropped
    // enqueue means the sealed PDF is never produced and nothing else notices.
    console.error(
      '[queue] FAILED to enqueue seal-signed-pdf for signatureRequest=%s — contract is executed but will have no sealed PDF until this is retried: %s',
      payload.signatureRequestId, err.message,
    ),
  )
}

/** In-app notification (+ optional email) — written to Notification table. */
export function queueNotification(payload: NotificationJob): void {
  notificationQueue.add('notify', payload, {
    attempts: 3,
    backoff:  { type: 'exponential', delay: 5000 },
  }).catch(err => console.warn('[queue] failed to enqueue notification:', err.message))
}

/**
 * Phase 07 Step 8 — Signature reminder. BullMQ delayed job that re-emails
 * any still-PENDING signers on a SignatureRequest. Idempotent: the worker
 * checks SR.status === 'PENDING' AND signer.status === 'PENDING' before
 * sending. Cancellable via the deterministic jobId.
 */
export interface SigningReminderJob {
  signatureRequestId: string
  /** 'first' = T-3d before expiry, 'final' = T-1d. Used in subject + body. */
  kind: 'first' | 'final' | 'manual'
}
export function queueSigningReminder(payload: SigningReminderJob, delayMs: number): Promise<Job> {
  return notificationQueue.add('signing-reminder', payload, {
    delay:    Math.max(0, delayMs),
    attempts: 3,
    backoff:  { type: 'fixed', delay: 30_000 },
    // Deterministic id so we can cancel + dedupe by (sr, kind).
    jobId:    `sig-reminder-${payload.signatureRequestId}-${payload.kind}`,
  })
}
