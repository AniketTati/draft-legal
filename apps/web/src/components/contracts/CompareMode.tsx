/**
 * CompareMode — State 9 in the unified-canvas wireframes.
 *
 * A first-class fullscreen mode (not a buried tab) for comparing two
 * contract versions. Per docs/26 §5 State 9 + the round-3 critique:
 * negotiation attribution + per-change accept/reject is what turns a
 * diff viewer into a negotiation tool. We ship the mode + attribution
 * + bulk controls now; the per-change inline buttons land in v1.1 once
 * the backend supports a patch-apply endpoint (it currently returns the
 * full diffHtml, not per-span mutations).
 *
 * Open from: the header [Compare ▾] button, or the History rail
 * section. Esc closes.
 *
 * Wave 2.1 (2026-07): per-change Accept/Reject is now real. Changes are parsed
 * from the diff blob (lib/redline.ts), reviewed in the side list or bulk-set,
 * and "Apply as new version" resolves the decisions into merged HTML saved via
 * POST /contracts/:id/html-version. Undecided changes keep the older version.
 */
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { DiffViewer } from './DiffViewer'
import { extractChanges, resolveDiff, type RedlineDecision, type RedlineChange } from '@/lib/redline'
import { sanitizeHtml } from '@/lib/sanitize'
import { X, ChevronDown, Loader2, User, Clock, Check, XCircle, Download } from 'lucide-react'

interface VersionMini {
  id:            string
  versionNumber: number
  createdAt:     string
  authorName?:   string | null
  changeNote?:   string | null
}

export function CompareMode({
  open,
  onClose,
  contractId,
  versions,
}: {
  open:        boolean
  onClose:     () => void
  contractId:  string
  versions:    VersionMini[]
}) {
  // Default: newest vs. one-prior. This matches State 9's "v5 vs v4".
  const sorted = useMemo(
    () => [...versions].sort((a, b) => b.versionNumber - a.versionNumber),
    [versions],
  )
  const [newerId, setNewerId] = useState<string>(sorted[0]?.id ?? '')
  const [olderId, setOlderId] = useState<string>(sorted[1]?.id ?? '')
  const [filter,  setFilter]  = useState<'all' | 'theirs' | 'ours' | 'pending'>('all')

  const newer = sorted.find(v => v.id === newerId) ?? null
  const older = sorted.find(v => v.id === olderId) ?? null

  // Keep picker state in sync when the parent's versions list changes.
  useEffect(() => {
    if (sorted.length === 0) return
    if (!sorted.find(v => v.id === newerId)) setNewerId(sorted[0].id)
    if (!sorted.find(v => v.id === olderId)) setOlderId(sorted[1]?.id ?? sorted[0].id)
  }, [sorted, newerId, olderId])

  // Esc to close.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const { data: diff, isLoading, error } = useQuery({
    queryKey: ['contract-diff', contractId, olderId, newerId],
    queryFn: () => api
      .get(`/contracts/${contractId}/versions/${olderId}/diff/${newerId}`)
      .then(r => r.data),
    enabled: open && !!olderId && !!newerId && olderId !== newerId,
  })

  // A 409 from the diff endpoint means one version's text has not been
  // extracted yet (e.g. a counterparty turn still in the parse pipeline).
  // That's a wait, not a failure — it must not read as "no diff available".
  const stillProcessing =
    (error as { response?: { status?: number } } | null)?.response?.status === 409

  // Wave 2.1 — per-change accept/reject. Changes come from the diff blob in
  // document order; decisions are keyed by their ids. accept = take theirs,
  // reject = keep ours. Reset when the version pair (or diff) changes.
  const changes = useMemo(() => (diff?.diffHtml ? extractChanges(diff.diffHtml) : []), [diff?.diffHtml])
  const [decisions, setDecisions] = useState<Record<string, RedlineDecision>>({})
  useEffect(() => { setDecisions({}) }, [olderId, newerId, diff?.diffHtml])

  const acceptedCount = Object.values(decisions).filter(d => d === 'accept').length
  const rejectedCount = Object.values(decisions).filter(d => d === 'reject').length
  const pendingCount  = changes.length - acceptedCount - rejectedCount
  const setAll = (d: RedlineDecision) => setDecisions(Object.fromEntries(changes.map(c => [c.id, d])))
  const setOne = (id: string, d: RedlineDecision) =>
    setDecisions(prev => (prev[id] === d ? (() => { const n = { ...prev }; delete n[id]; return n })() : { ...prev, [id]: d }))

  const qc = useQueryClient()
  const applyMerge = useMutation({
    mutationFn: async () => {
      const mergedHtml = sanitizeHtml(resolveDiff(diff!.diffHtml, decisions, 'reject'))
      const note = `Redline merge: ${acceptedCount} accepted, ${rejectedCount} rejected vs v${newer?.versionNumber ?? '?'}`
      const r = await api.post(`/contracts/${contractId}/html-version`, { htmlContent: mergedHtml, changeNote: note })
      return r.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', contractId] })
      qc.invalidateQueries({ queryKey: ['contract-versions', contractId] })
      onClose()
    },
  })

  /**
   * Phase 4 — download the pair as a .docx with native tracked changes.
   *
   * Goes through the axios `api` client rather than raw fetch. ContractEditor
   * downloads with a bare fetch and no Authorization header against a
   * permission-guarded route, so it 401s and silently does nothing; that is
   * not a pattern to copy.
   */
  const downloadDocx = useMutation({
    mutationFn: async () => {
      const r = await api.get(
        `/contracts/${contractId}/versions/${olderId}/redline-docx/${newerId}`,
        { responseType: 'blob' },
      )
      const blob = new Blob([r.data], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `redline-v${older?.versionNumber ?? '?'}-to-v${newer?.versionNumber ?? '?'}.docx`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    },
  })

  const visibleChanges = changes.filter(c =>
    filter === 'all'    ? true
    : filter === 'theirs' ? c.type === 'ins'
    : filter === 'ours'   ? c.type === 'del'
    : /* pending */       !decisions[c.id],
  )

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-label="Compare versions"
      className="fixed inset-0 z-50 bg-white flex flex-col"
    >
      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 px-6 py-3 border-b border-gray-200 bg-white">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold text-gray-900">Compare versions</span>

          {/* Newer picker */}
          <VersionPicker
            value={newerId}
            onChange={setNewerId}
            versions={sorted}
            label="Newer"
          />

          <span className="text-gray-400 text-xs">vs.</span>

          {/* Older picker */}
          <VersionPicker
            value={olderId}
            onChange={setOlderId}
            versions={sorted}
            label="Older"
          />
        </div>

        {/* Attribution chips for the two versions */}
        <div className="hidden md:flex items-center gap-3 text-[11px] text-gray-500">
          {newer && (
            <Attribution label={`v${newer.versionNumber}`} author={newer.authorName} createdAt={newer.createdAt} tone="blue" />
          )}
          {older && (
            <Attribution label={`v${older.versionNumber}`} author={older.authorName} createdAt={older.createdAt} tone="gray" />
          )}
        </div>

        {/* Filter chips — filter the per-change review list (theirs=added, ours=removed, pending=undecided) */}
        <div className="ml-auto flex items-center gap-1 p-0.5 bg-gray-100 rounded-lg">
          {(['all', 'theirs', 'ours', 'pending'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'px-2.5 py-1 rounded-md text-xs font-medium capitalize',
                filter === f ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {f}
            </button>
          ))}
        </div>

        <button
          onClick={onClose}
          className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
          aria-label="Close compare (Esc)"
          title="Close (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* ── Bulk action bar — visible when diff loaded ──────────── */}
      {diff && (
        <div className="flex items-center gap-3 px-6 py-2 border-b border-gray-100 bg-gray-50 text-xs">
          <span className="text-gray-500">
            <span className="text-emerald-700 font-medium">{diff.stats.insertions}</span> added,{' '}
            <span className="text-red-700 font-medium">{diff.stats.deletions}</span> removed
          </span>
          {changes.length > 0 && (
            <>
              <div className="h-3 w-px bg-gray-300" aria-hidden />
              <span className="text-gray-500">
                <span className="text-emerald-700 font-medium">{acceptedCount}</span> accepted ·{' '}
                <span className="text-red-700 font-medium">{rejectedCount}</span> rejected ·{' '}
                <span className="text-gray-500 font-medium">{pendingCount}</span> pending
              </span>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm" variant="outline"
              className="gap-1 text-emerald-700 border-emerald-200 hover:bg-emerald-50"
              onClick={() => setAll('accept')} disabled={changes.length === 0}
            >
              <Check className="h-3.5 w-3.5" /> Accept all
            </Button>
            <Button
              size="sm" variant="outline"
              className="gap-1 text-red-700 border-red-200 hover:bg-red-50"
              onClick={() => setAll('reject')} disabled={changes.length === 0}
            >
              <XCircle className="h-3.5 w-3.5" /> Reject all
            </Button>
            {/* Phase 4 — the same two versions, as a Word file with native
                tracked changes. This is the handoff to the counterparty:
                they mark it up in Word and send it back. */}
            <Button
              size="sm" variant="outline" className="gap-1"
              onClick={() => downloadDocx.mutate()}
              disabled={!olderId || !newerId || downloadDocx.isPending}
              title="Download as a Word document with tracked changes"
              data-testid="download-redline-docx"
            >
              {downloadDocx.isPending
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Download className="h-3.5 w-3.5" />}
              Word (tracked)
            </Button>
            <Button
              size="sm" className="gap-1"
              onClick={() => applyMerge.mutate()}
              disabled={changes.length === 0 || acceptedCount + rejectedCount === 0 || applyMerge.isPending}
              title={pendingCount > 0 ? `${pendingCount} undecided change(s) will keep the older version` : 'Save the merged result as a new version'}
            >
              {applyMerge.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Apply as new version
            </Button>
          </div>
          {applyMerge.isError && <span className="text-red-600">Failed to apply — try again.</span>}
          {/* A download that silently does nothing is indistinguishable from a
              browser blocking it, so say so rather than failing quietly. */}
          {downloadDocx.isError && (
            <span className="text-red-600" data-testid="docx-download-error">
              Could not build the Word file — try again.
            </span>
          )}
        </div>
      )}

      {/* ── Diff body ───────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto bg-gray-50 p-4">
        {sorted.length < 2 ? (
          <Centered>
            <p className="text-sm text-gray-500">Only one version exists — nothing to compare.</p>
          </Centered>
        ) : olderId === newerId ? (
          <Centered>
            <p className="text-sm text-gray-500">Pick two different versions to see changes.</p>
          </Centered>
        ) : isLoading ? (
          <Centered>
            <Loader2 className="h-5 w-5 animate-spin text-gray-400 mb-2" />
            <p className="text-sm text-gray-500">Computing diff…</p>
          </Centered>
        ) : stillProcessing ? (
          <Centered>
            <Loader2 className="h-5 w-5 animate-spin text-gray-400 mb-2" />
            <p className="text-sm text-gray-500 max-w-sm text-center">
              This version is still being processed. The comparison will be
              available once extraction finishes.
            </p>
          </Centered>
        ) : diff?.diffHtml ? (
          <div className="flex gap-4 items-start">
            <div className="flex-1 min-w-0">
              <DiffViewer
                diffHtml={diff.diffHtml}
                stats={diff.stats}
                v1Label={older ? `v${older.versionNumber} · ${short(older.authorName)} · ${dateLabel(older.createdAt)}` : 'Older'}
                v2Label={newer ? `v${newer.versionNumber} · ${short(newer.authorName)} · ${dateLabel(newer.createdAt)}` : 'Newer'}
              />
            </div>
            {changes.length > 0 && (
              <ChangesList
                changes={visibleChanges}
                totalChanges={changes.length}
                decisions={decisions}
                onDecide={setOne}
              />
            )}
          </div>
        ) : (
          <Centered>
            <p className="text-sm text-gray-500">No diff available for these versions.</p>
          </Centered>
        )}
      </div>
    </div>
  )
}

function VersionPicker({
  value,
  onChange,
  versions,
  label,
}: {
  value:     string
  onChange:  (id: string) => void
  versions:  VersionMini[]
  label:     string
}) {
  return (
    <label className="inline-flex items-center gap-1 bg-gray-50 border border-gray-200 rounded-md px-2 py-1 text-xs">
      <span className="text-gray-500 text-[10px] uppercase tracking-wide">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="bg-transparent outline-none text-gray-800 font-medium pr-1"
      >
        {versions.map(v => (
          <option key={v.id} value={v.id}>
            v{v.versionNumber}
          </option>
        ))}
      </select>
      <ChevronDown className="h-3 w-3 text-gray-400 -ml-1" />
    </label>
  )
}

function Attribution({
  label,
  author,
  createdAt,
  tone,
}: {
  label:     string
  author?:   string | null
  createdAt: string
  tone:      'blue' | 'gray'
}) {
  return (
    <div className={cn(
      'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border',
      tone === 'blue'
        ? 'bg-blue-50 text-blue-700 border-blue-200'
        : 'bg-gray-50 text-gray-600 border-gray-200',
    )}>
      <span className="font-semibold">{label}</span>
      <span className="opacity-60">·</span>
      <User className="h-3 w-3 opacity-60" />
      <span className="truncate max-w-[120px]">{short(author)}</span>
      <span className="opacity-60">·</span>
      <Clock className="h-3 w-3 opacity-60" />
      <span>{dateLabel(createdAt)}</span>
    </div>
  )
}

function ChangesList({
  changes,
  totalChanges,
  decisions,
  onDecide,
}: {
  changes:      RedlineChange[]
  totalChanges: number
  decisions:    Record<string, RedlineDecision>
  onDecide:     (id: string, d: RedlineDecision) => void
}) {
  return (
    <aside className="w-80 shrink-0 sticky top-0 self-start max-h-[calc(100vh-170px)] overflow-auto rounded-lg border border-gray-200 bg-white">
      <div className="px-3 py-2 border-b border-gray-100 text-xs font-semibold text-gray-700 sticky top-0 bg-white">
        Changes ({totalChanges})
      </div>
      {changes.length === 0 ? (
        <p className="px-3 py-4 text-xs text-gray-400 italic">No changes match this filter.</p>
      ) : (
        <ul className="divide-y divide-gray-50">
          {changes.map(c => {
            const decision = decisions[c.id]
            return (
              <li key={c.id} className="px-3 py-2">
                <div className="flex items-start gap-2">
                  <span className={cn(
                    'mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                    c.type === 'ins' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700',
                  )}>
                    {c.type === 'ins' ? 'Added' : 'Removed'}
                  </span>
                  <p className={cn(
                    'text-xs text-gray-700 line-clamp-3',
                    c.type === 'del' && 'line-through text-gray-400',
                  )}>
                    {c.text || <span className="italic text-gray-400">(formatting change)</span>}
                  </p>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <button
                    onClick={() => onDecide(c.id, 'accept')}
                    className={cn(
                      'inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium border',
                      decision === 'accept'
                        ? 'bg-emerald-600 text-white border-emerald-600'
                        : 'text-emerald-700 border-emerald-200 hover:bg-emerald-50',
                    )}
                  >
                    <Check className="h-3 w-3" /> Accept
                  </button>
                  <button
                    onClick={() => onDecide(c.id, 'reject')}
                    className={cn(
                      'inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium border',
                      decision === 'reject'
                        ? 'bg-red-600 text-white border-red-600'
                        : 'text-red-700 border-red-200 hover:bg-red-50',
                    )}
                  >
                    <XCircle className="h-3 w-3" /> Reject
                  </button>
                  {!decision && <span className="text-[10px] text-gray-400">pending</span>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex flex-col items-center justify-center">
      {children}
    </div>
  )
}

function short(a: string | null | undefined): string {
  if (!a) return 'Unknown'
  return a.length > 20 ? a.slice(0, 20) + '…' : a
}

function dateLabel(iso: string): string {
  const d = new Date(iso)
  const now = Date.now()
  const diff = Math.max(0, now - d.getTime())
  const days = Math.floor(diff / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
