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
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'

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
export async function computeVersionDiff(v1Html: string, v2Html: string): Promise<VersionDiff> {
  const diffHtml = await htmlDiff(v1Html, v2Html)
  return {
    diffHtml,
    stats: {
      insertions: (diffHtml.match(/<ins[\s>]/g) ?? []).length,
      deletions:  (diffHtml.match(/<del[\s>]/g) ?? []).length,
    },
  }
}

// ── Off the request thread (X32) ────────────────────────────────────────────
// htmldiff is synchronous and grows faster than the text: 45 KB took 0.2 s,
// 354 KB 5.6 s, a large low-vocabulary pair minutes. On the request thread
// that stalled every other request on the instance. It runs on a worker
// thread instead, stopped past a time limit, two at a time per process.

const DIFF_TIMEOUT_MS = 30_000
const MAX_RUNNING = 2

const HTMLDIFF_MODULE = createRequire(import.meta.url).resolve('node-htmldiff')
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
parentPort.postMessage(require(workerData.module)(workerData.a, workerData.b))
`

/** The versions are too large (or too alike in the wrong way) to diff within the time limit. */
export class DiffTooLargeError extends Error {
  constructor() {
    super('These versions are too large to compare. Compare smaller sections, or download both versions.')
    this.name = 'DiffTooLargeError'
  }
}

let running = 0
const waiting: Array<() => void> = []

async function inSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running < MAX_RUNNING) running++
  else await new Promise<void>(resolve => waiting.push(resolve))   // a finishing diff hands its slot over
  try {
    return await fn()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else running--
  }
}

/** htmldiff(a, b) on a worker thread; rejects with DiffTooLargeError past the time limit. */
export function htmlDiff(a: string, b: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DIFF_TIMEOUT_MS
  return inSlot(() => new Promise<string>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { module: HTMLDIFF_MODULE, a, b } })
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
      void worker.terminate()
    }
    const timer = setTimeout(() => settle(() => reject(new DiffTooLargeError())), timeoutMs)
    worker.once('message', (html: string) => settle(() => resolve(html)))
    worker.once('error', err => settle(() => reject(err)))
    worker.once('exit', code => settle(() => reject(new Error(`diff worker exited with code ${code}`))))
  }))
}
