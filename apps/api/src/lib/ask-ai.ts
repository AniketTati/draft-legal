/**
 * docs/41 Part 16, step 6 — "Ask AI" on selected words: the reader's own
 * instruction, then three drafts to choose from, each with a one-line reason.
 *
 * It reuses the rewriter that drafts clause alternatives (agents
 * /redline_propose: three variants with a rationale each), with the selected
 * words as the text and the instruction as the user's direction. The words go
 * out under the org's PII policy and come back with their values.
 */
import { randomUUID } from 'node:crypto'
import { redactJson, restorePii } from './pii-policy.js'
import { prisma } from './prisma.js'
import { modelFetch } from './model-boundary.js'

const AGENTS_URL = process.env.AGENTS_URL ?? 'http://localhost:8002'

export interface AskAiDraft { id: string; text: string; rationale: string }
export interface AskAiResult { suggestionId: string; drafts: AskAiDraft[] }

const MAX_SELECTION = 6000
const MAX_INSTRUCTION = 1000

export type AskAiOutcome =
  | { ok: true; data: AskAiResult }
  | { ok: false; status: number; detail: string }

export async function askAiDrafts(a: { orgId: string; contractId: string; selectedText: string; instruction: string }): Promise<AskAiOutcome> {
  const selected = a.selectedText.trim()
  const instruction = a.instruction.trim()
  if (!selected) return { ok: false, status: 400, detail: 'Select the words to rewrite.' }
  if (selected.length > MAX_SELECTION) return { ok: false, status: 400, detail: `Select at most ${MAX_SELECTION.toLocaleString('en')} characters.` }
  if (!instruction) return { ok: false, status: 400, detail: 'Say what to do with the words.' }
  if (instruction.length > MAX_INSTRUCTION) return { ok: false, status: 400, detail: 'Keep the instruction under 1,000 characters.' }

  const contract = await prisma.contract.findFirst({
    where: { id: a.contractId, orgId: a.orgId, deletedAt: null },
    select: { id: true, type: true, currentVersionId: true },
  })
  if (!contract) return { ok: false, status: 404, detail: 'Contract not found' }

  // Values are judged against the whole document, as the clause rewriter does.
  const document = contract.currentVersionId
    ? (await prisma.contractVersion.findUnique({ where: { id: contract.currentVersionId }, select: { plainText: true } }))?.plainText ?? ''
    : ''
  const source = [selected, document]
  const { clauseText } = await redactJson(a.orgId, { clauseText: selected }, {
    surface: 'ask_ai', contractId: contract.id, roundTrip: contract.id, valuesFrom: source,
  })

  const res = await modelFetch(`${AGENTS_URL}/redline_propose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body: JSON.stringify({ clauseText, contractType: contract.type, instructions: instruction, orgId: a.orgId }),
  }, { orgId: a.orgId, surface: 'ask_ai', contractId: contract.id, userAuthored: ['instructions'] })
  if (!res.ok) return { ok: false, status: 502, detail: 'No drafts could be made. Try again.' }

  const body = restorePii(await res.json() as { variants?: Array<{ proposedText?: string; rationale?: string }> }, source, contract.id)
  const seen = new Set<string>()
  const drafts: AskAiDraft[] = []
  for (const v of body.variants ?? []) {
    const text = String(v.proposedText ?? '').trim()
    // A variant the model left as the original, or a repeat, is no choice.
    if (!text || text === selected || seen.has(text)) continue
    seen.add(text)
    drafts.push({ id: randomUUID(), text, rationale: String(v.rationale ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) })
  }
  if (!drafts.length) return { ok: false, status: 502, detail: 'No drafts could be made for these words. Try a different instruction.' }
  return { ok: true, data: { suggestionId: randomUUID(), drafts: drafts.slice(0, 3) } }
}
