/**
 * docs/39 I2 — the org's corrections, as examples for the next extraction.
 *
 * A person who corrects a value the AI read teaches something about how the
 * org reads that field ("State of Delaware" is kept as "Delaware"; a total
 * value is a yearly one; the notice to stop renewal isn't the notice to end
 * early). The store keeps what the AI read beside the correction
 * (correctedFrom); the fields corrected more than once — a pattern, not a
 * slip — go to the extraction as a few "read this, corrected to that"
 * examples, so it stops making the mistake. A5 does the same for the org's
 * custom fields with the values people set.
 *
 * Fields about the one contract (its counterparty, parties, signatories,
 * address) teach nothing about reading the next one and are left out. The
 * examples come from other contracts than the one being read, so the org's
 * personal-data policy is applied to them.
 */
import { Prisma } from '@prisma/client'
import { formatFieldValue, type FieldValueType } from '@clm/types'
import { prisma } from './prisma.js'
import { applyPiiPolicyBatch } from './pii-policy.js'

export interface CorrectionExample {
  /** What the AI read. */
  read: string
  /** What a person made it ("nothing" when they cleared it). */
  corrected: string
  /** The words the AI read it from. */
  quote?: string
}

export interface FieldCorrections {
  key: string
  label: string
  examples: CorrectionExample[]
}

export interface CorrectableField { key: string; label: string; type: FieldValueType; unit?: string }

/** A field corrected this often is a pattern worth teaching. */
export const MIN_CORRECTIONS = 2
const PER_FIELD = 3
const MAX_FIELDS = 8
const QUOTE_MAX = 200

/** Values about the one contract: nothing to learn for the next. */
const CONTRACT_SPECIFIC = new Set(['counterpartyName', 'counterpartyAddress', 'parties', 'signatories'])

const NOTHING = 'nothing — the contract doesn’t say'

function shown(f: CorrectableField, value: unknown): string {
  if (value === null || value === undefined || value === '') return NOTHING
  const text = formatFieldValue(f.type, value)
  return f.unit && typeof value === 'number' ? `${text} ${f.unit}` : text
}

export async function correctionExamples(
  orgId: string,
  fields: CorrectableField[],
  opts: { excludeContractId?: string } = {},
): Promise<FieldCorrections[]> {
  const byKey = new Map(fields.filter(f => !CONTRACT_SPECIFIC.has(f.key)).map(f => [f.key, f]))
  if (!byKey.size) return []
  const rows = await prisma.contractFieldValue.findMany({
    where: {
      orgId, fieldKey: { in: [...byKey.keys()] }, correctedFrom: { not: Prisma.DbNull },
      ...(opts.excludeContractId && { contractId: { not: opts.excludeContractId } }),
    },
    orderBy: { updatedAt: 'desc' },
    take: 400,
    select: { fieldKey: true, value: true, correctedFrom: true },
  })
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.fieldKey, (counts.get(r.fieldKey) ?? 0) + 1)
  const keys = [...counts.entries()]
    .filter(([, n]) => n >= MIN_CORRECTIONS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FIELDS)
    .map(([k]) => k)
  if (!keys.length) return []

  const picked: Array<{ key: string } & CorrectionExample> = []
  for (const r of rows) {
    if (!keys.includes(r.fieldKey)) continue
    const f = byKey.get(r.fieldKey)!
    const from = r.correctedFrom as { value?: unknown; quote?: string | null } | null
    if (!from || from.value === undefined) continue
    const ex = { key: r.fieldKey, read: shown(f, from.value), corrected: shown(f, r.value), quote: from.quote?.trim().slice(0, QUOTE_MAX) || undefined }
    const mine = picked.filter(p => p.key === r.fieldKey)
    // Different corrections teach more than the same one three times.
    if (ex.read === ex.corrected || mine.length >= PER_FIELD || mine.some(p => p.read === ex.read && p.corrected === ex.corrected)) continue
    picked.push(ex)
  }
  if (!picked.length) return []

  // Values and quotes from other contracts: the org's personal-data policy first.
  const texts = picked.flatMap(p => [p.read, p.corrected, p.quote ?? ''])
  const redacted = (await applyPiiPolicyBatch(orgId, texts, { surface: 'field_corrections' })).texts
  const out = new Map<string, FieldCorrections>()
  picked.forEach((p, i) => {
    const [read, corrected, quote] = [redacted[i * 3] ?? p.read, redacted[i * 3 + 1] ?? p.corrected, redacted[i * 3 + 2] ?? p.quote]
    const entry = out.get(p.key) ?? { key: p.key, label: byKey.get(p.key)!.label, examples: [] }
    entry.examples.push({ read, corrected, ...(quote ? { quote } : {}) })
    out.set(p.key, entry)
  })
  return keys.map(k => out.get(k)).filter((c): c is FieldCorrections => !!c)
}
