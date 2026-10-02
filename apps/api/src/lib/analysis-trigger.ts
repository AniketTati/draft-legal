/**
 * docs/41 P0.1 — one way into a contract's analysis, from every place a
 * version a person will rely on is made.
 *
 * Analysis used to depend on how a contract was created: only a parsed file
 * was read for its clauses, risk and terms. A draft made from a request, a
 * draft added as a version and (before docs/39 H3) the assistant's template
 * draft were never read, and two of them still wrote `analysisStatus: DONE`.
 * Such a contract looked analysed and clean when nothing had been read, and
 * every check that loops over its clauses found nothing to flag.
 *
 * Now each of those paths calls `onVersionCreated`, which points the contract
 * at the version and queues the full analysis for it (classify → extract →
 * chunk → playbook review), or says truthfully why it can't: `NOT_ANALYSED`.
 *
 * Edits are the exception (docs/41 §6.7): the editor saves a version a few
 * seconds after typing stops, and a full analysis per save would be a model
 * run per pause. An edit asks for a *checkpoint* instead: one delayed job per
 * contract, pushed back by every later save, that analyses whatever version
 * the contract stands on once it has been left alone for two minutes.
 *
 * What an analysis describes is stamped on the contract when it finishes
 * (`metadata._analysis`, written by the chunk step): the version it read. A
 * contract whose current version isn't that one has stale analysis, and the
 * page and the approval guard say so.
 */
import { NOT_ANALYSED, ANALYSIS_IN_PROGRESS, analysisStampOf, type AnalysisStamp } from '@clm/types'
import { prisma } from './prisma.js'
import { startRun, type RunReason } from './analysis-runs.js'

export { NOT_ANALYSED, ANALYSIS_IN_PROGRESS, analysisStampOf, analysisState, type AnalysisStamp, type AnalysisState } from '@clm/types'

/** Why a version is being analysed. */
export type AnalysisReason =
  | 'generated'   // drafted from a template or by the draft agent
  | 'uploaded'    // a file a person or the counterparty supplied
  | 'added'       // a draft added to an existing contract as a new version
  | 'checkpoint'  // an edited version, left alone long enough
  | 'backfill'    // an old contract marked analysed that never was
  | 'retry'       // a person asked again

/**
 * A document this long with no clauses found is a failed analysis, not a
 * clean one: a real contract of a few hundred words has clauses. Shorter text
 * (a one-line placeholder, a cover note) can honestly have none.
 */
export const MIN_WORDS_FOR_CLAUSES = 150

export const NO_CLAUSES_ERROR =
  'No clauses found — the document may not be a contract, or its text could not be read properly. Check the document and analyse it again.'

/** How long an edited contract is left alone before its analysis runs again. 0 turns checkpoints off. */
export function checkpointDelayMs(): number {
  const raw = process.env.ANALYSIS_CHECKPOINT_MS
  if (raw === undefined || raw === '') return 120_000
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 120_000
}

export function wordCount(text: string | null | undefined): number {
  return (text ?? '').split(/\s+/).filter(Boolean).length
}

/**
 * Point the contract at `versionId` and queue the analysis of it. Never
 * throws for a missing contract or version (the caller has made its version
 * either way); returns what it did.
 */
export async function onVersionCreated(
  contractId: string,
  versionId: string,
  reason: AnalysisReason,
): Promise<'queued_parse' | 'queued_extract' | 'queued_classify' | 'not_analysed' | 'skipped'> {
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, deletedAt: null },
    select: { id: true, orgId: true, type: true, currentVersionId: true, metadata: true },
  })
  const version = await prisma.contractVersion.findFirst({
    where: { id: versionId, contractId },
    select: { id: true, plainText: true, s3Key: true, mimeType: true },
  })
  if (!contract || !version) return 'skipped'
  // A checkpoint analyses what the contract stands on now; a newer save has
  // its own checkpoint.
  if (reason === 'checkpoint' && contract.currentVersionId !== versionId) return 'skipped'
  // docs/41 P1 — the run every step of this analysis records itself on.
  if (version.plainText.trim() || version.s3Key) {
    await startRun({ orgId: contract.orgId, contractId, versionId, reason: reason as RunReason, mode: 'full' })
  }

  // Imported here: the queue module opens a Redis connection when loaded,
  // and the pure helpers above are unit-tested.
  const { queueParseDocument, queueExtractAi, queueClassifyDocument } = await import('./queue.js')

  // A file not read yet: the parse pipeline reads it and runs the rest.
  if (!version.plainText.trim() && version.s3Key) {
    await prisma.contract.update({
      where: { id: contractId },
      data: { currentVersionId: versionId, analysisStatus: 'PENDING', analysisError: null },
    })
    const ext = version.mimeType === 'application/pdf' ? 'pdf' : version.mimeType?.includes('wordprocessingml') ? 'docx' : 'txt'
    queueParseDocument({ contractId, versionId, s3Key: version.s3Key, mimeType: version.mimeType ?? 'application/pdf', orgId: contract.orgId, filename: `contract.${ext}` })
    return 'queued_parse'
  }

  if (!version.plainText.trim()) {
    await prisma.contract.update({
      where: { id: contractId },
      data: { currentVersionId: versionId, analysisStatus: NOT_ANALYSED, analysisError: 'The document has no text to analyse yet.' },
    })
    return 'not_analysed'
  }

  // The type is known when the contract was drafted for one (a template's
  // type, the request's) or has been read before: the extraction keeps it
  // rather than spending a call on guessing it again.
  const typeKnown = !!contract.type && contract.type !== 'OTHER'
  if (typeKnown) {
    await prisma.contract.update({
      where: { id: contractId },
      data: { currentVersionId: versionId, analysisStatus: 'EXTRACTING', analysisError: null },
    })
    queueExtractAi({ contractId, versionId, orgId: contract.orgId, contractType: contract.type, triggeredBy: reason === 'checkpoint' ? 'checkpoint' : 'template', typeLocked: true })
    return 'queued_extract'
  }
  await prisma.contract.update({
    where: { id: contractId },
    data: { currentVersionId: versionId, analysisStatus: 'CLASSIFYING', analysisError: null },
  })
  queueClassifyDocument({ contractId, versionId, orgId: contract.orgId })
  return 'queued_classify'
}

/** The job id of a contract's checkpoint: one per contract. */
export const checkpointJobId = (contractId: string) => `analysis-checkpoint-${contractId}`

/**
 * An edit was saved: analyse the contract once it has been left alone for
 * the checkpoint delay. A later save replaces the waiting job, so the timer
 * restarts — an analysis per pause in typing would be a model run per pause.
 * Returns false when checkpoints are off.
 */
export async function scheduleCheckpointAnalysis(contractId: string, orgId: string): Promise<boolean> {
  const delay = checkpointDelayMs()
  if (delay <= 0) return false
  const { agentQueue } = await import('./queue.js')
  const jobId = checkpointJobId(contractId)
  const existing = await agentQueue.getJob(jobId)
  if (existing) {
    // A waiting checkpoint is pushed back; one already running finishes, and
    // a second, later one is queued under its own id.
    const removed = await existing.remove().then(() => true, () => false)
    if (!removed) {
      await agentQueue.add('analysis-checkpoint', { contractId, orgId }, { jobId: `${jobId}-${Date.now()}`, delay, removeOnComplete: true, removeOnFail: 50 })
      return true
    }
  }
  await agentQueue.add('analysis-checkpoint', { contractId, orgId }, { jobId, delay, removeOnComplete: true, removeOnFail: 50 })
  return true
}

/**
 * The checkpoint fired: analyse the version the contract stands on, unless
 * that version is the one already analysed, or an analysis is running (then
 * try again after another delay, so the edit isn't lost).
 */
export async function runCheckpointAnalysis(data: { contractId: string; orgId: string }): Promise<string> {
  const c = await prisma.contract.findFirst({
    where: { id: data.contractId, orgId: data.orgId, deletedAt: null },
    select: { currentVersionId: true, analysisStatus: true, metadata: true },
  })
  if (!c?.currentVersionId) return 'no version'
  const stamp = analysisStampOf(c.metadata)
  if (stamp?.versionId === c.currentVersionId && c.analysisStatus === 'DONE') return 'already analysed'
  if (ANALYSIS_IN_PROGRESS.includes(c.analysisStatus)) {
    await scheduleCheckpointAnalysis(data.contractId, data.orgId)
    return 'analysis running — later'
  }
  // The same words as the version analysed (an edit undone, a signed copy
  // sealed from the text): that analysis describes this version too.
  if (stamp && c.analysisStatus === 'DONE') {
    const [now, analysed] = await Promise.all([
      prisma.contractVersion.findUnique({ where: { id: c.currentVersionId }, select: { plainText: true, versionNumber: true } }),
      prisma.contractVersion.findUnique({ where: { id: stamp.versionId }, select: { plainText: true } }),
    ])
    if (now && analysed && now.plainText.trim() && now.plainText.trim() === analysed.plainText.trim()) {
      const moved: AnalysisStamp = { ...stamp, versionId: c.currentVersionId, versionNumber: now.versionNumber }
      await prisma.$executeRaw`UPDATE contracts SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_analysis}', ${JSON.stringify(moved)}::jsonb) WHERE id = ${data.contractId}`
      return 'unchanged text'
    }
  }
  // docs/41 P1 (Part 5) — an edit of an analysed contract: only what changed
  // is read again. A rewrite too large for that is analysed in full.
  if (stamp && c.analysisStatus === 'DONE') {
    const done = await incrementalAnalysis(data.contractId, data.orgId, c.currentVersionId, stamp.versionId)
    if (done) return done
  }
  return onVersionCreated(data.contractId, c.currentVersionId, 'checkpoint')
}

/** Below this share of the analysed version's words kept, an edit is analysed in full. */
export const INCREMENTAL_MIN_KEPT = 0.6
/** Added text shorter than this isn't a clause of its own (a heading, a date, a word). */
const NEW_CLAUSE_MIN_WORDS = 12

/**
 * docs/41 P1 (Part 5) — the edited version, analysed from the one analysed
 * before it, without reading the whole document again:
 *   - its clauses are the analysed version's, followed into the new words
 *     (clause-carry.ts: unchanged ones keep their type and the model's
 *     verdict; changed ones keep their type and lose the verdict);
 *   - text added outside every clause, long enough to be one, becomes a new
 *     clause of no type yet — the position check names its type;
 *   - the findings are worked out against the baseline, and only the
 *     clauses that changed go to the model's position check.
 * The contract's summary, risk score and key terms are not read again (they
 * are read again on the next full analysis). Returns null when the edit is
 * too large, or the clauses can't be followed: then it is analysed in full.
 */
export async function incrementalAnalysis(contractId: string, orgId: string, versionId: string, analysedVersionId: string): Promise<'incremental' | null> {
  const [now, analysed] = await Promise.all([
    prisma.contractVersion.findFirst({ where: { id: versionId, contractId }, select: { plainText: true } }),
    prisma.contractVersion.findFirst({ where: { id: analysedVersionId, contractId }, select: { plainText: true } }),
  ])
  if (!now?.plainText.trim() || !analysed?.plainText.trim()) return null
  const { tokensOf, mapText, carryClauses } = await import('./clause-carry.js')
  const before = tokensOf(analysed.plainText)
  const map = mapText(before, tokensOf(now.plainText))
  let kept = 0
  for (let i = 0; i < before.length; i++) if (map.equal[i] >= 0) kept++
  if (before.length === 0 || kept < before.length * INCREMENTAL_MIN_KEPT) return null

  const { startRun, asStep } = await import('./analysis-runs.js')
  await startRun({ orgId, contractId, versionId, reason: 'checkpoint', mode: 'incremental' })
  await prisma.contract.update({ where: { id: contractId }, data: { analysisStatus: 'ANALYZING', analysisError: null } })
  try {
    const carried = await asStep(contractId, versionId, 'carry', async () => {
      const r = await carryClauses({ contractId, toVersionId: versionId, fromVersionId: analysedVersionId })
      const rows = await prisma.contractClause.findMany({ where: { versionId, isSubChunk: false }, orderBy: { sortOrder: 'asc' }, select: { content: true, sortOrder: true } })
      if (rows.length === 0) throw new Error('the clauses could not be followed into the edit')
      // New text outside every clause: a clause of its own, typed by the position check.
      const spans = rows.map(c => { const at = now.plainText.indexOf(c.content); return at < 0 ? null : { start: at, end: at + c.content.length, sortOrder: c.sortOrder } }).filter((x): x is NonNullable<typeof x> => !!x)
      const { insertedRuns } = await import('./review-findings.js')
      let added = 0
      for (const run of insertedRuns(analysed.plainText, now.plainText)) {
        if (run.text.split(/\s+/).filter(Boolean).length < NEW_CLAUSE_MIN_WORDS) continue
        if (spans.some(s => s.start <= run.start && run.end <= s.end)) continue
        const before = spans.filter(s => s.end <= run.start).pop()
        await prisma.contractClause.create({ data: {
          versionId, clauseType: 'unclassified', content: run.text, sortOrder: before?.sortOrder ?? 0,
          source: 'ai', docStart: run.start, docEnd: run.end, provenance: 'internal_edit',
        } })
        added++
      }
      return { ...r, clauses: rows.length + added, added }
    }, { final: false, counts: r => ({ carried: r.carried, changed: r.changed, dropped: r.dropped, added: r.added }) })
    // The analysis now describes this version. (A failure here falls back to
    // a full analysis on the same run, so it isn't the run's failure.)
    await asStep(contractId, versionId, 'index', () => finishAnalysis(contractId, versionId, carried.clauses), { final: false, counts: () => ({ clauses: carried.clauses }) })
  } catch (err) {
    console.warn('[analysis] incremental analysis of versionId=%s fell back to a full one: %s', versionId, (err as Error).message)
    return null
  }
  const { afterAnalysis } = await import('./presence-rules.js')
  await afterAnalysis(contractId, versionId)
  const { queuePlaybookReview } = await import('./queue.js')
  queuePlaybookReview({ contractId, orgId, versionId })
  return 'incremental'
}

/**
 * The chunk step finished: stamp what the analysis describes, or fail it when
 * a document of real length yielded no clauses (an empty success is what made
 * unread contracts look clean). Returns whether the analysis counts as done.
 */
export async function finishAnalysis(contractId: string, versionId: string, clauseCount: number): Promise<{ done: boolean }> {
  const [contract, version] = await Promise.all([
    prisma.contract.findUnique({ where: { id: contractId }, select: { metadata: true } }),
    prisma.contractVersion.findUnique({ where: { id: versionId }, select: { versionNumber: true, plainText: true } }),
  ])
  if (clauseCount === 0 && wordCount(version?.plainText) >= MIN_WORDS_FOR_CLAUSES) {
    await prisma.contract.update({
      where: { id: contractId },
      data: { analysisStatus: 'FAILED', analysisError: NO_CLAUSES_ERROR },
    })
    return { done: false }
  }
  const previous = analysisStampOf(contract?.metadata)
  const stamp: AnalysisStamp = {
    versionId,
    versionNumber: version?.versionNumber ?? null,
    at: new Date().toISOString(),
    clauses: clauseCount,
    baselineVersionId: previous
      ? (previous.versionId === versionId ? previous.baselineVersionId : previous.versionId)
      : null,
  }
  // jsonb_set: other workers write sibling keys of metadata meanwhile.
  await prisma.$executeRaw`UPDATE contracts SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_analysis}', ${JSON.stringify(stamp)}::jsonb), "analysisStatus" = 'DONE', "analysisError" = NULL WHERE id = ${contractId}`
  return { done: true }
}
