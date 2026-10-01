/**
 * docs/41 P1 (Workstream A, Part 11) — every analysis of a version, step by
 * step.
 *
 * `analysisStatus` was one word for the whole contract: it didn't say which
 * version was read, and the steps that failed quietly (a chunk with no
 * clauses, a review whose callback failed, a classify that skipped a job
 * with no text) left nothing behind. Each analysis is now an `AnalysisRun`
 * row: why it ran, each step's start, time taken, counts and error, and how
 * it ended. The steps record themselves from wherever they run (the parse
 * and agent workers, the findings service), keyed by the contract and
 * version, so no job has to carry a run id; a step with no run open for its
 * version opens one (an upload's parse, a manual re-analyse).
 *
 * Each step also writes one structured log line,
 * `{runId, contractId, versionId, step, ms, outcome}`, so a run can be
 * followed in the logs as well as on the admin "Analysis health" page.
 *
 * Recording never fails the step it records: a run that can't be written is
 * logged and the analysis goes on.
 */
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { moduleLogger } from './logger.js'

const log = moduleLogger('analysis')

/** The steps of an analysis, in the order they run. */
export const RUN_STEPS = ['parse', 'classify', 'extract', 'carry', 'index', 'findings', 'position_check'] as const
export type RunStepName = typeof RUN_STEPS[number]

/** What each step is called on screen. */
export const STEP_LABEL: Record<RunStepName, string> = {
  parse: 'reading the document',
  classify: 'working out its type',
  extract: 'reading its fields and clauses',
  carry: 'following its clauses into the edit',
  index: 'finding and indexing its clauses',
  findings: 'checking it against the playbook and the last version',
  position_check: 'checking changed clauses against your positions',
}

/**
 * The steps after which a run's analysis is usable: a failure in a later one
 * (the model's position check) is the run's, but leaves the contract
 * analysed (lib/agent-job-failure.ts keeps follow-on failures off the
 * contract's status).
 */
export const FOLLOW_ON_STEPS = new Set<RunStepName>(['position_check'])

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'superseded'
export type StepStatus = 'running' | 'done' | 'retrying' | 'failed' | 'skipped'

export interface RunStep {
  name: RunStepName
  status: StepStatus
  startedAt: string
  ms?: number
  error?: string
  attempt?: number
  counts?: Record<string, number>
  model?: string
}

/** Runs not finished: a step may still write to them. */
const OPEN: RunStatus[] = ['queued', 'running']

/** A run open this long without a step moving has stopped. */
export const STUCK_RUN_MS = 15 * 60 * 1000

export type RunReason = 'generated' | 'uploaded' | 'added' | 'checkpoint' | 'backfill' | 'retry' | 'unknown'

function logStep(run: { id: string; contractId: string; versionId: string }, step: RunStepName, outcome: string, ms?: number, extra?: Record<string, unknown>) {
  log.info({ runId: run.id, contractId: run.contractId, versionId: run.versionId, step, ms: ms ?? null, outcome, ...extra }, 'analysis.step')
}

/**
 * Open a run for a version about to be analysed. An open run of the same
 * version is reused (a retry of a job, a second trigger for the same save);
 * open runs of the contract's other versions are superseded — the contract
 * has moved on, and nothing will finish them.
 */
export async function startRun(opts: { orgId: string; contractId: string; versionId: string; reason: RunReason; mode?: 'full' | 'incremental' }): Promise<string | null> {
  try {
    await prisma.analysisRun.updateMany({
      where: { contractId: opts.contractId, versionId: { not: opts.versionId }, status: { in: OPEN } },
      data: { status: 'superseded', finishedAt: new Date() },
    })
    const open = await prisma.analysisRun.findFirst({
      where: { contractId: opts.contractId, versionId: opts.versionId, status: { in: OPEN } },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    })
    if (open) {
      await prisma.analysisRun.update({ where: { id: open.id }, data: { reason: opts.reason, ...(opts.mode && { mode: opts.mode }) } })
      return open.id
    }
    const run = await prisma.analysisRun.create({
      data: { orgId: opts.orgId, contractId: opts.contractId, versionId: opts.versionId, reason: opts.reason, mode: opts.mode ?? 'full', status: 'queued' },
      select: { id: true },
    })
    log.info({ runId: run.id, contractId: opts.contractId, versionId: opts.versionId, reason: opts.reason, mode: opts.mode ?? 'full' }, 'analysis.run.start')
    return run.id
  } catch (err) {
    console.warn('[analysis-runs] run not opened contractId=%s: %s', opts.contractId, (err as Error).message)
    return null
  }
}

/** The run a step of this version writes to: the open one, or (for a follow-on step) the latest. */
async function runFor(contractId: string, versionId: string, step: RunStepName) {
  const open = await prisma.analysisRun.findFirst({
    where: { contractId, versionId, status: { in: OPEN } },
    orderBy: { startedAt: 'desc' },
  })
  if (open) return open
  if (FOLLOW_ON_STEPS.has(step) || step === 'findings') {
    const latest = await prisma.analysisRun.findFirst({ where: { contractId, versionId }, orderBy: { startedAt: 'desc' } })
    if (latest && latest.status !== 'superseded') return latest
  }
  // No run open: a path that doesn't go through onVersionCreated (an upload's
  // parse, a manual re-analyse, a re-read for an exhibit). Open one.
  const contract = await prisma.contract.findUnique({ where: { id: contractId }, select: { orgId: true } })
  if (!contract) return null
  const id = await startRun({ orgId: contract.orgId, contractId, versionId, reason: step === 'parse' ? 'uploaded' : 'unknown' })
  return id ? prisma.analysisRun.findUnique({ where: { id } }) : null
}

/** Replace (or add) one step of a run, in one statement: steps of one run are written from two workers at once. */
async function writeStep(runId: string, step: RunStep, run: { status?: RunStatus; failedStep?: string | null; error?: string | null; finishedAt?: Date | null } = {}) {
  const json = JSON.stringify(step)
  const finishedAt = run.finishedAt ? run.finishedAt.toISOString() : null
  // Timestamps are stored as UTC without a zone, as Prisma writes them.
  await prisma.$executeRaw`
    UPDATE analysis_runs
    SET steps = (
          SELECT COALESCE(jsonb_agg(s ORDER BY ord), '[]'::jsonb)
          FROM jsonb_array_elements(steps) WITH ORDINALITY AS t(s, ord)
          WHERE s->>'name' <> ${step.name}
        ) || jsonb_build_array(${json}::jsonb),
        status = COALESCE(${run.status ?? null}::text, status),
        "failedStep" = CASE WHEN ${run.failedStep !== undefined}::boolean THEN ${run.failedStep ?? null}::text ELSE "failedStep" END,
        error = CASE WHEN ${run.error !== undefined}::boolean THEN ${run.error ?? null}::text ELSE error END,
        "finishedAt" = CASE WHEN ${run.finishedAt !== undefined}::boolean THEN (${finishedAt}::timestamptz AT TIME ZONE 'UTC') ELSE "finishedAt" END,
        "updatedAt" = (now() AT TIME ZONE 'UTC')
    WHERE id = ${runId}`
}

function stepsOf(run: { steps: Prisma.JsonValue }): RunStep[] {
  return Array.isArray(run.steps) ? run.steps as unknown as RunStep[] : []
}

/** A step began. Returns a function that records its end. */
export async function stepStarted(contractId: string, versionId: string, name: RunStepName, attempt?: number): Promise<{ runId: string | null; startedAt: number }> {
  const startedAt = Date.now()
  try {
    const run = await runFor(contractId, versionId, name)
    if (!run) return { runId: null, startedAt }
    // A follow-on step on a finished run opens it again while it runs.
    const reopen = !OPEN.includes(run.status as RunStatus)
    await writeStep(run.id, { name, status: 'running', startedAt: new Date(startedAt).toISOString(), ...(attempt && { attempt }) }, {
      status: 'running',
      ...(reopen && { finishedAt: null, failedStep: null, error: null }),
    })
    logStep(run, name, 'started', undefined, attempt ? { attempt } : undefined)
    return { runId: run.id, startedAt }
  } catch (err) {
    console.warn('[analysis-runs] step %s not recorded contractId=%s: %s', name, contractId, (err as Error).message)
    return { runId: null, startedAt }
  }
}

/** A step finished. `last` closes the run (done): the analysis is complete. */
export async function stepDone(contractId: string, versionId: string, name: RunStepName, opts: { counts?: Record<string, number>; model?: string; skipped?: string; last?: boolean; startedAt?: number } = {}): Promise<void> {
  try {
    const run = await runFor(contractId, versionId, name)
    if (!run) return
    const was = stepsOf(run).find(s => s.name === name)
    const began = opts.startedAt ?? (was?.startedAt ? Date.parse(was.startedAt) : Date.now())
    const ms = Math.max(0, Date.now() - began)
    const step: RunStep = {
      name, status: opts.skipped ? 'skipped' : 'done', startedAt: new Date(began).toISOString(), ms,
      ...(was?.attempt && { attempt: was.attempt }),
      ...(opts.counts && { counts: opts.counts }),
      ...(opts.model && { model: opts.model }),
      ...(opts.skipped && { error: opts.skipped }),
    }
    // A follow-on step that ends closes the run it reopened, unless a step failed.
    const close = opts.last || (FOLLOW_ON_STEPS.has(name) && !run.failedStep)
    await writeStep(run.id, step, close ? { status: 'done', finishedAt: new Date() } : { status: 'running' })
    if (opts.model) {
      const models = (Array.isArray(run.model) ? run.model : []) as Array<{ step: string; model: string }>
      await prisma.analysisRun.update({ where: { id: run.id }, data: { model: [...models.filter(m => m.step !== name), { step: name, model: opts.model }] } })
    }
    logStep(run, name, opts.skipped ? 'skipped' : 'done', ms, opts.counts)
  } catch (err) {
    console.warn('[analysis-runs] step %s end not recorded contractId=%s: %s', name, contractId, (err as Error).message)
  }
}

/**
 * A step failed. With retries left (`final: false`) the step says it is
 * being tried again; on the last attempt the run fails at this step.
 */
export async function stepFailed(contractId: string, versionId: string, name: RunStepName, error: string, opts: { final?: boolean; attempt?: number } = {}): Promise<void> {
  try {
    const run = await runFor(contractId, versionId, name)
    if (!run) return
    const was = stepsOf(run).find(s => s.name === name)
    const began = was?.startedAt ? Date.parse(was.startedAt) : Date.now()
    const ms = Math.max(0, Date.now() - began)
    const final = opts.final ?? true
    await writeStep(run.id, {
      name, status: final ? 'failed' : 'retrying', startedAt: new Date(began).toISOString(), ms,
      error: error.slice(0, 500), ...((opts.attempt ?? was?.attempt) && { attempt: opts.attempt ?? was?.attempt }),
    }, final ? { status: 'failed', failedStep: name, error: error.slice(0, 500), finishedAt: new Date() } : {})
    logStep(run, name, final ? 'failed' : 'retrying', ms, { error: error.slice(0, 200) })
  } catch (err) {
    console.warn('[analysis-runs] step %s failure not recorded contractId=%s: %s', name, contractId, (err as Error).message)
  }
}

/** Run `fn` as a step: timed, its end or failure recorded. */
export async function asStep<T>(contractId: string, versionId: string, name: RunStepName, fn: () => Promise<T>, opts: { final?: boolean; attempt?: number; last?: boolean; counts?: (r: T) => Record<string, number> | undefined } = {}): Promise<T> {
  const { startedAt } = await stepStarted(contractId, versionId, name, opts.attempt)
  try {
    const out = await fn()
    await stepDone(contractId, versionId, name, { startedAt, last: opts.last, counts: opts.counts?.(out) })
    return out
  } catch (err) {
    await stepFailed(contractId, versionId, name, (err as Error).message, { final: opts.final, attempt: opts.attempt })
    throw err
  }
}

/** What a step's job says of itself when it ends without throwing. */
export interface StepOutcome {
  /** It had nothing to do, and why ("no clauses extracted"). */
  skipped?: string
  /** It ended without throwing but the analysis failed here ("no clauses found"). */
  failed?: string
  counts?: Record<string, number>
  model?: string
  /** What runs next, once this step's end is recorded (the findings after the index). */
  after?: () => Promise<void>
}

/** The step each queued job is, for the jobs that are analysis steps. */
export const JOB_STEP: Record<string, RunStepName> = {
  'parse-document': 'parse',
  'detect-binder': 'classify',
  'classify-document': 'classify',
  'extract-ai': 'extract',
  'chunk-and-index': 'index',
  'playbook-review': 'position_check',
}

/**
 * Run one attempt of a queued job as its analysis step. A throw is recorded
 * as a retry while attempts are left and as the run's failure on the last;
 * the job's own failure handling (the contract's status) is unchanged.
 */
export async function runJobStep(
  job: { name: string; attemptsMade: number; opts: { attempts?: number } },
  ids: { contractId: string; versionId: string | null | undefined },
  fn: () => Promise<StepOutcome | void>,
): Promise<void> {
  const name = JOB_STEP[job.name]
  if (!name || !ids.versionId) { const out = await fn(); await out?.after?.(); return }
  const versionId = ids.versionId
  const attempt = job.attemptsMade + 1
  const final = attempt >= (job.opts.attempts ?? 1)
  const { startedAt } = await stepStarted(ids.contractId, versionId, name, attempt)
  let outcome: StepOutcome | void
  try {
    outcome = await fn()
  } catch (err) {
    await stepFailed(ids.contractId, versionId, name, (err as Error).message, { final, attempt })
    throw err
  }
  if (outcome?.failed) await stepFailed(ids.contractId, versionId, name, outcome.failed, { final: true, attempt })
  else await stepDone(ids.contractId, versionId, name, { startedAt, counts: outcome?.counts, model: outcome?.model, skipped: outcome?.skipped })
  await outcome?.after?.()
}

/** Close the version's open run as failed: the contract's analysis was failed elsewhere (the stuck sweep). */
export async function failOpenRuns(contractIds: string[], error: string): Promise<number> {
  if (!contractIds.length) return 0
  const runs = await prisma.analysisRun.findMany({ where: { contractId: { in: contractIds }, status: { in: OPEN } } })
  for (const run of runs) {
    const running = stepsOf(run).filter(s => s.status === 'running' || s.status === 'retrying').pop()
    const name = running?.name ?? 'parse'
    await stepFailed(run.contractId, run.versionId, name, error)
  }
  return runs.length
}

// ── Reading runs ─────────────────────────────────────────────────────────────

export interface RunView {
  id: string
  versionId: string
  versionNumber: number | null
  reason: string
  mode: string
  status: RunStatus
  failedStep: string | null
  failedStepLabel: string | null
  error: string | null
  startedAt: string
  finishedAt: string | null
  /** The step running now, and where it is in the run ("step 3 of 5"). */
  current: { name: string; label: string; index: number; of: number } | null
  stuck: boolean
  steps: Array<RunStep & { label: string }>
}

/** Steps in the order they run, whatever order they were written in. */
export function orderedSteps(steps: RunStep[]): RunStep[] {
  return [...steps].sort((a, b) => RUN_STEPS.indexOf(a.name) - RUN_STEPS.indexOf(b.name))
}

/** The steps a run of this mode takes, for "step n of m". */
function plannedSteps(mode: string, steps: RunStep[]): RunStepName[] {
  const planned: RunStepName[] = mode === 'incremental'
    ? ['carry', 'index', 'findings', 'position_check']
    : ['extract', 'index', 'findings', 'position_check']
  // A step it took that wasn't planned (a parse, a classify) is counted too.
  for (const s of steps) if (!planned.includes(s.name)) planned.push(s.name)
  return planned.sort((a, b) => RUN_STEPS.indexOf(a) - RUN_STEPS.indexOf(b))
}

export function viewRun(run: { id: string; versionId: string; reason: string; mode: string; status: string; failedStep: string | null; error: string | null; startedAt: Date; finishedAt: Date | null; updatedAt: Date; steps: Prisma.JsonValue }, versionNumber: number | null, now = Date.now()): RunView {
  const steps = orderedSteps(stepsOf(run))
  const running = steps.filter(s => s.status === 'running' || s.status === 'retrying').pop() ?? null
  const plan = plannedSteps(run.mode, steps)
  const open = OPEN.includes(run.status as RunStatus)
  return {
    id: run.id,
    versionId: run.versionId,
    versionNumber,
    reason: run.reason,
    mode: run.mode,
    status: run.status as RunStatus,
    failedStep: run.failedStep,
    failedStepLabel: run.failedStep ? STEP_LABEL[run.failedStep as RunStepName] ?? run.failedStep : null,
    error: run.error,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    current: running && open ? { name: running.name, label: STEP_LABEL[running.name] ?? running.name, index: plan.indexOf(running.name) + 1, of: plan.length } : null,
    stuck: open && now - run.updatedAt.getTime() > STUCK_RUN_MS,
    steps: steps.map(s => ({ ...s, label: STEP_LABEL[s.name] ?? s.name })),
  }
}

/** The latest run of a contract (of one version, when given), as the page shows it. */
export async function latestRun(contractId: string, versionId?: string | null): Promise<RunView | null> {
  const run = await prisma.analysisRun.findFirst({
    where: { contractId, ...(versionId && { versionId }), status: { not: 'superseded' } },
    orderBy: { startedAt: 'desc' },
  })
  if (!run) return null
  const v = await prisma.contractVersion.findUnique({ where: { id: run.versionId }, select: { versionNumber: true } })
  return viewRun(run, v?.versionNumber ?? null)
}
