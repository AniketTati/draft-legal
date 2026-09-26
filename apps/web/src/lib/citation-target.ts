/**
 * X1 — where a citation pill lands.
 *
 * `contract_cite` returns each passage's page and bounding box, recorded by
 * the extractor (apps/agents/app/routes/extract.py): a 1-based page, and the
 * paragraph's box as [x0, y0, x1, y1] in PDF points from the page's top-left
 * (PyMuPDF). The pill used to link only to `?section=`, so the reader got the
 * styled text scrolled to a matching heading. Now it also carries the page
 * and box, and the contract page opens the original PDF there and outlines
 * the passage.
 */

export type Box = [number, number, number, number]

export interface CitationTarget {
  page: number | null
  bbox: Box | null
}

export function citationHref(
  contractId: string,
  c: { sectionRef: string | null; page: number | null; bbox: number[] | null },
): string {
  const q = new URLSearchParams()
  if (c.sectionRef) q.set('section', c.sectionRef)
  if (c.page != null && Number.isInteger(c.page) && c.page >= 1) {
    q.set('page', String(c.page))
    const box = validBox(c.bbox)
    if (box) q.set('bbox', box.map(n => Math.round(n * 100) / 100).join(','))
  }
  const qs = q.toString()
  return `/contracts/${contractId}${qs ? `?${qs}` : ''}`
}

/** Reads `?page=` / `?bbox=`, ignoring anything malformed. */
export function parseCitationTarget(params: URLSearchParams): CitationTarget {
  const rawPage = params.get('page')
  const page = rawPage && /^\d+$/.test(rawPage) && Number(rawPage) >= 1 ? Number(rawPage) : null
  const raw = params.get('bbox')
  const bbox = page && raw ? validBox(raw.split(',').map(Number)) : null
  return { page, bbox }
}

/** The passage's outline on a rendered page, in CSS pixels at `scale`. */
export function highlightRect(bbox: Box, scale: number): { left: number; top: number; width: number; height: number } {
  // A little breathing room around the text, so the outline doesn't cut glyphs.
  const pad = 2
  return {
    left:   bbox[0] * scale - pad,
    top:    bbox[1] * scale - pad,
    width:  (bbox[2] - bbox[0]) * scale + 2 * pad,
    height: (bbox[3] - bbox[1]) * scale + 2 * pad,
  }
}

function validBox(b: number[] | null | undefined): Box | null {
  if (!b || b.length !== 4 || b.some(n => !Number.isFinite(n) || n < 0)) return null
  const [x0, y0, x1, y1] = b
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null
}
