/**
 * docs/39 D1 — a new field tried before it goes live, and what filling it in
 * would take.
 *
 * Filling a field in across every contract used to be one button, blind: no
 * way to see what it would find, whether its description was good enough,
 * or what it would cost. Now an admin tries it on a few contracts first
 * (nothing is saved), can reword what the AI should look for and try again,
 * sees how many contracts a fill would read and about what it would cost,
 * and can undo the fill for 30 days (lib/field-runs.ts).
 */
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { resolveLlm } from './aiRouter.js'
import { tokenCostUsd } from './model-pricing.js'
import { fieldExamples } from './field-examples.js'
import { formatFieldValue, type FieldValueType } from '@clm/types'

export interface ExtractedField { value: unknown; confidence?: number; quote?: string | null; issue?: string | null }

/** One contract's reading of the field, for the preview. */
export interface PreviewRow {
  contractId: string
  title: string
  value: unknown
  display: string | null
  quote: string | null
  confidence: number | null
  /** What the contract holds for the field now, if anything. */
  current: string | null
  /** A5 — why the reading is less sure (its quote isn't in the document). */
  issue?: string | null
  error?: string
}

type Def = { id: string; orgId: string; fieldKey: string; fieldLabel: string; fieldType: string; options: unknown; helpText: string | null; contractType: string | null }

export type ExtractCall = (args: { contractId: string; body: { plainText: string; fields: unknown[]; contractType: string | null; orgId: string } }) => Promise<Record<string, ExtractedField> | null>

const PREVIEW_CONCURRENCY = 3

/** The contracts a field applies to: the org's own, analysed, of its type. */
function targetSql(def: Def): Prisma.Sql {
  return Prisma.sql`c."orgId" = ${def.orgId} AND c."deletedAt" IS NULL AND c."diligenceRoomId" IS NULL
    AND c."analysisStatus" = 'DONE' ${def.contractType ? Prisma.sql`AND c.type = ${def.contractType}` : Prisma.empty}
    AND v."plainText" <> ''`
}

export async function previewField(def: Def, opts: { limit: number; helpText?: string }, extract: ExtractCall): Promise<PreviewRow[]> {
  const sample = await prisma.$queryRaw<Array<{ id: string; title: string; type: string; plainText: string }>>`
    SELECT c.id, c.title, c.type, v."plainText" FROM contracts c
    JOIN contract_versions v ON v.id = c."currentVersionId"
    WHERE ${targetSql(def)}
    ORDER BY c."updatedAt" DESC
    LIMIT ${opts.limit}`
  const rows = sample.length
    ? await prisma.contractFieldValue.findMany({ where: { contractId: { in: sample.map(s => s.id) }, fieldKey: def.fieldKey }, select: { contractId: true, value: true } })
    : []
  const currentOf = new Map(rows.map(r => [r.contractId, r.value]))
  // A5 — how people filled it in elsewhere, as the review run asks with them.
  const examples = (await fieldExamples(def.orgId, [def.fieldKey])).get(def.fieldKey)
  const field = {
    fieldKey: def.fieldKey, fieldLabel: def.fieldLabel, fieldType: def.fieldType,
    options: (def.options as string[]) ?? [], helpText: (opts.helpText ?? def.helpText) || undefined,
    ...(examples?.length && { examples }),
  }
  const type = def.fieldType as FieldValueType
  const out: PreviewRow[] = new Array(sample.length)
  let next = 0
  const worker = async () => {
    for (let i = next++; i < sample.length; i = next++) {
      const c = sample[i]
      const current = currentOf.get(c.id)
      const base = { contractId: c.id, title: c.title, current: current === null || current === undefined ? null : formatFieldValue(type, current) }
      try {
        const got = (await extract({ contractId: c.id, body: { plainText: c.plainText, fields: [field], contractType: c.type, orgId: def.orgId } }))?.[def.fieldKey]
        const value = got?.value ?? null
        out[i] = { ...base, value, display: value === null ? null : formatFieldValue(type, value), quote: got?.quote ?? null, confidence: got?.confidence ?? null, issue: got?.issue ?? null }
      } catch (err) {
        out[i] = { ...base, value: null, display: null, quote: null, confidence: null, error: (err as Error).message.slice(0, 200) }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PREVIEW_CONCURRENCY, sample.length) }, worker))
  return out
}

/** Prompt and answer overhead of one /extract-fields call, beyond the contract's own text. */
const PROMPT_TOKENS = 700
const ANSWER_TOKENS = 150

export interface FillEstimate {
  /** Contracts the field applies to that don't hold a value yet. */
  contracts: number
  inputTokens: number
  outputTokens: number
  usd: number
  model: string | null
  /** The org's own key pays (BYOK): not the platform's spend. */
  byok: boolean
  /**
   * docs/39 D5 — a re-check: the empty ones and those holding a value the AI
   * found (nobody set or checked it), read again with the field's wording now.
   */
  recheck: { contracts: number; aiValues: number; usd: number }
}

export async function estimateFill(def: Def): Promise<FillEstimate> {
  const has = Prisma.sql`f.value IS NOT NULL AND f.value <> 'null'::jsonb`
  const lockedByPerson = Prisma.sql`(f."verifiedAt" IS NOT NULL OR f.source NOT IN ('ai', 'calculated'))`
  const [row] = await prisma.$queryRaw<Array<{ n: number; chars: bigint; rn: number; rchars: bigint; ai: number }>>`
    SELECT
      COUNT(*) FILTER (WHERE f.id IS NULL OR NOT (${has}))::int AS n,
      COALESCE(SUM(LENGTH(v."plainText")) FILTER (WHERE f.id IS NULL OR NOT (${has})), 0)::bigint AS chars,
      COUNT(*) FILTER (WHERE f.id IS NULL OR NOT (${has}) OR NOT ${lockedByPerson})::int AS rn,
      COALESCE(SUM(LENGTH(v."plainText")) FILTER (WHERE f.id IS NULL OR NOT (${has}) OR NOT ${lockedByPerson}), 0)::bigint AS rchars,
      COUNT(*) FILTER (WHERE f.id IS NOT NULL AND ${has} AND NOT ${lockedByPerson})::int AS ai
    FROM contracts c
    JOIN contract_versions v ON v.id = c."currentVersionId"
    LEFT JOIN contract_field_values f ON f."contractId" = c.id AND f."fieldKey" = ${def.fieldKey}
    WHERE ${targetSql(def)}`
  const tokens = (n: number, chars: bigint | number) => ({ input: Math.ceil(Number(chars) / 4) + n * PROMPT_TOKENS, output: n * ANSWER_TOKENS })
  const contracts = row?.n ?? 0
  const fill = tokens(contracts, row?.chars ?? 0)
  const recheck = tokens(row?.rn ?? 0, row?.rchars ?? 0)
  let model: string | null = null
  let byok = false
  try {
    const llm = await resolveLlm(def.orgId, 'default')
    model = llm.model
    byok = llm.source === 'byok'
  } catch { /* no key configured: priced at the default, which errs high */ }
  const usd = (t: { input: number; output: number }) => tokenCostUsd(model ?? 'unknown', t.input, t.output)
  return {
    contracts, inputTokens: fill.input, outputTokens: fill.output, usd: usd(fill), model, byok,
    recheck: { contracts: row?.rn ?? 0, aiValues: row?.ai ?? 0, usd: usd(recheck) },
  }
}
