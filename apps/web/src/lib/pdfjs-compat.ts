/**
 * docs/39 C1 — pdf.js as @react-pdf-viewer expects it.
 *
 * pdfjs-dist is kept at 4.2.67 or later (the root package.json's override:
 * CVE-2024-4367, a crafted PDF could run script). @react-pdf-viewer 3.12 was
 * written for pdf.js 3 and draws each page's text with renderTextLayer(),
 * which pdf.js 4 replaced with the TextLayer class — so the original PDF
 * rendered without its text layer: nothing to select, and nothing for "Show
 * in document" to highlight. Vite hands the viewer this module for
 * 'pdfjs-dist' (vite.config.ts): all of pdf.js, and renderTextLayer on top of
 * TextLayer, with the CSS variables pdf.js 5 sizes the layer and its text by.
 */
// @ts-expect-error — pdf.js ships no type declarations for its build file.
export * from 'pdfjs-dist/build/pdf.mjs'
// @ts-expect-error — as above.
import { TextLayer } from 'pdfjs-dist/build/pdf.mjs'

interface Viewport { scale: number }

export function renderTextLayer(params: { container: HTMLElement; textContentSource?: unknown; textContent?: unknown; viewport: Viewport }) {
  const { container, viewport } = params
  // pdf.js's own viewer sets these on the page; the text layer's size and font sizes are worked out from them.
  container.classList.add('textLayer')
  container.style.setProperty('--total-scale-factor', String(viewport.scale))
  container.style.setProperty('--scale-factor', String(viewport.scale))
  container.style.setProperty('--scale-round-x', '1px')
  container.style.setProperty('--scale-round-y', '1px')
  const layer = new TextLayer({ textContentSource: params.textContentSource ?? params.textContent, container, viewport })
  return { promise: layer.render() as Promise<void>, cancel: () => layer.cancel() }
}
