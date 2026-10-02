/**
 * docs/41 P0.1 — what a contract's analysis describes, read the same way by
 * the API (the approval guard) and the contract page.
 *
 * `analysisStatus` alone said DONE for contracts nobody had read, and said
 * nothing about which version was read. A finished analysis is now stamped
 * with its version (`metadata._analysis`); a contract standing on another
 * version has stale analysis, and one with no stamp has none.
 */

/** `analysisStatus` of a contract nothing has read (and nothing is queued to read). */
export const NOT_ANALYSED = 'NOT_ANALYSED'

/** Statuses that mean an analysis is queued or running. */
export const ANALYSIS_IN_PROGRESS = ['PENDING', 'DRAFTING', 'PARSING', 'SPLITTING', 'CLASSIFYING', 'EXTRACTING', 'ANALYZING', 'INDEXING']

/** What `metadata._analysis` holds once an analysis finishes. */
export interface AnalysisStamp {
  versionId: string
  versionNumber: number | null
  at: string
  clauses: number
  /**
   * The version analysed before this one, which deletions are measured
   * against. Kept across a re-analysis of the same version.
   */
  baselineVersionId: string | null
}

export function analysisStampOf(metadata: unknown): AnalysisStamp | null {
  const a = (metadata as { _analysis?: AnalysisStamp } | null)?._analysis
  return a && typeof a.versionId === 'string' ? a : null
}

export type AnalysisState =
  | { kind: 'not_analysed'; reason: string | null }
  | { kind: 'running'; status: string }
  | { kind: 'failed'; error: string | null }
  | { kind: 'stale'; analysedVersionId: string; analysedVersionNumber: number | null }
  | { kind: 'done'; versionId: string; versionNumber: number | null; clauses: number }

export function analysisState(c: { analysisStatus: string; analysisError?: string | null; currentVersionId: string | null; metadata: unknown }): AnalysisState {
  if (ANALYSIS_IN_PROGRESS.includes(c.analysisStatus)) return { kind: 'running', status: c.analysisStatus }
  if (c.analysisStatus === 'FAILED') return { kind: 'failed', error: c.analysisError ?? null }
  const stamp = analysisStampOf(c.metadata)
  if (!stamp || c.analysisStatus === NOT_ANALYSED) {
    return { kind: 'not_analysed', reason: c.analysisStatus === NOT_ANALYSED ? c.analysisError ?? null : null }
  }
  if (c.currentVersionId && stamp.versionId !== c.currentVersionId) {
    return { kind: 'stale', analysedVersionId: stamp.versionId, analysedVersionNumber: stamp.versionNumber }
  }
  return { kind: 'done', versionId: stamp.versionId, versionNumber: stamp.versionNumber, clauses: stamp.clauses }
}

/**
 * The step a failed analysis stopped at, in words, from its error
 * ("Failed while reading its fields and clauses (attempt 3 of 3): …").
 */
export function failedStep(error: string | null | undefined): string | null {
  if (!error) return null
  const m = /^Failed while ([^(:]+?)(?:\s*\(|:)/.exec(error)
  if (m) return m[1].trim()
  if (/^Search indexing failed/i.test(error)) return 'building the search index'
  if (/^Embedding failed/i.test(error)) return 'indexing its clauses'
  if (/^No clauses found/i.test(error)) return 'finding its clauses'
  if (/^Could not extract text/i.test(error)) return 'reading the document'
  return null
}
