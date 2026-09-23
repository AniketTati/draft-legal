/**
 * Page ranges for splitting a binder, from what binder detection returned.
 * Pure, so it can be tested without the worker.
 */

export type DetectedDocument = { title: string; docType: string; charStart?: number; pageHint?: string }
export type SplitSpec = { title: string; type: string; pageStart: number; pageEnd: number }

/**
 * X16 follow-up — the page each agreement starts on, from its character
 * offset: the detector reports `charStart` in the whole text (X16 made it
 * absolute for long binders), and a text sample carries no page numbers, so
 * its "~page N" hints are guesses. Pages are placed in proportion to the
 * text, which is approximate when page densities differ; the split can be
 * adjusted after. null when the offsets aren't usable: missing, out of
 * range, out of order, or the first not near the start.
 */
function pagesFromOffsets(docs: DetectedDocument[], totalPages: number, textLength: number): number[] | null {
  if (!(textLength > 0) || docs.length === 0) return null
  const offsets = docs.map(d => d.charStart)
  if (offsets.some(o => typeof o !== 'number' || !Number.isFinite(o) || o < 0 || o >= textLength)) return null
  const starts = offsets as number[]
  if (starts[0] > textLength * 0.05 || starts.some((o, i) => i > 0 && o <= starts[i - 1])) return null
  const pages: number[] = []
  for (const [i, o] of starts.entries()) {
    const page = i === 0 ? 1 : Math.min(totalPages, Math.floor((o / textLength) * totalPages) + 1)
    // Two agreements whose offsets fall on one page: the later starts on the next page.
    pages.push(i === 0 ? page : Math.max(page, pages[i - 1] + 1))
  }
  return pages[pages.length - 1] <= totalPages ? pages : null
}

// Otherwise, convert LLM pageHint strings ("~page N") to concrete {pageStart,
// pageEnd} ranges. Resilient to an LLM that hands us bad hints:
//   • "~page 1" for all 3 docs (all same) → distribute evenly
//   • "~page 5" on a 2-page PDF (out of range) → clamp + distribute
//   • missing hints → index-proportional default
// If after parsing we end up with <2 unique page starts but docs.length >= 2,
// we FALL BACK to even distribution across the PDF.
export function docsToSplitSpecs(
  docs: DetectedDocument[],
  totalPages: number,
  textLength = 0,
): SplitSpec[] {
  if (docs.length === 0) return []
  const fromOffsets = pagesFromOffsets(docs, totalPages, textLength)
  if (fromOffsets) {
    return docs.map((doc, i) => ({
      title:     doc.title,
      type:      doc.docType,
      pageStart: fromOffsets[i],
      pageEnd:   i < docs.length - 1 ? fromOffsets[i + 1] - 1 : totalPages,
    }))
  }
  const evenShare = Math.max(1, Math.floor(totalPages / docs.length))

  let withPages = docs.map((doc, i) => {
    const match = doc.pageHint?.match(/\d+/)
    const rawPage = match ? parseInt(match[0], 10) : NaN
    // Valid if within [1, totalPages]
    const pageNum = Number.isFinite(rawPage) && rawPage >= 1 && rawPage <= totalPages
      ? rawPage
      : i * evenShare + 1
    return { ...doc, pageNum }
  })

  // Sort by LLM-suggested start (usable when hints vary).
  withPages.sort((a, b) => a.pageNum - b.pageNum)

  // Collapsed starts? Example: LLM gave pageHint="~page 1" for every
  // agreement → all pageNums equal. Detect + re-distribute so we
  // actually carve N pieces.
  const uniqueStarts = new Set(withPages.map(w => w.pageNum))
  if (uniqueStarts.size < withPages.length && withPages.length >= 2) {
    console.warn(
      '[agent-worker] docsToSplitSpecs: %d unique starts for %d docs — redistributing evenly',
      uniqueStarts.size, withPages.length,
    )
    // Preserve the original order from the LLM (insertion order) for
    // the title sequence, then space them across totalPages.
    withPages = docs.map((doc, i) => ({
      ...doc,
      pageNum: Math.min(totalPages, i * evenShare + 1),
    }))
  }

  return withPages.map((doc, i) => {
    const nextStart = i < withPages.length - 1 ? withPages[i + 1].pageNum : totalPages + 1
    const pageEnd   = Math.max(doc.pageNum, nextStart - 1)
    return {
      title:     doc.title,
      type:      doc.docType,
      pageStart: doc.pageNum,
      pageEnd,
    }
  })
}
