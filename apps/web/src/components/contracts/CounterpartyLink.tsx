/**
 * CounterpartyLink (docs/39 A14, A8) — under a contract's Counterparty: the
 * directory entry it links to, or what to do when it links to none.
 *
 * The directory used to find a company's contracts only when the contract
 * spelled the name exactly as the directory did, so "ACME CORPORATION, INC."
 * never reached Acme's page, and nothing on the contract said so. Here:
 *
 *   - linked — the entry's name, a link to its page;
 *   - an entry it might be ("Acme Holdings" / Acme Corp.) — Link, which also
 *     teaches the directory the name, so the next contract links itself;
 *   - none — Add it to the directory, named as a directory would name it;
 *   - one of our own companies — the counterparty is the other party: the
 *     other parties the contract names, one click each;
 *   - a person just replaced the AI's counterparty — was that one of our
 *     companies? Adding it to Our entities keeps the AI off it next time.
 */
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Building2, ChevronRight, Loader2, Plus } from 'lucide-react'
import { isOurs, sameCompany } from '@clm/types'
import { api } from '@/lib/api'
import { useCanRequest } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover } from '@/components/ui/popover'
import { toast } from '@/components/common/Toaster'

function errorDetail(err: unknown): string {
  return (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? (err as Error)?.message ?? 'Unknown error'
}

export interface CounterpartyView {
  name: string | null
  placeholder: boolean
  linked: { id: string; name: string } | null
  suggestions: Array<{ id: string; name: string; score: number }>
  directoryName: string | null
  ours: boolean
  others: string[]
  ourNames: string[]
}

export const counterpartyKey = (contractId: string) => ['contract-counterparty', contractId]

export function CounterpartyLink({ contractId, canEdit, replaced, onReplacedSeen, onUseParty, className }: {
  contractId: string
  /** May set the contract's counterparty (the Fields panel's edit right). */
  canEdit: boolean
  /** The AI's counterparty a person just replaced, to ask whether it was one of ours. */
  replaced?: string | null
  onReplacedSeen?: () => void
  /** Set this party as the counterparty (through the Fields panel, so it updates). */
  onUseParty?: (name: string) => void
  className?: string
}) {
  const qc = useQueryClient()
  const canLink = useCanRequest('POST /contracts/:id/counterparty/link')
  const canCreate = useCanRequest('POST /counterparties')
  const canConfigure = useCanRequest('POST /organization/entities')
  const addRef = useRef<HTMLButtonElement>(null)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

  const { data: v } = useQuery({
    queryKey: counterpartyKey(contractId),
    queryFn: async () => (await api.get<CounterpartyView>(`/contracts/${contractId}/counterparty`)).data,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: counterpartyKey(contractId) })
    qc.invalidateQueries({ queryKey: ['counterparties'] })
    qc.invalidateQueries({ queryKey: ['counterparties-unlinked'] })
  }
  const others = (n: number) => (n > 1 ? ` and ${n - 1} other contract${n === 2 ? '' : 's'}` : '')

  const link = useMutation({
    mutationFn: async (to: { id: string; name: string }) =>
      (await api.post<CounterpartyView & { linkedContracts: number }>(`/contracts/${contractId}/counterparty/link`, { counterpartyId: to.id })).data,
    onSuccess: (r, to) => {
      refresh()
      toast.success(`Linked to ${to.name}${others(r.linkedContracts)}`, {
        description: v?.name && !sameCompany(v.name, to.name) ? `Contracts that say “${v.name}” will link to it from now on.` : undefined,
      })
    },
    onError: err => toast.error("Couldn't link it", { description: errorDetail(err) }),
  })

  const create = useMutation({
    mutationFn: async (name: string) =>
      (await api.post<{ id: string; name: string; linkedContracts: number }>('/counterparties', {
        name,
        ...(v?.name && v.name !== name ? { aliases: [v.name] } : {}),
      })).data,
    onSuccess: r => {
      setAdding(false)
      refresh()
      toast.success(`Added ${r.name} to Counterparties`, { description: r.linkedContracts > 1 ? `Linked this contract${others(r.linkedContracts)} that name it.` : undefined })
    },
    onError: err => toast.error("Couldn't add it", { description: errorDetail(err) }),
  })

  const addOurs = useMutation({
    mutationFn: async (name: string) => (await api.post('/organization/entities', { name })).data,
    onSuccess: (_r, name) => {
      onReplacedSeen?.()
      refresh()
      qc.invalidateQueries({ queryKey: ['our-entities'] })
      toast.success(`${name} is one of your companies now`, { description: 'The AI won’t take it for the other party again. Settings › Organization lists them.' })
    },
    onError: err => toast.error("Couldn't add it", { description: errorDetail(err) }),
  })

  if (!v) return null
  const busy = link.isPending || create.isPending

  // A person replaced the AI's counterparty: was it one of ours?
  const askReplaced = !!replaced && canConfigure && !isOurs(replaced, v.ourNames) && !(v.name && sameCompany(replaced, v.name))

  const line = 'flex items-start gap-1.5 text-[11.5px] leading-snug'

  return (
    <div className={cn('mt-1.5 space-y-1.5', className)} data-testid="counterparty-link">
      {v.ours ? (
        <div className="rounded-md border border-attention-200 bg-attention-50 px-2.5 py-2" data-testid="counterparty-ours">
          <p className="text-[12px] text-ink-950 flex items-start gap-1.5">
            <AlertTriangle className="size-3.5 mt-0.5 text-attention-600 shrink-0" />
            <span>
              This is one of your own companies. The counterparty is the other party
              {v.others.length ? '' : ' — enter it'}.
            </span>
          </p>
          {canEdit && onUseParty && v.others.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {v.others.slice(0, 4).map(name => (
                <Button key={name} size="xs" variant="outline" onClick={() => onUseParty(name)} data-testid="counterparty-use-party">
                  Use {name}
                </Button>
              ))}
            </div>
          )}
        </div>
      ) : v.placeholder ? (
        <p className={cn(line, 'text-attention-700')} data-testid="counterparty-placeholder">
          <AlertTriangle className="size-3 mt-0.5 shrink-0" />
          This looks like a placeholder left in from a template, not a company.
        </p>
      ) : v.linked ? (
        <p className={cn(line, 'text-ink-500')} data-testid="counterparty-linked">
          <Building2 className="size-3 mt-0.5 shrink-0" />
          <Link to={`/counterparties/${v.linked.id}`} className="inline-flex items-center hover:text-ink-950 hover:underline underline-offset-2">
            {v.name && sameCompany(v.name, v.linked.name) && v.name.trim() === v.linked.name.trim()
              ? 'In your directory'
              : <>In your directory as <span className="font-medium text-ink-700 ml-1">{v.linked.name}</span></>}
            <ChevronRight className="size-3" />
          </Link>
        </p>
      ) : v.name ? (
        <div className="space-y-1" data-testid="counterparty-unlinked">
          {v.suggestions.slice(0, 2).map(s => (
            <div key={s.id} className={cn(line, 'text-ink-700 items-center')} data-testid="counterparty-suggestion">
              <Building2 className="size-3 shrink-0 text-ink-400" />
              <span className="min-w-0 flex-1">
                {s.score >= 1 ? 'Matches ' : 'Not in your directory. Is it '}
                <Link to={`/counterparties/${s.id}`} className="font-medium text-ink-950 hover:underline underline-offset-2">{s.name}</Link>
                {s.score >= 1 ? ' in your directory.' : '?'}
              </span>
              {canLink && (
                <Button size="xs" variant="outline" disabled={busy} onClick={() => link.mutate(s)} data-testid="counterparty-link-button">
                  {link.isPending && link.variables?.id === s.id ? <Loader2 className="animate-spin" /> : null} Link
                </Button>
              )}
            </div>
          ))}
          {!v.suggestions.some(s => s.score >= 1) && (
            <div className={cn(line, 'text-ink-500 items-center')}>
              {!v.suggestions.length && <Building2 className="size-3 shrink-0 text-ink-400" />}
              <span className="min-w-0 flex-1">{v.suggestions.length ? 'Not the same company?' : 'Not in your directory.'}</span>
              {canCreate && (
                <Button
                  ref={addRef} size="xs" variant={v.suggestions.length ? 'ghost' : 'outline'} disabled={busy}
                  onClick={() => { setNewName(v.directoryName ?? v.name ?? ''); setAdding(a => !a) }}
                  aria-expanded={adding} data-testid="counterparty-add-button"
                >
                  <Plus /> Add to directory
                </Button>
              )}
            </div>
          )}
        </div>
      ) : null}

      {askReplaced && (
        <div className="rounded-md border border-paper-200 bg-paper-50 px-2.5 py-2" data-testid="counterparty-replaced">
          <p className="text-[12px] text-ink-950">
            Was <span className="font-medium">{replaced}</span> one of your own companies? Add it to your entities and the AI won’t take it for the other party again.
          </p>
          <div className="flex justify-end gap-1.5 mt-2">
            <Button size="xs" variant="ghost" onClick={onReplacedSeen} data-testid="counterparty-replaced-no">No</Button>
            <Button size="xs" variant="outline" disabled={addOurs.isPending} onClick={() => addOurs.mutate(replaced!)} data-testid="counterparty-replaced-add">
              {addOurs.isPending && <Loader2 className="animate-spin" />} It’s ours
            </Button>
          </div>
        </div>
      )}

      <Popover open={adding} onClose={() => setAdding(false)} anchor={addRef.current} align="end" width={300} label="Add to Counterparties">
        <form
          className="p-3 space-y-2.5"
          onSubmit={e => { e.preventDefault(); if (newName.trim()) create.mutate(newName.trim()) }}
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-400">Add to Counterparties</p>
          <label className="block">
            <span className="block text-[11px] text-ink-700 mb-1">Name</span>
            <Input value={newName} onChange={e => setNewName(e.target.value)} autoFocus data-testid="counterparty-add-name" />
          </label>
          {v.name && newName.trim() && v.name !== newName.trim() && (
            <p className="text-[11px] text-ink-500">Contracts that say “{v.name}” will link to it too.</p>
          )}
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="xs" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="submit" size="xs" disabled={!newName.trim() || create.isPending} data-testid="counterparty-add-save">
              {create.isPending && <Loader2 className="animate-spin" />} Add
            </Button>
          </div>
        </form>
      </Popover>
    </div>
  )
}
