/**
 * /agent chat request + "which model answered" readout (C3).
 *
 * The page used to pin provider 'openai' / model 'gpt-4.1-mini' on every
 * turn, and an explicit pin outranks the org's AI config, so Admin → AI
 * Config never applied on /agent (and the org was billed for a model it had
 * not chosen). With no pin the server picks per tier from the org's ladder,
 * as it already does for the side rail.
 */

export interface AgentChatBodyInput {
  message: string
  sessionId?: string
  skillSlug?: string | null
  /** Only for an explicit, user-chosen pin. Omitted → the org's configuration decides. */
  pin?: { provider: string; modelId: string } | null
}

export function buildAgentChatBody(input: AgentChatBodyInput): Record<string, unknown> {
  return {
    message: input.message,
    sessionId: input.sessionId,
    agentMode: true,
    ...(input.pin ? { provider: input.pin.provider, modelId: input.pin.modelId } : {}),
    ...(input.skillSlug ? { skillSlug: input.skillSlug } : {}),
  }
}

export interface Provenance { provider?: string; model?: string; tier?: string }

/**
 * Fold one SSE frame into the running provenance. Every frame is stamped with
 * the REQUESTED provider/model_id; only the terminal `done` frame carries the
 * resolved provider/model/tier — what actually answered — so it always wins.
 */
export function readProvenance(prev: Provenance | undefined, evt: Record<string, unknown>): Provenance | undefined {
  const str = (v: unknown) => (v == null || v === '' ? undefined : String(v))
  if (evt.type === 'done') {
    return {
      provider: str(evt.provider) ?? prev?.provider,
      model:    str(evt.model) ?? str(evt.model_id) ?? prev?.model,
      tier:     str(evt.tier) ?? prev?.tier,
    }
  }
  if (evt.model || evt.model_id || evt.tier) {
    return {
      ...prev,
      model: str(evt.model) ?? str(evt.model_id) ?? prev?.model,
      tier:  str(evt.tier) ?? prev?.tier,
    }
  }
  return prev
}
