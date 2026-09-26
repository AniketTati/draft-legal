/**
 * X48 — one run of `fn` for any number of concurrent callers: while a run is
 * in flight every caller gets its promise, and the first call after it
 * settles starts a new run.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null
  return () => {
    if (!inFlight) inFlight = fn().finally(() => { inFlight = null })
    return inFlight
  }
}
