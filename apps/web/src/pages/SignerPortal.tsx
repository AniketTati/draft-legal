/**
 * SignerPortal — minimal-chrome page at /sign/:token.
 *
 * P7.6.1 — wired to the live eSignature backend. The signer's job is
 * still binary (sign or decline); the captured signature is just a
 * typed name + IP/UA/timestamp for now (X.509 + pdf-lib field
 * injection is a V1.5 follow-up).
 */
import { useParams } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useState } from 'react'
import axios from 'axios'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Wordmark } from '@/components/brand/Wordmark'
import {
  AlertCircle, Loader2, PenLine, ShieldCheck, Clock, Building2, X, CheckCircle2,
  Printer, FileWarning,
} from 'lucide-react'

interface SignerPayload {
  signer: {
    id: string
    name: string
    email: string
    role: string | null
    status: 'PENDING' | 'SIGNED' | 'DECLINED'
    signedAt: string | null
  }
  signatureRequest: {
    id: string
    status: 'PENDING' | 'COMPLETED' | 'VOIDED' | 'EXPIRED'
    message: string | null
    expiresAt: string | null
    signOrder: 'ANY' | 'SEQUENTIAL'
    totalSigners: number
    signedCount: number
  }
  contract: {
    id: string
    title: string
    type: string
    counterpartyName: string | null
    org: { name: string; brandColor: string | null; logoUrl: string | null }
  }
  version: { id: string; versionNumber: number; htmlContent: string }
}

export function SignerPortal() {
  const { token } = useParams<{ token: string }>()
  const [showSignDialog, setShowSignDialog] = useState(false)
  // Declining used to run through window.prompt() followed by window.confirm().
  // Two OS dialogs on the one screen a counterparty ever sees of this product,
  // and the pair was wrong as well as ugly: cancelling the prompt returned
  // null, which `?? ''` swallowed, so the confirm still ran and a signer who
  // backed out of the reason box was asked to commit anyway.
  const [showDeclineDialog, setShowDeclineDialog] = useState(false)
  const [declineReason, setDeclineReason] = useState('')
  const [signedName, setSignedName] = useState('')
  const [consent, setConsent] = useState(false)
  const [confirmation, setConfirmation] = useState<'signed' | 'declined' | null>(null)

  // Escape closes whichever dialog is open. A modal you can only leave with the
  // mouse is a bad modal anywhere; on a page where the alternative is closing
  // the tab and losing the link, it is worse.
  useEffect(() => {
    if (!showSignDialog && !showDeclineDialog) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setShowSignDialog(false)
      setShowDeclineDialog(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showSignDialog, showDeclineDialog])

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['signer-v2', token],
    queryFn: async () => {
      // Direct axios so we don't need an auth header — public endpoint.
      const r = await axios.get<SignerPayload>(`/api/v1/sign/${token}`)
      return r.data
    },
    enabled: !!token,
    retry: false,
  })

  const sign = useMutation({
    mutationFn: () => axios.post(`/api/v1/sign/${token}/sign`, { signedName, consent }),
    onSuccess: () => {
      // Do NOT refetch — once signing completes the request flips to
      // COMPLETED on the backend and GET /sign/:token returns 410. The
      // local `confirmation` state alone drives the success render below
      // (alreadySigned check on line 113). Refetching would erase the
      // user's "you signed!" confirmation with a generic "Link unavailable"
      // error page. Caught during P7 smoke test.
      setConfirmation('signed')
      setShowSignDialog(false)
    },
  })

  const decline = useMutation({
    mutationFn: (reason: string) => axios.post(`/api/v1/sign/${token}/decline`, { reason }),
    onSuccess: () => {
      // Same reason — declining voids the request server-side; refetch
      // would 410 and obscure the user's "declined" confirmation.
      setConfirmation('declined')
      setShowDeclineDialog(false)
    },
  })

  const detailOf = (e: unknown) =>
    (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? null

  /*
   * SEQUENTIAL requests are gated server-side: a later signer gets a 403 with
   * "Earlier signers have not yet signed." That used to surface only as small
   * red text inside the signature dialog, i.e. AFTER the signer had typed their
   * full legal name and ticked the ESIGN consent. Hoisting it to the page and
   * standing the sign action down means the rejection is read as "not yet",
   * which is what it is, rather than as a failure to sign.
   */
  const signStatus = (sign.error as { response?: { status?: number } })?.response?.status
  const notYourTurn = signStatus === 403

  // A turn-order rejection is not something to keep staring at inside the
  // dialog — close it and let the page banner carry the news.
  useEffect(() => {
    if (notYourTurn) setShowSignDialog(false)
  }, [notYourTurn])

  const editor = useEditor({
    extensions: [StarterKit],
    content: data?.version?.htmlContent ?? '',
    editable: false,
  }, [data?.version?.htmlContent])

  if (isLoading) {
    return (
      <Centered>
        <Loader2 className="size-6 animate-spin text-ink-400 mb-3" />
        <p className="text-ink-500 text-body">Loading document to sign…</p>
      </Centered>
    )
  }
  if (isError || !data) {
    const detail = detailOf(error)
    /*
     * The dead-link page is the state an outside signer hits most often — links
     * expire, requests complete, senders void them. It used to be an unbranded
     * sentence floating in white space: no wordmark, nothing that told them
     * which product this was or what to do next, and a signer who had just
     * completed the flow and hit Back saw the same undifferentiated wall.
     * Now it says what to do, and it is recognisably a page rather than an error.
     */
    return (
      <Centered>
        <div className="w-full max-w-md rounded-card border border-paper-200 bg-card p-8 text-center shadow-e1">
          <span className="mb-4 inline-flex size-11 items-center justify-center rounded-full bg-risk-50">
            <AlertCircle className="size-5 text-risk-600" />
          </span>
          <h1 className="text-title text-ink-950">Link unavailable</h1>
          <p className="mt-2 text-body text-ink-500">
            {detail ?? 'This signing link is invalid, has expired, or has been revoked.'}
          </p>
          <div className="mt-5 rounded-md border border-paper-200 bg-paper-50 px-4 py-3 text-left text-dense text-ink-700">
            <p className="font-medium text-ink-950">What to do next</p>
            <ul className="mt-1.5 space-y-1 text-ink-500">
              <li>· If you already signed, no further action is needed — the sender has your signature.</li>
              <li>· Otherwise, reply to the email that carried this link and ask for a fresh one.</li>
              <li>· Signing links are single-recipient. Forwarding one does not work.</li>
            </ul>
          </div>
        </div>
        <ExternalFooter />
      </Centered>
    )
  }

  const { contract, signer, signatureRequest, version } = data
  // Same call as the external portal: the sending org's own brand keeps this
  // strip when they've set one, otherwise ink rather than an off-system blue.
  const brandColor = contract.org?.brandColor ?? null
  const daysToExpiry = signatureRequest.expiresAt
    ? Math.max(0, Math.ceil((new Date(signatureRequest.expiresAt).getTime() - Date.now()) / 86_400_000))
    : null
  const alreadySigned = signer.status === 'SIGNED' || confirmation === 'signed'
  const declined = signer.status === 'DECLINED' || confirmation === 'declined'
  const hasDocument = Boolean(version?.htmlContent?.trim())
  // Post-signature, say what actually happens next. "Thank you" alone leaves an
  // outside signer wondering whether anything else is expected of them.
  const remaining = Math.max(0, signatureRequest.totalSigners - (signatureRequest.signedCount + 1))

  return (
    <div className="min-h-screen bg-paper-50 flex flex-col pb-32 sm:pb-24" data-testid="signer-portal">
      {/* ── Slim branded strip ─────────────────────────────────── */}
      <header
        className={`px-6 py-3 flex items-center justify-between ${brandColor ? '' : 'bg-ink-950'}`}
        style={brandColor ? { backgroundColor: brandColor } : undefined}
      >
        <div className="flex items-center gap-2">
          {contract.org.logoUrl ? (
            <img src={contract.org.logoUrl} alt="" className="h-6 w-auto object-contain bg-white/10 rounded-chip px-1" />
          ) : (
            <div className="flex items-center justify-center size-6 rounded-chip bg-white/20">
              <Building2 className="size-3.5 text-white" />
            </div>
          )}
          <span className="text-white font-medium text-body">{contract.org.name} · Signing portal</span>
        </div>
        <div className="flex items-center gap-3 text-white/80 text-dense">
          <span className="inline-flex items-center gap-1">
            <ShieldCheck className="size-3.5" /> Secure link
          </span>
          {daysToExpiry != null && (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Clock className="size-3.5" />
              {daysToExpiry > 0 ? `Expires in ${daysToExpiry}d` : 'Expires today'}
            </span>
          )}
        </div>
      </header>

      {/* ── Banner: who you are + progress ─────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-paper-200 bg-card px-6 py-2 text-dense text-ink-500">
        <span>
          Signing as <span className="font-medium text-ink-950">{signer.name}</span>
          {signer.role && <span className="text-ink-400"> · {signer.role}</span>}
        </span>
        <span className="text-ink-400">·</span>
        <span className="font-mono">v{version.versionNumber}</span>
        <span className="text-ink-400">·</span>
        <span>
          <span className="tabular-nums">{signatureRequest.signedCount} / {signatureRequest.totalSigners}</span> signed
        </span>
        {signatureRequest.signOrder === 'SEQUENTIAL' && (
          <>
            <span className="text-ink-400">·</span>
            {/* Sequential signing changes what a signer should expect from this
                page, so it is stated rather than left to be discovered. */}
            <span>signed in order</span>
          </>
        )}
        {/* Taking a copy away to read, or to a printer, is the first thing a
            lawyer does with a document put in front of them. There was no way
            to do it: no download, no print control, nothing. */}
        <button
          type="button"
          onClick={() => window.print()}
          data-testid="signer-print"
          className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-ink-700 hover:bg-paper-100 hover:text-ink-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring print:hidden"
        >
          <Printer className="size-3.5" />
          Print or save a copy
        </button>
      </div>

      {/* Turn-order rejection, surfaced where the signer can act on it. */}
      {notYourTurn && (
        <div
          role="status"
          data-testid="signer-not-your-turn"
          className="flex items-start gap-2 border-b border-info-200 bg-info-50 px-6 py-2.5 text-body text-info-700"
        >
          <Clock className="mt-px size-4 flex-shrink-0" />
          <span>
            <span className="font-medium">Not your turn yet.</span>{' '}
            {detailOf(sign.error) ??
              'Earlier signers have not signed. You will be emailed when this reaches you — this link stays valid.'}
          </span>
        </div>
      )}

      {/* ── Document (read-only, full-bleed) ────────────────────── */}
      <main className="flex-1 px-4 py-6">
        <div className="max-w-4xl mx-auto">
          <div className="mb-4">
            <h1 className="text-title text-ink-950 break-words">{contract.title}</h1>
            <div className="flex flex-wrap items-center gap-2 mt-1 text-dense text-ink-500">
              <span className="text-eyebrow uppercase">{contract.type.replace(/_/g, ' ')}</span>
              {contract.counterpartyName && <span>· {contract.counterpartyName}</span>}
              <span className="text-ink-400">· sent by {contract.org.name}</span>
            </div>
          </div>
          {/* A note from the sender describes nothing about the document's
              state, so it takes no meaning color — just a quiet paper card. */}
          {signatureRequest.message && (
            <div className="mb-4 p-3 rounded-md border border-paper-200 bg-paper-100 text-body text-ink-950">
              <strong>Message from sender:</strong> {signatureRequest.message}
            </div>
          )}
          {/* The document is the hero — paper radius and the one page shadow. */}
          <div className="bg-card rounded-paper shadow-page overflow-hidden">
            <div className="p-8 md:p-12">
              {!hasDocument ? (
                /*
                 * A signature request can point at a version with no body. The
                 * page used to render that as a blank sheet with a live Sign
                 * button under it — asking someone to execute a document they
                 * cannot read. Say so instead.
                 */
                <div className="py-10 text-center" data-testid="signer-no-document">
                  <span className="mb-3 inline-flex size-10 items-center justify-center rounded-card border border-paper-200 bg-paper-100 text-ink-400">
                    <FileWarning className="size-5" />
                  </span>
                  <p className="text-[13.5px] font-semibold text-ink-950">
                    This request has no readable document attached
                  </p>
                  <p className="mx-auto mt-1 max-w-md text-dense text-ink-500">
                    Nothing was included for you to review, so there is nothing to
                    sign. Contact {contract.org.name} and ask them to re-send the
                    request with the executed form of agreement attached.
                  </p>
                </div>
              ) : editor ? (
                <EditorContent
                  editor={editor}
                  className="prose prose-sm md:prose max-w-none focus:outline-none [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[480px]"
                />
              ) : (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="size-5 animate-spin text-ink-400" />
                </div>
              )}
            </div>
          </div>

          <ExternalFooter className="print:hidden" />
        </div>
      </main>

      {/* ── Sticky bottom bar ──────────────────────────────────── */}
      <div
        role="region"
        aria-label="Sign bar"
        className="fixed bottom-0 inset-x-0 bg-card border-t border-paper-200 z-40 print:hidden"
      >
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
          {alreadySigned ? (
            <div data-testid="signer-confirmation">
              <p className="inline-flex items-center gap-2 text-body font-medium text-brand-700">
                <CheckCircle2 className="size-4" />
                You've signed this document.
              </p>
              <p className="mt-0.5 text-dense text-ink-500">
                {remaining > 0
                  ? `Waiting on ${remaining} more signature${remaining === 1 ? '' : 's'}. ${contract.org.name} will send the fully executed copy once everyone has signed.`
                  : `That was the last signature. ${contract.org.name} will send the fully executed copy.`}
              </p>
            </div>
          ) : declined ? (
            <div data-testid="signer-declined">
              <p className="text-body font-medium text-risk-700">
                You declined to sign this document.
              </p>
              <p className="mt-0.5 text-dense text-ink-500">
                {contract.org.name} has been notified. This link is now closed — if
                you meant to sign, ask them to send a new request.
              </p>
            </div>
          ) : (
            <>
              {/* The prompt has to agree with the buttons: telling someone to
                  "click Sign" next to a disabled Sign is how a page loses
                  trust. */}
              <p className="text-body text-ink-700">
                {notYourTurn ? (
                  <>
                    <span className="font-medium">Waiting on earlier signers.</span>
                    <span className="text-ink-500"> Nothing to do yet — keep this link.</span>
                  </>
                ) : !hasDocument ? (
                  <>
                    <span className="font-medium">Nothing to sign.</span>
                    <span className="text-ink-500"> No document was attached to this request.</span>
                  </>
                ) : (
                  <>
                    <span className="font-medium">Ready to sign?</span>
                    <span className="text-ink-500"> Review the document above, then click Sign.</span>
                  </>
                )}
              </p>
              {/* This is the one surface where the decision buttons belong:
                  danger for the reject, brand for the binding act. */}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="danger"
                  size="md"
                  onClick={() => setShowDeclineDialog(true)}
                  data-testid="signer-decline-btn"
                >
                  Decline
                </Button>
                <Button
                  variant="brand"
                  size="md"
                  onClick={() => setShowSignDialog(true)}
                  // Nothing to read means nothing to execute.
                  disabled={!hasDocument || notYourTurn}
                  data-testid="signer-sign-btn"
                >
                  <PenLine />
                  Sign
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Decline dialog ──────────────────────────────────────── */}
      {showDeclineDialog && (
        <Overlay onDismiss={() => setShowDeclineDialog(false)} label="Decline to sign">
          <h2 className="text-section text-ink-950">Decline to sign?</h2>
          <p className="mt-2 text-body text-ink-500">
            {contract.org.name} is told immediately, and this signing link closes.
            You cannot undo it — they would have to send a new request.
          </p>
          <label
            htmlFor="decline-reason"
            className="mt-4 block text-dense font-medium text-ink-700"
          >
            Reason <span className="font-normal text-ink-400">(optional, shared with the sender)</span>
          </label>
          <textarea
            id="decline-reason"
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            rows={3}
            autoFocus
            data-testid="signer-decline-reason"
            placeholder="e.g. the indemnity in clause 9 still needs to be resolved"
            className="mt-1.5 w-full resize-y rounded-md border border-input bg-card px-[11px] py-2 text-[13px] text-ink-950 transition-colors placeholder:text-ink-400 focus-visible:border-brand-700 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-700/15"
          />
          {decline.isError && (
            <p className="mt-2 text-dense text-risk-700">
              {detailOf(decline.error) ?? 'Failed to record your decision. Try again.'}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" size="md" onClick={() => setShowDeclineDialog(false)}>
              Keep reviewing
            </Button>
            <Button
              variant="destructive"
              size="md"
              onClick={() => decline.mutate(declineReason.trim())}
              disabled={decline.isPending}
              data-testid="signer-decline-confirm"
            >
              {decline.isPending && <Loader2 className="animate-spin" />}
              Decline to sign
            </Button>
          </div>
        </Overlay>
      )}

      {/* ── Sign dialog ─────────────────────────────────────────── */}
      {showSignDialog && (
        <Overlay onDismiss={() => setShowSignDialog(false)} label="Confirm signature">
          <div className="flex items-start justify-between mb-3">
              <h2 className="text-section text-ink-950">Sign this document</h2>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setShowSignDialog(false)}
                className="text-ink-400"
                aria-label="Close"
              >
                <X />
              </Button>
            </div>
            {/* Restate what is being signed. By the time this dialog is open the
                title has scrolled away, and "sign this document" is not enough
                to act on when a signer has three of these links open. */}
            <p className="mb-3 rounded-md border border-paper-200 bg-paper-50 px-3 py-2 text-dense text-ink-700">
              <span className="font-medium text-ink-950">{contract.title}</span>
              <span className="text-ink-400"> · v{version.versionNumber}</span>
            </p>
            <p className="text-body text-ink-500 mb-4">
              Type your full legal name to sign. Your signature, IP address, and timestamp
              will be captured + included in the signed audit trail.
            </p>
            <label htmlFor="signer-name" className="block text-dense font-medium text-ink-700 mb-1.5">Your full legal name</label>
            <Input
              id="signer-name"
              type="text"
              value={signedName}
              onChange={(e) => setSignedName(e.target.value)}
              placeholder={signer.name}
              data-testid="signer-name-input"
              autoFocus
            />
            {/* Wave 2.7 — explicit ESIGN/UETA consent, required before signing. */}
            <label className="mt-4 flex items-start gap-2 text-dense text-ink-500 cursor-pointer">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                data-testid="signer-consent"
                className="mt-0.5 size-4 rounded-chip border-input text-brand-700 focus:ring-brand-700"
              />
              <span>
                I agree to conduct this transaction and sign electronically. I understand my
                electronic signature is legally binding, and that the document will be sealed
                with a tamper-evident digital signature.
              </span>
            </label>
            {sign.isError && !notYourTurn && (
              <p className="mt-2 text-dense text-risk-700">
                {detailOf(sign.error) ?? 'Failed to record signature.'}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="outline"
                size="md"
                onClick={() => setShowSignDialog(false)}
              >
                Cancel
              </Button>
              <Button
                variant="brand"
                size="md"
                onClick={() => sign.mutate()}
                disabled={!signedName.trim() || !consent || sign.isPending}
                data-testid="signer-confirm-btn"
              >
                {sign.isPending ? <Loader2 className="animate-spin" /> : <PenLine />}
                Sign
              </Button>
            </div>
        </Overlay>
      )}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-paper-50 flex flex-col items-center justify-center gap-6 p-4">
      {children}
    </div>
  )
}

/**
 * Overlay — one dialog scaffold for this page.
 *
 * The backdrop is a sibling of the panel rather than its ancestor: the old
 * markup put role="dialog" on the full-screen click-catcher and relied on
 * stopPropagation inside it, which announced the whole viewport as the dialog
 * and made every stray click inside the panel a candidate for dismissal.
 */
function Overlay({
  children,
  onDismiss,
  label,
}: {
  children: React.ReactNode
  onDismiss: () => void
  label: string
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 print:hidden">
      <div className="absolute inset-0 bg-ink-950/40" onClick={onDismiss} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="relative w-full max-w-md rounded-card bg-card p-6 shadow-e3"
      >
        {children}
      </div>
    </div>
  )
}

/**
 * The trimmed external shell's footer. A counterparty landing here has no app
 * nav and no account: this is the only place that says what this product is,
 * and the only route to the terms they are transacting under.
 */
function ExternalFooter({ className = '' }: { className?: string }) {
  return (
    <footer
      className={`mt-8 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-dense text-ink-400 ${className}`}
    >
      <span className="inline-flex items-center gap-1.5">
        Secured by <Wordmark size="sm" />
      </span>
      <span aria-hidden="true">·</span>
      <a
        href="/terms"
        className="underline decoration-paper-300 underline-offset-2 hover:text-ink-700 hover:decoration-brand-700"
      >
        Terms
      </a>
      <a
        href="/privacy"
        className="underline decoration-paper-300 underline-offset-2 hover:text-ink-700 hover:decoration-brand-700"
      >
        Privacy
      </a>
    </footer>
  )
}
