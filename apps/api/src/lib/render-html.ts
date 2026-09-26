/**
 * The HTML document Gotenberg is allowed to render (X11).
 *
 * Gotenberg's Chromium renders whatever HTML it is handed, from inside the
 * server's network. Contract HTML is user-controlled: the editor's
 * html-version save, the `POST /contracts/export` body, AI drafts, and text
 * extracted from uploads. So an <iframe>, <img>, CSS url() or
 * <meta http-equiv="refresh"> naming an internal address (Elasticsearch,
 * MinIO, a metadata server) was fetched by the renderer — and with an iframe
 * or a refresh, the internal response was printed into the PDF handed back.
 *
 * Every render goes through renderableHtml():
 *   - parse with parse5 (spec-compliant, so the browser sees the same tree);
 *   - drop elements that load, embed or navigate (script, iframe, object,
 *     embed, link, meta, base, frame, SVG animation, …) and comments;
 *   - drop event-handler attributes, and every URL attribute that isn't an
 *     inline data: image or an in-document anchor (an <a href> keeps
 *     http/https/mailto: a link in a PDF is not fetched);
 *   - neutralise url() / @import in CSS, and drop CSS that uses escapes (a
 *     CSS escape can spell `url(` past any pattern);
 *   - rebuild the document with a Content-Security-Policy <meta> as the first
 *     thing in <head>, so anything that slips past still cannot load.
 */
import { parse, serialize, serializeOuter, defaultTreeAdapter } from 'parse5'

type Attr = { name: string; value: string; prefix?: string; namespace?: string }
type Node = {
  nodeName: string
  tagName?: string
  value?: string
  attrs?: Attr[]
  childNodes?: Node[]
  parentNode?: Node | null
}

/**
 * Render limits. parse5 is synchronous: its scope checks walk the open-element
 * stack, so cost grows with nesting depth, and the clean/serialize walks
 * recurse — 2,000 nested <div>s overflowed the stack and 50,000 blocked the
 * event loop for 44s. Unclosed formatting elements are re-opened in every
 * new block, so a few KB can also expand into millions of elements. Contract
 * HTML nests a few dozen levels and holds tens of thousands of elements.
 */
export const MAX_RENDER_HTML_CHARS = 5_000_000
export const MAX_RENDER_DEPTH = 128
export const MAX_RENDER_ELEMENTS = 200_000

/** The HTML was refused before rendering (too large or too deep) — a 422, not a crash. */
export class RenderRefusedError extends Error {}

/** A tree adapter that stops the parse as soon as the tree outgrows the limits. */
function boundedTreeAdapter(): typeof defaultTreeAdapter {
  let elements = 0
  const depth = new WeakMap<object, number>()
  const place = (parent: object, child: object) => {
    const d = (depth.get(parent) ?? 0) + 1
    if (d > MAX_RENDER_DEPTH) {
      throw new RenderRefusedError(`The document nests elements more than ${MAX_RENDER_DEPTH} levels deep, so it can't be rendered.`)
    }
    depth.set(child, d)
  }
  return {
    ...defaultTreeAdapter,
    createElement(...args: Parameters<typeof defaultTreeAdapter.createElement>) {
      if (++elements > MAX_RENDER_ELEMENTS) {
        throw new RenderRefusedError(`The document has more than ${MAX_RENDER_ELEMENTS} elements, so it can't be rendered.`)
      }
      return defaultTreeAdapter.createElement(...args)
    },
    appendChild(parent, child) {
      place(parent, child)
      defaultTreeAdapter.appendChild(parent, child)
    },
    insertBefore(parent, child, reference) {
      place(parent, child)
      defaultTreeAdapter.insertBefore(parent, child, reference)
    },
  }
}

/** Nothing loads but inline data: images/fonts and inline styles. */
export const RENDER_CSP =
  "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"

export const DEFAULT_RENDER_STYLES = `
  body { font-family: Georgia, serif; font-size: 12pt; line-height: 1.6; margin: 2.5cm; color: #1a1a1a; }
  h1 { font-size: 18pt; margin-top: 1.2em; } h2 { font-size: 14pt; } h3 { font-size: 12pt; }
  table { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
  td, th { border: 1px solid #ccc; padding: 6px 10px; vertical-align: top; }
  ul, ol { padding-left: 1.5em; }
  blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 1em; color: #555; }
`

const DROP_ELEMENTS = new Set([
  'script', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'link', 'meta', 'base', 'portal', 'fencedframe',
  // SVG can re-point an href declaratively, without script.
  'set', 'animate', 'animatemotion', 'animatetransform', 'foreignobject',
])

// Attributes whose value is a URL the renderer may fetch.
const URL_ATTRS = new Set([
  'src', 'href', 'srcset', 'action', 'formaction', 'poster', 'background', 'data', 'ping',
  'lowsrc', 'dynsrc', 'cite', 'longdesc', 'usemap', 'manifest', 'codebase', 'archive',
  'classid', 'profile', 'icon', 'imagesrcset',
])

const INLINE_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp);/i

function keepUrl(tag: string, attr: string, raw: string): boolean {
  const v = raw.trim()
  if (attr === 'href' && tag === 'a') return /^(https?:|mailto:|#)/i.test(v)
  if (attr === 'href') return v.startsWith('#')
  if (attr === 'src' && tag === 'img') return INLINE_IMAGE.test(v)
  return false
}

/** CSS with no way to fetch: url() only for inline data, no @import, no escapes. */
export function cleanCss(css: string): string | null {
  if (css.includes('\\')) return null
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, _q, u: string) => (/^data:(image|font)\//i.test(u.trim()) ? m : 'none'))
    // Image-producing functions that take a bare string URL.
    .replace(/(?:-webkit-)?(?:image-set|image|cross-fade|element|paint)\s*\(/gi, 'none(')
}

function cleanAttrs(el: Node): void {
  const tag = (el.tagName ?? '').toLowerCase()
  el.attrs = (el.attrs ?? []).filter(a => {
    const name = a.name.toLowerCase()
    if (name.startsWith('on')) return false
    if (URL_ATTRS.has(name)) return keepUrl(tag, name, a.value)
    if (name === 'style') {
      const css = cleanCss(a.value)
      if (css === null) return false
      a.value = css
    }
    // <meta http-equiv> is dropped with the element; `is`/`xmlns` load nothing.
    return true
  })
}

function clean(node: Node): void {
  const kept: Node[] = []
  for (const child of node.childNodes ?? []) {
    if (child.nodeName === '#comment') continue
    if (child.nodeName === '#text' || child.nodeName === '#documentType') { kept.push(child); continue }
    const tag = (child.tagName ?? child.nodeName).toLowerCase()
    if (DROP_ELEMENTS.has(tag)) continue
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
      // A mangled name (a NUL in the tag becomes U+FFFD) is no element we
      // know. The parser nests what follows inside it, so keep that content
      // (cleaned) and drop only the wrapper.
      clean(child)
      for (const inner of child.childNodes ?? []) { inner.parentNode = node; kept.push(inner) }
      continue
    }
    if (tag === 'style') {
      const css = cleanCss((child.childNodes ?? []).map(t => t.value ?? '').join(''))
      if (css === null) continue
      child.childNodes = [{ nodeName: '#text', value: css, parentNode: child }]
      child.attrs = []
      kept.push(child)
      continue
    }
    cleanAttrs(child)
    clean(child)
    kept.push(child)
  }
  node.childNodes = kept
}

const find = (node: Node | undefined, tag: string): Node | undefined =>
  node?.childNodes?.find(c => c.tagName === tag)

/**
 * A complete HTML document that is safe to hand to Gotenberg: the input's
 * body (and any <style>/<title> from its head), sanitised, under a head that
 * starts with the CSP.
 */
export function renderableHtml(html: string): string {
  if (html.length > MAX_RENDER_HTML_CHARS) {
    throw new RenderRefusedError(`The document is too large to render (${html.length} characters; the limit is ${MAX_RENDER_HTML_CHARS}).`)
  }
  try {
    const doc = parse(html, { treeAdapter: boundedTreeAdapter() }) as unknown as Node
    const root = find(doc, 'html')
    const head = find(root, 'head')
    const body = find(root, 'body')
    if (head) clean(head)
    if (body) clean(body)
    const extras = (head?.childNodes ?? [])
      .filter(c => c.tagName === 'style' || c.tagName === 'title')
      .map(c => serializeOuter(c as never))
      .join('')
    return '<!DOCTYPE html><html><head><meta charset="utf-8">'
      + `<meta http-equiv="Content-Security-Policy" content="${RENDER_CSP}">`
      + `<style>${DEFAULT_RENDER_STYLES}</style>${extras}</head>`
      + `<body>${body ? serialize(body as never) : ''}</body></html>`
  } catch (err) {
    // Belt-and-braces: a move the depth tracking missed still fails cleanly.
    if (err instanceof RangeError) throw new RenderRefusedError('The document is too deeply nested to render.')
    throw err
  }
}
