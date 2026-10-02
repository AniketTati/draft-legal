/**
 * docs/39 B3/I2 — how often the AI is right about each field on the org's
 * contracts, and when each field's values need a person.
 *
 * Every time a person checks one of the AI's values they keep it or correct
 * it (field-store records what the AI read, `correctedFrom`). Per field that
 * is a record: kept 18, corrected 6 — right 75% of the time. A field wrong
 * often enough needs attention (a clearer description, examples, or always
 * checking it); its record also holds down how sure its next values are
 * (field-confidence). Settings › Fields shows the records and sets each
 * field's check level.
 */
import { AuditAction, CHECK_LEVELS, type CatalogField, type CheckLevel } from '@clm/types'
import { prisma } from './prisma.js'
import { fieldCatalog } from './field-query.js'
import { clearFieldCheckLevels, fieldAccuracy, fieldCheckLevels, MIN_CHECKS } from './field-confidence.js'
import { createAuditEvent } from './audit.js'

/** Right less often than this, with enough checks: the field needs attention. */
export const ATTENTION_BELOW = 0.8

export interface FieldRecord {
  key: string
  label: string
  kind: CatalogField['kind']
  type: CatalogField['type']
  contractTypes: string[] | null
  /** AI values a person kept, and corrected or rejected. */
  confirmed: number
  corrected: number
  /** Right this often, from MIN_CHECKS checks on (else null). */
  accuracy: number | null
  /** The AI's values nobody has checked yet. */
  unchecked: number
  check: CheckLevel
  attention: boolean
}

/** Every field's record, the ones needing attention first. */
export async function fieldRecords(orgId: string): Promise<FieldRecord[]> {
  const [catalog, accuracy, levels, pending] = await Promise.all([
    fieldCatalog(orgId),
    fieldAccuracy(orgId),
    fieldCheckLevels(orgId),
    prisma.$queryRaw<Array<{ fieldKey: string; n: number }>>`
      SELECT "fieldKey", COUNT(*)::int AS n FROM contract_field_values
       WHERE "orgId" = ${orgId} AND source IN ('ai', 'calculated') AND "verifiedAt" IS NULL AND "rejectedAt" IS NULL
         AND value IS NOT NULL AND value NOT IN ('null'::jsonb, '[]'::jsonb, '""'::jsonb, '{}'::jsonb)
       GROUP BY "fieldKey"`,
  ])
  const unchecked = new Map(pending.map(p => [p.fieldKey, p.n]))
  const records = catalog.map(f => {
    const a = accuracy.get(f.key) ?? { confirmed: 0, corrected: 0 }
    const checked = a.confirmed + a.corrected
    const rate = checked >= MIN_CHECKS ? Math.round((a.confirmed / checked) * 100) / 100 : null
    return {
      key: f.key, label: f.label, kind: f.kind, type: f.type, contractTypes: f.contractTypes,
      confirmed: a.confirmed, corrected: a.corrected, accuracy: rate,
      unchecked: unchecked.get(f.key) ?? 0,
      check: levels[f.key] ?? 'unsure',
      attention: rate != null && rate < ATTENTION_BELOW,
    }
  })
  return records.sort((x, y) =>
    Number(y.attention) - Number(x.attention)
    || (x.accuracy ?? 2) - (y.accuracy ?? 2)
    || y.corrected - x.corrected
    || (y.confirmed + y.corrected) - (x.confirmed + x.corrected)
    || x.label.localeCompare(y.label))
}

/** Set when a field's AI values need a person; 'unsure' is the default and is stored as nothing. */
export async function setFieldCheck(input: { orgId: string; userId: string; key: string; level: CheckLevel; ipAddress?: string }): Promise<
  { ok: true; level: CheckLevel } | { ok: false; status: 400 | 404; detail: string }
> {
  if (!(CHECK_LEVELS as readonly string[]).includes(input.level)) return { ok: false, status: 400, detail: `level must be one of ${CHECK_LEVELS.join(', ')}` }
  const catalog = await fieldCatalog(input.orgId)
  if (!catalog.some(f => f.key === input.key)) return { ok: false, status: 404, detail: `No field named “${input.key}”` }
  const before = (await fieldCheckLevels(input.orgId))[input.key] ?? 'unsure'
  if (input.level === 'unsure') {
    await prisma.$executeRaw`
      UPDATE organizations
         SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{fieldChecks}',
                                  COALESCE(settings->'fieldChecks', '{}'::jsonb) - ${input.key}::text),
             "updatedAt" = NOW()
       WHERE id = ${input.orgId}`
  } else {
    await prisma.$executeRaw`
      UPDATE organizations
         SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{fieldChecks}',
                                  COALESCE(settings->'fieldChecks', '{}'::jsonb) || jsonb_build_object(${input.key}::text, ${input.level}::text)),
             "updatedAt" = NOW()
       WHERE id = ${input.orgId}`
  }
  clearFieldCheckLevels(input.orgId)
  if (before !== input.level) {
    await createAuditEvent({
      orgId: input.orgId, userId: input.userId, action: AuditAction.AI_SETTINGS_UPDATED,
      resourceType: 'organization', resourceId: input.orgId,
      metadata: { changed: { [`fieldChecks.${input.key}`]: { from: before, to: input.level } } },
      ipAddress: input.ipAddress,
    }).catch(() => {})
  }
  return { ok: true, level: input.level }
}
