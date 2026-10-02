/**
 * docs/41 Part 16 — the AI suggestion log: what became of each suggestion
 * (shown, accepted, edited before use, dismissed), per feature. The web
 * writes outcomes it sees (POST /ai-suggestion-events); routes that apply a
 * suggestion on the server write theirs here. Logging never fails the action.
 */
import { prisma } from './prisma.js'

export const AI_FEATURES = ['ask_ai', 'counter', 'insert_standard', 'redline_to_position', 'fix_all', 'amendment_language', 'draft'] as const
export const AI_OUTCOMES = ['shown', 'accepted', 'edited', 'dismissed'] as const
export type AiFeature = (typeof AI_FEATURES)[number]
export type AiOutcome = (typeof AI_OUTCOMES)[number]

export interface AiSuggestionEventInput {
  orgId: string
  contractId: string
  userId: string
  feature: AiFeature
  outcome: AiOutcome
  versionId?: string | null
  suggestionId?: string | null
}

/** Write outcomes; a failure is logged and swallowed. */
export async function recordAiSuggestions(events: AiSuggestionEventInput[]): Promise<number> {
  if (!events.length) return 0
  try {
    const r = await prisma.aiSuggestionEvent.createMany({
      data: events.map(e => ({
        orgId: e.orgId, contractId: e.contractId, userId: e.userId, feature: e.feature, outcome: e.outcome,
        versionId: e.versionId ?? null, suggestionId: e.suggestionId ?? null,
      })),
    })
    return r.count
  } catch (err) {
    console.warn('[ai-suggestion-events] not recorded', (err as Error).message)
    return 0
  }
}

/** One server-side outcome (fire and forget from a route). */
export function recordAiSuggestion(e: AiSuggestionEventInput): void {
  void recordAiSuggestions([e])
}
