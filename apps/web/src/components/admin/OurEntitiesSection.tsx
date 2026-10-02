/**
 * OurEntitiesSection (docs/39 A8) — the companies the org signs contracts as.
 *
 * The AI knew only the org's own name, so a contract signed through a
 * subsidiary, a former name or a trading name came back with our own company
 * as "the other party" — and its address as theirs. The org lists those
 * names here; the AI never takes one for the counterparty, a contract whose
 * counterparty is one of them says so, and the contracts analysed before can
 * be put right in one go (the other party where the contract names exactly
 * one — undoable for 30 days).
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building, Loader2, Plus, Undo2, X } from 'lucide-react'
import { sameCompany } from '@clm/types'
import { api } from '@/lib/api'
import { useCanRequest } from '@/lib/permissions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/common/Toaster'

interface NamingUs { id: string; title: string; counterpartyName: string; others: string[] }

interface EntitiesView {
  orgName: string
  entities: string[]
  max: number
  namingUs: { total: number; fixable: number; contracts: NamingUs[] }
}

interface PickResult { fixed: number; runId: string | null; left: NamingUs[]; leftTotal: number }

function detail(e: unknown): string {
  return (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? (e as Error)?.message ?? 'Unknown error'
}

export function OurEntitiesSection() {
  const qc = useQueryClient()
  const canEdit = useCanRequest('PUT /organization/entities')
  const [name, setName] = useState('')
  const [result, setResult] = useState<PickResult | null>(null)

  const { data } = useQuery({
    queryKey: ['our-entities'],
    queryFn: async () => (await api.get<EntitiesView>('/organization/entities')).data,
  })

  const after = (v: EntitiesView) => {
    qc.setQueryData(['our-entities'], v)
    qc.invalidateQueries({ queryKey: ['contract-counterparty'] })
  }

  const save = useMutation({
    mutationFn: async (entities: string[]) => (await api.put<EntitiesView>('/organization/entities', { entities })).data,
    onSuccess: (v, entities) => {
      after(v)
      const added = entities.length > (data?.entities.length ?? 0)
      if (added) setName('')
      toast.success(added ? 'Added — the AI won’t take it for the other party' : 'Removed')
    },
    onError: e => toast.error('Couldn’t save', { description: detail(e) }),
  })

  const pick = useMutation({
    mutationFn: async () => (await api.post<PickResult>('/organization/entities/pick-other-party')).data,
    onSuccess: r => {
      setResult(r)
      qc.invalidateQueries({ queryKey: ['our-entities'] })
      qc.invalidateQueries({ queryKey: ['contract-counterparty'] })
      qc.invalidateQueries({ queryKey: ['contract-fields'] })
    },
    onError: e => toast.error('Couldn’t put them right', { description: detail(e) }),
  })

  const undo = useMutation({
    mutationFn: async (runId: string) => (await api.post<{ restored: number; skipped: number }>(`/field-runs/${runId}/undo`)).data,
    onSuccess: r => {
      setResult(null)
      qc.invalidateQueries({ queryKey: ['our-entities'] })
      qc.invalidateQueries({ queryKey: ['contract-counterparty'] })
      toast.success(`Put back ${r.restored} value${r.restored === 1 ? '' : 's'}`, { description: r.skipped ? `${r.skipped} changed since, so left as they are.` : undefined })
    },
    onError: e => toast.error('Couldn’t undo', { description: detail(e) }),
  })

  const entities = data?.entities ?? []
  const trimmed = name.trim()
  const duplicate = !!trimmed && !!data && [data.orgName, ...entities].find(n => sameCompany(n, trimmed))
  const add = () => { if (trimmed && !duplicate) save.mutate([...entities, trimmed]) }
  const naming = data?.namingUs

  return (
    <section className="bg-card rounded-card border border-paper-200 p-5 space-y-4" data-testid="our-entities-section">
      <header>
        <h2 className="text-section text-ink-950 flex items-center gap-2">
          <Building className="size-4 text-ink-700" />
          Our entities
        </h2>
        <p className="text-dense text-ink-500 mt-1">
          The companies you sign contracts as: subsidiaries, former names, trading names. The AI never takes one of them for the other party.
        </p>
      </header>

      <ul className="flex flex-wrap gap-1.5" aria-label="Our entities">
        {data && (
          <li className="inline-flex items-center gap-1.5 rounded-full border border-paper-200 bg-paper-50 px-2.5 py-1 text-[12px] text-ink-950" title="Your organization's name, from above">
            {data.orgName}
            <span className="text-[10.5px] text-ink-400">organization name</span>
          </li>
        )}
        {entities.map(n => (
          <li key={n} className="inline-flex items-center gap-1 rounded-full border border-paper-200 bg-card pl-2.5 pr-1 py-1 text-[12px] text-ink-950" data-testid="our-entity">
            {n}
            {canEdit && (
              <button
                type="button" aria-label={`Remove ${n}`} disabled={save.isPending}
                onClick={() => save.mutate(entities.filter(x => x !== n))}
                className="p-0.5 rounded-full text-ink-400 hover:text-ink-950 hover:bg-paper-100"
              >
                <X className="size-3" />
              </button>
            )}
          </li>
        ))}
      </ul>

      {canEdit && (
        <form className="flex items-start gap-2" onSubmit={e => { e.preventDefault(); add() }}>
          <div className="flex-1 max-w-sm">
            <Input
              value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Acme UK Ltd"
              aria-label="Add a company you sign as" data-testid="our-entity-input"
            />
            {duplicate && <p className="text-[11.5px] text-ink-500 mt-1">Already listed as {duplicate}.</p>}
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={!trimmed || !!duplicate || save.isPending || entities.length >= (data?.max ?? 50)} data-testid="our-entity-add">
            {save.isPending ? <Loader2 className="animate-spin" /> : <Plus />} Add
          </Button>
        </form>
      )}

      {result ? (
        <div className="rounded-md border border-paper-200 bg-paper-50 px-3 py-2.5 space-y-2" data-testid="our-entities-result">
          <div className="flex items-start justify-between gap-3">
            <p className="text-dense text-ink-950">
              {result.fixed
                ? <>The other party is now the counterparty on <span className="font-semibold tabular-nums">{result.fixed}</span> contract{result.fixed === 1 ? '' : 's'}.</>
                : 'No contract could be put right without a person.'}
              {result.leftTotal > 0 && <> {result.leftTotal} need{result.leftTotal === 1 ? 's' : ''} someone to choose: {result.leftTotal === 1 ? 'it names' : 'they name'} no single other party, or a person set the counterparty.</>}
            </p>
            {result.runId && (
              <Button size="xs" variant="ghost" disabled={undo.isPending} onClick={() => undo.mutate(result.runId!)} data-testid="our-entities-undo">
                {undo.isPending ? <Loader2 className="animate-spin" /> : <Undo2 />} Undo
              </Button>
            )}
          </div>
          {result.left.length > 0 && <ContractList contracts={result.left} />}
        </div>
      ) : naming && naming.total > 0 && (
        <div className="rounded-md border border-attention-200 bg-attention-50 px-3 py-2.5 space-y-2" data-testid="our-entities-naming">
          <div className="flex items-start justify-between gap-3">
            <p className="text-dense text-ink-950">
              <span className="font-semibold tabular-nums">{naming.total}</span> contract{naming.total === 1 ? ' names' : 's name'} one of these as the counterparty.
              {naming.fixable > 0 && (naming.fixable === naming.total
                ? <> {naming.total === 1 ? 'It names' : 'Each names'} one other party, which can take its place.</>
                : <> <span className="tabular-nums">{naming.fixable}</span> name{naming.fixable === 1 ? 's' : ''} one other party, which can take its place; the rest need someone to choose.</>)}
            </p>
            {canEdit && naming.fixable > 0 && (
              <Button size="xs" disabled={pick.isPending} onClick={() => pick.mutate()} data-testid="our-entities-pick">
                {pick.isPending && <Loader2 className="animate-spin" />} Use the other party
              </Button>
            )}
          </div>
          <ContractList contracts={naming.contracts} />
        </div>
      )}
    </section>
  )
}

function ContractList({ contracts }: { contracts: NamingUs[] }) {
  return (
    <ul className="text-[12px] text-ink-700 space-y-0.5">
      {contracts.slice(0, 5).map(c => (
        <li key={c.id} className="truncate">
          <Link to={`/contracts/${c.id}?field=counterpartyName`} className="text-ink-950 hover:underline underline-offset-2">{c.title}</Link>
          <span className="text-ink-500"> — {c.counterpartyName}{c.others.length === 1 ? ` → ${c.others[0]}` : c.others.length > 1 ? ` (${c.others.length} other parties)` : ' (no other party named)'}</span>
        </li>
      ))}
      {contracts.length > 5 && <li className="text-ink-500">and {contracts.length - 5} more</li>}
    </ul>
  )
}
