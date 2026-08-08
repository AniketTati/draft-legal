/**
 * lib.mjs — shared helpers for persona-test conversations.
 *
 * Two primary functions:
 *
 *   login(email, password) → { accessToken, user }
 *   askAgent({ token, sessionId, message, agentMode, contractId }) →
 *     { tools, assistantText, latencyMs, allEvents }
 *
 * The askAgent helper does the SSE wrangling: stream raw NDJSON,
 * collect tool_call_start / tool_call_result / token / done events,
 * and return a structured object the runner can score.
 */

const API = process.env.PERSONA_API ?? 'http://localhost:3001'

export async function login(email, password) {
  const res = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Login failed for ${email}: ${res.status} ${body.slice(0, 120)}`)
  }
  return res.json()
}

/**
 * Stream the agent SSE response and collect structured events.
 *
 * Returns { tools[], assistantText, latencyMs, allEvents[], error? }
 *   - tools:        [{ name, args, result, ok }]   in call order
 *   - assistantText: concatenated tokens
 *   - latencyMs:    full request duration
 *   - allEvents:    raw SSE events (for debugging)
 *   - error:        defined when the stream ended with an error event
 */
export async function askAgent({
  token,
  sessionId,
  message,
  agentMode = true,
  contractId = null,
  pageContext = null,
  timeoutMs = 90_000,
  // docs/37 E3 — these were passed by lib-multi.mjs and silently discarded:
  // they were never destructured here and never reached the request body. So
  // 66 committed conversations ran on org defaults while persona-test-report.md
  // attributed their cost and latency to gpt-4.1-mini. Whether a pin is
  // HONOURED still depends on which keys the environment has; the done frame
  // now reports what actually answered (E2), so check there rather than
  // assuming.
  provider = null,
  modelId = null,
}) {
  const start = Date.now()
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)

  const res = await fetch(`${API}/api/v1/agent/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      sessionId,
      agentMode,
      ...(contractId ? { contractId } : {}),
      ...(pageContext ? { pageContext } : {}),
      ...(provider ? { provider } : {}),
      ...(modelId ? { modelId } : {}),
    }),
    signal: controller.signal,
  }).catch(err => {
    clearTimeout(t)
    return { ok: false, status: 0, _err: err.message }
  })

  if (!res || !res.ok) {
    clearTimeout(t)
    return {
      tools: [], assistantText: '', latencyMs: Date.now() - start,
      allEvents: [], error: res?._err ?? `HTTP ${res?.status ?? '?'}`,
    }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events = []
  const tools = []
  let assistantText = ''
  let error
  const toolsByCallId = new Map()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') continue
        let evt
        try { evt = JSON.parse(payload) } catch { continue }
        events.push(evt)
        if (evt.type === 'token' && typeof evt.delta === 'string') {
          assistantText += evt.delta
        } else if (evt.type === 'tool_call_start') {
          const t = { id: evt.id, name: evt.name, args: evt.args, result: null, ok: null }
          tools.push(t)
          toolsByCallId.set(evt.id, t)
        } else if (evt.type === 'tool_call_result') {
          const t = toolsByCallId.get(evt.id)
          if (t) {
            // Result is JSON-stringified — try to parse
            try { t.result = JSON.parse(evt.result) } catch { t.result = evt.result }
            t.ok = evt.error == null
          } else {
            // Defensive: result without start (shouldn't happen but log)
            tools.push({ id: evt.id, name: evt.name, args: null, result: evt.result, ok: evt.error == null })
          }
        } else if (evt.type === 'error') {
          error = evt.message ?? 'agent error'
        }
      }
    }
  } catch (e) {
    error = error ?? `stream read failed: ${e.message}`
  } finally {
    clearTimeout(t)
  }

  return {
    tools,
    assistantText: assistantText.trim(),
    latencyMs: Date.now() - start,
    allEvents: events,
    error,
  }
}

/**
 * Score a single turn's response against an expectation rubric.
 *
 * Rubric:
 *   - expectedTools: any of these tool names was called (OR semantics)
 *   - mustMention: assistant text must contain ALL of these substrings (case-insensitive)
 *   - shouldNotMention: assistant text must NOT contain any of these
 *   - maxLatencyMs: stream ended within this duration
 *
 * Returns { ok, reasons } where reasons is an array of strings explaining
 * any failures (empty if ok).
 */
export function scoreTurn(turn, response) {
  const reasons = []
  if (response.error) reasons.push(`error: ${response.error}`)

  if (turn.expectedTools && turn.expectedTools.length > 0) {
    const calledNames = response.tools.map(t => t.name)
    const hit = turn.expectedTools.some(n => calledNames.includes(n))
    if (!hit) {
      reasons.push(`tool: expected one of [${turn.expectedTools.join(', ')}], got [${calledNames.join(', ') || 'none'}]`)
    }
  }

  const lowerText = response.assistantText.toLowerCase()
  // mustMention — AND semantics (every phrase must appear). Useful for
  // multi-entity comparisons ("Mayo" AND "Cleveland").
  if (turn.mustMention && turn.mustMention.length > 0) {
    for (const phrase of turn.mustMention) {
      if (!lowerText.includes(phrase.toLowerCase())) {
        reasons.push(`text missing: "${phrase}"`)
      }
    }
  }
  // mustMentionAny — OR semantics (any one suffices). For terms with synonyms
  // ("sub-processor" / "subprocessor" / "DPA") we accept any acceptable form.
  if (turn.mustMentionAny && turn.mustMentionAny.length > 0) {
    const hit = turn.mustMentionAny.some(p => lowerText.includes(p.toLowerCase()))
    if (!hit) {
      reasons.push(`text missing any of: ${turn.mustMentionAny.map(p => `"${p}"`).join(', ')}`)
    }
  }
  if (turn.shouldNotMention && turn.shouldNotMention.length > 0) {
    for (const phrase of turn.shouldNotMention) {
      if (lowerText.includes(phrase.toLowerCase())) {
        reasons.push(`text leaked: "${phrase}"`)
      }
    }
  }
  if (turn.maxLatencyMs && response.latencyMs > turn.maxLatencyMs) {
    reasons.push(`latency: ${response.latencyMs}ms > ${turn.maxLatencyMs}ms`)
  }

  return { ok: reasons.length === 0, reasons }
}
