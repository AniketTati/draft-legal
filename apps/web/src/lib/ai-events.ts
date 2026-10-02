/**
 * docs/41 Part 16 — what became of each AI suggestion (shown, accepted,
 * edited, dismissed), sent in batches to POST /ai-suggestion-events. A lost
 * batch costs a statistic, never the person's work, so failures are dropped.
 */
import { api } from '@/lib/api'

export type AiFeature = 'ask_ai' | 'counter' | 'insert_standard' | 'redline_to_position' | 'fix_all' | 'amendment_language' | 'draft'
export type AiOutcome = 'shown' | 'accepted' | 'edited' | 'dismissed'

export interface AiEvent {
  contractId: string
  versionId?: string | null
  feature: AiFeature
  outcome: AiOutcome
  suggestionId?: string | null
}

const queue: AiEvent[] = []
let timer: ReturnType<typeof setTimeout> | null = null
const WAIT_MS = 2000
const MAX_BATCH = 100

export function flushAiEvents(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null }
  const batch = queue.splice(0, MAX_BATCH)
  if (!batch.length) return Promise.resolve()
  const sent = api.post('/ai-suggestion-events', { events: batch }).then(() => {}, () => {})
  return queue.length ? sent.then(flushAiEvents) : sent
}

/** Log one outcome; sent with the others a moment later. */
export function logAiEvent(e: AiEvent): void {
  if (!e.contractId) return
  queue.push(e)
  if (queue.length >= MAX_BATCH) { void flushAiEvents(); return }
  if (!timer) timer = setTimeout(() => { void flushAiEvents() }, WAIT_MS)
}

/** Pending outcomes (tests). */
export const pendingAiEvents = (): readonly AiEvent[] => queue

if (typeof window !== 'undefined') {
  // Leaving the page: send what is waiting.
  window.addEventListener('pagehide', () => { void flushAiEvents() })
}

const seen = new Set<string>()
/** Log an outcome once per key (a staged batch shown on every render). */
export function logAiEventOnce(key: string, e: AiEvent): void {
  if (seen.has(key)) return
  seen.add(key)
  logAiEvent(e)
}
