/**
 * docs/39 D3 — every field the org's contracts can hold (GET /contracts/fields),
 * for the contracts list's columns and filters, and grouped as the pickers
 * show them: the standard fields by group, each contract type's own, then
 * the org's.
 */
import { useQuery } from '@tanstack/react-query'
import { FIELD_GROUP_LABELS, type CatalogField } from '@clm/types'
import { api } from '@/lib/api'

export function useFieldCatalog() {
  return useQuery({
    queryKey: ['contract-field-catalog'],
    queryFn: async () => (await api.get<{ fields: CatalogField[] }>('/contracts/fields')).data.fields,
    staleTime: 60_000,
  })
}

export interface FieldSection { title: string; fields: CatalogField[] }

/** The catalogue in picker order, narrowed by words in the label, the key or the contract types. */
export function catalogSections(catalog: CatalogField[], search = ''): FieldSection[] {
  const q = search.trim().toLowerCase()
  const match = (f: CatalogField) => !q || f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q)
    || (f.contractTypes ?? []).some(t => t.toLowerCase().replace(/_/g, ' ').includes(q))
  const sections: FieldSection[] = (Object.keys(FIELD_GROUP_LABELS) as Array<keyof typeof FIELD_GROUP_LABELS>).map(g => ({
    title: FIELD_GROUP_LABELS[g],
    fields: catalog.filter(f => f.kind === 'core' && f.group === g && match(f)),
  }))
  sections.push({ title: 'Your fields', fields: catalog.filter(f => f.kind === 'custom' && match(f)) })
  sections.push({ title: 'By contract type', fields: catalog.filter(f => f.kind === 'type' && match(f)) })
  return sections.filter(s => s.fields.length)
}

/** "SOW", "MSA, SOW" — the types a field applies to, when not every contract has it. */
export function typesOf(f: CatalogField): string | null {
  return f.contractTypes?.length ? f.contractTypes.map(t => t.replace(/_/g, ' ')).join(', ') : null
}
