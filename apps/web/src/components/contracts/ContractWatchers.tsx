/**
 * docs/41 Part 14 — who else follows this contract's renewal. Watchers get the
 * same renewal reminders as the owner, and its dates in their calendar feed.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { api } from '@/lib/api'
import { UserPicker } from '@/components/common/UserPicker'

interface Watcher { userId: string; name: string | null; email: string }

export function ContractWatchers({ contractId, ownerId }: { contractId: string; ownerId?: string | null }) {
  const qc = useQueryClient()
  const key = ['contract-watchers', contractId]
  const list = useQuery({ queryKey: key, queryFn: async () => (await api.get<{ data: Watcher[] }>(`/contracts/${contractId}/watchers`)).data.data })
  const [picking, setPicking] = useState(false)
  const done = (r: { data: { data: Watcher[] } }) => qc.setQueryData(key, r.data.data)
  const add = useMutation({ mutationFn: (userId: string) => api.post<{ data: Watcher[] }>(`/contracts/${contractId}/watchers`, { userId }), onSuccess: r => { done(r); setPicking(false) } })
  const remove = useMutation({ mutationFn: (userId: string) => api.delete<{ data: Watcher[] }>(`/contracts/${contractId}/watchers/${userId}`), onSuccess: done })
  const watchers = list.data ?? []

  return (
    <div className="text-[11px] text-ink-700 space-y-1" data-testid="contract-watchers">
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-ink-500">Also reminded:</span>
        {watchers.length === 0 && <span className="text-ink-500">nobody yet</span>}
        {watchers.map(w => (
          <span key={w.userId} className="inline-flex items-center gap-0.5 rounded-chip bg-paper-100 px-1.5 py-0.5">
            {w.name || w.email}
            <button type="button" onClick={() => remove.mutate(w.userId)} aria-label={`Stop reminding ${w.name || w.email}`} className="text-ink-400 hover:text-ink-950">
              <X className="size-3" />
            </button>
          </span>
        ))}
        {!picking && (
          <button type="button" onClick={() => setPicking(true)} className="underline hover:text-ink-950" data-testid="contract-watchers-add">Add someone</button>
        )}
      </div>
      {picking && (
        <UserPicker value="" autoFocus testId="contract-watchers-picker"
          excludeUserIds={[...watchers.map(w => w.userId), ...(ownerId ? [ownerId] : [])]}
          onChange={id => { if (id) add.mutate(id) }} />
      )}
      {(add.isError || remove.isError) && <p className="text-risk-700">That didn’t work. Try again.</p>}
    </div>
  )
}
