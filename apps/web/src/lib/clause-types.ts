/**
 * docs/39 E3 — the clause types an organization's contracts can hold: the
 * built-in ones (@clm/types CLAUSE_TYPE_LABELS), then those it added
 * (Settings › Clause types). Every picker and label reads them from here.
 */
import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CLAUSE_TYPE_LABELS, clauseTypeLabel } from '@clm/types'
import { api } from '@/lib/api'

export interface DetectState {
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'PAUSED' | 'FAILED'
  total: number
  processed: number
  found: number
  failed: number
  error: string | null
  updatedAt: string
}

export interface ClauseTypeOption {
  key: string
  label: string
  custom: boolean
  id?: string
  description?: string | null
  examples?: string[]
  detect?: DetectState | null
}

const BUILT_IN: ClauseTypeOption[] = Object.entries(CLAUSE_TYPE_LABELS).map(([key, label]) => ({ key, label, custom: false }))

export const clauseTypesKey = ['clause-types'] as const

export function useClauseTypes() {
  const { data } = useQuery({
    queryKey: clauseTypesKey,
    queryFn: async () => (await api.get<{ clauseTypes: ClauseTypeOption[] }>('/clause-types')).data.clauseTypes,
    staleTime: 60_000,
  })
  const types = data ?? BUILT_IN
  const labels = useMemo(() => new Map(types.map(t => [t.key, t.label])), [types])
  const labelOf = useCallback((key: string) => labels.get(key) ?? clauseTypeLabel(key), [labels])
  const custom = useMemo(() => types.filter(t => t.custom), [types])
  return { types, custom, labelOf }
}
