/**
 * UnlinkedNames (docs/39 A14) — counterparty names on contracts that no
 * directory entry has, for Counterparties.
 *
 * A company's page lists the contracts linked to it. Contracts link
 * themselves when their counterparty is a name the directory knows ("ACME
 * CORP" finds Acme Corporation); these are the rest — a company never added,
 * or a name only close to one ("Acme Holdings"). One row per company, its
 * spellings together, most contracts first: link it to the entry it is (the
 * name becomes one of the entry's, so later contracts link themselves), or
 * add it. A name that is one of our own companies is a wrong counterparty,
 * not a company to add: it points to Settings.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown, ChevronRight, Link2, Loader2, Plus } from 'lucide-react'
import { directoryName, encodeFieldFilters } from '@clm/types'
import { api } from '@/lib/api'
import { useCanRequest } from '@/lib/permissions'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toaster'

interface Group {
  key: string
  names: string[]
  count: number
  suggestion: { id: string; name: string; score: number } | null
  ours: boolean
}

interface Unlinked { groups: Group[]; total: number; contracts: number }

const contractsNaming = (names: string[]) =>
  `/contracts?ff=${encodeURIComponent(encodeFieldFilters([{ key: 'counterpartyName', op: 'any_of', value: names }]))}`

function detail(e: unknown): string {
  return (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? (e as Error)?.message ?? 'Unknown error'
}

export function UnlinkedNames() {
  const qc = useQueryClient()
  const canLink = useCanRequest('POST /counterparties/:id/aliases')
  const canAdd = useCanRequest('POST /counterparties')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const { data } = useQuery({
    queryKey: ['counterparties-unlinked'],
    queryFn: async () => (await api.get<Unlinked>('/counterparties/unlinked')).data,
  })

  const done = () => {
    qc.invalidateQueries({ queryKey: ['counterparties'] })
    qc.invalidateQueries({ queryKey: ['counterparties-unlinked'] })
    qc.invalidateQueries({ queryKey: ['contract-counterparty'] })
  }
  const contracts = (n: number) => `${n} contract${n === 1 ? '' : 's'}`

  const link = useMutation({
    mutationFn: async (g: Group) => (await api.post<{ name: string; linkedContracts: number }>(`/counterparties/${g.suggestion!.id}/aliases`, { names: g.names })).data,
    onMutate: g => setBusy(g.key),
    onSuccess: (r, g) => { done(); toast.success(`Linked ${contracts(r.linkedContracts)} to ${g.suggestion!.name}`, { description: `“${g.names[0]}” is one of its names now.` }) },
    onError: e => toast.error('Couldn’t link them', { description: detail(e) }),
    onSettled: () => setBusy(null),
  })

  const add = useMutation({
    mutationFn: async (g: Group) => {
      const name = directoryName(g.names[0])
      return (await api.post<{ name: string; linkedContracts: number }>('/counterparties', { name, aliases: g.names.filter(n => n !== name) })).data
    },
    onMutate: g => setBusy(g.key),
    onSuccess: r => { done(); toast.success(`Added ${r.name}`, { description: `Linked ${contracts(r.linkedContracts)}.` }) },
    onError: e => toast.error('Couldn’t add it', { description: detail(e) }),
    onSettled: () => setBusy(null),
  })

  if (!data?.groups.length) return null
  const shown = data.groups

  return (
    <div className="bg-card rounded-card border border-paper-200 mb-4" data-testid="cp-unlinked">
      <button
        type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="w-full flex items-center gap-2 px-5 py-3 text-left hover:bg-paper-50 rounded-card"
        data-testid="cp-unlinked-toggle"
      >
        {open ? <ChevronDown className="size-4 text-ink-400" /> : <ChevronRight className="size-4 text-ink-400" />}
        <span className="text-dense text-ink-950">
          <span className="font-semibold tabular-nums">{data.total}</span> counterpart{data.total === 1 ? 'y' : 'ies'} on{' '}
          <span className="tabular-nums">{contracts(data.contracts)}</span> {data.total === 1 ? 'isn’t' : 'aren’t'} linked to your directory
        </span>
        <span className="text-[11.5px] text-ink-500 ml-auto">Link or add them, so each company’s page has all its contracts</span>
      </button>

      {open && (
        <ul className="divide-y divide-paper-100 border-t border-paper-200">
          {shown.map(g => {
            const rowBusy = busy === g.key
            return (
              <li key={g.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-5 py-2.5" data-testid="cp-unlinked-row">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-ink-950 truncate">{g.names[0]}</p>
                  <p className="text-[11.5px] text-ink-500 truncate">
                    <Link to={contractsNaming(g.names)} className="hover:text-ink-950 hover:underline underline-offset-2">{contracts(g.count)}</Link>
                    {g.names.length > 1 && <> · also written {g.names.slice(1, 4).map(n => `“${n}”`).join(', ')}{g.names.length > 4 ? ` and ${g.names.length - 4} more` : ''}</>}
                  </p>
                </div>
                <div className="flex items-center gap-2 justify-end">
                  {g.ours ? (
                    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-attention-700">
                      <AlertTriangle className="size-3.5" />
                      One of your own companies —
                      <Link to="/admin/org" className="underline underline-offset-2 hover:text-ink-950">put the counterparty right</Link>
                    </span>
                  ) : (
                    <>
                      {g.suggestion && (
                        <>
                          <span className="text-[11.5px] text-ink-500">
                            {g.suggestion.score >= 1 ? 'Matches ' : 'Same company as '}
                            <Link to={`/counterparties/${g.suggestion.id}`} className="font-medium text-ink-950 hover:underline underline-offset-2">{g.suggestion.name}</Link>
                            {g.suggestion.score >= 1 ? '' : '?'}
                          </span>
                          {canLink && (
                            <Button size="xs" variant="outline" disabled={rowBusy} onClick={() => link.mutate(g)} data-testid="cp-unlinked-link">
                              {rowBusy && link.isPending ? <Loader2 className="animate-spin" /> : <Link2 />} Link
                            </Button>
                          )}
                        </>
                      )}
                      {canAdd && (!g.suggestion || g.suggestion.score < 1) && (
                        <Button size="xs" variant={g.suggestion ? 'ghost' : 'outline'} disabled={rowBusy} onClick={() => add.mutate(g)} data-testid="cp-unlinked-add">
                          {rowBusy && add.isPending ? <Loader2 className="animate-spin" /> : <Plus />} {g.suggestion ? 'Add as new' : 'Add'}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </li>
            )
          })}
          {data.total > shown.length && (
            <li className="px-5 py-2 text-[11.5px] text-ink-500">and {data.total - shown.length} more</li>
          )}
        </ul>
      )}
    </div>
  )
}
