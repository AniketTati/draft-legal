/**
 * QA harness — 2026-08-18 full-app pass.
 * Thin wrappers over the live stack. No mocks: we hit localhost:3001 (API),
 * localhost:8002 (agents) and the real Postgres/ES/Redis behind them.
 */
import { execFileSync } from 'node:child_process'

export const API_BASE = process.env.API_BASE ?? 'http://localhost:3001'
export const WEB_BASE = process.env.WEB_BASE ?? 'http://localhost:5173'
export const AGENTS_BASE = process.env.AGENTS_BASE ?? 'http://localhost:8002'
export const INTERNAL_SERVICE_SECRET =
  process.env.INTERNAL_SERVICE_SECRET ?? 'clm-internal-dev-secret-2026'

const TIMEOUT_MS = Number(process.env.QA_TIMEOUT_MS ?? 30000)

/** Log in and return { accessToken, refreshToken, user }. Throws on failure. */
export async function login(email, password = 'password123') {
  const r = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`login ${email} -> ${r.status}: ${(await r.text()).slice(0, 300)}`)
  return r.json()
}

/**
 * Raw call that never throws on HTTP status — returns
 * { status, ok, body, text, ms } so probes can assert on the shape.
 */
export async function call(method, path, { token, body, headers = {}, raw = false } = {}) {
  const t0 = Date.now()
  const h = { ...headers }
  if (token) h.Authorization = `Bearer ${token}`
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json'
  let status = 0
  let text = ''
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    status = r.status
    text = await r.text()
    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = undefined }
    return { status, ok: r.ok, body: parsed, text, ms: Date.now() - t0 }
  } catch (err) {
    return { status, ok: false, body: undefined, text: `FETCH_ERROR: ${err.message}`, ms: Date.now() - t0, error: err }
  }
}

export const apiGet = (path, token, opts) => call('GET', path, { token, ...opts })
export const apiPost = (path, token, body, opts) => call('POST', path, { token, body, ...opts })
export const apiPatch = (path, token, body, opts) => call('PATCH', path, { token, body, ...opts })
export const apiDelete = (path, token, opts) => call('DELETE', path, { token, ...opts })

/** Run a SQL query against the dev DB via docker exec. Returns rows as arrays of strings. */
export function sql(query) {
  const out = execFileSync(
    'docker',
    ['exec', 'clm_postgres', 'psql', '-U', 'clm', '-d', 'clm_dev', '-t', '-A', '-F', '', '-c', query],
    { encoding: 'utf8', timeout: 20000 },
  )
  return out.trim().split('\n').filter(Boolean).map((line) => line.split(''))
}

/** Single scalar from SQL. */
export function sqlOne(query) {
  const rows = sql(query)
  return rows.length ? rows[0][0] : null
}

/**
 * Stream an agent chat turn through the API SSE endpoint.
 * Returns { events, assistantText, status, raw }.
 */
export async function streamAgentChat(token, { message, sessionId, agentMode = true, contractId, skillSlug, timeoutMs = 120000 }) {
  const payload = { message, sessionId, agentMode }
  if (contractId) payload.contractId = contractId
  if (skillSlug) payload.skillSlug = skillSlug

  const r = await fetch(`${API_BASE}/api/v1/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const raw = await r.text()
  const events = []
  let assistantText = ''
  for (const block of raw.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const ev = JSON.parse(data)
        events.push(ev)
        // The agents service streams prose as {type:'token', delta:'…'}.
        // Older/alternate frames use content/text; accept all three.
        if (ev.type === 'token' || ev.type === 'text' || ev.type === 'delta') {
          if (typeof ev.delta === 'string') assistantText += ev.delta
          else if (typeof ev.content === 'string') assistantText += ev.content
          else if (typeof ev.text === 'string') assistantText += ev.text
        }
      } catch { /* non-JSON frame */ }
    }
  }
  return { events, assistantText, status: r.status, raw }
}

/** Normalised probe result. */
export function result({ id, status, severity = 'medium', evidence = '', area = '' }) {
  return { id, status, severity, evidence, area }
}

/** ANSI-free console line for a result. */
export function fmt(r) {
  const mark = r.status === 'pass' ? 'PASS' : r.status === 'warn' ? 'WARN' : r.status === 'skip' ? 'SKIP' : 'FAIL'
  return `[${mark}] ${r.id}${r.severity && r.status === 'fail' ? ` (${r.severity})` : ''} — ${r.evidence}`
}
