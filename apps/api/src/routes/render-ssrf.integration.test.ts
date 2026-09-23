/**
 * X11 — Gotenberg renders contract HTML from inside the server's network, so
 * HTML that names an internal URL was fetched by the renderer, and an iframe
 * or a meta refresh printed the internal response into the PDF handed back
 * (reproduced: "INTERNAL SECRET PAGE" in the exported PDF). A probe server
 * stands in for an internal service; after the fix nothing may reach it.
 *
 * The probe cases need a real Gotenberg (docker compose); CI's integration job
 * has none, so they skip there like the Elasticsearch-backed ones.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

vi.hoisted(() => { process.env.GOTENBERG_URL ??= 'http://localhost:3002' })

import { getApp, closeApp, makeOrg, makeUser, auth, cleanupAll, type TestApp } from '../test-support/helpers.js'

// A stack without Gotenberg refuses the connection at once; a running one can
// take more than 2 s to answer under the full suite's load, which silently
// skipped these cases.
const GOTENBERG_UP = await fetch(`${process.env.GOTENBERG_URL}/health`, { signal: AbortSignal.timeout(15_000) })
  .then(r => r.ok, () => false)

let app: TestApp
let org: string, user: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Render SSRF Org')
  user = await makeUser(org)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

const exportPdf = (html: string) => app.inject({
  method: 'POST', url: '/api/v1/contracts/export', headers: auth(org, ['VIEWER'], user),
  payload: { html, format: 'pdf' },
})

describe.skipIf(!GOTENBERG_UP)('Gotenberg renders cannot reach the internal network', () => {
  let probe: http.Server
  let base = ''
  const hits: string[] = []

  function hostileHtml(tag: string): string {
    return `<p>Hello</p>`
      + `<img src="${base}/${tag}/img">`
      + `<iframe src="${base}/${tag}/iframe" width="600" height="100"></iframe>`
      + `<meta http-equiv="refresh" content="0;url=${base}/${tag}/refresh">`
      + `<p style="background:url(${base}/${tag}/css)">styled</p>`
      + `<script>fetch('${base}/${tag}/script')</script>`
  }

  beforeAll(async () => {
    probe = http.createServer((req, res) => {
      hits.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<h1>INTERNAL SECRET PAGE</h1>')
    })
    await new Promise<void>(r => probe.listen(0, '0.0.0.0', r))
    // The renderer runs in a container; the host is host.docker.internal there.
    base = `http://host.docker.internal:${(probe.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise(r => probe.close(r))
  })

  it('POST /contracts/export returns a PDF of the contract, and fetches nothing', async () => {
    const res = await exportPdf(hostileHtml('export'))
    await new Promise(r => setTimeout(r, 300))
    expect(hits.filter(h => h.startsWith('/export/'))).toEqual([])
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('the html-version render (the canonical PDF) fetches nothing either', async () => {
    const { renderHtmlToPdf } = await import('../lib/gotenberg.js')
    const pdf = await renderHtmlToPdf(hostileHtml('version'))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    await new Promise(r => setTimeout(r, 300))
    expect(hits.filter(h => h.startsWith('/version/'))).toEqual([])
  })
})

describe('HTML too deep to render is refused, not a stalled server', () => {
  it('POST /contracts/export answers 422 with the reason, quickly', async () => {
    const t0 = performance.now()
    const res = await exportPdf('<div>'.repeat(50_000) + 'x')
    expect(res.statusCode).toBe(422)
    expect(res.json().detail).toMatch(/levels deep/)
    expect(performance.now() - t0).toBeLessThan(1000)
  })
})
