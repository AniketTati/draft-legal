/**
 * ExternalPortalPage — Phase 05 (Negotiation) + B.5.14 trust refactor.
 *
 * Token-gated portal for external reviewers/counterparties. No auth —
 * accessed via /portal/:portalToken. The B.5.14 refactor (docs/26 §6.9
 * and ChatGPT round-3 feedback) added:
 *
 *   - Trust header band: "✓ Shared by <orgName>" + clock + link label,
 *     calming the "is this legit?" anxiety that blocks engagement.
 *   - Primary actions: [Download .docx to redline] + [Upload revised]
 *     — closes the loop so counterparties don't have to be forced into
 *     our portal to get things done. Deal-losing friction point fixed.
 *   - Existing comments tab stays for in-portal back-and-forth.
 *
 * What stays hidden from the counterparty: internal AI summary, risk
 * scores, approvals, precedents, review progress. This is THEIR view —
 * all our analysis is our own.
 */
import { useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { api } from '@/lib/api'
import { CommentsPanel } from '@/components/contracts/CommentsPanel'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/primitives'
import { Wordmark } from '@/components/brand/Wordmark'
import {
  AlertCircle, Loader2, MessageSquare, FileText, Clock, Upload, Download,
  ChevronRight, Building2, ShieldCheck, CheckCircle2, FileWarning, Printer,
} from 'lucide-react'

interface PortalContract {
  id: string
  title: string
  type: string
  status: string
  counterpartyName?: string | null
  effectiveDate?: string | null
  expiryDate?: string | null
  org: {
    name: string
    brandColor?: string | null
    logoUrl?: string | null
  }
}

interface PortalData {
  contract: PortalContract
  htmlContent: string
  versionId?: string
  permissions: string[]
  shareLink: {
    id: string
    label?: string | null
    expiresAt: string
    viewCount: number
  }
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return null
  try {
    return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  } catch {
    return null
  }
}

export function ExternalPortalPage() {
  const { portalToken } = useParams<{ portalToken: string }>()
  const [activeTab, setActiveTab] = useState<'document' | 'comments'>('document')
  const qc = useQueryClient()
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['portal', portalToken],
    queryFn: () =>
      api.get(`/portal/${portalToken}/contract`).then(r => r.data as PortalData),
    enabled: !!portalToken,
    retry: false,
  })

  // B.5.14 — upload a revised version mutation (multipart).
  const uploadRevision = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData()
      form.append('file', file)
      const res = await api.post(`/portal/${portalToken}/versions`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return res.data as { versionNumber: number; filename: string; message: string }
    },
    onSuccess: (res) => {
      setUploadSuccess(`v${res.versionNumber} · ${res.filename}`)
      qc.invalidateQueries({ queryKey: ['portal', portalToken] })
    },
  })

  const editor = useEditor({
    extensions: [StarterKit],
    content: data?.htmlContent ?? '',
    editable: false,
  }, [data?.htmlContent])

  if (isLoading) {
    return (
      <div className="min-h-screen bg-paper-50 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="size-6 animate-spin text-ink-400 mx-auto mb-3" />
          <p className="text-ink-500 text-body">Loading contract…</p>
        </div>
      </div>
    )
  }

  if (isError || !data) {
    /*
     * The most-visited state of this page, and until now the least designed
     * one: three lines of grey text on an otherwise blank browser window, with
     * nothing identifying the product and no next step. A counterparty who
     * reaches it should be able to act without emailing to ask what happened.
     */
    return (
      <div className="min-h-screen bg-paper-50 flex flex-col items-center justify-center gap-6 p-4">
        <div className="w-full max-w-md rounded-card border border-paper-200 bg-card p-8 text-center shadow-e1">
          {/* A dead share link is expiry/revocation — genuine risk, not decor. */}
          <span className="mb-4 inline-flex size-11 items-center justify-center rounded-full bg-risk-50">
            <AlertCircle className="size-5 text-risk-600" />
          </span>
          <h1 className="text-title text-ink-950">Link unavailable</h1>
          <p className="mt-2 text-body text-ink-500">
            This share link is invalid, has expired, or has been revoked.
          </p>
          <div className="mt-5 rounded-md border border-paper-200 bg-paper-50 px-4 py-3 text-left text-dense text-ink-700">
            <p className="font-medium text-ink-950">What to do next</p>
            <ul className="mt-1.5 space-y-1 text-ink-500">
              <li>· Reply to the email that carried this link and ask the sender for a new one.</li>
              <li>· Share links expire on a schedule the sender sets — this is routine, not a fault.</li>
              <li>· Anything you uploaded or commented before it expired was already delivered.</li>
            </ul>
          </div>
        </div>
        <ExternalFooter />
      </div>
    )
  }

  const { contract, permissions, shareLink } = data
  // The sharing org's own brand still owns this strip when they've set one.
  // With no brand configured we fall back to ink rather than a blue that would
  // read as "in flight" in a system where blue means exactly that.
  const brandColor = contract.org?.brandColor ?? null
  const expiresDate = formatDate(shareLink.expiresAt)
  const canComment = permissions.includes('comment')
  // B.5.14 — upload is gated on an explicit 'edit' or 'upload' permission
  // so read-only shares stay truly read-only. Download is allowed for any
  // active link (a read-only link can still be taken home to print).
  const canUpload = permissions.includes('edit') || permissions.includes('upload')
  /*
   * 269 of the 420 contracts in this org have no version row at all, so a share
   * link minted against one delivers `htmlContent: ''`. The portal rendered
   * that as a full-height blank sheet of paper — the counterparty's read is
   * "their product is broken", and the Download .docx button next to it answers
   * with a 400. Detect the case, say what happened, and stop offering an export
   * that cannot succeed.
   */
  const hasDocument = Boolean(data.htmlContent?.trim())
  const isExpiringSoon = shareLink.expiresAt
    ? Date.now() > new Date(shareLink.expiresAt).getTime() - 48 * 3600 * 1000
    : false
  const daysToExpiry = shareLink.expiresAt
    ? Math.max(0, Math.ceil((new Date(shareLink.expiresAt).getTime() - Date.now()) / 86_400_000))
    : null

  return (
    <div className="min-h-screen bg-paper-50 flex flex-col">
      {/* Branded header */}
      <header
        className={`px-6 py-4 flex items-center justify-between ${brandColor ? '' : 'bg-ink-950'}`}
        style={brandColor ? { backgroundColor: brandColor } : undefined}
      >
        <div className="flex items-center gap-3">
          {contract.org.logoUrl ? (
            <img
              src={contract.org.logoUrl}
              alt={contract.org.name}
              className="h-8 w-auto rounded-chip object-contain bg-white/10 p-1"
            />
          ) : (
            <div className="flex items-center justify-center size-8 rounded-md bg-white/20">
              <Building2 className="size-4 text-white" />
            </div>
          )}
          <span className="text-white font-semibold text-body">{contract.org.name}</span>
        </div>
        <div className="flex items-center gap-3">
          {shareLink.label && (
            <span className="text-white/70 text-dense">{shareLink.label}</span>
          )}
          <div className="flex items-center gap-1 text-white/70 text-dense">
            <Clock className="size-3.5" />
            {expiresDate ? `Expires ${expiresDate}` : 'Link active'}
          </div>
        </div>
      </header>

      {/*
        B.5.14 — TRUST BAND. One row of "this is legit" signals + the
        primary actions. Appears between the branded header and the
        contract title so the counterparty sees them before deciding
        whether to engage.

        The band itself is paper now. The one colored thing in it is the
        "Shared by" attestation — verified provenance is one of the few
        non-legal senses the brand green keeps.
      */}
      <div
        role="region"
        aria-label="Portal trust and actions"
        className="bg-paper-100 border-b border-paper-200 px-6 py-2.5"
      >
        <div className="max-w-5xl mx-auto flex items-center gap-4 flex-wrap text-dense">
          <div className="flex items-center gap-1.5 text-brand-700">
            <ShieldCheck className="size-4" />
            <span className="font-medium">Shared by {contract.org.name}</span>
          </div>

          <div className="flex items-center gap-1 text-ink-500">
            <Clock className="size-3.5 text-ink-400" />
            <span>
              {daysToExpiry != null && daysToExpiry > 0
                ? <>Expires in <span className="font-medium tabular-nums">{daysToExpiry}d</span></>
                : expiresDate ? <>Expires {expiresDate}</> : 'Link active'}
            </span>
          </div>

          {shareLink.label && (
            <span className="text-ink-500 truncate">· {shareLink.label}</span>
          )}

          {/* Primary CTAs pushed right. Download is always available on an
              active link; upload requires an 'edit' / 'upload' permission. */}
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            {hasDocument && (
              <>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => window.print()}
                  title="Print, or save as PDF"
                >
                  <Printer />
                  Print
                </Button>
                <Button asChild variant="outline" size="xs">
                  <a
                    href={`/api/v1/portal/${portalToken}/download/docx`}
                    title="Download this version as a Word document you can redline"
                  >
                    <Download />
                    Download .docx
                  </a>
                </Button>
              </>
            )}
            {canUpload && (
              <>
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) uploadRevision.mutate(f)
                    e.target.value = ''
                  }}
                  className="hidden"
                />
                {/* Returning a redline is the job this page exists for, so it
                    takes the single ink primary. */}
                <Button
                  size="xs"
                  onClick={() => uploadInputRef.current?.click()}
                  disabled={uploadRevision.isPending}
                  title="Upload your revised version — lands in our history attributed to this link"
                >
                  {uploadRevision.isPending
                    ? <Loader2 className="animate-spin" />
                    : <Upload />}
                  Upload revised
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Secondary status lines sit just below the trust band. */}
        {uploadSuccess && (
          <div className="max-w-5xl mx-auto mt-1.5 flex items-center gap-1.5 text-dense text-ink-700">
            <CheckCircle2 className="size-3.5" />
            Uploaded {uploadSuccess}. The owner has been notified.
          </div>
        )}
        {uploadRevision.isError && (
          <div className="max-w-5xl mx-auto mt-1.5 flex items-center gap-1.5 text-dense text-risk-700">
            <AlertCircle className="size-3.5" />
            {(uploadRevision.error as { response?: { data?: { error?: string } } })?.response?.data?.error
              ?? 'Upload failed — try again.'}
          </div>
        )}
      </div>

      {/* Expiry warning — the counterparty is the one who has to act on it,
          which is precisely what attention means. */}
      {isExpiringSoon && (
        <div className="bg-attention-50 border-b border-attention-200 px-6 py-2.5 flex items-center gap-2 text-body text-attention-700">
          <AlertCircle className="size-4 flex-shrink-0" />
          This link expires soon. Contact the sender to get a new link before it expires.
        </div>
      )}

      {/* Contract header */}
      <div className="bg-card border-b border-paper-200 px-6 py-5">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              {/* Contract titles run long and arrive from customer data — a
                  180-character title used to push the access label off-screen. */}
              <h1 className="text-title text-ink-950 break-words">{contract.title}</h1>
              <div className="flex items-center gap-3 mt-2 flex-wrap">
                <Chip>{contract.type.replace(/_/g, ' ')}</Chip>
                {contract.counterpartyName && (
                  <span className="text-dense text-ink-500 flex items-center gap-1">
                    <ChevronRight className="size-3" />
                    {contract.counterpartyName}
                  </span>
                )}
                {contract.effectiveDate && (
                  <span className="text-dense text-ink-400">
                    Effective {formatDate(contract.effectiveDate)}
                  </span>
                )}
                {contract.expiryDate && (
                  <span className="text-dense text-ink-400">
                    Expires {formatDate(contract.expiryDate)}
                  </span>
                )}
              </div>
            </div>
            <div className="flex-shrink-0">
              <span className="text-dense text-ink-400 italic">
                {canUpload ? 'View + comment + redline' : 'Read-only view'}
              </span>
            </div>
          </div>

          {/* Tabs. A selected tab is an action state, so it is ink — the blue
              it used to use now belongs to "in flight" statuses only. */}
          <div className="flex gap-1 mt-4">
            <button
              onClick={() => setActiveTab('document')}
              className={`flex items-center gap-1.5 px-3 py-2 text-body font-medium border-b-2 transition-colors ${
                activeTab === 'document'
                  ? 'border-ink-950 text-ink-950'
                  : 'border-transparent text-ink-500 hover:text-ink-950'
              }`}
            >
              <FileText className="size-3.5" />
              Document
            </button>
            {canComment && (
              <button
                onClick={() => setActiveTab('comments')}
                className={`flex items-center gap-1.5 px-3 py-2 text-body font-medium border-b-2 transition-colors ${
                  activeTab === 'comments'
                    ? 'border-ink-950 text-ink-950'
                    : 'border-transparent text-ink-500 hover:text-ink-950'
                }`}
              >
                <MessageSquare className="size-3.5" />
                Comments
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <main className="flex-1 py-8 px-4">
        <div className="max-w-5xl mx-auto">
          {activeTab === 'document' && (
            // The document is the hero: paper radius, page shadow, no card
            // chrome competing with it.
            <div className="bg-card rounded-paper shadow-page overflow-hidden">
              <div className="p-8 md:p-12">
                {!hasDocument ? (
                  <div className="py-12 text-center" data-testid="portal-no-document">
                    <span className="mb-3 inline-flex size-10 items-center justify-center rounded-card border border-paper-200 bg-paper-100 text-ink-400">
                      <FileWarning className="size-5" />
                    </span>
                    <p className="text-[13.5px] font-semibold text-ink-950">
                      No document has been attached to this link yet
                    </p>
                    <p className="mx-auto mt-1 max-w-md text-dense text-ink-500">
                      The link is valid and the record exists, but {contract.org.name} has
                      not uploaded a version for you to read.
                      {canComment
                        ? ' You can still leave a comment below, or reply to the email that sent you here.'
                        : ' Reply to the email that sent you here and ask them to attach it.'}
                    </p>
                  </div>
                ) : editor ? (
                  <EditorContent
                    editor={editor}
                    className="prose prose-sm md:prose max-w-none focus:outline-none [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[400px]"
                  />
                ) : (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="size-5 animate-spin text-ink-400" />
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'comments' && canComment && (
            <CommentsPanel
              contractId={contract.id}
              versionId={data.versionId}
              portalMode={true}
              portalToken={portalToken}
              permissions={permissions}
            />
          )}
        </div>
      </main>

      {/*
        Footer. It used to assert "View only · Do not distribute" on every
        link, including the ones granting comment and upload — the page was
        contradicting its own toolbar. Now it states the access this particular
        link actually carries, and carries the product identity, which a
        counterparty had no other way to learn.
      */}
      <footer className="border-t border-paper-200 bg-card px-6 py-4 text-center print:hidden">
        <p className="text-dense text-ink-400">
          Shared securely by {contract.org.name} ·{' '}
          {canUpload
            ? 'You may comment and return a revised version'
            : canComment
              ? 'You may read and comment'
              : 'Read-only'}{' '}
          · Do not redistribute this link
        </p>
        <ExternalFooter className="mt-2" />
      </footer>
    </div>
  )
}

/**
 * The trimmed external shell's footer — the counterparty has no app nav and no
 * account, so this is the only place that names the product and the only route
 * to the terms under which they are transacting.
 */
function ExternalFooter({ className = '' }: { className?: string }) {
  return (
    <div
      className={`flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-dense text-ink-400 ${className}`}
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
    </div>
  )
}
