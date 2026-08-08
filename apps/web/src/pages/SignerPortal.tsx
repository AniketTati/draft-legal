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
import { useState } from 'react'
import axios from 'axios'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertCircle, Loader2, PenLine, ShieldCheck, Clock, Building2, X, CheckCircle2,
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
  const [signedName, setSignedName] = useState('')
  const [consent, setConsent] = useState(false)
  const [confirmation, setConfirmation] = useState<'signed' | 'declined' | null>(null)

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
    },
  })

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
    const detail = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail
    return (
      <Centered>
        {/* A dead signing link is expiry or revocation — real risk. */}
        <AlertCircle className="size-6 text-risk-600 mb-4" />
        <h1 className="text-title text-ink-950 mb-2">Link unavailable</h1>
        <p className="text-body text-ink-500 max-w-sm text-center">
          {detail ?? 'This signing link is invalid, has expired, or has been revoked. Please contact the sender for a new link.'}
        </p>
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

  return (
    <div className="min-h-screen bg-paper-50 flex flex-col pb-24" data-testid="signer-portal">
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
      <div className="bg-card border-b border-paper-200 px-6 py-2 text-dense text-ink-500">
        Signing as <span className="font-medium text-ink-950">{signer.name}</span>
        {signer.role && <span className="text-ink-400"> · {signer.role}</span>}
        <span className="text-ink-400 mx-2">·</span>
        <span className="font-mono">v{version.versionNumber}</span>
        <span className="text-ink-400 mx-2">·</span>
        <span className="tabular-nums">{signatureRequest.signedCount} / {signatureRequest.totalSigners}</span> signed
      </div>

      {/* ── Document (read-only, full-bleed) ────────────────────── */}
      <main className="flex-1 px-4 py-6">
        <div className="max-w-4xl mx-auto">
          <div className="mb-4">
            <h1 className="text-title text-ink-950">{contract.title}</h1>
            <div className="flex items-center gap-2 mt-1 text-dense text-ink-500">
              <span className="text-eyebrow uppercase">{contract.type.replace(/_/g, ' ')}</span>
              {contract.counterpartyName && <span>· {contract.counterpartyName}</span>}
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
              {editor ? (
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
        </div>
      </main>

      {/* ── Sticky bottom bar ──────────────────────────────────── */}
      <div
        role="region"
        aria-label="Sign bar"
        className="fixed bottom-0 inset-x-0 bg-card border-t border-paper-200 z-40"
      >
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
          {alreadySigned ? (
            <p className="text-body text-brand-700 font-medium inline-flex items-center gap-2" data-testid="signer-confirmation">
              <CheckCircle2 className="size-4" />
              You've signed this document. Thank you.
            </p>
          ) : declined ? (
            <p className="text-body text-risk-700 font-medium" data-testid="signer-declined">
              You declined to sign this document.
            </p>
          ) : (
            <>
              <p className="text-body text-ink-700">
                <span className="font-medium">Ready to sign?</span>
                <span className="text-ink-500"> Review the document above, then click Sign.</span>
              </p>
              {/* This is the one surface where the decision buttons belong:
                  danger for the reject, brand for the binding act. */}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="danger"
                  size="md"
                  onClick={() => {
                    const reason = window.prompt('Optional — tell the sender why you cannot sign:') ?? ''
                    if (window.confirm('Decline signing this document? This cannot be undone.')) {
                      decline.mutate(reason)
                    }
                  }}
                  data-testid="signer-decline-btn"
                >
                  Decline
                </Button>
                <Button
                  variant="brand"
                  size="md"
                  onClick={() => setShowSignDialog(true)}
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

      {/* ── Sign dialog ─────────────────────────────────────────── */}
      {showSignDialog && (
        <div
          role="dialog"
          aria-label="Confirm signature"
          className="fixed inset-0 z-50 bg-ink-950/40 flex items-center justify-center p-4"
          onClick={() => setShowSignDialog(false)}
        >
          <div
            className="bg-card rounded-card max-w-md w-full shadow-e3 p-6"
            onClick={(e) => e.stopPropagation()}
          >
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
            <p className="text-body text-ink-500 mb-4">
              Type your full legal name to sign. Your signature, IP address, and timestamp
              will be captured + included in the signed audit trail.
            </p>
            <label className="block text-dense font-medium text-ink-700 mb-1.5">Your full legal name</label>
            <Input
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
                className="mt-0.5 size-4 rounded-chip border-input text-brand-700 focus:ring-brand-700/35"
              />
              <span>
                I agree to conduct this transaction and sign electronically. I understand my
                electronic signature is legally binding, and that the document will be sealed
                with a tamper-evident digital signature.
              </span>
            </label>
            {sign.isError && (
              <p className="mt-2 text-dense text-risk-700">
                {(sign.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Failed to record signature.'}
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
          </div>
        </div>
      )}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-paper-50 flex flex-col items-center justify-center p-4">
      {children}
    </div>
  )
}
