/**
 * docs/39 B3 — how much of each contract a person has checked, in SQL: the
 * contracts list shows it, filters and sorts by it, and exports it.
 *
 * A contract's values are the fields its Fields panel shows holding
 * something: every core field, its type's fields, and the org's live custom
 * fields for that type. A value is checked when a person set it, or checked
 * the AI's (field-checks isChecked). Verified: all of them; Partly: some;
 * Unverified: none (@clm/types verificationState).
 */
import { Prisma } from '@prisma/client'
import { TYPE_FIELDS, verificationState, type VerificationState } from '@clm/types'
import { prisma } from './prisma.js'

/** A value in a JSON column that holds something. */
const PRESENT = Prisma.sql`(v.value IS NOT NULL AND v.value NOT IN ('null'::jsonb, '[]'::jsonb, '""'::jsonb, '{}'::jsonb))`

/** (contract type, field key) for every type's own fields. */
const TYPE_PAIRS = Prisma.join(Object.entries(TYPE_FIELDS).flatMap(([type, defs]) => defs.map(d => Prisma.sql`(${type}::text, ${d.key}::text)`)))

/** Row `v` is one of contract `c`'s fields and holds a value. */
export const COUNTED = Prisma.sql`(
  (v.kind = 'core'
   OR (v.kind = 'type' AND (c.type, v."fieldKey") IN (VALUES ${TYPE_PAIRS}))
   OR (v.kind = 'custom' AND EXISTS (
         SELECT 1 FROM contract_field_definitions d
          WHERE d."orgId" = c."orgId" AND d."fieldKey" = v."fieldKey" AND d."deletedAt" IS NULL
            AND (d."contractType" IS NULL OR d."contractType" = c.type))))
  AND ${PRESENT} AND v."rejectedAt" IS NULL)`

/** Row `v` was set by a person, or checked by one. */
export const CHECKED = Prisma.sql`(v.source NOT IN ('ai', 'calculated') OR v."verifiedAt" IS NOT NULL)`

const rowsOf = (extra: Prisma.Sql) =>
  Prisma.sql`EXISTS (SELECT 1 FROM contract_field_values v WHERE v."contractId" = c.id AND ${COUNTED} AND ${extra})`

export type CheckedFilter = Exclude<VerificationState, 'empty'>

/** Contracts `c` in a verification state. */
export function verificationFilterSql(state: CheckedFilter): Prisma.Sql {
  switch (state) {
    case 'verified':   return Prisma.sql`(${rowsOf(Prisma.sql`TRUE`)} AND NOT ${rowsOf(Prisma.sql`NOT ${CHECKED}`)})`
    case 'unverified': return Prisma.sql`(${rowsOf(Prisma.sql`TRUE`)} AND NOT ${rowsOf(CHECKED)})`
    case 'partly':     return Prisma.sql`(${rowsOf(CHECKED)} AND ${rowsOf(Prisma.sql`NOT ${CHECKED}`)})`
  }
}

/** The share of contract `c`'s values a person checked (NULL: it holds none), to sort by. */
export const CHECKED_SHARE_SQL = Prisma.sql`(
  SELECT (COUNT(*) FILTER (WHERE ${CHECKED}))::float8 / NULLIF(COUNT(*), 0)
    FROM contract_field_values v WHERE v."contractId" = c.id AND ${COUNTED})`

export interface VerificationSummary {
  state: VerificationState
  checked: number
  filled: number
  /** Fields holding an AI value nobody checked. */
  unchecked: string[]
}

/** Each contract's summary, for the list and the export. */
export async function verificationSummaries(ids: string[]): Promise<Map<string, VerificationSummary>> {
  const out = new Map<string, VerificationSummary>(ids.map(id => [id, { state: 'empty', checked: 0, filled: 0, unchecked: [] }]))
  if (!ids.length) return out
  const rows = await prisma.$queryRaw<Array<{ id: string; filled: number; checked: number; unchecked: string[] | null }>>`
    SELECT c.id,
           COUNT(v.id)::int AS filled,
           (COUNT(v.id) FILTER (WHERE ${CHECKED}))::int AS checked,
           array_agg(v."fieldKey" ORDER BY v."fieldKey") FILTER (WHERE NOT ${CHECKED}) AS unchecked
      FROM contracts c
      JOIN contract_field_values v ON v."contractId" = c.id AND ${COUNTED}
     WHERE c.id IN (${Prisma.join(ids)})
     GROUP BY c.id`
  for (const r of rows) {
    out.set(r.id, { state: verificationState(r.checked, r.filled), checked: r.checked, filled: r.filled, unchecked: r.unchecked ?? [] })
  }
  return out
}
