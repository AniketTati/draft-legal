import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/ui/status-pill'
import { Chip, Eyebrow } from '@/components/ui/primitives'
import { AssistMark, AssistCard } from '@/components/ui/assist'
import {
  X, Loader2, CheckCircle, XCircle, MessageSquare, User,
  ChevronRight, AlertTriangle,
} from 'lucide-react'

/**
 * Colour comes from lib/status now; only the wording is local, because this
 * panel has always spelled these two states out longhand.
 */
const STATUS_LABEL: Record<string, string> = {
  SUBMITTED:        'Submitted',
  IN_REVIEW:        'In Review',
  ACCEPTED:         'Accepted',
  REJECTED:         'Rejected',
  MORE_INFO_NEEDED: 'More Info Needed',
  COMPLETED:        'Completed',
}

/**
 * Priority, as prose and mostly without colour — see the long note in
 * RequestsPage. A request's priority is a property of the request, not of the
 * pair (request, viewer), so it cannot mean "your turn"; and "blocking a deal"
 * is urgency, not the legal exposure that red is reserved for. Only URGENT
 * keeps a mark, and it is a dot rather than a wash so the status pill beside
 * it stays the loudest thing in the header.
 */
const PRIORITY: Record<string, { label: string; cls: string; dot?: string }> = {
  LOW:    { label: 'Low priority',    cls: 'text-ink-500' },
  MEDIUM: { label: 'Medium priority', cls: 'text-ink-500' },
  HIGH:   { label: 'High priority',   cls: 'text-ink-700 font-medium' },
  URGENT: { label: 'Urgent',          cls: 'text-attention-700 font-medium', dot: 'bg-attention-600' },
}

// The eleven-hue type palette is gone. A contract type is a fact about the
// document, and none of those hues meant anything in this system.

interface AiClassification {
  contractType:      string
  suggestedPriority: string
  confidence:        number
  reason:            string
  extractedTerms: {
    counterparty?:   string | null
    estimatedValue?: number | null
    governingLaw?:   string | null
    duration?:       string | null
    startDate?:      string | null
  }
}

interface Request {
  id:              string
  requestNumber:   string | null
  title:           string
  type:            string
  status:          string
  priority:        string
  counterpartyName: string | null
  description:     string
  estimatedValue:  string | null
  assignedToId:    string | null
  createdAt:       string
  metadata:        Record<string, unknown>
}

interface Props {
  request: Request
  onClose: () => void
}

export function RequestDetailPanel({ request, onClose }: Props) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [selectedAssignee, setSelectedAssignee] = useState(request.assignedToId ?? '')
  /*
   * Rejection used to be one unguarded click on a red button: no confirm, no
   * reason captured, no undo, and — because the mutation had no `onError` —
   * no feedback at all when the PATCH failed. A colleague's intake request
   * would be marked Rejected, they'd never learn why, and half the time the
   * reviewer wouldn't know whether it had even saved. It is now a two-step
   * that states the consequence, and every mutation reports its failure.
   */
  const [rejecting, setRejecting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Escape closed nothing; the only way out was the × or a backdrop click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (rejecting) { setRejecting(false); return }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, rejecting])

  // Move focus into the panel so keyboard users aren't left behind the backdrop.
  useEffect(() => { panelRef.current?.focus() }, [])

  const { data: usersData } = useQuery({
    queryKey: ['org-users'],
    queryFn: () => api.get('/users').then(r => r.data),
  })
  const users: Array<{ id: string; name: string; email: string }> = usersData?.data ?? usersData ?? []

  const aiClassification = request.metadata?._aiClassification as AiClassification | undefined

  const failed = (e: unknown) =>
    setActionError((e as Error)?.message ?? 'That did not save. The request is unchanged.')

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch(`/requests/${request.id}`, body).then(r => r.data),
    onSuccess: () => {
      setActionError(null)
      queryClient.invalidateQueries({ queryKey: ['requests'] })
      queryClient.invalidateQueries({ queryKey: ['requests-counts'] })
      queryClient.invalidateQueries({ queryKey: ['request', request.id] })
    },
    onError: failed,
  })

  const convert = useMutation({
    mutationFn: () => api.post(`/requests/${request.id}/convert`).then(r => r.data),
    onSuccess: (data: { contractId: string }) => {
      queryClient.invalidateQueries({ queryKey: ['requests'] })
      queryClient.invalidateQueries({ queryKey: ['requests-counts'] })
      onClose()
      navigate(`/contracts/${data.contractId}`)
    },
    onError: failed,
  })

  const handleAssign = (userId: string) => {
    setSelectedAssignee(userId)
    patch.mutate({ assignedToId: userId || null })
  }

  const handleStatus = (status: string) => patch.mutate({ status })

  /*
   * No reason field here, deliberately.
   *
   * `UpdateRequestSchema` is a plain (non-strict) Zod object over
   * {assignedToId, status, priority}, so any extra key — `rejectionReason`,
   * `metadata`, anything — is silently stripped by `.parse()` and never
   * reaches Prisma. A textarea wired to that would look like it recorded the
   * reviewer's reasoning and record nothing, which is worse than not asking.
   * The confirmation step is the part that can be honest today; persisting
   * the reason needs a schema + column change on the API side.
   */
  const confirmReject = () =>
    patch.mutate({ status: 'REJECTED' }, { onSuccess: () => setRejecting(false) })

  const isActionable = !['ACCEPTED', 'REJECTED', 'COMPLETED', 'CANCELLED'].includes(request.status)
  const pri = PRIORITY[request.priority] ?? PRIORITY.MEDIUM

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-ink-950/30 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Request: ${request.title}`}
        className="w-full max-w-md bg-card shadow-e3 flex flex-col h-full overflow-hidden focus:outline-none"
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-paper-200">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {request.requestNumber && (
                <span className="text-[10px] font-mono text-ink-400">{request.requestNumber}</span>
              )}
              <StatusPill status={request.status}>{STATUS_LABEL[request.status]}</StatusPill>
              <span className={`inline-flex items-center gap-1 text-[10.5px] ${pri.cls}`}>
                {pri.dot && <span className={`size-1.5 rounded-full ${pri.dot}`} aria-hidden />}
                {pri.label}
              </span>
            </div>
            <h2 className="text-section text-ink-950 mt-1.5">{request.title}</h2>
          </div>
          <button onClick={onClose} className="ml-3 p-1.5 hover:bg-paper-100 rounded-md flex-shrink-0">
            <X className="size-4 text-ink-400" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* AI Classification card */}
          {/* Machine-authored surface — the diamond and indigo live here and
              nowhere else in this panel. */}
          <AssistCard
            eyebrow={
              <span className="inline-flex items-center gap-2">
                AI Classification
                {!aiClassification && (
                  <span className="inline-flex items-center gap-1 font-normal tracking-normal">
                    <Loader2 className="size-3 animate-spin" /> Classifying…
                  </span>
                )}
              </span>
            }
          >
            {aiClassification ? (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <Chip>{aiClassification.contractType.replace(/_/g, ' ')}</Chip>
                  {/* The mark IS the confidence reading — it goes hollow as the
                      model gets less sure, so no separate meter is needed. */}
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tabular-nums">
                    <AssistMark
                      confidence={
                        aiClassification.confidence < 0.5 ? 'low'
                        : aiClassification.confidence < 0.7 ? 'medium'
                        : 'high'
                      }
                    />
                    {Math.round(aiClassification.confidence * 100)}%
                  </span>
                </div>
                {aiClassification.reason && (
                  <p className="italic">{aiClassification.reason}</p>
                )}
                {/* Extracted terms */}
                {(() => {
                  const t = aiClassification.extractedTerms
                  const terms = [
                    t.counterparty    && ['Counterparty', t.counterparty],
                    t.estimatedValue  && ['Est. Value', `$${Number(t.estimatedValue).toLocaleString()}`],
                    t.governingLaw    && ['Governing Law', t.governingLaw],
                    t.duration        && ['Duration', t.duration],
                  ].filter(Boolean) as [string, string][]
                  return terms.length > 0 ? (
                    <div className="grid grid-cols-2 gap-1.5 pt-1">
                      {terms.map(([label, val]) => (
                        <div key={label} className="bg-card rounded-md px-2.5 py-1.5 border border-paper-200">
                          <p className="text-[9px] uppercase tracking-[0.08em] text-ink-400">{label}</p>
                          <p className="text-dense font-medium text-ink-950 truncate">{val}</p>
                        </div>
                      ))}
                    </div>
                  ) : null
                })()}
              </div>
            ) : (
              <p>AI is analysing the request in the background…</p>
            )}
          </AssistCard>

          {/* Meta */}
          <div className="space-y-3">
            <div className="flex items-center justify-between text-dense">
              <span className="text-ink-500">Contract type</span>
              <Chip>{request.type.replace(/_/g, ' ')}</Chip>
            </div>
            {request.counterpartyName && (
              <div className="flex items-center justify-between text-dense">
                <span className="text-ink-500">Counterparty</span>
                <span className="font-medium text-ink-950">{request.counterpartyName}</span>
              </div>
            )}
            {request.estimatedValue && (
              <div className="flex items-center justify-between text-dense">
                <span className="text-ink-500">Est. value</span>
                <span className="font-medium tabular-nums text-ink-950">${Number(request.estimatedValue).toLocaleString()}</span>
              </div>
            )}
            <div className="flex items-center justify-between text-dense">
              <span className="text-ink-500">Submitted</span>
              <span className="text-ink-700 tabular-nums">{new Date(request.createdAt).toLocaleDateString()}</span>
            </div>
          </div>

          {/* Description */}
          <div>
            <Eyebrow className="mb-1.5">Description</Eyebrow>
            <p className="text-body text-ink-700 whitespace-pre-wrap">{request.description}</p>
          </div>

          {/* Assignee */}
          <div>
            <Eyebrow className="mb-1.5">Assignee</Eyebrow>
            <div className="relative">
              <User className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-ink-400 pointer-events-none" />
              <select
                value={selectedAssignee}
                onChange={e => handleAssign(e.target.value)}
                disabled={!isActionable || patch.isPending}
                className="w-full h-9 text-[13px] text-ink-950 border border-input rounded-md pl-8 pr-3 bg-card focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Action footer */}
        {isActionable ? (
          <div className="border-t border-paper-200 px-5 py-4 space-y-2">
            {actionError && (
              <div
                role="alert"
                data-testid="request-action-error"
                className="flex items-start gap-2 text-dense text-risk-900 bg-risk-50 border border-risk-200 rounded-md px-3 py-2"
              >
                <AlertTriangle className="size-3.5 flex-shrink-0 mt-0.5 text-risk-600" />
                <span className="min-w-0 break-words">{actionError}</span>
              </div>
            )}

            {rejecting ? (
              /* Two-step reject. The reason is the whole point: a requester
                 who gets "Rejected" and nothing else has to come and ask. */
              <div className="space-y-2" data-testid="request-reject-confirm">
                <Eyebrow>Reject this request?</Eyebrow>
                <p className="text-dense text-ink-500">
                  “{request.title}” closes and leaves the queue. The requester
                  is not told why — follow up with them directly.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="ghost" size="sm" className="flex-1"
                    onClick={() => setRejecting(false)}
                    disabled={patch.isPending}
                    autoFocus
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="danger" size="sm" className="flex-1"
                    onClick={confirmReject}
                    disabled={patch.isPending}
                    data-testid="request-reject-confirm-btn"
                  >
                    {patch.isPending ? <><Loader2 className="animate-spin" /> Rejecting…</> : <><XCircle /> Reject request</>}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {/* Accepting a request commits it — this is the decision surface
                    where brand and danger are allowed to sit on buttons. */}
                <Button
                  variant="brand"
                  className="w-full"
                  size="sm"
                  onClick={() => convert.mutate()}
                  disabled={convert.isPending || patch.isPending}
                >
                  {convert.isPending ? (
                    <><Loader2 className="animate-spin" /> Creating contract…</>
                  ) : (
                    <><CheckCircle /> Accept &amp; Create Contract <ChevronRight className="ml-auto" /></>
                  )}
                </Button>
                <div className="flex gap-2">
                  {request.status !== 'MORE_INFO_NEEDED' && (
                    // Asking for more info is a hand-back, not a verdict — neutral.
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => handleStatus('MORE_INFO_NEEDED')}
                      disabled={patch.isPending}
                    >
                      <MessageSquare /> Need More Info
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    size="sm"
                    className="flex-1"
                    onClick={() => setRejecting(true)}
                    disabled={patch.isPending}
                    data-testid="request-reject-btn"
                  >
                    <XCircle /> Reject
                  </Button>
                </div>
                {request.status === 'MORE_INFO_NEEDED' && (
                  <div className="flex items-center gap-1.5 text-dense text-attention-700 bg-attention-50 px-3 py-2 rounded-md">
                    <AlertTriangle className="size-3.5 flex-shrink-0" />
                    Awaiting additional information from requester
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          /*
            Settled requests used to render no footer at all — the panel just
            stopped, with no statement of the outcome and no way back. A
            reviewer who rejected something in error had to go to the database.
          */
          <div className="border-t border-paper-200 px-5 py-4 space-y-2" data-testid="request-settled-footer">
            {actionError && (
              <div role="alert" className="flex items-start gap-2 text-dense text-risk-900 bg-risk-50 border border-risk-200 rounded-md px-3 py-2">
                <AlertTriangle className="size-3.5 flex-shrink-0 mt-0.5 text-risk-600" />
                <span className="min-w-0 break-words">{actionError}</span>
              </div>
            )}
            <p className="text-dense text-ink-500">
              This request is settled ({STATUS_LABEL[request.status] ?? request.status.toLowerCase()}).
              {typeof request.metadata?.rejectionReason === 'string' && request.metadata.rejectionReason
                ? ` Reason given: “${request.metadata.rejectionReason}”`
                : ''}
            </p>
            {['REJECTED', 'CANCELLED'].includes(request.status) && (
              <Button
                variant="outline" size="sm" className="w-full"
                onClick={() => handleStatus('IN_REVIEW')}
                disabled={patch.isPending}
                data-testid="request-reopen-btn"
              >
                {patch.isPending ? <><Loader2 className="animate-spin" /> Reopening…</> : 'Reopen for review'}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
