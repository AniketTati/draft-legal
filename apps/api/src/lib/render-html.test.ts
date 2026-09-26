/**
 * X11 — the HTML Gotenberg renders must not be able to load or navigate to
 * anything: no scripts, frames, embeds, meta refreshes, remote images or CSS
 * fetches. What a contract legitimately contains (text, formatting, tables,
 * links, inline images) survives.
 */
import { describe, it, expect } from 'vitest'
import { renderableHtml, cleanCss, RENDER_CSP, RenderRefusedError, MAX_RENDER_DEPTH } from './render-html.js'

const INTERNAL = 'http://elasticsearch:9200/contracts/_search'

describe('renderableHtml', () => {
  it('starts the head with the CSP, before anything from the input', () => {
    const out = renderableHtml('<!DOCTYPE html><html><head><title>T</title><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body>x</body></html>')
    const head = out.slice(out.indexOf('<head>'), out.indexOf('</head>'))
    expect(head.indexOf(RENDER_CSP)).toBeGreaterThan(-1)
    expect(head.indexOf('Content-Security-Policy')).toBeLessThan(head.indexOf('<title>'))
    expect(out).not.toContain('default-src *')
  })

  it('drops everything that loads, embeds or navigates', () => {
    const hostile = [
      `<script>fetch("${INTERNAL}")</script>`,
      `<iframe src="${INTERNAL}"></iframe>`,
      `<meta http-equiv="refresh" content="0;url=${INTERNAL}">`,
      `<object data="${INTERNAL}"></object><embed src="${INTERNAL}">`,
      `<link rel="stylesheet" href="${INTERNAL}"><base href="${INTERNAL}">`,
      `<img src="${INTERNAL}" srcset="${INTERNAL} 2x" onerror="alert(1)">`,
      `<video poster="${INTERNAL}"><source src="${INTERNAL}"></video>`,
      `<table background="${INTERNAL}"><tr><td>cell</td></tr></table>`,
      `<svg><image href="${INTERNAL}"/><use xlink:href="${INTERNAL}#a"/><set attributeName="href" to="${INTERNAL}"/></svg>`,
      `<p style="background:url(${INTERNAL})">styled</p>`,
      `<style>@import "${INTERNAL}"; p { background: url('${INTERNAL}') }</style>`,
      `<p style="background:u\\72l(${INTERNAL})">escaped</p>`,
      `<form action="${INTERNAL}"><button formaction="${INTERNAL}">go</button></form>`,
      `<a href="javascript:fetch('${INTERNAL}')">js</a>`,
      `<noscript><img src="${INTERNAL}"></noscript><template><img src="${INTERNAL}"></template>`,
    ].join('')
    const out = renderableHtml(`<p>Contract</p>${hostile}`)
    expect(out).not.toContain('elasticsearch')
    expect(out).not.toMatch(/<(script|iframe|object|embed|link|base|set|noscript|template)\b/i)
    expect(out).not.toMatch(/http-equiv="refresh"/i)
    expect(out).not.toMatch(/\son\w+=/i)
    expect(out).toContain('<p>Contract</p>')
    expect(out).toContain('<td>cell</td>')
  })

  it('keeps what a contract legitimately contains', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const html = `<h1>MSA</h1><p><strong>Bold</strong> &amp; <em>em</em> &lt;tag&gt;</p>`
      + `<ol><li>one</li></ol><table><tr><td style="text-align:right">1</td></tr></table>`
      + `<a href="https://example.com/terms">terms</a><a href="#s2">§2</a><img src="${png}" alt="signature">`
    const out = renderableHtml(html)
    for (const kept of ['<h1>MSA</h1>', '<strong>Bold</strong> &amp; <em>em</em> &lt;tag&gt;', '<li>one</li>',
      'style="text-align:right"', 'href="https://example.com/terms"', 'href="#s2"', `src="${png}"`]) {
      expect(out).toContain(kept)
    }
  })

  it('treats a fragment and a full document alike', () => {
    const frag = renderableHtml('<p>x</p>')
    const full = renderableHtml('<!DOCTYPE html><html><head></head><body><p>x</p></body></html>')
    expect(frag).toBe(full)
  })
})

describe('renderableHtml refuses what would stall or crash it', () => {
  it('deep nesting is refused fast, not a stack overflow or a blocked event loop', () => {
    for (const html of ['<div>'.repeat(2000) + 'x' + '</div>'.repeat(2000), '<div>'.repeat(50_000) + 'x', '<b>'.repeat(5000) + 'x']) {
      const t0 = performance.now()
      expect(() => renderableHtml(html)).toThrow(RenderRefusedError)
      expect(performance.now() - t0).toBeLessThan(500)
    }
  })

  it('a contract nested well within the limit renders', () => {
    const nested = '<div>'.repeat(MAX_RENDER_DEPTH - 10) + '<p>deep clause</p>' + '</div>'.repeat(MAX_RENDER_DEPTH - 10)
    expect(renderableHtml(nested)).toContain('<p>deep clause</p>')
  })

  it('a mangled tag name (NUL byte) loses its wrapper and attributes, keeping the text', () => {
    const out = renderableHtml('<meta\u0000 http-equiv="refresh" content="0;url=http://elasticsearch:9200"><iframe\u0000 src="http://elasticsearch:9200/"></iframe><p>ok</p>')
    expect(out).not.toContain('elasticsearch')
    expect(out).not.toMatch(/http-equiv="refresh"/i)
    expect(out).toContain('<p>ok</p>')
  })
})

describe('cleanCss', () => {
  it('keeps inline data urls and plain declarations, neutralises the rest', () => {
    expect(cleanCss('color: red; font-weight: bold')).toBe('color: red; font-weight: bold')
    expect(cleanCss('background: url(data:image/png;base64,AA)')).toBe('background: url(data:image/png;base64,AA)')
    expect(cleanCss(`background: url("${INTERNAL}")`)).toBe('background: none')
    expect(cleanCss(`@import url(${INTERNAL}); p{}`)).toBe(' p{}')
    expect(cleanCss('background: \\75 rl(x)')).toBeNull()
    for (const fn of ['image-set', '-webkit-image-set', 'image', 'cross-fade', 'element']) {
      expect(cleanCss(`background-image: ${fn}('${INTERNAL}' 1x)`), fn).not.toMatch(new RegExp(`${fn}\\s*\\(`))
    }
  })
})
