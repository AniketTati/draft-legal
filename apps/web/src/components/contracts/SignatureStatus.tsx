/**
 * SignatureStatus (Phase 07) — per-signer status panel for the
 * contract detail page. Renders when there's at least one
 * SignatureRequest on the contract.
 *
 * Shows for each request:
 *   • Top: status pill (PENDING / COMPLETED / VOIDED / EXPIRED)
 *     + signedCount/total + expiry countdown
 *   • Per-signer cards: name, role, email, status pill,
 *     signedAt time, copy-link button (PENDING signers only)
 *   • Recent audit timeline (last ~6 events)
 *   • Sender actions: Void (PENDING) / Resend link (PENDING signers)
 */
import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { MEANING_CLASS, statusMeaning } from '@/lib/status'
import {
  Loader2, CheckCircle2, XCircle, Clock, Copy, Mail,
  PenLine, Ban, AlertCircle, Eye, Send,
} from 'lucide-react'

interface SignerData {
  id: string
  name: string
  email: string
  role: string | null
  signOrder: number
  token: string
  status: 'PENDING' | 'SIGNED' | 'DECLINED'
  signedAt: string | null
  declinedAt: string | null
  declinedReason: string | null
  signedName: string | null
}
interface EventData {
  id: string
  kind: 'SENT' | 'VIEWED' | 'SIGNED' | 'DECLINED' | 'VOIDED' | 'REMINDED' | 'COMPLETED'
  metadata: Record<string, unknown>
  createdAt: string
  signerId: string | null
}
interface SignatureRequestData {
  id: string
  status: 'PENDING' | 'COMPLETED' | 'VOIDED' | 'EXPIRED'
  signOrder: 'ANY' | 'SEQUENTIAL'
  expiresAt: string | null
  message: string | null
  createdAt: string
  completedAt: string | null
  voidedAt: string | null
  voidedReason: string | null
  signers: SignerData[]
  events: EventData[]
}

// Words only. Every color on this panel now comes from the status's meaning in
// lib/status, so a request that is PENDING here reads the same as a PENDING
// anything else in the product.
const REQUEST_LABEL: Record<string, string> = {
  PENDING:   'Awaiting signatures',
  COMPLETED: 'Fully signed',
  VOIDED:    'Voided',
  EXPIRED:   'Expired',
}

const SIGNER_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  PENDING:  Clock,
  SIGNED:   CheckCircle2,
  DECLINED: XCircle,
}

const EVENT_LABEL: Record<EventData['kind'], { icon: React.ComponentType<{ className?: string }>; color: string; label: string }> = {
  SENT:      { icon: Send,        color: 'text-info-600',  label: 'Sent for signature' },
  VIEWED:    { icon: Eye,         color: 'text-ink-500',   label: 'Viewed by signer' },
  SIGNED:    { icon: CheckCircle2,color: 'text-brand-700', label: 'Signed' },
  DECLINED:  { icon: XCircle,     color: 'text-risk-600',  label: 'Declined' },
  VOIDED:    { icon: Ban,         color: 'text-ink-500',   label: 'Voided' },
  REMINDED:  { icon: Mail,        color: 'text-info-600',  label: 'Reminder sent' },
  COMPLETED: { icon: CheckCircle2,color: 'text-brand-700', label: 'Fully completed' },
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  const diff = Date.now() - t
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`
  return `${Math.round(diff / 86400_000)}d ago`
}

export function SignatureStatus({
  contractId,
  onChanged,
}: {
  contractId: string
  onChanged?: () => void
}) {
  const [copiedToken, setCopiedToken] = useState<string | null>(null)
  const { data, isLoading, refetch } = useQuery<{ data: SignatureRequestData[] }>({
    queryKey: ['signature-requests', contractId],
    queryFn: () => api.get(`/contracts/${contractId}/signature-requests`).then(r => r.data),
    staleTime: 5_000,
    refetchInterval: 15_000,   // poll while a request is PENDING
  })

  const voidMut = useMutation({
    // Pass `{}` body — Fastify rejects empty body on POSTs with json content-type.
    mutationFn: (srId: string) =>
      api.post(`/contracts/${contractId}/signature-requests/${srId}/void`, {}).then(r => r.data),
    onSuccess: () => { refetch(); onChanged?.() },
  })

  // Phase 07 Step 8b — manual nudge. Re-emails any still-PENDING signers
  // (worker is idempotent on SR/Signer status).
  //
  // L6 #11 — this had no onError at all, while signatures.ts returns 409 both
  // for a non-PENDING request and for one where everyone has already
  // responded. The button simply stayed "Send reminder" and no email was sent,
  // so the user pressed it again. Only voidMut.isError was rendered anywhere.
  //
  // State is keyed by signature-request id because ONE mutation object is
  // shared across every row: reading remindMut.isSuccess directly made every
  // row on the card claim "Reminder sent" as soon as any one of them succeeded.
  const [remindState, setRemindState] = useState<Record<string, { ok: boolean; error?: string }>>({})
  const remindMut = useMutation({
    mutationFn: (srId: string) =>
      api.post(`/contracts/${contractId}/signature-requests/${srId}/remind`, {}).then(r => r.data),
    onSuccess: (_data, srId) => {
      setRemindState(s => ({ ...s, [srId]: { ok: true } }))
      refetch()
    },
    onError: (err: unknown, srId) => {
      const detail =
        (err as { response?: { data?: { detail?: string; error?: string } } })?.response?.data?.detail ??
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Could not send the reminder.'
      setRemindState(s => ({ ...s, [srId]: { ok: false, error: detail } }))
    },
  })

  const requests = data?.data ?? []
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-dense text-ink-500 py-2">
        <Loader2 className="size-3.5 animate-spin" />
        Loading signature status…
      </div>
    )
  }
  if (requests.length === 0) return null

  const copyLink = async (token: string) => {
    const url = `${window.location.origin}/sign/${token}`
    try {
      await navigator.clipboard.writeText(url)
      setCopiedToken(token)
      setTimeout(() => setCopiedToken(null), 2000)
    } catch { /* ignore */ }
  }

  // Show all requests, latest first. The data already comes desc by createdAt.
  return (
    <div className="space-y-4" data-testid="signature-status">
      {requests.map((sr) => {
        const meaning = MEANING_CLASS[statusMeaning(sr.status)]
        const pillLabel = REQUEST_LABEL[sr.status] ?? REQUEST_LABEL.PENDING
        const signedCount = sr.signers.filter(s => s.status === 'SIGNED').length
        const total = sr.signers.length
        const daysToExpiry = sr.expiresAt
          ? Math.max(0, Math.ceil((new Date(sr.expiresAt).getTime() - Date.now()) / 86_400_000))
          : null
        // The card stays paper; the status line is the one colored thing on it,
        // so a rail of these reads as a list rather than a wash.
        return (
          <div
            key={sr.id}
            className="rounded-card border border-paper-200 bg-card p-4"
            data-testid={`signature-request-${sr.id}`}
          >
            {/* Header: status + counts. Actions live on a separate row
                so they don't get squeezed/wrapped at narrow rail widths
                (see screenshots — "Send reminder" was breaking across
                two lines and the Void icon was cut off the right edge). */}
            <div className="mb-3">
              <div className="flex items-center gap-2 flex-wrap">
                <PenLine className={`size-4 flex-shrink-0 ${meaning.fg}`} />
                <span className={`text-body font-semibold ${meaning.fg}`}>{pillLabel}</span>
                <span className="text-dense text-ink-500 tabular-nums">
                  · {signedCount}/{total} signed
                </span>
              </div>
              <div className="text-dense text-ink-500 mt-1 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
                <span>Sent {relTime(sr.createdAt)}</span>
                {sr.expiresAt && sr.status === 'PENDING' && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="size-3" />
                    {daysToExpiry === 0 ? 'Expires today' : `Expires in ${daysToExpiry}d`}
                  </span>
                )}
                {sr.signOrder === 'SEQUENTIAL' && (
                  <span className="text-ink-400">· Sequential signing</span>
                )}
                {sr.completedAt && (
                  <span>· Completed {relTime(sr.completedAt)}</span>
                )}
                {sr.voidedReason && (
                  <span className="text-risk-700 break-words">· {sr.voidedReason}</span>
                )}
              </div>
              {sr.status === 'PENDING' && (
                <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => remindMut.mutate(sr.id)}
                    disabled={remindMut.isPending && remindMut.variables === sr.id}
                    className="text-dense text-ink-700 hover:text-ink-950 inline-flex items-center gap-1 px-2 py-1 rounded-md border border-paper-200 hover:border-paper-300 bg-card whitespace-nowrap"
                    data-testid="remind-sr-btn"
                    title="Email a reminder to all still-pending signers"
                  >
                    <Mail className="size-3.5" />
                    {remindState[sr.id]?.ok ? 'Reminder sent' : 'Send reminder'}
                  </button>
                  {remindState[sr.id]?.error && (
                    <span
                      className="text-dense text-risk-700 break-words"
                      data-testid="remind-sr-error"
                    >
                      {remindState[sr.id]?.error}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm('Void this signature request? This cannot be undone.')) {
                        voidMut.mutate(sr.id)
                      }
                    }}
                    disabled={voidMut.isPending}
                    className="text-dense text-ink-700 hover:text-risk-700 inline-flex items-center gap-1 px-2 py-1 rounded-md border border-paper-200 hover:border-risk-200 bg-card whitespace-nowrap"
                    data-testid="void-sr-btn"
                    title="Void this signature request"
                  >
                    <Ban className="size-3.5" />
                    Void
                  </button>
                </div>
              )}
            </div>

            {/* Per-signer cards. Re-laid-out (2026-05-02 user feedback)
                so the name + email are ALWAYS visible. The previous
                horizontal layout squeezed `flex-1` to ~24px when the
                rail was narrow, truncating the name to "M…" and the
                email to "ma…". Now: top row = avatar + name + status
                badge; second row = full email; third row = action
                button (copy link). All three rows have full card
                width so nothing gets clipped. */}
            <div className="space-y-2 mb-3">
              {sr.signers.map((signer) => {
                const sm = MEANING_CLASS[statusMeaning(signer.status)]
                const SignIcon = SIGNER_ICON[signer.status] ?? Clock
                const statusLabel =
                  signer.status === 'SIGNED' && signer.signedAt
                    ? `Signed ${relTime(signer.signedAt)}`
                    : signer.status === 'DECLINED'
                      ? 'Declined'
                      : 'Pending'
                return (
                  <div
                    key={signer.id}
                    className="rounded-md bg-paper-50 border border-paper-200 p-2.5"
                    data-testid={`signer-${signer.id}`}
                  >
                    {/* Row 1: avatar + name (+ role) + status pill */}
                    <div className="flex items-center gap-2">
                      <div className={`size-7 rounded-full ${sm.wash} flex items-center justify-center flex-shrink-0`}>
                        <SignIcon className={`size-3.5 ${sm.fg}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-body font-medium text-ink-950 truncate">
                          {signer.name}
                          {signer.role && (
                            <span className="text-ink-400 font-normal ml-1.5">· {signer.role}</span>
                          )}
                        </div>
                      </div>
                      <div
                        className={`text-[10.5px] font-medium ${sm.fg} px-1.5 py-0.5 rounded-chip ${sm.wash} flex-shrink-0 whitespace-nowrap`}
                      >
                        {statusLabel}
                      </div>
                    </div>

                    {/* Row 2: email (always full width below the row 1 cluster) */}
                    <div className="text-[11.5px] text-ink-500 truncate mt-1 ml-9">
                      {signer.email}
                      {sr.signOrder === 'SEQUENTIAL' && (
                        <span className="text-ink-400 ml-1.5 tabular-nums">· Order #{signer.signOrder}</span>
                      )}
                    </div>

                    {/* Row 3: copy-link action — only for pending signers */}
                    {signer.status === 'PENDING' && sr.status === 'PENDING' && (
                      <div className="mt-1.5 ml-9">
                        <button
                          type="button"
                          onClick={() => copyLink(signer.token)}
                          className="text-dense text-ink-700 hover:text-ink-950 inline-flex items-center gap-1 px-2 py-1 rounded-md border border-paper-200 hover:border-paper-300 bg-card whitespace-nowrap"
                          title="Copy signing link"
                        >
                          {copiedToken === signer.token ? (
                            <><CheckCircle2 className="size-3.5 text-ink-400" />Copied</>
                          ) : (
                            <><Copy className="size-3.5" />Copy link</>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Audit timeline (collapsed to 6 most recent) */}
            {sr.events.length > 0 && (
              <details className="text-dense">
                <summary className="cursor-pointer text-ink-500 hover:text-ink-700 inline-flex items-center gap-1 select-none">
                  <span>Activity ({sr.events.length})</span>
                </summary>
                <ul className="mt-2 space-y-1.5 pl-1">
                  {sr.events.slice(0, 6).map((e) => {
                    const meta = EVENT_LABEL[e.kind]
                    if (!meta) return null
                    const Icon = meta.icon
                    const sgn = e.signerId ? sr.signers.find(s => s.id === e.signerId) : null
                    return (
                      <li key={e.id} className="flex items-start gap-2 text-ink-700">
                        <Icon className={`size-3.5 mt-0.5 flex-shrink-0 ${meta.color}`} />
                        <div className="flex-1">
                          {meta.label}
                          {sgn && <span className="text-ink-500"> · {sgn.name}</span>}
                          <span className="text-ink-400 ml-1.5">{relTime(e.createdAt)}</span>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </details>
            )}

            {/* Sender's optional message */}
            {sr.message && (
              <div className="mt-3 p-2 rounded-md bg-paper-50 text-dense text-ink-700 border border-paper-200">
                <span className="font-medium text-ink-950">Cover note:</span> {sr.message}
              </div>
            )}
          </div>
        )
      })}

      {voidMut.isError && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-risk-50 border border-risk-200 text-body text-risk-700">
          <AlertCircle className="size-4 mt-0.5 flex-shrink-0" />
          <span>Failed to void signature request. {(voidMut.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? ''}</span>
        </div>
      )}
    </div>
  )
}
