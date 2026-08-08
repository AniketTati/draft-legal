/**
 * Approvals Page — Phase 06 + P7.2.2
 *
 * Three tabs:
 *   • My Queue — pending approval steps assigned to me (the current step only)
 *   • All approvals — org-wide oversight (admin / legal_ops only) — P7.2.2 / F-11
 *   • Manage Workflows — workflow definition CRUD
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/auth'
import { ApprovalCard } from '@/components/approvals/ApprovalCard'
import { WorkflowDefinitionList } from '@/components/approvals/WorkflowDefinitionList'
import { CheckSquare, Settings2, Loader2, Inbox, AlertTriangle, Globe2, ArrowRight, ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CountBadge, EmptyState } from '@/components/ui/primitives'

type Tab = 'queue' | 'all' | 'workflows'

interface AllApprovalRow {
  instanceId:        string
  contract?:         { id: string; title: string; type: string; value?: number | null; currency?: string | null; counterpartyName?: string | null; status: string }
  status:            string
  submittedAt:       string
  submittedByName:   string
  currentStepOrder:  number
  currentStepName:   string | null
  currentApproverName: string | null
  currentApproverEmail: string | null
  waitingDays:       number
  totalSteps:        number
  approvalRecommendation: string | null
}

interface QueueItem {
  stepId:      string
  instanceId:  string
  stepOrder:   number
  stepName:    string
  status:      string
  escalateAt?: string
  contract: {
    id:              string
    title:           string
    type:            string
    value?:          number | null
    counterpartyName?: string | null
    status:          string
  }
  instance: {
    id:                    string
    status:                string
    submittedAt:           string
    submittedByName?:      string
    aiSummary?:            string
    keyRisks?:             Array<{ title: string; description: string; severity: string }>
    nonStandardTerms?:     string[]
    approvalRecommendation?: string
  }
}

export function ApprovalsPage() {
  const [tab, setTab] = useState<Tab>('queue')
  const [bulkOpen, setBulkOpen] = useState(false)
  // P7.2.2 — Show "All approvals" tab only to admins / legal-ops.
  // The /approvals/all endpoint is gated on `configure:workflow` so a
  // non-admin call would 403; we hide the tab proactively to avoid
  // showing a feature the user can't use.
  const userRoles = (useAuthStore(s => s.user?.roles ?? []) as readonly string[])
  const canSeeAll = userRoles.includes('ADMIN') || userRoles.includes('LEGAL_OPS')

  const { data, isLoading, refetch } = useQuery<{ data: QueueItem[]; total: number }>({
    queryKey: ['approval-queue'],
    queryFn:  () => api.get('/approvals/my-queue').then(r => r.data),
    enabled:  tab === 'queue',
    staleTime: 10_000,
  })

  // P7.2.2 — All-approvals query (admin only). Lazy: only fires when
  // the tab is active so we don't burn a query for non-admin viewers.
  const { data: allData, isLoading: allLoading } = useQuery<{ data: AllApprovalRow[]; total: number }>({
    queryKey: ['approval-all'],
    queryFn:  () => api.get('/approvals/all').then(r => r.data),
    enabled:  tab === 'all' && canSeeAll,
    staleTime: 10_000,
  })

  const items = data?.data ?? []
  const pendingCount = data?.total ?? 0
  const allItems = allData?.data ?? []
  const allCount = allData?.total ?? 0

  // B.6.21 — warn when the org has zero workflow definitions. Without
  // one, every `Submit for Approval` silently fails. This tells the
  // user up-front + deep-links them to the fix.
  //
  // The endpoint returns either a raw array or `{data:[…]}` depending
  // on the call site history; normalise defensively.
  const { data: workflowsData } = useQuery<unknown>({
    queryKey: ['approval-workflows'],
    queryFn: () => api.get('/approvals/workflows').then(r => r.data),
    staleTime: 30_000,
  })
  const workflowList = Array.isArray(workflowsData)
    ? workflowsData
    : Array.isArray((workflowsData as { data?: unknown[] } | null)?.data)
      ? (workflowsData as { data: unknown[] }).data
      : null
  const showNoWorkflowsWarning = workflowList !== null && workflowList.length === 0

  return (
    <div className="h-full flex flex-col bg-paper-50">
      {/* Header */}
      <div className="bg-card border-b border-paper-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-title text-ink-950">Approvals</h1>
            {pendingCount > 0 && (
              <p className="text-body text-ink-500 mt-0.5">{pendingCount} pending your decision</p>
            )}
          </div>
        </div>

        {/* Tabs — the selected tab is a selection, so ink carries it. */}
        <div className="flex gap-1 mt-3 border-b border-paper-200 -mb-px">
          {([
            { id: 'queue' as Tab,     label: 'My Queue', icon: <CheckSquare className="size-4" />, badge: pendingCount },
            ...(canSeeAll ? [{ id: 'all' as Tab, label: 'All approvals', icon: <Globe2 className="size-4" />, badge: allCount }] : []),
            { id: 'workflows' as Tab, label: 'Manage Workflows', icon: <Settings2 className="size-4" /> },
          ] as { id: Tab; label: string; icon: React.ReactNode; badge?: number }[]).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-[13px] font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-ink-950 text-ink-950'
                  : 'border-transparent text-ink-500 hover:text-ink-950'
              }`}
            >
              {t.icon}
              {t.label}
              {t.badge != null && t.badge > 0 && (
                // My Queue is the only badge that is genuinely blocked on this
                // user; the org-wide count is oversight, so it stays neutral.
                <CountBadge tone={t.id === 'queue' ? 'attention' : 'neutral'}>
                  {t.badge}
                </CountBadge>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">

        {/* B.6.21 — No-workflow warning (global across both tabs) */}
        {showNoWorkflowsWarning && (
          <div
            role="alert"
            data-testid="no-workflows-warning"
            className="max-w-3xl mx-auto mb-5 rounded-md border border-attention-200 bg-attention-50 px-4 py-3 flex items-start gap-3"
          >
            <AlertTriangle className="size-4 text-attention-600 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-body font-semibold text-attention-700">
                No approval workflows defined yet.
              </p>
              <p className="text-dense text-ink-700 mt-0.5">
                Until someone creates a workflow, the "Submit for Approval"
                button on contracts won't know where to route decisions and
                will fail quietly. Create one to unblock your team.
              </p>
            </div>
            <button
              onClick={() => setTab('workflows')}
              className="text-dense font-semibold text-ink-950 underline underline-offset-2 decoration-paper-300 hover:decoration-ink-950 shrink-0"
            >
              Create workflow →
            </button>
          </div>
        )}

        {/* ── My Queue ────────────────────────────────────────────────── */}
        {tab === 'queue' && (
          <>
            {isLoading ? (
              <div className="flex justify-center items-center py-20">
                <Loader2 className="size-6 animate-spin text-ink-400" />
              </div>
            ) : items.length === 0 ? (
              <div className="max-w-3xl mx-auto">
                <EmptyState
                  icon={<Inbox />}
                  title="All clear"
                  description="No contracts are awaiting your approval."
                />
              </div>
            ) : (
              <>
                {items.length > 1 && (
                  <div className="max-w-5xl mx-auto mb-3 flex items-center justify-between gap-2">
                    <span className="text-dense text-ink-500">
                      {items.length} item{items.length === 1 ? '' : 's'} awaiting your decision
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setBulkOpen(true)}
                      data-testid="bulk-approve-btn"
                    >
                      <ListChecks />
                      Bulk decision…
                    </Button>
                  </div>
                )}
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 max-w-5xl mx-auto">
                  {items.map(item => (
                    <ApprovalCard
                      key={item.stepId}
                      stepId={item.stepId}
                      instanceId={item.instanceId}
                      stepName={item.stepName}
                      contract={item.contract}
                      instance={item.instance}
                      onDecided={() => refetch()}
                    />
                  ))}
                </div>
                {bulkOpen && (
                  <BulkDecisionDialog
                    items={items}
                    onClose={() => setBulkOpen(false)}
                    onDone={() => { setBulkOpen(false); refetch() }}
                  />
                )}
              </>
            )}
          </>
        )}

        {/* ── All approvals (admin oversight) — P7.2.2 ─────────────────── */}
        {tab === 'all' && (
          <>
            {allLoading ? (
              <div className="flex justify-center items-center py-20">
                <Loader2 className="size-6 animate-spin text-ink-400" />
              </div>
            ) : allItems.length === 0 ? (
              <div className="max-w-3xl mx-auto">
                <EmptyState
                  icon={<Globe2 />}
                  title="No approvals in flight"
                  description="No contracts are pending approval anywhere in the org."
                />
              </div>
            ) : (
              <div className="max-w-5xl mx-auto" data-testid="all-approvals-list">
                <p className="text-body text-ink-500 mb-3">
                  Org-wide view of every approval in flight. Use this to spot where deals are stuck.
                </p>
                <div className="rounded-card border border-paper-200 bg-card overflow-hidden">
                  <table className="w-full text-[13px]">
                    <thead className="bg-paper-50">
                      <tr className="text-left text-eyebrow uppercase text-ink-500">
                        <th className="px-4 py-2 font-semibold">Contract</th>
                        <th className="px-4 py-2 font-semibold">Current step</th>
                        <th className="px-4 py-2 font-semibold">Awaiting</th>
                        <th className="px-4 py-2 font-semibold">Submitted</th>
                        <th className="px-4 py-2 font-semibold">Waiting</th>
                        <th className="px-4 py-2"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-paper-200">
                      {allItems.map(row => {
                        // Age of a stuck approval, on the same three-step ramp the
                        // risk meter uses: a week idle is exposure, three days is
                        // someone's turn, anything fresher is fine.
                        const dotClass = row.waitingDays >= 7 ? 'bg-risk-600' :
                                         row.waitingDays >= 3 ? 'bg-attention-600' :
                                         'bg-brand-700'
                        const waitingText = row.waitingDays === 0 ? 'today' :
                                            row.waitingDays === 1 ? '1d' :
                                            `${row.waitingDays}d`
                        return (
                          <tr key={row.instanceId} className="hover:bg-paper-50 transition-colors">
                            <td className="px-4 py-2">
                              <Link
                                to={`/contracts/${row.contract?.id}`}
                                className="font-medium text-ink-950 hover:underline underline-offset-2 decoration-paper-300"
                              >
                                {row.contract?.title ?? 'Unknown'}
                              </Link>
                              {row.contract?.counterpartyName && (
                                <div className="text-[11px] text-ink-500 mt-0.5">
                                  {row.contract.counterpartyName}
                                  {row.contract.value && ` · ${row.contract.currency ?? 'USD'} ${row.contract.value.toLocaleString()}`}
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-2 text-ink-700 text-[11.5px]">
                              <div className="font-medium">{row.currentStepName ?? '—'}</div>
                              <div className="text-ink-400 mt-0.5 tabular-nums">step {row.currentStepOrder} of {row.totalSteps}</div>
                            </td>
                            <td className="px-4 py-2 text-ink-700 text-[13px]">
                              {row.currentApproverName ?? <span className="text-ink-400 italic">unassigned</span>}
                            </td>
                            <td className="px-4 py-2 text-ink-500 text-[11.5px]">
                              <div>{row.submittedByName}</div>
                              <div className="text-ink-400 mt-0.5 tabular-nums">{new Date(row.submittedAt).toLocaleDateString()}</div>
                            </td>
                            <td className="px-4 py-2">
                              <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium tabular-nums text-ink-700">
                                <span className={`size-1.5 rounded-full ${dotClass}`} />
                                {waitingText}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-right">
                              <Link
                                to={`/contracts/${row.contract?.id}`}
                                className="inline-flex items-center gap-1 text-[11.5px] font-medium text-ink-950 hover:text-ink-700"
                              >
                                Open
                                <ArrowRight className="size-3" />
                              </Link>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Manage Workflows ────────────────────────────────────────── */}
        {tab === 'workflows' && (
          <div className="max-w-3xl mx-auto">
            <p className="text-body text-ink-500 mb-5">
              Workflow definitions control how contracts are routed for approval.
              Set a default workflow so contracts are auto-routed on submission.
            </p>
            <WorkflowDefinitionList />
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Bulk-decision dialog (P10D) ─────────────────────────────────────
//
// Renders a checklist of the user's PENDING approval steps. The user
// picks a decision (Approve / Reject), optionally adds a bulk comment
// applied to every selected item, and submits.
function BulkDecisionDialog({
  items,
  onClose,
  onDone,
}: {
  items: QueueItem[]
  onClose: () => void
  onDone: () => void
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(items.map(i => i.stepId)))
  const [decision, setDecision] = useState<'APPROVED' | 'REJECTED'>('APPROVED')
  const [comment, setComment] = useState('')
  const [progress, setProgress] = useState<{ done: number; failed: number; total: number } | null>(null)
  const [failures, setFailures] = useState<{ stepId: string; title: string; detail: string }[]>([])

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  // L6 #10 — this used to `catch { failed++ }`, throwing away the server's
  // per-step detail, then close the dialog unconditionally after 600 ms with
  // the failure count rendered in emerald success green. The user got a green
  // tick, a number, and no way to learn which items failed or why.
  const submit = async () => {
    const targets = items.filter(i => selected.has(i.stepId))
    setProgress({ done: 0, failed: 0, total: targets.length })
    setFailures([])
    let done = 0
    const failedItems: { stepId: string; title: string; detail: string }[] = []
    for (const t of targets) {
      try {
        await api.post(`/approvals/${t.instanceId}/decide`, {
          stepId:   t.stepId,
          decision,
          comment:  comment.trim() || undefined,
        })
        done++
      } catch (err) {
        const detail =
          (err as { response?: { data?: { detail?: string; error?: string } } })?.response?.data?.detail ??
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Request failed'
        failedItems.push({ stepId: t.stepId, title: t.contract?.title ?? t.stepName ?? t.stepId, detail })
      }
      setProgress({ done, failed: failedItems.length, total: targets.length })
    }
    setFailures(failedItems)
    // Only close on a clean run. Closing over failures is what made a partial
    // failure indistinguishable from success.
    if (failedItems.length === 0) setTimeout(() => onDone(), 600)
  }

  const retryFailed = () => {
    setSelected(new Set(failures.map(f => f.stepId)))
    setProgress(null)
    setFailures([])
  }

  const isRejecting = decision === 'REJECTED'
  const valid = selected.size > 0 && (!isRejecting || comment.trim().length > 0) && !progress

  return (
    <div role="dialog" className="fixed inset-0 z-50 bg-ink-950/40 flex items-center justify-center p-4 overflow-auto" onClick={onClose} data-testid="bulk-decision-dialog">
      <div className="bg-card rounded-card max-w-2xl w-full shadow-e3 my-8" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-paper-200 flex items-start justify-between">
          <div>
            <h2 className="text-section text-ink-950 flex items-center gap-2">
              <ListChecks className="size-4 text-ink-400" />
              Bulk decision
            </h2>
            <p className="text-dense text-ink-500 mt-1">
              Apply a single decision (with optional comment) to multiple pending approvals.
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-paper-100 text-ink-400">×</button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* Decision picker — a decision surface, so brand and risk are earned. */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setDecision('APPROVED')}
              data-testid="bulk-decision-approve"
              className={`flex-1 p-3 rounded-md border text-[13px] font-medium transition-colors ${
                decision === 'APPROVED' ? 'border-brand-700 bg-brand-50 text-brand-700' : 'border-paper-200 hover:border-paper-300 text-ink-700'
              }`}
            >Approve all selected</button>
            <button
              type="button"
              onClick={() => setDecision('REJECTED')}
              data-testid="bulk-decision-reject"
              className={`flex-1 p-3 rounded-md border text-[13px] font-medium transition-colors ${
                decision === 'REJECTED' ? 'border-risk-600 bg-risk-50 text-risk-700' : 'border-paper-200 hover:border-paper-300 text-ink-700'
              }`}
            >Reject all selected</button>
          </div>

          {/* Selection list */}
          <div className="border border-paper-200 rounded-md max-h-72 overflow-y-auto">
            <div className="px-3 py-2 bg-paper-50 border-b border-paper-200 text-[11.5px] flex items-center justify-between">
              <span className="text-ink-700 tabular-nums">{selected.size} of {items.length} selected</span>
              <button
                onClick={() => setSelected(new Set(selected.size === items.length ? [] : items.map(i => i.stepId)))}
                className="font-medium text-ink-950 hover:text-ink-700"
              >
                {selected.size === items.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <ul className="divide-y divide-paper-200">
              {items.map(it => (
                <li key={it.stepId} className="px-3 py-2 hover:bg-paper-50 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selected.has(it.stepId)}
                    onChange={() => toggle(it.stepId)}
                    className="size-4 accent-ink-950"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-ink-950 truncate">{it.contract.title}</div>
                    <div className="text-[11.5px] text-ink-500 truncate">
                      {it.contract.type} · {it.stepName} · submitted by {it.instance.submittedByName ?? 'unknown'}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <label className="block text-dense font-semibold text-ink-700 mb-1">
              Comment {isRejecting && <span className="text-risk-600">*</span>}
              {!isRejecting && <span className="text-ink-400 font-normal"> (optional)</span>}
            </label>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder={isRejecting ? 'Reason for rejection — applied to every selected item' : 'Optional note recorded against each decision'}
              rows={2}
              className="w-full text-[13px] text-ink-950 bg-card border border-input rounded-md px-3 py-2 placeholder:text-ink-400 focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/12 resize-y"
            />
          </div>

          {progress && (
            <div
              className={`text-[13px] border rounded-md px-3 py-2 ${
                progress.failed > 0
                  ? 'bg-risk-50 border-risk-200'
                  : 'bg-info-50 border-info-200'
              }`}
            >
              {progress.done + progress.failed === progress.total ? (
                progress.failed > 0 ? (
                  <span className="text-risk-700 tabular-nums" data-testid="bulk-partial-failure">
                    {progress.done} of {progress.total} processed · {progress.failed} failed
                  </span>
                ) : (
                  // Every decision landed — the run is binding, so brand is earned.
                  <span className="text-brand-700 tabular-nums">
                    ✓ {progress.done} of {progress.total} processed
                  </span>
                )
              ) : (
                <span className="text-info-700 tabular-nums">
                  <Loader2 className="size-4 animate-spin inline mr-1" />
                  Processing {progress.done + progress.failed} of {progress.total}…
                </span>
              )}
            </div>
          )}

          {/* Name the items that failed, with the server's own reason. The
              bare `catch { failed++ }` this replaces threw that detail away,
              so the count was all anyone ever saw — in success green, for
              600 ms, before the dialog closed itself. */}
          {failures.length > 0 && (
            <div
              className="text-[13px] border border-risk-200 rounded-md divide-y divide-risk-100"
              data-testid="bulk-failure-list"
            >
              {failures.map(f => (
                <div key={f.stepId} className="px-3 py-2">
                  <div className="font-medium text-ink-950 truncate">{f.title}</div>
                  <div className="text-[11.5px] text-risk-700">{f.detail}</div>
                </div>
              ))}
              <div className="px-3 py-2">
                <Button size="sm" variant="outline" onClick={retryFailed}>
                  Retry {failures.length} failed
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-paper-200 flex justify-end gap-2 bg-paper-50 rounded-b-card">
          <Button variant="outline" onClick={onClose} disabled={!!progress}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={!valid}
            data-testid="bulk-decision-confirm"
            variant={isRejecting ? 'danger' : 'brand'}
          >
            {isRejecting ? `Reject ${selected.size}` : `Approve ${selected.size}`}
          </Button>
        </div>
      </div>
    </div>
  )
}
