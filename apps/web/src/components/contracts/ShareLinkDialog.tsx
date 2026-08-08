/**
 * ShareLinkDialog — create and manage portal share links for contracts.
 * Creates time-limited, permission-scoped links for external reviewers.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Link, Copy, Check, X, Trash2, Loader2, Eye, MessageSquare, Upload } from 'lucide-react'

interface ShareLink {
  id: string
  label?: string | null
  invitedEmail?: string | null
  permissions: string[]
  expiresAt: string
  viewCount: number
  lastViewedAt?: string | null
  createdAt: string
}

interface ShareLinkDialogProps {
  contractId: string
  onClose: () => void
}

const EXPIRY_OPTIONS = [
  { label: '24 hours',  hours: 24 },
  { label: '3 days',   hours: 72 },
  { label: '7 days',   hours: 168 },
  { label: '14 days',  hours: 336 },
  { label: '30 days',  hours: 720 },
]

export function ShareLinkDialog({ contractId, onClose }: ShareLinkDialogProps) {
  const qc = useQueryClient()
  const [label, setLabel] = useState('')
  const [expiresInHours, setExpiresInHours] = useState(168)
  const [canComment, setCanComment] = useState(false)
  const [canUpload, setCanUpload] = useState(false)
  const [recipientEmail, setRecipientEmail] = useState('')
  const [message, setMessage] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [newLinkUrl, setNewLinkUrl] = useState<string | null>(null)
  const [emailedTo, setEmailedTo] = useState<string | null>(null)
  // null = no email requested; false = requested but SMTP isn't configured.
  const [emailDelivered, setEmailDelivered] = useState<boolean | null>(null)

  const linksQuery = useQuery({
    queryKey: ['share-links', contractId],
    queryFn: () => api.get(`/contracts/${contractId}/share`).then(r => r.data.data as ShareLink[]),
  })

  const createLink = useMutation({
    mutationFn: () => api.post(`/contracts/${contractId}/share`, {
      label: label.trim() || undefined,
      permissions: [
        'read',
        ...(canComment ? ['comment'] : []),
        ...(canUpload ? ['upload'] : []),
      ],
      expiresInHours,
      // When set, the server emails the link instead of leaving the user to
      // copy/paste it into their own mail client.
      recipientEmail: recipientEmail.trim() || undefined,
      message: message.trim() || undefined,
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['share-links', contractId] })
      setNewLinkUrl(res.data.portalUrl)
      setEmailedTo(res.data.emailedTo ?? null)
      setEmailDelivered(res.data.emailDelivered ?? null)
      setLabel('')
      setCanComment(false)
      setCanUpload(false)
      setRecipientEmail('')
      setMessage('')
    },
  })

  const revokeLink = useMutation({
    mutationFn: (linkId: string) => api.delete(`/contracts/${contractId}/share/${linkId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['share-links', contractId] }),
  })

  const handleCopy = async (url: string, id: string) => {
    await navigator.clipboard.writeText(url)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const links: ShareLink[] = linksQuery.data ?? []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-card rounded-card shadow-e3 w-full max-w-lg flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-paper-200">
          <div className="flex items-center gap-2">
            <Link className="size-4 text-ink-400" />
            <h2 className="text-section text-ink-950">Share Contract</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-ink-400 hover:text-ink-700 hover:bg-paper-100 transition-colors">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* New link just created. A link that exists is a fact, not a
              binding one — this used to be an emerald "success" card, which is
              the decoration emerald is not for. */}
          {newLinkUrl && (
            <div className="bg-paper-50 border border-paper-200 rounded-card p-4">
              <p className="text-body font-semibold text-ink-950 mb-2">
                {emailedTo && emailDelivered
                  ? `Link sent to ${emailedTo}`
                  : 'Link created! Share this URL:'}
              </p>
              {emailedTo && emailDelivered === false && (
                <p className="text-dense text-attention-700 bg-attention-50 border border-attention-200 rounded-md px-2.5 py-1.5 mb-2">
                  Email isn't configured on this deployment, so nothing was sent to{' '}
                  <span className="font-medium">{emailedTo}</span>. Copy the URL below and send it yourself.
                </p>
              )}
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={newLinkUrl}
                  className="flex-1 h-8 text-[11px] font-mono bg-card border border-paper-200 rounded-md px-2 truncate"
                />
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => handleCopy(newLinkUrl, 'new')}
                  className="flex-shrink-0"
                >
                  {copiedId === 'new' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copiedId === 'new' ? 'Copied!' : 'Copy'}
                </Button>
              </div>
            </div>
          )}

          {/* Create form */}
          <div className="space-y-4">
            <p className="text-section text-ink-950">Create new link</p>
            <div>
              <label className="text-dense text-ink-500 font-medium mb-1 block">Label (optional)</label>
              <Input
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="e.g. Acme Legal Review"
              />
            </div>
            <div>
              <label className="text-dense text-ink-500 font-medium mb-1 block">
                Send to (optional)
              </label>
              <Input
                type="email"
                value={recipientEmail}
                onChange={e => setRecipientEmail(e.target.value)}
                placeholder="counsel@counterparty.com"
                data-testid="share-recipient-email"
              />
              <p className="text-[11px] text-ink-400 mt-1">
                Leave blank to just generate a link you copy yourself.
              </p>
            </div>
            {recipientEmail.trim() && (
              <div>
                <label className="text-dense text-ink-500 font-medium mb-1 block">Note (optional)</label>
                <textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  rows={2}
                  placeholder="Happy to walk through the redlines this week."
                  className="w-full resize-none rounded-md border border-input bg-card px-[11px] py-2 text-[13px] text-ink-950 placeholder:text-ink-400 focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/12"
                />
              </div>
            )}
            <div>
              <label className="text-dense text-ink-500 font-medium mb-1 block">Expires in</label>
              <select
                value={expiresInHours}
                onChange={e => setExpiresInHours(Number(e.target.value))}
                className="w-full h-8 text-[13px] border border-input bg-card rounded-md px-2.5 focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/12"
              >
                {EXPIRY_OPTIONS.map(opt => (
                  <option key={opt.hours} value={opt.hours}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <p className="text-dense text-ink-500 font-medium mb-2">Permissions</p>
              <div className="space-y-2">
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <div className="size-4 rounded-chip border-2 border-ink-950 bg-ink-950 flex items-center justify-center flex-shrink-0">
                    <Check className="size-2.5 text-white" />
                  </div>
                  <div className="flex items-center gap-1.5 text-body text-ink-700">
                    <Eye className="size-3.5 text-ink-400" />
                    Read — view contract
                  </div>
                </label>
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={canComment}
                    onChange={e => setCanComment(e.target.checked)}
                    className="size-4 rounded-chip border-paper-300 accent-ink-950"
                  />
                  <div className="flex items-center gap-1.5 text-body text-ink-700">
                    <MessageSquare className="size-3.5 text-ink-400" />
                    Comment — add comments
                  </div>
                </label>
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={canUpload}
                    onChange={e => setCanUpload(e.target.checked)}
                    className="size-4 rounded-chip border-paper-300 accent-ink-950"
                  />
                  <div className="flex items-center gap-1.5 text-body text-ink-700">
                    <Upload className="size-3.5 text-ink-400" />
                    Upload — return a revised version
                  </div>
                </label>
              </div>
              {canUpload && (
                <p className="text-[11px] text-ink-500 mt-2 leading-relaxed">
                  Lets the counterparty download the document, redline it offline, and
                  upload it back as a new version for you to review.
                </p>
              )}
            </div>
            <Button
              className="w-full"
              disabled={createLink.isPending}
              onClick={() => createLink.mutate()}
            >
              {createLink.isPending ? <Loader2 className="size-3.5 animate-spin mr-2" /> : <Link className="size-3.5 mr-2" />}
              {recipientEmail.trim() ? 'Send link' : 'Generate link'}
            </Button>
          </div>

          {/* Existing links */}
          {links.length > 0 && (
            <div className="space-y-3">
              <p className="text-section text-ink-950">Active links</p>
              {links.map(link => (
                <div key={link.id} className="bg-paper-50 border border-paper-200 rounded-card p-3.5 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-body font-medium text-ink-950">
                        {link.label ?? 'Untitled link'}
                      </p>
                      {link.invitedEmail && (
                        <p className="text-dense text-ink-500 mt-0.5">Sent to {link.invitedEmail}</p>
                      )}
                      <p className="text-dense text-ink-400 mt-0.5 tabular-nums">
                        Expires {new Date(link.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        {' · '}{link.viewCount} view{link.viewCount !== 1 ? 's' : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {/* Permissions are labels, not states — none of the
                          three is a meaning, so all three are neutral. */}
                      <div className="flex gap-1">
                        {(link.permissions.includes('upload') || link.permissions.includes('edit')) && (
                          <span className="text-[11px] bg-paper-100 text-ink-700 px-1.5 py-0.5 rounded-chip font-medium">
                            upload
                          </span>
                        )}
                        {link.permissions.includes('comment') && (
                          <span className="text-[11px] bg-paper-100 text-ink-700 px-1.5 py-0.5 rounded-chip font-medium">
                            comment
                          </span>
                        )}
                        <span className="text-[11px] bg-paper-100 text-ink-500 px-1.5 py-0.5 rounded-chip font-medium">
                          read
                        </span>
                      </div>
                      <button
                        onClick={() => revokeLink.mutate(link.id)}
                        className="p-1 text-ink-400 hover:text-risk-600 rounded-md transition-colors ml-1"
                        title="Revoke link"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
