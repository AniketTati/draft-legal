/**
 * Version diffing.
 *
 * Lifted out of the `/:id/versions/:v1Id/diff/:v2Id` route so the DOCX exporter
 * can produce the SAME diff the review UI shows. Two callers computing "the
 * diff" slightly differently is how an export ends up disagreeing with the
 * screen a reviewer approved it on.
 *
 * Note for anyone tempted to reuse the web helper instead: `apps/web/src/lib/
 * redline.ts` returns `null` from its `parse()` when `window` is undefined, so
 * server-side `extractChanges()` yields `[]` and `resolveDiff()` returns its
 * input unchanged — with no error. That path produces a document with zero
 * tracked changes that looks like a successful export.
 */
// @ts-ignore — no type definitions for node-htmldiff
import htmldiff from 'node-htmldiff'

export interface DiffStats {
  insertions: number
  deletions:  number
}

export interface VersionDiff {
  diffHtml: string
  stats:    DiffStats
}

/**
 * Diff two versions' HTML.
 *
 * Known limitation, measured rather than assumed: when a block structural
 * change coincides with token similarity spanning the block boundary, htmldiff
 * can split one source block across two. Across 69 consecutive version pairs in
 * the dev corpus this never occurred (accept 0 wrong, reject 0 wrong on genuine
 * data). See docs/35 for the measurement and the fixture that does reproduce it.
 */
export function computeVersionDiff(v1Html: string, v2Html: string): VersionDiff {
  const diffHtml: string = htmldiff(v1Html, v2Html)
  return {
    diffHtml,
    stats: {
      insertions: (diffHtml.match(/<ins[\s>]/g) ?? []).length,
      deletions:  (diffHtml.match(/<del[\s>]/g) ?? []).length,
    },
  }
}
