/**
 * Gotenberg client — HTML → PDF rendering.
 *
 * Used by A.5 (hybrid canonical artifact) to regenerate a PDF every time
 * the editor saves HTML, so signers/approvers always see the latest edits
 * in the PDF they're shown.
 *
 * Also reusable for export flows and future preview generation.
 */
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { s3, S3_BUCKET } from './storage.js'
import { renderableHtml } from './render-html.js'

const GOTENBERG_URL = process.env.GOTENBERG_URL ?? 'http://localhost:3002'

// Wave 4 — when Gotenberg is deployed privately on Cloud Run (recommended;
// it has no built-in auth), service-to-service calls must carry an OIDC
// identity token whose audience is the Gotenberg URL. We fetch it from the
// Cloud Run metadata server and cache it (~1h TTL). Enabled by setting
// GOTENBERG_REQUIRE_AUTH=true on the API service in prod; off in local dev.
let _idTokenCache: { token: string; exp: number } | null = null

async function gotenbergAuthHeaders(): Promise<Record<string, string>> {
  if (process.env.GOTENBERG_REQUIRE_AUTH !== 'true') return {}
  const now = Date.now()
  if (_idTokenCache && _idTokenCache.exp > now + 60_000) {
    return { Authorization: `Bearer ${_idTokenCache.token}` }
  }
  const metaUrl =
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity'
    + `?audience=${encodeURIComponent(GOTENBERG_URL)}`
  const res = await fetch(metaUrl, { headers: { 'Metadata-Flavor': 'Google' } })
  if (!res.ok) {
    throw new Error(`Gotenberg OIDC token fetch failed (${res.status}) — the API must run on Cloud Run with a service account for private Gotenberg calls.`)
  }
  const token = (await res.text()).trim()
  let exp = now + 50 * 60_000 // default 50 min if the JWT can't be parsed
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    if (payload.exp) exp = payload.exp * 1000
  } catch { /* keep default TTL */ }
  _idTokenCache = { token, exp }
  return { Authorization: `Bearer ${token}` }
}

export interface RenderResult {
  s3Key: string
  size: number
}

/**
 * Render HTML to PDF bytes. X11 — every render is sanitised first: Gotenberg's
 * Chromium runs inside the server's network and fetched whatever the HTML
 * named, printing internal responses into the PDF. See render-html.ts.
 */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  if (!html?.trim()) throw new Error('renderHtmlToPdf: html is empty')

  const formData = new FormData()
  formData.append('files', new Blob([renderableHtml(html)], { type: 'text/html' }), 'index.html')

  const upstream = await fetch(`${GOTENBERG_URL}/forms/chromium/convert/html`, {
    method:  'POST',
    headers: await gotenbergAuthHeaders(),
    body:    formData,
  })

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    throw new Error(`Gotenberg HTML→PDF failed (${upstream.status}): ${errText.slice(0, 200)}`)
  }
  return Buffer.from(await upstream.arrayBuffer())
}

/**
 * Render HTML to PDF and store in S3. Returns the S3 key.
 *
 * Throws on Gotenberg failure — callers should treat rendering as
 * best-effort (fire-and-forget) for editor saves so the save itself
 * doesn't fail if the PDF render is slow or the Gotenberg container
 * is temporarily down.
 */
export async function renderHtmlToPdfAndStore({
  html,
  keyPrefix,
  filename = 'contract.pdf',
}: {
  html: string
  /** S3 key prefix (e.g. `${orgId}/contracts/${contractId}/rendered`) */
  keyPrefix: string
  filename?: string
}): Promise<RenderResult> {
  const pdfBuffer = await renderHtmlToPdf(html)
  const key = `${keyPrefix.replace(/\/+$/, '')}/${Date.now()}-${filename}`

  await s3.send(new PutObjectCommand({
    Bucket:      S3_BUCKET,
    Key:         key,
    Body:        pdfBuffer,
    ContentType: 'application/pdf',
  }))

  return { s3Key: key, size: pdfBuffer.length }
}
