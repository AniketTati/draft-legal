/**
 * docs/41 Part 15 (C2) — the workspace's Changes mode: what changed since a
 * baseline, shown in the document as tracked changes (DiffViewer's marks),
 * each with its finding and Accept change / Keep original / Counter… /
 * Comment. It replaces the Compare overlay, the Negotiate tab and the
 * redline panel, which showed the same diff three ways.
 *
 * Decisions change the draft changes (onApply), never a version; the
 * person saves a version when they are ready (lib/changes.ts has how each
 * decision changes the text).
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Download, Loader2, MessageSquare, Undo2, Wand2 } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toaster'
import { serverMessage } from '@/lib/approval-keys'
import { sanitizeHtml } from '@/lib/sanitize'
import type { ContractReview, ReviewFindingView } from '@/lib/review'
import { applyDecisions, changeKey, changesOf, findingFor, taggedDiff, type Change, type ChangeDecision } from '@/lib/changes'

export interface ChangesResponse {
  baseline: { versionId: string; versionNumber: number; reason: string; words: string } | null
  against: { kind: 'draft' | 'version'; versionId: string; versionNumber: number }
  diffHtml: string
  stats: { insertions: number; deletions: number }
  options: { originVersionId: string | null; versions: Array<{ id: string; versionNumber: number; changeNote: string | null; fromCounterparty: boolean }> }
}

export const changesKey = (contractId: string, baseline: string) => ['contract-changes', contractId, baseline] as const

export function ChangesView({ contractId, canEdit, onApply, onComment }: {
  contractId: string
  canEdit: boolean
  /** Put this text in the draft changes; false when it could not be saved. */
  onApply: (html: string) => Promise<boolean>
  /** Start a comment on these words. */
  onComment: (quote: string) => void
}) {
  const qc = useQueryClient()
  // '' is the review's baseline; 'origin' the version generated from the template.
  const [baseline, setBaseline] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  // Accepted changes stay in the diff (the document has their words): marked by their words.
  const [accepted, setAccepted] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)

  const q = useQuery<ChangesResponse>({
    queryKey: changesKey(contractId, baseline),
    queryFn: () => api.get(`/contracts/${contractId}/changes`, { params: baseline ? { baseline } : {} }).then(r => r.data),
    meta: { errorHandled: true },
  })
  const review = useQuery<ContractReview>({
    queryKey: ['contract-review', contractId],
    queryFn: () => api.get(`/contracts/${contractId}/review`).then(r => r.data),
    staleTime: 10_000,
  })
  const findings = useMemo<ReviewFindingView[]>(() => {
    const g = review.data?.groups
    return g ? [...g.needsAttention, ...g.notDetected, ...g.accepted] : []
  }, [review.data])
  const diffHtml = q.data?.diffHtml ?? ''
  const changes = useMemo(() => changesOf(diffHtml), [diffHtml])
  const html = useMemo(() => sanitizeHtml(taggedDiff(diffHtml)), [diffHtml])
  const open = changes.filter(c => !accepted.has(changeKey(c)))

  const decideFinding = (f: ReviewFindingView | null, d: ChangeDecision) => {
    if (!f) return
    if (d.kind === 'accept' && f.actions.includes('accept')) void api.post(`/contracts/${contractId}/findings/${f.id}/accept`, { note: 'Accepted their change' }).catch(() => {})
    else if (d.kind !== 'accept' && f.actions.includes('resolve')) void api.post(`/contracts/${contractId}/findings/${f.id}/resolve`, {}).catch(() => {})
    qc.invalidateQueries({ queryKey: ['contract-review', contractId] })
  }

  /** Apply one decision to the draft changes, then show the diff again. */
  const decide = async (c: Change, d: ChangeDecision) => {
    setBusy(c.id)
    try {
      if (d.kind === 'accept') {
        setAccepted(s => new Set(s).add(changeKey(c)))
      } else {
        const ok = await onApply(applyDecisions(diffHtml, { [c.id]: d }))
        if (!ok) { toast.error('Not saved', { description: 'Your draft changes could not be saved. Try again.' }); return }
        await qc.invalidateQueries({ queryKey: ['contract-changes', contractId] })
      }
      decideFinding(findingFor(c, findings), d)
    } finally {
      setBusy(null)
    }
  }

  const counter = useMutation({
    meta: { errorHandled: true },
    mutationFn: async (c: Change) => {
      const f = findingFor(c, findings)
      const r = await api.post<{ counterText: string; counterNote: string }>(`/contracts/${contractId}/changes/counter`, {
        ourText: c.before, theirText: c.after, clauseType: f?.clauseType ?? null,
      })
      return { c, ...r.data }
    },
    onSuccess: async ({ c, counterText, counterNote }) => {
      await decide(c, { kind: 'counter', text: counterText })
      toast.success('Counter put in your draft changes', { description: `${counterNote} Their words were: “${c.after || c.before}”`, durationMs: 9000 })
    },
    onError: err => toast.error('No counter drafted', { description: serverMessage(err, 'Try again.') }),
  })

  const download = useMutation({
    meta: { errorHandled: true },
    mutationFn: async () => {
      const b = q.data!.baseline!, a = q.data!.against
      const r = await api.get(`/contracts/${contractId}/versions/${b.versionId}/redline-docx/${a.versionId}`, { responseType: 'blob' })
      const url = URL.createObjectURL(new Blob([r.data], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
      const el = document.createElement('a')
      el.href = url
      el.download = `redline-v${b.versionNumber}-to-v${a.versionNumber}.docx`
      document.body.appendChild(el); el.click(); el.remove()
      URL.revokeObjectURL(url)
    },
    onError: err => toast.error('Not downloaded', { description: serverMessage(err, 'Try again.') }),
  })

  const show = (id: string) => {
    setSelected(id)
    document.querySelector(`[data-change-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const d = q.data
  const failure = (q.error as { response?: { data?: { detail?: string } } } | null)?.response?.data?.detail
  return (
    <div className="flex flex-col gap-3" data-testid="changes-view">
      <div className="flex flex-wrap items-center gap-2 text-dense">
        <label className="text-ink-500" htmlFor="changes-baseline">Changes since</label>
        <select
          id="changes-baseline"
          value={baseline}
          onChange={e => { setBaseline(e.target.value); setAccepted(new Set()); setSelected(null) }}
          className="h-7 rounded-md border border-input bg-card px-2 text-dense"
          data-testid="changes-baseline"
        >
          <option value="">{d?.baseline && !baseline ? `v${d.baseline.versionNumber} · ${d.baseline.words}` : 'The review’s baseline'}</option>
          {d?.options.originVersionId && <option value="origin">The template’s first draft</option>}
          {d?.options.versions.map(v => (
            <option key={v.id} value={v.id}>v{v.versionNumber}{v.fromCounterparty ? ' · from the counterparty' : ''}{v.changeNote ? ` · ${v.changeNote}` : ''}</option>
          ))}
        </select>
        {d && <span className="text-ink-500 tabular-nums" data-testid="changes-count">{open.length} change{open.length === 1 ? '' : 's'} to decide{accepted.size ? ` · ${accepted.size} accepted` : ''}</span>}
        {d?.against.kind === 'draft' && <span className="text-[11.5px] text-ink-500">Shown with your draft changes</span>}
        {d?.baseline && (
          <Button size="xs" variant="ghost" className="ml-auto" onClick={() => download.mutate()} disabled={download.isPending} title={`A Word file with tracked changes from v${d.baseline.versionNumber} to v${d.against.versionNumber}${d.against.kind === 'draft' ? ' (saved versions only, not your draft changes)' : ''}`} data-testid="changes-download-word">
            {download.isPending ? <Loader2 className="animate-spin" /> : <Download />}Word with tracked changes
          </Button>
        )}
      </div>

      {q.isLoading && <div className="flex items-center gap-2 text-ink-500 text-dense"><Loader2 className="size-4 animate-spin" />Comparing…</div>}
      {q.isError && <p className="text-dense text-attention-700">{failure ?? 'The changes could not be shown. Try again.'}</p>}
      {d && !d.baseline && <p className="text-dense text-ink-500">There is no earlier version to compare with.</p>}
      {d?.baseline && changes.length === 0 && <p className="text-dense text-ink-500" data-testid="changes-none">No changes since v{d.baseline.versionNumber}.</p>}

      {d?.baseline && changes.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)_280px] gap-4 items-start">
          <div
            className="diff-unified prose prose-sm max-w-none bg-card border border-paper-200 rounded-card p-6"
            onClick={e => { const id = (e.target as HTMLElement).closest('[data-change-id]')?.getAttribute('data-change-id'); if (id) setSelected(id) }}
            dangerouslySetInnerHTML={{ __html: html }}
            data-testid="changes-document"
          />
          <ol className="space-y-2 sticky top-0" data-testid="changes-list">
            {changes.map(c => {
              const f = findingFor(c, findings)
              const done = accepted.has(changeKey(c))
              return (
                <li
                  key={c.id}
                  className={cn('rounded-md border bg-card p-2 text-[11.5px]', selected === c.id ? 'border-ink-950' : 'border-paper-200', done && 'opacity-60')}
                  data-testid={`change-${c.id}`}
                >
                  <button type="button" className="text-left w-full" onClick={() => show(c.id)} title="Show in the document">
                    {c.before && <span className="line-through text-ink-500">{c.before.slice(0, 140)}</span>}
                    {c.before && c.after && ' → '}
                    {c.after && <span className="underline decoration-info-600 text-ink-950">{c.after.slice(0, 140)}</span>}
                  </button>
                  {f && (
                    <div className="mt-1 text-ink-700" data-testid={`change-finding-${c.id}`}>
                      <span className="font-medium">{f.title}</span>
                      {f.advice && <span className="block text-assist-700">AI: {ADVICE_WORDS[f.advice.recommendation] ?? f.advice.recommendation}. {f.advice.reasoning}</span>}
                    </div>
                  )}
                  {done ? <div className="mt-1 text-binding-700 inline-flex items-center gap-1"><Check className="size-3" />Accepted</div> : canEdit && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <Button size="xs" variant="outline" disabled={!!busy} onClick={() => decide(c, { kind: 'accept' })} data-testid={`change-accept-${c.id}`}><Check />Accept change</Button>
                      <Button size="xs" variant="outline" disabled={!!busy} onClick={() => decide(c, { kind: 'keep' })} data-testid={`change-keep-${c.id}`}><Undo2 />Keep original</Button>
                      <Button size="xs" variant="outline" disabled={!!busy || counter.isPending} onClick={() => counter.mutate(c)} data-testid={`change-counter-${c.id}`}>
                        {counter.isPending && counter.variables?.id === c.id ? <Loader2 className="animate-spin" /> : <Wand2 />}Counter…
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => onComment(c.after || c.before)} data-testid={`change-comment-${c.id}`}><MessageSquare />Comment</Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </div>
  )
}

const ADVICE_WORDS: Record<string, string> = { accept: 'Accept', counter: 'Counter', reject: 'Push back' }
