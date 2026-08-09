/**
 * SendForSignatureDialog (Phase 07)
 *
 * Frontend gateway to POST /api/v1/contracts/:id/send-for-signature.
 * Until this dialog landed, the eSignature backend (P7.6.1) was reachable
 * only via API — there was no way to trigger it from the app, so the
 * existing SignerPortal had no real-world entry point.
 *
 * Captures:
 *   • Signer roster (name + email + role + signOrder)
 *   • Sign order: ANY (parallel) | SEQUENTIAL
 *   • Expiry: 7 / 14 / 30 / 60 / 90 days
 *   • Optional cover message shown on the signer's portal
 *
 * On submit:
 *   • Calls POST /contracts/:id/send-for-signature
 *   • Backend: creates SignatureRequest + per-signer Signers + tokens,
 *     flips contract.status → PENDING_SIGNATURE, emits SIGNATURE_SENT
 *     audit event.
 *   • This dialog: closes + onSent() so caller can refetch.
 */
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { X, Plus, Trash2, Loader2, AlertCircle, PenLine, ArrowRight, Users } from 'lucide-react'

interface SignerRow {
  name: string
  email: string
  role: string
  signOrder: number   // 1, 2, 3 — same value = parallel siblings
}

const newRow = (signOrder = 1): SignerRow => ({ name: '', email: '', role: '', signOrder })

export function SendForSignatureDialog({
  contractId,
  contractTitle,
  contractStatus,
  hasVersion,
  open,
  onClose,
  onSent,
}: {
  contractId: string
  contractTitle: string
  contractStatus: string
  hasVersion: boolean
  open: boolean
  onClose: () => void
  onSent: () => void
}) {
  const [signers, setSigners] = useState<SignerRow[]>([newRow(1), newRow(2)])
  const [signOrder, setSignOrder] = useState<'ANY' | 'SEQUENTIAL'>('ANY')
  const [expiresInDays, setExpiresInDays] = useState(14)
  const [message, setMessage] = useState('')

  const submit = useMutation({
    mutationFn: () => api.post(`/contracts/${contractId}/send-for-signature`, {
      // Only submit rows that have BOTH name + email — empty placeholder
      // rows would make the backend Zod schema reject the whole batch.
      signers: signers
        .filter(s => s.name.trim() && /\S+@\S+\.\S+/.test(s.email))
        .map(s => ({
          name: s.name.trim(),
          email: s.email.trim(),
          role: s.role.trim() || undefined,
          signOrder: signOrder === 'SEQUENTIAL' ? s.signOrder : 1,
        })),
      message: message.trim() || undefined,
      signOrder,
      expiresInDays,
    }).then(r => r.data),
    onSuccess: () => {
      onSent()
      onClose()
      // reset for next open
      setSigners([newRow(1), newRow(2)])
      setSignOrder('ANY')
      setExpiresInDays(14)
      setMessage('')
    },
  })

  if (!open) return null

  // Validation: at least 1 signer with name + email; valid-ish email shape
  const validSigners = signers.filter(s => s.name.trim() && /\S+@\S+\.\S+/.test(s.email))
  const canSubmit = validSigners.length >= 1 && hasVersion && contractStatus !== 'EXECUTED' && !submit.isPending

  // Block reasons surface as banner
  const blockReason =
    !hasVersion ? 'Contract has no version to sign — upload or generate a version first.' :
    contractStatus === 'EXECUTED' ? 'Contract is already executed.' :
    null

  const update = (i: number, patch: Partial<SignerRow>) => {
    setSigners(prev => prev.map((s, j) => j === i ? { ...s, ...patch } : s))
  }
  const remove = (i: number) => {
    setSigners(prev => prev.length > 1 ? prev.filter((_, j) => j !== i) : prev)
  }
  const add = () => {
    setSigners(prev => {
      const nextOrder = signOrder === 'SEQUENTIAL'
        ? Math.max(0, ...prev.map(s => s.signOrder)) + 1
        : 1
      return [...prev, newRow(nextOrder)]
    })
  }

  return (
    <div
      role="dialog"
      aria-label="Send for signature"
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 overflow-auto"
      onClick={onClose}
      data-testid="send-for-signature-dialog"
    >
      <div
        className="bg-card rounded-card max-w-2xl w-full shadow-e3 my-8"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-paper-200 flex items-start justify-between">
          <div>
            {/* Signature is the surface brand exists for — this is the moment
                the document becomes binding. */}
            <h2 className="text-section text-ink-950 flex items-center gap-2">
              <PenLine className="size-4 text-brand-700" />
              Send for signature
            </h2>
            <p className="text-dense text-ink-500 mt-1 truncate max-w-md">
              {contractTitle}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md hover:bg-paper-100 text-ink-400"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          {blockReason && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-attention-50 border border-attention-200 text-body text-attention-700">
              <AlertCircle className="size-4 mt-0.5 flex-shrink-0" />
              <span>{blockReason}</span>
            </div>
          )}

          {/* Signers section */}
          <div>
            <label className="text-body font-medium text-ink-950 mb-1 flex items-center gap-1.5">
              <Users className="size-4 text-ink-400" />
              Signers
              <span className="text-dense font-normal text-ink-400 ml-1 tabular-nums">
                ({validSigners.length} valid · {signers.length} row{signers.length === 1 ? '' : 's'})
              </span>
            </label>
            <p className="text-dense text-ink-500 mb-2">
              Each signer gets a unique link. Internal signers can also sign in-app.
            </p>
            <div className="space-y-2">
              {signers.map((s, i) => (
                <div key={i} className="flex items-center gap-2" data-testid={`signer-row-${i}`}>
                  {signOrder === 'SEQUENTIAL' && (
                    <Input
                      type="number"
                      min={1}
                      value={s.signOrder}
                      onChange={(e) => update(i, { signOrder: Math.max(1, +e.target.value || 1) })}
                      className="w-12 px-0 text-center tabular-nums"
                      title="Sign order (1 first)"
                      aria-label={`Sign order for signer ${i + 1}`}
                    />
                  )}
                  <Input
                    type="text"
                    placeholder="Name"
                    value={s.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                    className="flex-1"
                    data-testid={`signer-name-${i}`}
                  />
                  <Input
                    type="email"
                    placeholder="email@example.com"
                    value={s.email}
                    onChange={(e) => update(i, { email: e.target.value })}
                    className="flex-1"
                    data-testid={`signer-email-${i}`}
                  />
                  <Input
                    type="text"
                    placeholder="Role (optional)"
                    value={s.role}
                    onChange={(e) => update(i, { role: e.target.value })}
                    className="w-28"
                    data-testid={`signer-role-${i}`}
                  />
                  {signers.length > 1 && (
                    <button
                      type="button"
                      onClick={() => remove(i)}
                      aria-label={`Remove signer ${i + 1}`}
                      className="p-1.5 rounded-md text-ink-400 hover:bg-risk-50 hover:text-risk-600"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={add}
              className="mt-2 inline-flex items-center gap-1 text-dense text-ink-700 hover:text-ink-950 font-medium"
              data-testid="add-signer"
            >
              <Plus className="size-3.5" />
              Add signer
            </button>
          </div>

          {/* Sign order + expiry row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-body font-medium text-ink-950 mb-1 block">
                Sign order
              </label>
              {/* Selection is an action, so the chosen option inverts to ink —
                  the same rule the filter chips follow. */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSignOrder('ANY')}
                  data-testid="sign-order-any"
                  className={`flex-1 h-8 text-[12.5px] rounded-md border transition-colors ${
                    signOrder === 'ANY'
                      ? 'border-ink-950 bg-ink-950 text-white font-semibold'
                      : 'border-paper-200 text-ink-700 hover:border-paper-300'
                  }`}
                >
                  Anyone, any order
                </button>
                <button
                  type="button"
                  onClick={() => setSignOrder('SEQUENTIAL')}
                  data-testid="sign-order-sequential"
                  className={`flex-1 h-8 text-[12.5px] rounded-md border transition-colors ${
                    signOrder === 'SEQUENTIAL'
                      ? 'border-ink-950 bg-ink-950 text-white font-semibold'
                      : 'border-paper-200 text-ink-700 hover:border-paper-300'
                  }`}
                >
                  In sequence
                </button>
              </div>
            </div>
            <div>
              <label className="text-body font-medium text-ink-950 mb-1 block">
                Expires in
              </label>
              <select
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(+e.target.value)}
                data-testid="expires-in-days"
                className="w-full h-8 text-[13px] border border-input rounded-md px-2.5 bg-card focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15"
              >
                <option value={7}>7 days</option>
                <option value={14}>14 days</option>
                <option value={30}>30 days</option>
                <option value={60}>60 days</option>
                <option value={90}>90 days</option>
              </select>
            </div>
          </div>

          {/* Message */}
          <div>
            <label className="text-body font-medium text-ink-950 mb-1 block">
              Message <span className="text-ink-400 font-normal">(optional)</span>
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value.slice(0, 2000))}
              placeholder="Shown above the document on the signer's page. Add context — what they're signing, deadline, who to contact with questions."
              rows={3}
              data-testid="sign-message"
              className="w-full resize-none rounded-md border border-input bg-card px-[11px] py-2 text-[13px] text-ink-950 placeholder:text-ink-400 focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15"
            />
            <p className="text-dense text-ink-400 mt-1 tabular-nums">{message.length} / 2000</p>
          </div>

          {/* Error from backend */}
          {submit.isError && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-risk-50 border border-risk-200 text-body text-risk-700" data-testid="send-for-signature-error">
              <AlertCircle className="size-4 mt-0.5 flex-shrink-0" />
              <span>
                {(submit.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail
                  ?? 'Failed to send for signature. Please try again.'}
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-paper-200 flex items-center justify-between bg-paper-50 rounded-b-card">
          <div className="text-dense text-ink-500">
            {validSigners.length === 0
              ? 'Add at least one signer with a valid email.'
              : `Will send ${validSigners.length} signing link${validSigners.length === 1 ? '' : 's'}.`}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            {/* Ink, not brand: this dispatches signing links, it does not make
                the contract binding. Matches the design system's own
                send-for-signature dialog, which confirms with an ink button. */}
            <Button
              variant="default"
              size="sm"
              onClick={() => submit.mutate()}
              disabled={!canSubmit}
              data-testid="send-for-signature-confirm"
            >
              {submit.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <>
                  <PenLine className="size-3.5 mr-1" />
                  Send for signature
                  <ArrowRight className="size-3.5 ml-1" />
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
