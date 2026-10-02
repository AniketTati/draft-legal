/**
 * docs/41 P0.1 — what the contract page says about its analysis, in plain
 * words: Not analysed · Analysing · Done for vN · Failed at step X · stale
 * (the document changed after it was read). The state itself is worked out
 * as the API works it out (@clm/types analysisState), so the page and the
 * approval guard never disagree.
 */
import { analysisState, failedStep, type AnalysisState } from '@clm/types'

export interface AnalysisLine {
  state: AnalysisState['kind']
  /** The one line the page shows. */
  text: string
  /** A second, quieter line, when there is something to add. */
  detail: string | null
  /** Whether the page offers to analyse (again). */
  canAnalyse: boolean
}

export function analysisLine(contract: {
  analysisStatus: string
  analysisError?: string | null
  currentVersionId: string | null
  metadata: unknown
}, opts: { currentVersionNumber?: number | null; checkpointSoon?: boolean } = {}): AnalysisLine {
  const s = analysisState(contract)
  switch (s.kind) {
    case 'running':
      return { state: s.kind, text: 'Analysing…', detail: null, canAnalyse: false }
    case 'failed': {
      const step = failedStep(s.error)
      return { state: s.kind, text: step ? `Analysis failed at ${step}` : 'Analysis failed', detail: s.error, canAnalyse: true }
    }
    case 'not_analysed':
      return {
        state: s.kind,
        text: 'Not analysed',
        detail: s.reason ?? 'Nothing has read this document yet, so no clause, risk or playbook check has been made.',
        canAnalyse: true,
      }
    case 'stale': {
      const was = s.analysedVersionNumber != null ? `v${s.analysedVersionNumber}` : 'an earlier version'
      const now = opts.currentVersionNumber != null ? `v${opts.currentVersionNumber}` : 'this version'
      return {
        state: s.kind,
        text: `Analysis is for ${was} — ${now} has changes`,
        detail: opts.checkpointSoon
          ? 'It is analysed again two minutes after the last edit.'
          : 'Checks shown here describe the earlier version until it is analysed again.',
        canAnalyse: true,
      }
    }
    case 'done':
      return {
        state: s.kind,
        text: s.versionNumber != null ? `Analysed · v${s.versionNumber}` : 'Analysed',
        detail: s.clauses === 0 ? 'No clauses were found in this short document.' : null,
        canAnalyse: false,
      }
  }
}

/**
 * docs/41 browser QA — why an analysis failed, in words a person reads. The
 * stored error is for the logs ("Failed while saving what was read (attempt
 * 3 of 3): the contract's fields were refused (422): {"type":…}"), and the
 * banner showed it as it was, JSON and all.
 */
export function plainFailure(error: string | null | undefined): string | null {
  if (!error?.trim()) return null
  // The cause, without "Failed while … (attempt n of m):" (the step is said apart).
  const cause = error.replace(/^Failed while [^:]*:\s*/, '').trim()
  if (/\brefused \(\d{3}\)/i.test(cause)) return 'What it read couldn’t be saved.'
  if (/timed? ?out|timeout|cut off/i.test(cause)) return 'The AI service took too long to answer.'
  if (/\b(?:service answered|status) 5\d\d\b|\b5\d\d\b|unavailable|ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i.test(cause)) return 'The AI service couldn’t be reached.'
  if (/no text yet|could not extract text/i.test(cause)) return 'The document has no text to read yet.'
  if (/no clauses found/i.test(cause)) return 'No clauses were found in the document.'
  if (/produced nothing/i.test(cause)) return 'The AI read nothing from the document.'
  // Anything else, only when it already reads as words.
  if (/[{}[\]<>]|\(\d{3}\)|\b[A-Z_]{6,}\b|Error:|at \w+ \(/.test(cause) || cause.length > 140) return 'Something went wrong on our side.'
  return `${cause[0].toUpperCase()}${cause.slice(1)}`.replace(/([^.!?])$/, '$1.')
}

/** The failed analysis as the banner says it: the step, from its run when there is one, and why. */
export function failureLine(
  run: { failedStepLabel?: string | null; error?: string | null } | null | undefined,
  analysisError: string | null | undefined,
): { title: string; reason: string | null } {
  const step = run?.failedStepLabel ?? failedStep(analysisError)
  return { title: step ? `Analysis failed while ${step}` : 'Analysis failed', reason: plainFailure(run?.error ?? analysisError) }
}
