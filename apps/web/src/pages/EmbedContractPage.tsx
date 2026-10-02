/**
 * docs/41 Part 17 (S3) — the read-only document preview Salesforce frames
 * (the dlDocumentPreview component). It needs no draftLegal session: the
 * short-lived token in the URL names this one contract and expires in
 * minutes. Nothing here can change the contract.
 */
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { Loader2, Lock } from 'lucide-react'
import { sanitizeHtml } from '@/lib/sanitize'
import { StatusPill } from '@/components/ui/status-pill'

interface EmbedData {
  contract: { id: string; title: string; type: string; status: string; counterpartyName: string | null; updatedAt: string }
  version: { versionNumber: number; html: string | null; text: string | null; createdAt: string } | null
  expiresAt: string
}

export function EmbedContractPage() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const { data, isLoading, error } = useQuery<EmbedData>({
    queryKey: ['embed-contract', id, token],
    queryFn: () => axios.get(`/api/v1/embed/contracts/${encodeURIComponent(id)}`, { params: { token } }).then(r => r.data),
    retry: false,
    refetchOnWindowFocus: false,
  })

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-paper-50"><Loader2 className="size-5 animate-spin text-ink-400" /></div>
  }
  if (error || !data) {
    const detail = (error as { response?: { data?: { detail?: string } } } | null)?.response?.data?.detail
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper-50 p-6" data-testid="embed-unavailable">
        <div className="max-w-sm text-center space-y-2">
          <Lock className="size-5 text-ink-400 mx-auto" />
          <p className="text-body text-ink-950 font-medium">Preview unavailable</p>
          <p className="text-dense text-ink-500">{detail ?? 'This preview link is invalid or has expired. Open it again from Salesforce.'}</p>
        </div>
      </div>
    )
  }

  const { contract, version } = data
  return (
    <div className="min-h-screen bg-paper-50" data-testid="embed-contract">
      <header className="sticky top-0 z-10 bg-card border-b border-paper-200 px-4 py-2.5 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-body font-semibold text-ink-950 truncate">{contract.title}</h1>
          <p className="text-[11px] text-ink-500 truncate">
            {[contract.counterpartyName, version ? `Version ${version.versionNumber}` : null, 'Read-only'].filter(Boolean).join(' · ')}
          </p>
        </div>
        <StatusPill status={contract.status} />
      </header>
      <main className="p-4">
        {version?.html ? (
          // The contract's own paper typography (styles/contract-paper.css), read-only.
          <article className="document-canvas bg-card border border-paper-200 rounded-card p-6 sm:p-10 max-w-[820px] mx-auto">
            <div className="ProseMirror" dangerouslySetInnerHTML={{ __html: sanitizeHtml(version.html) }} />
          </article>
        ) : version?.text ? (
          <article className="bg-card border border-paper-200 rounded-card p-6 max-w-[820px] mx-auto whitespace-pre-wrap text-body text-ink-950">{version.text}</article>
        ) : (
          <p className="text-dense text-ink-500 text-center py-12">This contract has no document yet.</p>
        )}
      </main>
    </div>
  )
}
