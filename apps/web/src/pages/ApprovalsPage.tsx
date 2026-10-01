/**
 * Inbox — docs/41 Part 6 (it replaces the Approvals page's tabs).
 *
 * The page counted two different things under labels that didn't say so
 * (My Queue = steps waiting on me; All approvals = every open workflow), and
 * the sidebar badge came from a third query. Now one question per view, each
 * answered by GET /inbox, counted by contract:
 *
 *   • Needs my action — contracts waiting on me, each once, with what I must
 *     do: approve, decide an exception, fix and resubmit, respond to the
 *     counterparty, send for signature, sign… The sidebar badge is this
 *     list's length, from the same cached response.
 *   • Waiting on others — what I own or submitted, who has it, since when.
 *   • Team — everything in flight (configure:workflow), with filters: stuck
 *     (an approval nobody can decide), aging, by stage.
 *   • Manage workflows — workflow definitions, as before.
 *
 * Bulk decisions act on the approvals of the list as filtered, and say so.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { approvalKeys, invalidateApproval, serverMessage } from '@/lib/approval-keys'
import { usePermission } from '@/lib/permissions'
import { ApprovalCard } from '@/components/approvals/ApprovalCard'
import { WorkflowDefinitionList } from '@/components/approvals/WorkflowDefinitionList'
import { Inbox, Settings2, Loader2, AlertTriangle, Users, Clock, ListChecks, ArrowRight, CheckCircle2, XCircle, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CountBadge, EmptyState, Chip } from '@/components/ui/primitives'

type Tab = 'mine' | 'waiting' | 'team' | 'workflows'

interface InboxAction {
  kind: 'approve' | 'decide_exception' | 'sign' | 'fix_and_resubmit' | 'decide_declined' | 'respond_to_counterparty' | 'send_for_signature' | 'take_back_signature'
  label: string
  since: string
  stepId?: string
  instanceId?: string
  findingId?: string
  signatureRequestId?: string
  detail?: string | null
}

export interface InboxRow {
  contractId: string
  title: string
  type: string
  counterpartyName: string | null
  value: number | null
  currency: string | null
  stage: string
  stageState: string
  turn: string
  turnSince: string
  line: string
  owner: { id: string; name: string }
  actions: InboxAction[]
  primary: InboxAction | null
  waitingOn: { who: string; names: string[]; since: string; sinceWords: string | null } | null
  approvals: { approved: number; total: number } | null
  stuck?: string | null
}

interface InboxResponse {
  view: string
  data: InboxRow[]
  total: number
  counts: { mine: number }
  canTeam: boolean
  stages?: Array<{ stage: string; label: string }>
}

/** The queue's cards, for the approval steps (they carry the AI summary). */
interface QueueItem {
  stepId: string
  instanceId: string
  stepName: string
  escalateAt?: string
  contract: { id: string; title: string; type: string; value?: number | null; counterpartyName?: string | null; status: string }
  instance: { id: string; status: string; submittedAt: string; submittedByName?: string; aiSummary?: string; keyRisks?: Array<{ title: string; description: string; severity: string }>; nonStandardTerms?: string[]; approvalRecommendation?: string; recommendationReasons?: string[] }
}

function money(value: number | null, currency: string | null): string | null {
  if (value == null || !Number.isFinite(value) || value === 0) return null
  return `${currency ?? 'USD'} ${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

function daysSince(iso: string): number {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86_400_000)) : 0
}

function AgeDot({ iso }: { iso: string }) {
  const d = daysSince(iso)
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium tabular-nums text-ink-700" title={new Date(iso).toLocaleString()}>
      <span className={`size-1.5 rounded-full shrink-0 ${d >= 7 ? 'bg-risk-600' : d >= 3 ? 'bg-attention-600' : 'bg-ink-350'}`} />
      {d === 0 ? 'today' : `${d}d`}
    </span>
  )
}

export function ApprovalsPage() {
  const [tab, setTab] = useState<Tab>('mine')
  const [query, setQuery] = useState('')
  const [bulkOpen, setBulkOpen] = useState(false)
  const [team, setTeam] = useState<{ stuck: boolean; agingDays: number | null; stage: string }>({ stuck: false, agingDays: null, stage: '' })
  const canTeam = usePermission('configure', 'workflow')
  const qc = useQueryClient()

  const params = tab === 'team'
    ? { view: 'team', ...(team.stuck && { stuck: '1' }), ...(team.agingDays && { agingDays: String(team.agingDays) }), ...(team.stage && { stage: team.stage }) }
    : { view: tab === 'waiting' ? 'waiting' : 'mine' }
  // "mine" shares its cache entry with the sidebar badge (approvalKeys.inboxView('mine')).
  const key = tab === 'team' ? approvalKeys.inboxView('team', team) : approvalKeys.inboxView(params.view)
  const { data, isLoading, isError, error } = useQuery<InboxResponse>({
    queryKey: key,
    queryFn: () => api.get('/inbox', { params }).then(r => r.data),
    enabled: tab !== 'workflows',
    staleTime: 10_000,
  })
  // The mine count for the tab badge, whichever view is open.
  const { data: mine } = useQuery<InboxResponse>({
    queryKey: approvalKeys.inboxView('mine'),
    queryFn: () => api.get('/inbox', { params: { view: 'mine' } }).then(r => r.data),
    staleTime: 10_000,
  })
  // The approval steps' cards (AI summary, risks) for rows whose action is "Approve".
  const { data: queue } = useQuery<{ data: QueueItem[] }>({
    queryKey: approvalKeys.myQueue,
    queryFn: () => api.get('/approvals/my-queue').then(r => r.data),
    enabled: tab === 'mine',
    staleTime: 10_000,
  })
  const cardOf = useMemo(() => new Map((queue?.data ?? []).map(q => [q.stepId, q])), [queue])

  const { data: workflowsData } = useQuery<unknown>({
    queryKey: ['approval-workflows'],
    queryFn: () => api.get('/approvals/workflows').then(r => r.data),
    staleTime: 30_000,
  })
  const workflowList = Array.isArray(workflowsData) ? workflowsData : (workflowsData as { data?: unknown[] } | null)?.data ?? null
  const showNoWorkflowsWarning = Array.isArray(workflowList) && workflowList.length === 0

  const rows = (data?.data ?? []).filter(r => {
    const q = query.trim().toLowerCase()
    return !q || r.title.toLowerCase().includes(q) || (r.counterpartyName ?? '').toLowerCase().includes(q) || r.type.toLowerCase().includes(q)
  })
  // What a bulk decision acts on: the approvals of the list as it is filtered.
  const bulkTargets = rows.flatMap(r => r.actions.filter(a => a.kind === 'approve' && a.stepId && a.instanceId).map(a => ({ row: r, action: a })))
  const mineCount = mine?.counts.mine ?? 0

  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode; badge?: number; tone?: 'attention' | 'neutral' }> = [
    { id: 'mine', label: 'Needs my action', icon: <Inbox className="size-4" />, badge: mineCount, tone: 'attention' },
    { id: 'waiting', label: 'Waiting on others', icon: <Clock className="size-4" /> },
    ...(canTeam ? [{ id: 'team' as Tab, label: 'Team', icon: <Users className="size-4" /> }] : []),
    { id: 'workflows', label: 'Manage workflows', icon: <Settings2 className="size-4" /> },
  ]

  return (
    <div className="h-full flex flex-col bg-paper-50">
      <div className="bg-card border-b border-paper-200 px-6 py-4">
        <h1 className="text-title text-ink-950">Inbox</h1>
        <p className="text-body text-ink-500 mt-0.5">
          {mineCount > 0
            ? `${mineCount} contract${mineCount === 1 ? '' : 's'} need${mineCount === 1 ? 's' : ''} something from you.`
            : 'Nothing is waiting on you. Contracts others have are under Waiting on others.'}
        </p>
        <div className="flex gap-1 mt-3 border-b border-paper-200 -mb-px">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-[13px] font-medium border-b-2 transition-colors ${tab === t.id ? 'border-ink-950 text-ink-950' : 'border-transparent text-ink-500 hover:text-ink-950'}`}
              data-testid={`inbox-tab-${t.id}`}
            >
              {t.icon}
              {t.label}
              {t.badge != null && t.badge > 0 && <CountBadge tone={t.tone ?? 'neutral'}>{t.badge}</CountBadge>}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {showNoWorkflowsWarning && tab !== 'workflows' && (
          <div role="alert" data-testid="no-workflows-warning" className="max-w-5xl mx-auto mb-5 rounded-md border border-attention-200 bg-attention-50 px-4 py-3 flex items-start gap-3">
            <AlertTriangle className="size-4 text-attention-600 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-body font-semibold text-attention-700">No approval workflows yet.</p>
              <p className="text-dense text-ink-700 mt-0.5">Contracts can't be submitted for approval until one exists.</p>
            </div>
            <button onClick={() => setTab('workflows')} className="text-dense font-semibold text-ink-950 underline underline-offset-2 decoration-paper-300 hover:decoration-ink-950 shrink-0">Create workflow →</button>
          </div>
        )}

        {tab === 'workflows' ? (
          <div className="max-w-3xl mx-auto">
            <p className="text-body text-ink-500 mb-5">Workflows decide who approves a contract, in what order, and when an approval is asked for again after a change.</p>
            <WorkflowDefinitionList />
          </div>
        ) : (
          <div className="max-w-5xl mx-auto">
            {/* Filters: the text filter narrows every view; Team has its own. */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <label className="relative flex-1 min-w-[200px] max-w-sm">
                <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Filter by title, counterparty or type"
                  className="w-full h-8 pl-8 pr-2 text-[13px] rounded-md border border-input bg-card placeholder:text-ink-400 focus:outline-none focus:border-brand-700"
                  data-testid="inbox-filter"
                />
              </label>
              {tab === 'team' && (
                <>
                  <label className="inline-flex items-center gap-1.5 text-dense text-ink-700">
                    <input type="checkbox" className="size-3.5 accent-ink-950" checked={team.stuck} onChange={e => setTeam(t => ({ ...t, stuck: e.target.checked }))} data-testid="team-stuck" />
                    Stuck (no one can approve)
                  </label>
                  <select value={team.agingDays ?? ''} onChange={e => setTeam(t => ({ ...t, agingDays: e.target.value ? Number(e.target.value) : null }))} className="h-8 rounded-md border border-input bg-card text-[13px] px-2" data-testid="team-aging">
                    <option value="">Any age</option>
                    {[3, 7, 14, 30].map(d => <option key={d} value={d}>Waiting {d}+ days</option>)}
                  </select>
                  <select value={team.stage} onChange={e => setTeam(t => ({ ...t, stage: e.target.value }))} className="h-8 rounded-md border border-input bg-card text-[13px] px-2" data-testid="team-stage">
                    <option value="">Every stage</option>
                    {(data?.stages ?? []).map(s => <option key={s.stage} value={s.stage}>{s.label}</option>)}
                  </select>
                </>
              )}
              {tab === 'mine' && bulkTargets.length > 1 && (
                <Button variant="outline" size="sm" className="ml-auto" onClick={() => setBulkOpen(true)} data-testid="bulk-approve-btn">
                  <ListChecks />Decide {bulkTargets.length} approvals at once…
                </Button>
              )}
            </div>

            {isLoading ? (
              <div className="flex justify-center items-center py-20"><Loader2 className="size-6 animate-spin text-ink-400" /></div>
            ) : isError ? (
              <div role="alert" className="rounded-md border border-risk-200 bg-risk-50 px-4 py-3 text-dense text-risk-700">{serverMessage(error, 'The inbox could not be loaded.')}</div>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={<Inbox />}
                title={tab === 'mine' ? 'All clear' : tab === 'waiting' ? 'Nothing waiting on others' : 'Nothing in flight matches'}
                description={tab === 'mine' ? 'No contract needs anything from you right now.' : tab === 'waiting' ? 'Contracts you own or submitted that someone else has will show here.' : 'Change the filters to see more.'}
              />
            ) : tab === 'mine' ? (
              <div className="space-y-3" data-testid="inbox-mine">
                {rows.map(r => <MineRow key={r.contractId} row={r} cardOf={cardOf} onDone={() => invalidateApproval(qc, r.contractId)} />)}
              </div>
            ) : (
              <OthersTable rows={rows} team={tab === 'team'} />
            )}

            {bulkOpen && (
              <BulkDecisionDialog
                targets={bulkTargets}
                filtered={!!query.trim()}
                onClose={() => setBulkOpen(false)}
                onDecided={(contractIds) => { for (const c of contractIds) invalidateApproval(qc, c); if (!contractIds.length) invalidateApproval(qc) }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** One contract that needs me: what to do, why, and the way to do it. */
function MineRow({ row, cardOf, onDone }: { row: InboxRow; cardOf: Map<string, QueueItem>; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const primary = row.primary!
  const approve = row.actions.find(a => a.kind === 'approve')
  const card = approve?.stepId ? cardOf.get(approve.stepId) : undefined
  const exception = row.actions.find(a => a.kind === 'decide_exception')
  const value = money(row.value, row.currency)
  const linkTo = primary.kind === 'sign' && primary.signatureRequestId ? `/signatures` : `/contracts/${row.contractId}`

  return (
    <div className="rounded-card border border-paper-200 bg-card" data-testid={`inbox-row-${row.contractId}`}>
      <div className="px-4 py-3 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <Link to={`/contracts/${row.contractId}`} className="text-[13.5px] font-semibold text-ink-950 hover:underline underline-offset-2 decoration-paper-300 truncate block">{row.title}</Link>
          <div className="text-[11.5px] text-ink-500 mt-0.5 truncate">
            {row.type}{row.counterpartyName ? ` · ${row.counterpartyName}` : ''}{value ? ` · ${value}` : ''} · {row.line}
          </div>
          {primary.detail && (
            <p className="mt-1.5 text-dense text-ink-700">
              {primary.kind === 'fix_and_resubmit' || primary.kind === 'decide_declined' ? <>Reason: “{primary.detail}”</> : primary.detail}
            </p>
          )}
          {row.actions.length > 1 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {row.actions.slice(1).map((a, i) => <Chip key={i}>Also: {a.label}</Chip>)}
            </div>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <AgeDot iso={primary.since} />
          {primary.kind === 'approve' && card ? (
            <Button size="sm" variant={open ? 'outline' : 'default'} onClick={() => setOpen(o => !o)} data-testid="inbox-approve">{open ? 'Close' : 'Review and decide'}</Button>
          ) : primary.kind === 'decide_exception' ? (
            <Button size="sm" variant={open ? 'outline' : 'default'} onClick={() => setOpen(o => !o)} data-testid="inbox-exception">{open ? 'Close' : primary.label}</Button>
          ) : (
            <Button size="sm" asChild><Link to={linkTo}>{primary.label}<ArrowRight /></Link></Button>
          )}
        </div>
      </div>
      {open && primary.kind === 'approve' && card && (
        <div className="border-t border-paper-200 p-3 bg-paper-50">
          <ApprovalCard stepId={card.stepId} instanceId={card.instanceId} stepName={card.stepName} escalateAt={card.escalateAt} contract={card.contract} instance={card.instance} onDecided={onDone} />
        </div>
      )}
      {open && primary.kind === 'decide_exception' && exception?.stepId && (
        <ExceptionDecision stepId={exception.stepId} contractId={row.contractId} title={exception.detail ?? 'the clause'} onDone={onDone} />
      )}
    </div>
  )
}

/** docs/41 Part 7 — an exception to a playbook position: approve it, or decline it with a reason. */
function ExceptionDecision({ stepId, contractId, title, onDone }: { stepId: string; contractId: string; title: string; onDone: () => void }) {
  const qc = useQueryClient()
  const [decision, setDecision] = useState<'APPROVED' | 'DECLINED' | null>(null)
  const [comment, setComment] = useState('')
  const { data: approval } = useQuery<{ exceptions?: Array<{ id: string; reason: string | null; requestedBy: string | null }> }>({
    queryKey: approvalKeys.contract(contractId),
    queryFn: () => api.get(`/contracts/${contractId}/approval`).then(r => r.data),
  })
  const asked = approval?.exceptions?.find(e => e.id === stepId)
  const decide = useMutation({
    mutationFn: () => api.post(`/approvals/steps/${stepId}/decide`, { decision, comment: comment.trim() || undefined }).then(r => r.data),
    onSuccess: () => { invalidateApproval(qc, contractId); qc.invalidateQueries({ queryKey: ['contract-review', contractId] }); onDone() },
    onError: () => {},
  })
  return (
    <div className="border-t border-paper-200 px-4 py-3 space-y-2 bg-paper-50" data-testid="exception-decision">
      <p className="text-dense text-ink-700">
        Exception asked for: <span className="font-medium text-ink-950">{title}</span>
        {asked?.requestedBy && <> by {asked.requestedBy}</>}
        {asked?.reason && <> — “{asked.reason}”</>}
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant={decision === 'APPROVED' ? 'brand' : 'outline'} onClick={() => setDecision('APPROVED')}><CheckCircle2 />Approve exception</Button>
        <Button size="sm" variant={decision === 'DECLINED' ? 'destructive' : 'danger'} onClick={() => setDecision('DECLINED')}><XCircle />Decline</Button>
      </div>
      {decision && (
        <textarea
          value={comment}
          onChange={e => setComment(e.target.value)}
          rows={2}
          placeholder={decision === 'DECLINED' ? 'Why not (required). The person who asked sees this.' : 'Optional note'}
          className="w-full text-[13px] rounded-md border border-input bg-card px-2.5 py-1.5 placeholder:text-ink-400 focus:outline-none focus:border-brand-700"
        />
      )}
      {decision && (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => decide.mutate()} disabled={decide.isPending || (decision === 'DECLINED' && !comment.trim())}>
            {decide.isPending && <Loader2 className="animate-spin" />}{decision === 'APPROVED' ? 'Approve exception' : 'Decline exception'}
          </Button>
          {decide.isError && <span className="text-dense text-risk-700">{serverMessage(decide.error, 'The decision wasn’t recorded — try again.')}</span>}
        </div>
      )}
    </div>
  )
}

/** Waiting on others and Team: who has each contract, and since when. */
function OthersTable({ rows, team }: { rows: InboxRow[]; team: boolean }) {
  return (
    <div className="rounded-card border border-paper-200 bg-card overflow-hidden" data-testid={team ? 'inbox-team' : 'inbox-waiting'}>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-[13px]">
          <thead className="bg-paper-50">
            <tr className="text-left text-eyebrow uppercase text-ink-500">
              <th className="px-4 py-2 font-semibold">Contract</th>
              <th className="px-3 py-2 font-semibold w-[26%]">Where it is</th>
              <th className="px-3 py-2 font-semibold w-[22%]">Who has it</th>
              <th className="px-3 py-2 font-semibold w-[76px]">Since</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-paper-200">
            {rows.map(r => (
              <tr key={r.contractId} className="hover:bg-paper-50 transition-colors">
                <td className="px-4 py-2">
                  <Link to={`/contracts/${r.contractId}`} className="font-medium text-ink-950 hover:underline underline-offset-2 decoration-paper-300 truncate block" title={r.title}>{r.title}</Link>
                  <div className="text-[11px] text-ink-500 mt-0.5 truncate">{r.type}{r.counterpartyName ? ` · ${r.counterpartyName}` : ''}{team ? ` · owner ${r.owner.name}` : ''}</div>
                </td>
                <td className="px-3 py-2 text-[11.5px] text-ink-700">
                  <div className="truncate" title={r.line}>{r.line.split(' · ').slice(0, 2).join(' · ')}</div>
                  {r.approvals && r.stage === 'approve' && <div className="text-ink-400 tabular-nums mt-0.5">Approvals {r.approvals.approved} of {r.approvals.total}</div>}
                </td>
                <td className="px-3 py-2 text-[12px] text-ink-700">
                  {r.stuck ? (
                    <span className="inline-flex items-start gap-1 font-medium text-risk-700" title={r.stuck}><AlertTriangle className="size-3 shrink-0 mt-0.5" />Stuck: {r.stuck}</span>
                  ) : (
                    <div className="truncate" title={r.waitingOn?.names.join(', ')}>
                      {r.waitingOn?.who === 'Approvers' || r.waitingOn?.who === 'Signers' ? `${r.waitingOn.who}: ${r.waitingOn.names.join(', ') || '—'}` : r.waitingOn?.names.join(', ') || r.waitingOn?.who || '—'}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2"><AgeDot iso={r.waitingOn?.since ?? r.turnSince} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Bulk decision (P10D) ───────────────────────────────────────────────────
// docs/41 Part 6 — acts only on the approvals of the list as it is shown
// (after the filter), and the dialog says so. A return needs a reason,
// applied to each.
function BulkDecisionDialog({ targets, filtered, onClose, onDecided }: {
  targets: Array<{ row: InboxRow; action: InboxAction }>
  filtered: boolean
  onClose: () => void
  onDecided?: (contractIds: string[]) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(targets.map(t => t.action.stepId!)))
  const [decision, setDecision] = useState<'APPROVED' | 'RETURNED'>('APPROVED')
  const [comment, setComment] = useState('')
  const [progress, setProgress] = useState<{ done: number; failed: number; total: number } | null>(null)
  const [failures, setFailures] = useState<Array<{ stepId: string; title: string; detail: string }>>([])

  const toggle = (id: string) => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const submit = async () => {
    const chosen = targets.filter(t => selected.has(t.action.stepId!))
    setProgress({ done: 0, failed: 0, total: chosen.length })
    setFailures([])
    let done = 0
    const failed: Array<{ stepId: string; title: string; detail: string }> = []
    for (const t of chosen) {
      try {
        await api.post(`/approvals/${t.action.instanceId}/decide`, { stepId: t.action.stepId, decision, comment: comment.trim() || undefined, via: 'bulk' })
        done++
      } catch (err) {
        failed.push({ stepId: t.action.stepId!, title: t.row.title, detail: serverMessage(err, 'Request failed') })
      }
      setProgress({ done, failed: failed.length, total: chosen.length })
    }
    setFailures(failed)
    const failedSteps = new Set(failed.map(f => f.stepId))
    onDecided?.([...new Set(chosen.filter(t => !failedSteps.has(t.action.stepId!)).map(t => t.row.contractId))])
    if (!failed.length) setTimeout(onClose, 600)
  }
  const returning = decision === 'RETURNED'
  const valid = selected.size > 0 && (!returning || comment.trim().length > 0) && !progress

  return (
    <div role="dialog" className="fixed inset-0 z-50 bg-ink-950/40 flex items-center justify-center p-4 overflow-auto" onClick={onClose} data-testid="bulk-decision-dialog">
      <div className="bg-card rounded-card max-w-2xl w-full shadow-e3 my-8" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-paper-200">
          <h2 className="text-section text-ink-950 flex items-center gap-2"><ListChecks className="size-4 text-ink-400" />Decide several approvals</h2>
          <p className="text-dense text-ink-500 mt-1">
            This applies to the {targets.length} approval{targets.length === 1 ? '' : 's'} in your list{filtered ? ' as it is filtered now' : ''} — only the ones ticked below. Nothing else in your inbox changes.
          </p>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="flex gap-2">
            <button type="button" onClick={() => setDecision('APPROVED')} data-testid="bulk-decision-approve" className={`flex-1 p-3 rounded-md border text-[13px] font-medium transition-colors ${decision === 'APPROVED' ? 'border-brand-700 bg-brand-50 text-brand-700' : 'border-paper-200 hover:border-paper-300 text-ink-700'}`}>Approve the ticked ones</button>
            <button type="button" onClick={() => setDecision('RETURNED')} data-testid="bulk-decision-return" className={`flex-1 p-3 rounded-md border text-[13px] font-medium transition-colors ${decision === 'RETURNED' ? 'border-ink-950 bg-paper-100 text-ink-950' : 'border-paper-200 hover:border-paper-300 text-ink-700'}`}>Return the ticked ones for changes</button>
          </div>
          <div className="border border-paper-200 rounded-md max-h-72 overflow-y-auto">
            <div className="px-3 py-2 bg-paper-50 border-b border-paper-200 text-[11.5px] flex items-center justify-between">
              <span className="text-ink-700 tabular-nums">{selected.size} of {targets.length} ticked</span>
              <button onClick={() => setSelected(new Set(selected.size === targets.length ? [] : targets.map(t => t.action.stepId!)))} className="font-medium text-ink-950 hover:text-ink-700">{selected.size === targets.length ? 'Untick all' : 'Tick all'}</button>
            </div>
            <ul className="divide-y divide-paper-200">
              {targets.map(t => (
                <li key={t.action.stepId} className="px-3 py-2 hover:bg-paper-50 flex items-center gap-2">
                  <input type="checkbox" checked={selected.has(t.action.stepId!)} onChange={() => toggle(t.action.stepId!)} className="size-4 accent-ink-950" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-ink-950 truncate">{t.row.title}</div>
                    <div className="text-[11.5px] text-ink-500 truncate">{t.row.type} · {t.action.detail ?? 'Approval'}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <label className="block text-dense font-semibold text-ink-700 mb-1">{returning ? 'What needs to change' : 'Note'}{returning ? <span className="text-risk-600"> *</span> : <span className="text-ink-400 font-normal"> (optional)</span>}</label>
            <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} placeholder={returning ? 'Sent to each owner with their contract' : 'Recorded with each decision'} className="w-full text-[13px] text-ink-950 bg-card border border-input rounded-md px-3 py-2 placeholder:text-ink-400 focus-visible:outline-none focus-visible:border-brand-700 resize-y" />
          </div>
          {progress && (
            <div className={`text-[13px] border rounded-md px-3 py-2 ${progress.failed > 0 ? 'bg-risk-50 border-risk-200' : 'bg-info-50 border-info-200'}`}>
              {progress.done + progress.failed === progress.total
                ? progress.failed > 0
                  ? <span className="text-risk-700 tabular-nums" data-testid="bulk-partial-failure">{progress.done} of {progress.total} done · {progress.failed} failed</span>
                  : <span className="text-brand-700 tabular-nums">✓ {progress.done} of {progress.total} done</span>
                : <span className="text-info-700 tabular-nums"><Loader2 className="size-4 animate-spin inline mr-1" />Working on {progress.done + progress.failed} of {progress.total}…</span>}
            </div>
          )}
          {failures.length > 0 && (
            <div className="text-[13px] border border-risk-200 rounded-md divide-y divide-risk-100" data-testid="bulk-failure-list">
              {failures.map(f => (
                <div key={f.stepId} className="px-3 py-2"><div className="font-medium text-ink-950 truncate">{f.title}</div><div className="text-[11.5px] text-risk-700">{f.detail}</div></div>
              ))}
              <div className="px-3 py-2"><Button size="sm" variant="outline" onClick={() => { setSelected(new Set(failures.map(f => f.stepId))); setProgress(null); setFailures([]) }}>Retry {failures.length} failed</Button></div>
            </div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-paper-200 flex justify-end gap-2 bg-paper-50 rounded-b-card">
          <Button variant="outline" onClick={onClose} disabled={!!progress && progress.done + progress.failed < progress.total}>Close</Button>
          <Button onClick={submit} disabled={!valid} data-testid="bulk-decision-confirm" variant={returning ? 'default' : 'brand'}>
            {returning ? `Return ${selected.size} for changes` : `Approve ${selected.size}`}
          </Button>
        </div>
      </div>
    </div>
  )
}
