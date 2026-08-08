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
    <div className="h-full flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Approvals</h1>
            {pendingCount > 0 && (
              <p className="text-sm text-gray-500 mt-0.5">{pendingCount} pending your decision</p>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-3 border-b border-gray-100 -mb-px">
          {([
            { id: 'queue' as Tab,     label: 'My Queue', icon: <CheckSquare className="h-4 w-4" />, badge: pendingCount },
            ...(canSeeAll ? [{ id: 'all' as Tab, label: 'All approvals', icon: <Globe2 className="h-4 w-4" />, badge: allCount }] : []),
            { id: 'workflows' as Tab, label: 'Manage Workflows', icon: <Settings2 className="h-4 w-4" /> },
          ] as { id: Tab; label: string; icon: React.ReactNode; badge?: number }[]).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.icon}
              {t.label}
              {t.badge != null && t.badge > 0 && (
                <span className="ml-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-100 text-blue-700 text-xs font-semibold px-1.5">
                  {t.badge}
                </span>
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
            className="max-w-3xl mx-auto mb-5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-3"
          >
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0 text-sm">
              <p className="font-semibold text-amber-900">
                No approval workflows defined yet.
              </p>
              <p className="text-amber-800/80 text-xs mt-0.5 leading-relaxed">
                Until someone creates a workflow, the "Submit for Approval"
                button on contracts won't know where to route decisions and
                will fail quietly. Create one to unblock your team.
              </p>
            </div>
            <button
              onClick={() => setTab('workflows')}
              className="text-xs font-semibold text-amber-900 underline hover:text-amber-950 shrink-0"
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
                <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-gray-400 gap-3">
                <Inbox className="w-12 h-12" />
                <div className="text-center">
                  <p className="text-base font-semibold text-gray-600">All clear</p>
                  <p className="text-sm mt-1">No contracts are awaiting your approval.</p>
                </div>
              </div>
            ) : (
              <>
                {items.length > 1 && (
                  <div className="max-w-5xl mx-auto mb-3 flex items-center justify-between gap-2">
                    <span className="text-xs text-gray-500">
                      {items.length} item{items.length === 1 ? '' : 's'} awaiting your decision
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setBulkOpen(true)}
                      data-testid="bulk-approve-btn"
                      className="gap-1.5"
                    >
                      <ListChecks className="h-4 w-4" />
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
                <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
              </div>
            ) : allItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-gray-400 gap-3">
                <Globe2 className="w-12 h-12" />
                <div className="text-center">
                  <p className="text-base font-semibold text-gray-600">No approvals in flight</p>
                  <p className="text-sm mt-1">No contracts are pending approval anywhere in the org.</p>
                </div>
              </div>
            ) : (
              <div className="max-w-5xl mx-auto" data-testid="all-approvals-list">
                <p className="text-sm text-gray-500 mb-3">
                  Org-wide view of every approval in flight. Use this to spot where deals are stuck.
                </p>
                <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr className="text-left text-xs uppercase tracking-wider text-gray-500">
                        <th className="px-4 py-2.5 font-semibold">Contract</th>
                        <th className="px-4 py-2.5 font-semibold">Current step</th>
                        <th className="px-4 py-2.5 font-semibold">Awaiting</th>
                        <th className="px-4 py-2.5 font-semibold">Submitted</th>
                        <th className="px-4 py-2.5 font-semibold">Waiting</th>
                        <th className="px-4 py-2.5"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {allItems.map(row => {
                        const dotClass = row.waitingDays >= 7 ? 'bg-red-500' :
                                         row.waitingDays >= 3 ? 'bg-amber-500' :
                                         'bg-emerald-500'
                        const waitingText = row.waitingDays === 0 ? 'today' :
                                            row.waitingDays === 1 ? '1d' :
                                            `${row.waitingDays}d`
                        return (
                          <tr key={row.instanceId} className="hover:bg-gray-50 transition-colors">
                            <td className="px-4 py-3">
                              <Link
                                to={`/contracts/${row.contract?.id}`}
                                className="font-medium text-gray-900 hover:text-blue-600"
                              >
                                {row.contract?.title ?? 'Unknown'}
                              </Link>
                              {row.contract?.counterpartyName && (
                                <div className="text-xs text-gray-500 mt-0.5">
                                  {row.contract.counterpartyName}
                                  {row.contract.value && ` · ${row.contract.currency ?? 'USD'} ${row.contract.value.toLocaleString()}`}
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3 text-gray-700 text-xs">
                              <div className="font-medium">{row.currentStepName ?? '—'}</div>
                              <div className="text-gray-400 mt-0.5">step {row.currentStepOrder} of {row.totalSteps}</div>
                            </td>
                            <td className="px-4 py-3 text-gray-700 text-sm">
                              {row.currentApproverName ?? <span className="text-gray-400 italic">unassigned</span>}
                            </td>
                            <td className="px-4 py-3 text-gray-500 text-xs">
                              <div>{row.submittedByName}</div>
                              <div className="text-gray-400 mt-0.5">{new Date(row.submittedAt).toLocaleDateString()}</div>
                            </td>
                            <td className="px-4 py-3">
                              <span className={`inline-flex items-center gap-1 text-xs font-medium`}>
                                <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
                                {waitingText}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <Link
                                to={`/contracts/${row.contract?.id}`}
                                className="inline-flex items-center gap-0.5 text-xs text-blue-600 hover:text-blue-700"
                              >
                                Open
                                <ArrowRight className="h-3 w-3" />
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
            <p className="text-sm text-gray-500 mb-5">
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
    <div role="dialog" className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 overflow-auto" onClick={onClose} data-testid="bulk-decision-dialog">
      <div className="bg-white rounded-xl max-w-2xl w-full shadow-2xl my-8" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <ListChecks className="h-5 w-5 text-blue-600" />
              Bulk decision
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              Apply a single decision (with optional comment) to multiple pending approvals.
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400">×</button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* Decision picker */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setDecision('APPROVED')}
              data-testid="bulk-decision-approve"
              className={`flex-1 p-3 rounded-md border text-sm font-medium transition-colors ${
                decision === 'APPROVED' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-gray-200 hover:border-gray-300 text-gray-700'
              }`}
            >Approve all selected</button>
            <button
              type="button"
              onClick={() => setDecision('REJECTED')}
              data-testid="bulk-decision-reject"
              className={`flex-1 p-3 rounded-md border text-sm font-medium transition-colors ${
                decision === 'REJECTED' ? 'border-red-500 bg-red-50 text-red-700' : 'border-gray-200 hover:border-gray-300 text-gray-700'
              }`}
            >Reject all selected</button>
          </div>

          {/* Selection list */}
          <div className="border border-gray-200 rounded-md max-h-72 overflow-y-auto">
            <div className="px-3 py-2 bg-gray-50 border-b text-xs flex items-center justify-between">
              <span className="text-gray-600">{selected.size} of {items.length} selected</span>
              <button
                onClick={() => setSelected(new Set(selected.size === items.length ? [] : items.map(i => i.stepId)))}
                className="text-blue-600 hover:text-blue-700"
              >
                {selected.size === items.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <ul className="divide-y divide-gray-100">
              {items.map(it => (
                <li key={it.stepId} className="px-3 py-2 hover:bg-gray-50 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selected.has(it.stepId)}
                    onChange={() => toggle(it.stepId)}
                    className="h-4 w-4"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{it.contract.title}</div>
                    <div className="text-xs text-gray-500 truncate">
                      {it.contract.type} · {it.stepName} · submitted by {it.instance.submittedByName ?? 'unknown'}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Comment {isRejecting && <span className="text-red-600">*</span>}
              {!isRejecting && <span className="text-gray-400 font-normal"> (optional)</span>}
            </label>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder={isRejecting ? 'Reason for rejection — applied to every selected item' : 'Optional note recorded against each decision'}
              rows={2}
              className="w-full text-sm border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-400 resize-y"
            />
          </div>

          {progress && (
            <div
              className={`text-sm border rounded-md px-3 py-2 ${
                progress.failed > 0
                  ? 'bg-red-50 border-red-200'
                  : 'bg-blue-50 border-blue-200'
              }`}
            >
              {progress.done + progress.failed === progress.total ? (
                progress.failed > 0 ? (
                  <span className="text-red-700" data-testid="bulk-partial-failure">
                    {progress.done} of {progress.total} processed · {progress.failed} failed
                  </span>
                ) : (
                  <span className="text-emerald-700">
                    ✓ {progress.done} of {progress.total} processed
                  </span>
                )
              ) : (
                <>
                  <Loader2 className="h-4 w-4 animate-spin inline mr-1" />
                  Processing {progress.done + progress.failed} of {progress.total}…
                </>
              )}
            </div>
          )}

          {/* Name the items that failed, with the server's own reason. The
              bare `catch { failed++ }` this replaces threw that detail away,
              so the count was all anyone ever saw — in success green, for
              600 ms, before the dialog closed itself. */}
          {failures.length > 0 && (
            <div
              className="text-sm border border-red-200 rounded-md divide-y divide-red-100"
              data-testid="bulk-failure-list"
            >
              {failures.map(f => (
                <div key={f.stepId} className="px-3 py-2">
                  <div className="font-medium text-gray-900 truncate">{f.title}</div>
                  <div className="text-xs text-red-700">{f.detail}</div>
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

        <div className="px-6 py-4 border-t flex justify-end gap-2 bg-gray-50 rounded-b-xl">
          <Button variant="outline" onClick={onClose} disabled={!!progress}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={!valid}
            data-testid="bulk-decision-confirm"
            className={isRejecting ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'}
          >
            {isRejecting ? `Reject ${selected.size}` : `Approve ${selected.size}`}
          </Button>
        </div>
      </div>
    </div>
  )
}
