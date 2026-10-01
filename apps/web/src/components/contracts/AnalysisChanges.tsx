/**
 * AnalysisChanges (docs/39 G1) — what the last re-analysis changed, and its
 * undo.
 *
 * A re-analysis refreshes the values the AI owns. When a better or worse
 * reading replaced one the reader relied on, nothing said so. Now the Fields
 * panel says how many values the last analysis changed, lists them (was →
 * now), and for 30 days puts them back in one step — a value someone has
 * changed since stays as they left it.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { api } from '@/lib/api'
import { useCanRequest } from '@/lib/permissions'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toaster'

interface Change { fieldKey: string; label: string; beforeDisplay: string; afterDisplay: string }
interface Run { id: string; createdAt: string; undoUntil: string; canUndo: boolean; changes: Change[] }

const seenKey = (runId: string) => `clm.analysis-changes.${runId}`

export function AnalysisChanges({ contractId }: { contractId: string }) {
  const qc = useQueryClient()
  const canUndo = useCanRequest('POST /field-runs/:id/undo')
  const [open, setOpen] = useState(false)
  const [, rerender] = useState(0)
  const { data } = useQuery({
    queryKey: ['field-run-latest', contractId],
    queryFn: async () => (await api.get<{ run: Run | null }>(`/field-runs/contract/${contractId}/latest`)).data.run,
    staleTime: 30_000,
  })
  const undo = useMutation({
    mutationFn: async (runId: string) => (await api.post<{ restored: number; skipped: number }>(`/field-runs/${runId}/undo`)).data,
    onSuccess: r => {
      toast.success(`Put back ${r.restored} value${r.restored === 1 ? '' : 's'}`, r.skipped ? { description: `${r.skipped} changed since, left as ${r.skipped === 1 ? 'it is' : 'they are'}.` } : undefined)
      qc.invalidateQueries({ queryKey: ['field-run-latest', contractId] })
      qc.invalidateQueries({ queryKey: ['contract-fields', contractId] })
      qc.invalidateQueries({ queryKey: ['contract', contractId] })
    },
    onError: (err: { response?: { data?: { detail?: string } } }) => toast.error("Couldn't undo", { description: err.response?.data?.detail ?? 'Try again.' }),
  })

  const run = data
  let dismissed = false
  try { dismissed = !!run && window.localStorage.getItem(seenKey(run.id)) === '1' } catch { /* storage unavailable: show it */ }
  if (!run || !run.canUndo || dismissed || !run.changes.length) return null
  const until = new Date(run.undoUntil).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  const dismiss = () => { try { window.localStorage.setItem(seenKey(run.id), '1') } catch { /* ignore */ } rerender(n => n + 1) }

  return (
    <div className="rounded-md border border-paper-200 bg-paper-50 px-3 py-2 text-[12px] text-ink-700" data-testid="analysis-changes">
      <div className="flex items-center gap-2">
        <History className="size-3.5 text-ink-400 shrink-0" />
        <span className="min-w-0 flex-1">
          The last analysis changed {run.changes.length} value{run.changes.length === 1 ? '' : 's'}.{' '}
          <button type="button" className="font-medium text-ink-950 hover:underline underline-offset-2" onClick={() => setOpen(o => !o)} aria-expanded={open}>
            {open ? 'Hide' : 'Show'}
          </button>
        </span>
        <button type="button" className="text-[11px] text-ink-400 hover:text-ink-700" onClick={dismiss} title="Hide this note">Dismiss</button>
      </div>
      {open && (
        <div className="mt-2 space-y-1">
          {run.changes.map(c => (
            <p key={c.fieldKey} className="flex items-baseline gap-2">
              <span className="text-ink-500 min-w-0 truncate">{c.label}</span>
              <span className="ml-auto shrink-0 tabular-nums"><span className="text-ink-400 line-through">{c.beforeDisplay}</span> → <span className="text-ink-950">{c.afterDisplay}</span></span>
            </p>
          ))}
          {canUndo && (
            <div className="flex items-center justify-end gap-2 pt-1">
              <span className="text-[11px] text-ink-400">Until {until}</span>
              <Button size="xs" variant="outline" disabled={undo.isPending} onClick={() => undo.mutate(run.id)} data-testid="analysis-changes-undo">
                Put the old values back
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
