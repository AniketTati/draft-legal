/**
 * Reciprocal Rank Fusion (RRF).
 *
 * Hybrid retrieval merges results from independent rankers — pgvector
 * (dense) and Elasticsearch (BM25) — whose raw scores live on
 * incomparable scales. RRF sidesteps score normalisation entirely: each
 * ranker contributes `1 / (k + rank)` per item and we sum the
 * contributions. An item that ranks decently across several rankers
 * beats one that ranks first in a single ranker, which is the
 * robustness hybrid search wants.
 *
 * `k` (default 60) damps the weight of the very top ranks so a couple of
 * first-place hits can't dominate the fused order. 60 is the constant
 * from Cormack et al. and the value the search routes have always used.
 *
 * This is the shared, pure core; the search routes wire their own result
 * shapes into it. Kept dependency-free and side-effect-free so it's
 * trivially unit-testable (see rrf.test.ts).
 */

export const RRF_K = 60

/**
 * RRF contribution of a single item sitting at a 0-based `rank` within
 * one ranked list. With the default k: rank 0 → 1/61, rank 1 → 1/62, …
 */
export function rrfScore(rank: number, k: number = RRF_K): number {
  return 1 / (k + rank + 1)
}

export interface RrfResult {
  id: string
  score: number
}

/**
 * Fuse several ranked lists of ids into one ranking.
 *
 * Each input list is an array of ids in descending rank order (best
 * first). Rules that mirror the hand-rolled fusion the search routes
 * used before this was extracted:
 *   - Falsy ids (undefined / null / '') are skipped, but still consume a
 *     rank position — so a hole in one list doesn't shift the items
 *     after it up a rank.
 *   - A duplicate id within a single list only scores once, at its first
 *     occurrence's rank; lists can therefore be passed raw (e.g. clause
 *     matches that repeat a contractId) without pre-deduping.
 *
 * Returns `{ id, score }` sorted by score descending. Ties preserve the
 * order in which ids were first seen (list 0 before list 1, earlier
 * ranks first) — deterministic, since Array.prototype.sort is stable.
 */
export function fuseRRF(
  lists: Array<ReadonlyArray<string | undefined | null>>,
  k: number = RRF_K,
): RrfResult[] {
  const scores = new Map<string, number>()

  for (const list of lists) {
    const seen = new Set<string>()
    list.forEach((id, rank) => {
      if (!id || seen.has(id)) return
      seen.add(id)
      scores.set(id, (scores.get(id) ?? 0) + rrfScore(rank, k))
    })
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
}
