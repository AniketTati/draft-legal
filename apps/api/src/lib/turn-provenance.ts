/**
 * Server-derived provenance for an agent turn.
 *
 * WHY THIS EXISTS. `AppendTurnSchema` used to accept `provider`, `model`,
 * `tier`, `inputTokens`, `outputTokens`, `costUsd` and `traceId` from the
 * BROWSER and persist all seven verbatim onto AgentMessage. So the record of
 * which model gave legal advice was whatever the client claimed, and any
 * authenticated user could post an arbitrary model name or cost onto a turn.
 *
 * It was not merely forgeable, it was already false: SideAgentRail sent the
 * literal `provider: 'openai', model: 'gpt-4.1-mini'` regardless of what
 * answered, and AgentHomePage sent nothing at all.
 *
 * The agents service already reports what actually answered on its `done` frame
 * (docs/37 E2: provider, model, tier, source). The chat proxy reads that frame
 * and stashes it here; the turn-append endpoint reads it back. The browser is
 * out of the loop in both directions.
 *
 * SHORT TTL ON PURPOSE. The value is consumed seconds later by the same client.
 * A long-lived key would let a stale resolution attach itself to a later turn,
 * which is a quieter version of the bug this replaces.
 */
import { redis } from './redis.js'

export interface TurnProvenance {
  provider: string
  model:    string
  tier:     string
  /** 'byok' | 'platform' — whose key paid. Worth persisting: it is the field
   *  that answers "did this org's own key answer their question?" */
  source?:  string
}

const TTL_SECONDS = 180

const key = (orgId: string, sessionId: string): string =>
  `agent:turn-prov:${orgId}:${sessionId}`

/**
 * Read the `done` frame out of the tail of an SSE stream.
 *
 * Takes bytes rather than a string because the chat proxy forwards raw bytes
 * and must not decode per-chunk — a multi-byte sequence straddling a chunk
 * boundary decodes to U+FFFD, which looked like a model-quality problem for
 * some time (see the comment in agents.ts). Decoding one bounded tail at the
 * end is safe: worst case the first line is truncated mid-character, and we
 * only read whole `data:` lines after it.
 */
export function readDoneProvenance(tail: Buffer): TurnProvenance | null {
  if (!tail?.length) return null
  const text = tail.toString('utf8')
  // Scan backwards: the done frame is the last one, and a tool result earlier
  // in the stream could contain the literal string "done".
  const lines = text.split('\n').filter(l => l.startsWith('data: '))
  for (let i = lines.length - 1; i >= 0; i--) {
    const payload = lines[i].slice('data: '.length).trim()
    if (payload === '[DONE]' || !payload.startsWith('{')) continue
    try {
      const frame = JSON.parse(payload) as Record<string, unknown>
      if (frame.type !== 'done') continue
      // `model` is the RESOLVED one. `model_id` is the requested one, which
      // routes/chat.py stamps onto every frame as a default — reading that key
      // first is exactly the bug the web client has.
      const provider = typeof frame.provider === 'string' ? frame.provider : null
      const model    = typeof frame.model === 'string' ? frame.model : null
      if (!provider || !model) return null
      return {
        provider,
        model,
        tier:   typeof frame.tier === 'string' ? frame.tier : 'default',
        source: typeof frame.source === 'string' ? frame.source : undefined,
      }
    } catch { /* a truncated frame in the tail — keep scanning back */ }
  }
  return null
}

export async function rememberTurnProvenance(
  orgId: string, sessionId: string | undefined, prov: TurnProvenance,
): Promise<void> {
  if (!sessionId) return
  await redis.set(key(orgId, sessionId), JSON.stringify(prov), 'EX', TTL_SECONDS)
}

/** Read and delete — a turn's provenance belongs to exactly one turn. */
export async function takeTurnProvenance(
  orgId: string, sessionId: string | undefined,
): Promise<TurnProvenance | null> {
  if (!sessionId) return null
  const k = key(orgId, sessionId)
  const raw = await redis.get(k)
  if (!raw) return null
  await redis.del(k).catch(() => { /* best effort */ })
  try { return JSON.parse(raw) as TurnProvenance } catch { return null }
}
