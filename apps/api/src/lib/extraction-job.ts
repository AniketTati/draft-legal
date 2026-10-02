/**
 * docs/39 A1 — a contract's extraction, run inside its queued job.
 *
 * The extract job used to hand the contract to the agents service's
 * fire-and-forget /review and finish: the extraction ran in a background task
 * of that service, which saved its result by calling back into this API. A
 * restart of the service lost the run, a failed save was only logged, and the
 * contract sat in EXTRACTING until the stuck sweep turned it FAILED five
 * minutes on, with no word of which step failed. Now the job
 *
 *   1. reads the version's text and the org's fields,
 *   2. runs the extraction and waits for it (the service's /review/run),
 *   3. saves it through the same routes the service used to call back into,
 *
 * and a failure at any step fails the job, which BullMQ retries. A run whose
 * save failed is kept with the job, so the retry saves it again without a new
 * run (or a new bill). While it runs, and when it fails, the contract says
 * which step and which attempt (metadata._extraction, and analysisError on
 * the last), and the stuck sweep leaves a contract alone while its job is
 * queued or running (lib/stuck-contracts.ts).
 *
 * A15 — the run reports its real token use per model, recorded as
 * `extraction` (it was estimated from a "queued" reply and filed as
 * `redline_analysis`).
 */
import { prisma } from './prisma.js'
import { estimateCostUsd, recordUsage } from './costCap.js'
import { tokenCostUsd } from './model-pricing.js'
import { detectLanguage } from './language.js'
import { orgDateOrder } from './org-date-order.js'
import { fieldExamples } from './field-examples.js'
import { ourNames } from './counterparty-directory.js'
import { correctionExamples } from './field-corrections.js'
import { CORE_FIELDS, typeFieldsFor, type FieldValueType } from '@clm/types'
import { queueObligationsIfSigned, queueProposedObligations } from './obligation-extract.js'
import { queueAnswerDiligenceDocument, type ExtractAiJob } from './queue.js'
import { readExhibits, withExhibits } from './exhibits.js'
import { customClauseTypesFor } from './clause-types.js'

export type ExtractionStep = 'reading' | 'extracting' | 'saving'

const STEP_LABEL: Record<ExtractionStep, string> = {
  reading: 'reading the document',
  extracting: 'reading its fields and clauses',
  saving: 'saving what was read',
}

export class ExtractionStepError extends Error {
  constructor(readonly step: ExtractionStep, message: string) {
    super(message)
  }
}

export interface RunUsage {
  calls: number
  inputTokens: number
  outputTokens: number
  byModel: Array<{ provider: string; model: string; source: string; calls: number; inputTokens: number; outputTokens: number }>
}

/** What /review/run answers: what to save, whether the run failed, and what it used. */
export interface ReviewRun {
  contract: Record<string, unknown>
  version: { clauseSegments?: unknown[]; clauseFlags?: unknown }
  failed: boolean
  error?: string | null
  usage?: RunUsage | null
}

/** The progress a contract shows while its extraction runs (metadata._extraction). */
export interface ExtractionMark {
  step: ExtractionStep
  attempt: number
  of: number
  /** Why the last attempt failed, when one did. */
  error?: string
}

export type ExtractionJobData = ExtractAiJob & { run?: ReviewRun }

export interface ExtractionJobLike {
  data: ExtractionJobData
  attemptsMade: number
  opts: { attempts?: number }
  updateData(data: ExtractionJobData): Promise<void>
}

export interface ExtractionDeps {
  /** POST /review/run on the agents service (the worker's callAgents: cost cap, PII policy). */
  review(body: Record<string, unknown>, text: string): Promise<Response>
  /** The fire-and-forget /review, for an agents service older than /review/run. */
  reviewLegacy(body: Record<string, unknown>, text: string): Promise<Response>
  /** A write to this API, made as the agents service made them. */
  api(method: 'PATCH' | 'POST', path: string, orgId: string, body?: unknown): Promise<{ status: number; text: string }>
}

/** Sets or clears the contract's extraction mark, without touching anything else (or updatedAt). */
export async function markExtraction(contractId: string, mark: ExtractionMark | null): Promise<void> {
  if (mark) {
    const value = JSON.stringify({ ...mark, at: new Date().toISOString() })
    await prisma.$executeRaw`UPDATE contracts SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_extraction}', ${value}::jsonb) WHERE id = ${contractId}`
  } else {
    await prisma.$executeRaw`UPDATE contracts SET metadata = COALESCE(metadata, '{}'::jsonb) - '_extraction' WHERE id = ${contractId}`
  }
}

/** The run's spend: its reported tokens per model, else an estimate from what went back and forth. */
export async function recordRunUsage(orgId: string, usage: RunUsage | null | undefined, fallback: { inputChars: number; outputChars: number }, toolName = 'extraction'): Promise<void> {
  const models = (usage?.byModel ?? []).filter(m => m.calls > 0)
  if (!models.length) {
    await recordUsage(orgId, estimateCostUsd(fallback.inputChars + fallback.outputChars), {
      provider: 'agents-service', model: 'background-job', tier: 'default', toolName,
      inputChars: fallback.inputChars, outputChars: fallback.outputChars,
    })
    return
  }
  for (const m of models) {
    await recordUsage(orgId, tokenCostUsd(m.model, m.inputTokens, m.outputTokens), {
      provider: m.provider, model: m.model, tier: 'default', toolName,
      inputTokens: m.inputTokens, outputTokens: m.outputTokens, calls: m.calls, isByok: m.source === 'byok',
    })
  }
}

/** The body /review/run takes: the version's text and the org's fields and name. */
async function reviewInput(data: ExtractAiJob): Promise<{ body: Record<string, unknown>; text: string } | null> {
  const { contractId, versionId, orgId, contractType } = data
  const version = await prisma.contractVersion.findUnique({ where: { id: versionId }, select: { plainText: true } })
  if (!version?.plainText) return null
  // orgName lets the counterparty picker tell "us" from "them" (Wave E.3);
  // A8 — so do the other names the org signs as (Settings › Our entities).
  const [customFields, ours] = await Promise.all([
    prisma.contractFieldDefinition.findMany({
      where: { orgId, deletedAt: null, OR: [{ contractType: contractType ?? null }, { contractType: null }] },
      orderBy: { sortOrder: 'asc' },
      select: { fieldKey: true, fieldLabel: true, fieldType: true, options: true, helpText: true },
    }),
    ourNames(orgId),
  ])
  // A11 — what the extraction is reading, and how the org writes dates: the
  // prompt quotes the original language and reads "03/04/2025" the org's way.
  const language = detectLanguage(version.plainText)
  const dateOrder = await orgDateOrder(orgId)
  // A5 — how people filled each custom field in on other contracts.
  const examples = await fieldExamples(orgId, customFields.map(f => f.fieldKey), { excludeContractId: contractId })
  // I2 — what people corrected the AI's readings of the standard and type fields to, where it's a pattern.
  const [corrections, customCorrections] = await Promise.all([
    correctionExamples(orgId, [
      ...CORE_FIELDS.filter(f => !f.legacy).map(f => ({ key: f.key, label: f.label, type: f.type, unit: f.unit })),
      ...typeFieldsFor(contractType).map(f => ({ key: f.key, label: f.label, type: f.type })),
    ], { excludeContractId: contractId }),
    // …and of the org's own fields, for their pass (A5).
    correctionExamples(orgId, customFields.map(f => ({ key: f.fieldKey, label: f.fieldLabel, type: f.fieldType as FieldValueType })), { excludeContractId: contractId }),
  ])
  const customCorrectionsOf = new Map(customCorrections.map(c => [c.key, c.examples]))
  // A12 — its exhibits and schedules, read as part of it: after its own text, each under its name.
  const text = withExhibits(version.plainText, await readExhibits(contractId))
  // E3 — the org's own clause types, tagged like the built-in ones.
  const customClauseTypes = await customClauseTypesFor(orgId)
  if (language) {
    const value = JSON.stringify(language)
    // Underscored: custom field values sit flat in metadata, and an org may have a field called "language".
    await prisma.$executeRaw`UPDATE contracts SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_language}', ${value}::jsonb) WHERE id = ${contractId}`
  }
  return {
    text,
    body: {
      contractId, versionId, orgId,
      orgName: ours.orgName || undefined,
      ourEntities: ours.entities,
      ...(corrections.length && { corrections }),
      language: language?.code,
      dateOrder,
      contractType: contractType ?? undefined,
      // A13 — a person's type is kept, and the review gives no opinion of its own.
      ...(data.typeLocked && { typeLocked: true }),
      ...(customClauseTypes.length && { customClauseTypes }),
      customFields: customFields.map(f => ({
        fieldKey: f.fieldKey, fieldLabel: f.fieldLabel, fieldType: f.fieldType,
        options: (f.options as string[]) ?? [], helpText: f.helpText ?? undefined,
        ...(examples.get(f.fieldKey)?.length && { examples: examples.get(f.fieldKey) }),
        ...(customCorrectionsOf.get(f.fieldKey)?.length && { corrections: customCorrectionsOf.get(f.fieldKey) }),
      })),
      plainText: text,
    },
  }
}

/** docs/39 D6 — a document of a diligence room is asked the room's questions once its analysis is saved. */
async function askRoomQuestions(data: ExtractAiJob): Promise<void> {
  const c = await prisma.contract.findUnique({ where: { id: data.contractId }, select: { diligenceRoomId: true } })
  if (c?.diligenceRoomId) queueAnswerDiligenceDocument({ orgId: data.orgId, contractId: data.contractId, versionId: data.versionId })
}

async function save(deps: ExtractionDeps, data: ExtractAiJob, run: ReviewRun): Promise<void> {
  const { contractId, versionId, orgId } = data
  if (Object.keys(run.contract).length) {
    // X23 — `versionId` is the version the text was read from, which PII tokens are restored against.
    const r = await deps.api('PATCH', `/api/v1/contracts/${contractId}?versionId=${encodeURIComponent(versionId)}`, orgId, run.contract)
    if (r.status >= 300) throw new ExtractionStepError('saving', `the contract's fields were refused (${r.status}): ${r.text.slice(0, 200)}`)
  }
  if (run.version.clauseSegments?.length || run.version.clauseFlags) {
    const r = await deps.api('POST', `/api/v1/contracts/${contractId}/versions/${versionId}/clauses`, orgId, run.version)
    if (r.status >= 300) throw new ExtractionStepError('saving', `the clauses were refused (${r.status}): ${r.text.slice(0, 200)}`)
  }
  // Search indexing is its own job with its own retries: a refusal here
  // doesn't fail the extraction. docs/41 P0.1 — asked for even when no
  // clauses came back: that step finishes the analysis, and says "no clauses
  // found" for a document that should have had some (it used to stay DONE
  // from the save above, an empty success).
  const c = await deps.api('POST', `/api/v1/contracts/${contractId}/versions/${versionId}/chunk`, orgId).catch(err => ({ status: 0, text: String(err) }))
  if (c.status >= 300 || c.status === 0) console.warn('[extraction] chunk request failed contractId=%s status=%d', contractId, c.status)
}

/** One attempt of a contract's extraction job. Throws for BullMQ to retry. */
export async function runExtractionJob(job: ExtractionJobLike, deps: ExtractionDeps): Promise<'saved' | 'handed_off'> {
  const data = job.data
  const attempt = job.attemptsMade + 1
  const of = Math.max(attempt, job.opts.attempts ?? 1)
  let run = data.run
  let step: ExtractionStep = run ? 'saving' : 'reading'
  try {
    if (!run) {
      await markExtraction(data.contractId, { step: 'reading', attempt, of })
      const input = await reviewInput(data)
      if (!input) throw new ExtractionStepError('reading', 'the document has no text yet (it may still be being read)')

      step = 'extracting'
      await markExtraction(data.contractId, { step, attempt, of })
      const res = await deps.review(input.body, input.text)
      // An agents service from before /review/run: hand the run to it, as before.
      if (res.status === 404 || res.status === 405) {
        const legacy = await deps.reviewLegacy(input.body, input.text)
        if (!legacy.ok) throw new ExtractionStepError('extracting', `the extraction service answered ${legacy.status}`)
        return 'handed_off'
      }
      const reply = await res.text()
      if (!res.ok) throw new ExtractionStepError('extracting', `the extraction service answered ${res.status}: ${reply.slice(0, 200)}`)
      try {
        run = JSON.parse(reply) as ReviewRun
      } catch {
        throw new ExtractionStepError('extracting', 'the extraction service’s answer was cut off')
      }
      await recordRunUsage(data.orgId, run.usage, { inputChars: JSON.stringify(input.body).length, outputChars: reply.length })
      if (run.failed) throw new ExtractionStepError('extracting', run.error || 'the extraction produced nothing')
      // Kept with the job: a failed save is retried without running the extraction again.
      await job.updateData({ ...data, run })
    }

    step = 'saving'
    await markExtraction(data.contractId, { step, attempt, of })
    await save(deps, data, run)
    await markExtraction(data.contractId, null)
    // A12 — read again for an exhibit: done.
    if (data.triggeredBy === 'exhibit') await prisma.$executeRaw`UPDATE contracts SET metadata = metadata - '_exhibitReread' WHERE id = ${data.contractId}`
    // docs/39 G4 — a signed contract is read for its obligations once analysed.
    await queueObligationsIfSigned(data.orgId, data.contractId)
      .catch(err => console.warn('[extraction] obligations not queued contractId=%s: %s', data.contractId, (err as Error).message))
    // docs/41 Part 11 — a draft's, as proposed: on a full analysis only, not an edit checkpoint.
    await queueProposedObligations(data.orgId, data.contractId, { full: data.triggeredBy !== 'checkpoint' && data.triggeredBy !== 'exhibit' })
      .catch(err => console.warn('[extraction] proposed obligations not queued contractId=%s: %s', data.contractId, (err as Error).message))
    // docs/39 D6 — a diligence room's document, read: the room's questions are asked of it.
    await askRoomQuestions(data)
      .catch(err => console.warn('[extraction] room questions not queued contractId=%s: %s', data.contractId, (err as Error).message))
    return 'saved'
  } catch (err) {
    const failedStep = err instanceof ExtractionStepError ? err.step : step
    const detail = (err as Error).message
    await markExtraction(data.contractId, { step: failedStep, attempt, of, error: detail.slice(0, 300) }).catch(() => {})
    // The message is what the contract shows when no attempts are left (onAgentJobFailed).
    throw new ExtractionStepError(failedStep, `Failed while ${STEP_LABEL[failedStep]} (attempt ${attempt} of ${of}): ${detail}`.slice(0, 480))
  }
}
