/**
 * docs/39 A5 — how people filled a field in on other contracts, as examples
 * for the AI reading it on the next one (Ironclad asks 5–10 for a custom AI
 * property). Only values a person set or checked, each with the words it came
 * from; those words are from other contracts than the one being read, so the
 * org's personal-data policy is applied to them here.
 */
import { formatFieldValue, type FieldValueType } from '@clm/types'
import { prisma } from './prisma.js'
import { applyPiiPolicyBatch } from './pii-policy.js'

export interface FieldExample { value: string; quote: string }

const PER_FIELD = 5
const QUOTE_MAX = 300
const PERSON_SOURCES = ['user', 'highlight', 'variable', 'import', 'amendment']

export async function fieldExamples(
  orgId: string,
  keys: string[],
  opts: { excludeContractId?: string } = {},
): Promise<Map<string, FieldExample[]>> {
  const out = new Map<string, FieldExample[]>()
  if (!keys.length) return out
  const rows = await prisma.contractFieldValue.findMany({
    where: {
      orgId, fieldKey: { in: keys }, quote: { not: null },
      ...(opts.excludeContractId && { contractId: { not: opts.excludeContractId } }),
      OR: [{ verifiedAt: { not: null } }, { source: { in: PERSON_SOURCES } }],
    },
    orderBy: { updatedAt: 'desc' },
    take: keys.length * 25,
    select: { fieldKey: true, value: true, valueType: true, quote: true },
  })
  const picked: Array<{ key: string; value: string; quote: string }> = []
  for (const r of rows) {
    if (r.value === null || !r.quote?.trim()) continue
    const value = formatFieldValue(r.valueType as FieldValueType, r.value)
    const mine = picked.filter(p => p.key === r.fieldKey)
    // Varied examples teach more than five of the same answer.
    if (mine.length >= PER_FIELD || mine.some(p => p.value === value)) continue
    picked.push({ key: r.fieldKey, value, quote: r.quote.trim().slice(0, QUOTE_MAX) })
  }
  if (!picked.length) return out
  const redacted = await applyPiiPolicyBatch(orgId, picked.map(p => p.quote), { surface: 'field_examples' })
  picked.forEach((p, i) => out.set(p.key, [...(out.get(p.key) ?? []), { value: p.value, quote: redacted.texts[i] ?? p.quote }]))
  return out
}
