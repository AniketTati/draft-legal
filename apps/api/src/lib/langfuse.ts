/**
 * Minimal Langfuse client — score writing only.
 *
 * The API makes no LLM calls of its own; the agents service owns tracing
 * (apps/agents/app/tracing.py). This exists for one thing the agents service
 * cannot do: record what the USER thought of an answer. That signal only exists
 * in the browser, arrives long after the turn finished, and is the highest-value
 * quality data there is — a real person saying "this was wrong" beats any
 * rubric, and costs nothing per judgement.
 *
 * Deliberately not the @langfuse/node SDK: this posts one small JSON body to
 * one endpoint, and a tracing SDK in the API would invite someone to start
 * emitting a second, competing set of traces alongside the agents service's.
 *
 * Fails open and silently by design. Feedback is a nice-to-have; a Langfuse
 * outage must never turn a thumbs-up into a 500 in the user's face.
 */

const HOST = () => process.env.LANGFUSE_HOST ?? ''
const PUBLIC_KEY = () => process.env.LANGFUSE_PUBLIC_KEY ?? ''
const SECRET_KEY = () => process.env.LANGFUSE_SECRET_KEY ?? ''

/** All three or nothing — same fail-closed rule as the Python side. */
export function langfuseConfigured(): boolean {
  return Boolean(HOST() && PUBLIC_KEY() && SECRET_KEY())
}

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${PUBLIC_KEY()}:${SECRET_KEY()}`).toString('base64')
}

export interface ScoreInput {
  name: string
  value: number | string
  /** Exactly ONE anchor. traceId is preferred; sessionId works when the caller only knows the thread. */
  traceId?: string
  sessionId?: string
  observationId?: string
  comment?: string
  dataType?: 'NUMERIC' | 'BOOLEAN' | 'CATEGORICAL'
  metadata?: Record<string, unknown>
}

/**
 * Post one score. Returns true if Langfuse accepted it.
 *
 * The API takes exactly one anchor — traceId (optionally with observationId),
 * sessionId, or datasetRunId. Sending two is a 400, which is easy to do by
 * accident because "attach this to the trace and the session" is what you mean.
 */
export async function postScore(input: ScoreInput): Promise<boolean> {
  if (!langfuseConfigured()) return false

  const dataType = input.dataType ?? (typeof input.value === 'string' ? 'CATEGORICAL' : 'NUMERIC')
  const anchor = input.traceId
    ? { traceId: input.traceId, ...(input.observationId ? { observationId: input.observationId } : {}) }
    : input.sessionId
      ? { sessionId: input.sessionId }
      : null
  if (!anchor) return false

  try {
    const res = await fetch(`${HOST().replace(/\/$/, '')}/api/public/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
      body: JSON.stringify({
        ...anchor,
        name: input.name,
        value: dataType === 'CATEGORICAL' ? String(input.value) : Number(input.value),
        comment: input.comment,
        dataType,
        metadata: input.metadata,
      }),
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Whose trace a user's feedback may score: their own chat turns only. */
export interface TraceOwner { orgId: string; userId: string }

interface TraceRow { id: string; timestamp: string; userId?: string | null; metadata?: unknown }

/**
 * X22 — the agents service sets a chat turn's trace `userId` to the user and
 * puts the org in its metadata (apps/agents/app/tracing.py). A trace or
 * session id sent by the client named any trace, another org's included, and
 * whether it was found told the caller that the session existed. User ids are
 * unique across orgs, so the user decides; an org in the metadata must agree.
 */
function ownedBy(trace: Pick<TraceRow, 'userId' | 'metadata'>, owner: TraceOwner): boolean {
  if (typeof trace.userId !== 'string' || trace.userId !== owner.userId) return false
  const org = (trace.metadata as { org_id?: unknown } | null | undefined)?.org_id
  return org === undefined || org === owner.orgId
}

/**
 * Find the trace a user's feedback is about, among their own turns in a chat
 * session: `traceId` if it is one of them, else the newest.
 *
 * apps/agents sets Langfuse's `session_id` from the chat thread id, so the
 * browser only has to send the session it already knows — it never sees a
 * Langfuse trace id. X22 — only `owner`'s traces: the session id comes from
 * the client, and another user's thread id is as easy to send as one's own.
 * A named trace is resolved through the same owner-filtered list, so another
 * user's trace and a missing one look alike, in the answer and in its timing.
 */
export async function findTraceBySession(sessionId: string, owner: TraceOwner, traceId?: string): Promise<string | null> {
  if (!langfuseConfigured()) return null
  try {
    // core = ids, timestamps, userId; io = metadata. Not observations/scores.
    const q = new URLSearchParams({ sessionId, userId: owner.userId, limit: '50', fields: 'core,io' })
    const res = await fetch(`${HOST().replace(/\/$/, '')}/api/public/traces?${q}`, {
      headers: { Authorization: authHeader() },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: TraceRow[] }
    const rows = (body.data ?? []).filter(r => ownedBy(r, owner))
    if (traceId) return rows.find(r => r.id === traceId)?.id ?? null
    if (!rows.length) return null
    rows.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    return rows[0].id   // most recent turn in the thread
  } catch {
    return null
  }
}
