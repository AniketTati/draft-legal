/**
 * docs/39 B3 — how sure to be of a value the AI read, and when a person must
 * check it.
 *
 * The confidence shown was the model's own number, and a model is as sure of
 * a value it made up as of one it copied. It is now that number held down by
 * what can be checked:
 *
 *   - the AI quoted no passage for it (0.65 at most; a "no" needs none);
 *   - it flagged the value itself — an ambiguous date, a reading the field
 *     can't hold (0.6);
 *   - the words it came from aren't in the version the contract stands on
 *     (0.5; the Review Queue lists these as "words changed");
 *   - people have corrected this field on the org's contracts: from five
 *     checks on, it is as sure as the field has been right.
 *
 * Each field also says when its AI values need a person (@clm/types
 * field-checks): always, when unsure (below 70%, the default) or only when
 * very unsure (below 40%) — Settings › Fields › How often the AI is right.
 */
import { Prisma } from '@prisma/client'
import { CHECK_LEVELS, DEFAULT_CHECK_BELOW, RARELY_CHECK_BELOW, type CheckLevel } from '@clm/types'
import { prisma } from './prisma.js'

/**
 * A value with no quote: the AI can't show where it read it. Under the
 * default threshold, so it asks for a person. Not for a "no": a clause that
 * isn't there has no passage to quote.
 */
export const NO_QUOTE_CAP = 0.65
/** A value the AI flagged (an issue). */
export const ISSUE_CAP = 0.6
/** A value whose words are gone from the current version. */
export const GONE_CAP = 0.5
/** The model's number when it gave none. */
export const DEFAULT_MODEL_CONFIDENCE = 0.8
/** Checks of a field before its record counts. */
export const MIN_CHECKS = 5
/** A field right this often (or more) is held down by nothing. */
const RELIABLE = 0.95

export interface FieldAccuracy {
  /** AI values a person checked and kept. */
  confirmed: number
  /** AI values a person corrected or rejected. */
  corrected: number
}

/** How sure the field's record lets a value be, or null (too few checks, or right nearly always). */
export function accuracyCap(a: FieldAccuracy | undefined): number | null {
  if (!a) return null
  const checked = a.confirmed + a.corrected
  if (checked < MIN_CHECKS) return null
  const rate = a.confirmed / checked
  return rate < RELIABLE ? Math.round(rate * 100) / 100 : null
}

export interface ConfidenceInput {
  source: string | null
  verifiedAt: Date | string | null
  /** The model's own number. */
  model: number | null
  quote: string | null
  issue: string | null
  /** The quote's words aren't in the version the contract stands on. */
  gone: boolean
  hasValue: boolean
  /** The value itself: a `false` (a clause that isn't there) needs no quote. */
  value?: unknown
}

const pct = (n: number) => `${Math.round(n * 100)}%`

/**
 * The confidence to show and to decide by, and why it's lower than the
 * model said. A person's value, or one they checked, is what they said it is;
 * so is "not found" (a person checks those by the queue's own reason).
 */
export function computedConfidence(i: ConfidenceInput, accuracy?: FieldAccuracy): { confidence: number | null; reasons: string[] } {
  if ((i.source !== 'ai' && i.source !== 'calculated') || i.verifiedAt || !i.hasValue) {
    return { confidence: i.model, reasons: [] }
  }
  let c = i.model ?? DEFAULT_MODEL_CONFIDENCE
  const reasons: string[] = []
  if (i.model != null && i.model < DEFAULT_CHECK_BELOW) reasons.push(`The AI was ${pct(i.model)} sure`)
  if (!i.quote?.trim() && i.value !== false) { c = Math.min(c, NO_QUOTE_CAP); reasons.push('It quotes no passage of the contract') }
  if (i.issue) { c = Math.min(c, ISSUE_CAP); reasons.push(i.issue) }
  if (i.gone) { c = Math.min(c, GONE_CAP); reasons.push('The words it came from aren’t in the current version') }
  const cap = accuracyCap(accuracy)
  if (cap != null && accuracy) {
    c = Math.min(c, cap)
    reasons.push(`People corrected this field on ${accuracy.corrected} of the ${accuracy.confirmed + accuracy.corrected} contracts they checked`)
  }
  return { confidence: Math.round(c * 100) / 100, reasons }
}

// ─── Per org ──────────────────────────────────────────────────────────────────

const TTL_MS = 60_000
const accuracyCache = new Map<string, { at: number; map: Map<string, FieldAccuracy> }>()
const levelCache = new Map<string, { at: number; levels: Record<string, CheckLevel> }>()

/** Each field's record on the org's contracts: the AI's values people kept, and those they corrected. */
export async function fieldAccuracy(orgId: string): Promise<Map<string, FieldAccuracy>> {
  const hit = accuracyCache.get(orgId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.map
  const rows = await prisma.$queryRaw<Array<{ fieldKey: string; confirmed: number; corrected: number }>>`
    SELECT "fieldKey",
           COUNT(*) FILTER (WHERE source IN ('ai', 'calculated') AND "verifiedAt" IS NOT NULL AND "rejectedAt" IS NULL
                              AND value IS NOT NULL AND value <> 'null'::jsonb)::int AS confirmed,
           COUNT(*) FILTER (WHERE "correctedFrom" IS NOT NULL)::int AS corrected
      FROM contract_field_values
     WHERE "orgId" = ${orgId}
     GROUP BY "fieldKey"`
  const map = new Map(rows.filter(r => r.confirmed + r.corrected > 0).map(r => [r.fieldKey, { confirmed: r.confirmed, corrected: r.corrected }]))
  accuracyCache.set(orgId, { at: Date.now(), map })
  return map
}

/** A person's check or correction changes a field's record: read it afresh next time. */
export function clearFieldAccuracy(orgId: string): void {
  accuracyCache.delete(orgId)
}

/** When each field's AI values need a person (org settings `fieldChecks`; absent: when unsure). */
export async function fieldCheckLevels(orgId: string): Promise<Record<string, CheckLevel>> {
  const hit = levelCache.get(orgId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.levels
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } })
  const raw = (org?.settings as Record<string, unknown> | null)?.fieldChecks
  const levels: Record<string, CheckLevel> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) if ((CHECK_LEVELS as readonly string[]).includes(v as string)) levels[k] = v as CheckLevel
  }
  levelCache.set(orgId, { at: Date.now(), levels })
  return levels
}

export function clearFieldCheckLevels(orgId: string): void {
  levelCache.delete(orgId)
}

/**
 * The org's per-field rules as a table `r` SQL can join on `r.key`: `cap`
 * (the record's cap, or NULL) and `level`. The Review Queue decides by them,
 * as the Fields panel does.
 */
export function fieldRulesSql(accuracy: Map<string, FieldAccuracy>, levels: Record<string, CheckLevel>): Prisma.Sql {
  const keys = new Set([...accuracy.keys(), ...Object.keys(levels)])
  const rows = [...keys]
    .map(k => ({ k, cap: accuracyCap(accuracy.get(k)), level: levels[k] ?? 'unsure' }))
    .filter(r => r.cap != null || r.level !== 'unsure')
  if (!rows.length) return Prisma.sql`(SELECT NULL::text AS key, NULL::float8 AS cap, NULL::text AS level WHERE FALSE) AS r`
  return Prisma.sql`(VALUES ${Prisma.join(rows.map(r => Prisma.sql`(${r.k}::text, ${r.cap}::float8, ${r.level}::text)`))}) AS r(key, cap, level)`
}

/** The computed confidence in SQL, for a row `v` joined to its rule `r` (see computedConfidence). */
export function computedConfidenceSql(v = 'v', r = 'r'): Prisma.Sql {
  const col = (name: string) => Prisma.raw(`${v}."${name}"`)
  return Prisma.sql`LEAST(
    COALESCE(${col('confidence')}, ${DEFAULT_MODEL_CONFIDENCE}),
    CASE WHEN COALESCE(btrim(${col('quote')}), '') = '' AND ${col('value')} <> 'false'::jsonb THEN ${NO_QUOTE_CAP} ELSE 1 END,
    CASE WHEN ${col('issue')} IS NOT NULL THEN ${ISSUE_CAP} ELSE 1 END,
    COALESCE(${Prisma.raw(`${r}.cap`)}, 1))`
}

/** The threshold for a row, from its field's level and the base the page asked for. */
export function checkBelowSql(base: number, r = 'r'): Prisma.Sql {
  return Prisma.sql`(CASE ${Prisma.raw(`${r}.level`)} WHEN 'rarely' THEN ${Math.min(RARELY_CHECK_BELOW, base)} ELSE ${base} END)`
}
