/**
 * docs/41 Parts 15, 16 (C2) — the contract workspace: one full-screen place
 * to work on a contract. No app rail: the status banner on top (its one
 * primary action), the document in the middle (typing autosaves to the
 * draft changes, C1), and on the right Review, Details or Comments. Changes
 * mode shows what changed since a baseline as tracked changes, each with
 * its finding and Accept change / Keep original / Counter… / Comment.
 *
 * Where it opens from: lib/workspace.ts (openPathFor) says which contracts
 * open here and why.
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, GitCompareArrows, History, Loader2 } from 'lucide-react'
import type { Editor } from '@tiptap/react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toaster'
import { useCanRequest, usePermission } from '@/lib/permissions'
import { currentVersionOf } from '@/lib/current-version'
import { invalidateApproval, serverMessage } from '@/lib/approval-keys'
import { useWorkingCopy } from '@/hooks/useWorkingCopy'
import { type SaveVersionBody } from '@/lib/working-copy'
import { DocumentCanvas, type CanvasState } from '@/components/contracts/DocumentCanvas'
import { StatusBanner } from '@/components/contracts/StatusBanner'
import { HistoryDrawer } from '@/components/contracts/HistoryDrawer'
import { ReviewPanel } from '@/components/contracts/review/ReviewPanel'
import { CommentsPanel } from '@/components/contracts/CommentsPanel'
import { SendForReviewDialog } from '@/components/contracts/SendForReviewDialog'
import { SendForSignatureDialog } from '@/components/contracts/SendForSignatureDialog'
import { revealInCanvas } from '@/components/contracts/SourceHighlight'
import { LeaveDraftPrompt, SaveVersionDialog, WorkingCopyConflictDialog, draftStatusText, type LeaveChoice } from '@/components/contracts/WorkingCopyDialogs'
import { WorkspaceDetails } from '@/components/contracts/workspace/WorkspaceDetails'
import { ChangesView } from '@/components/contracts/workspace/ChangesView'
import { WORKSPACE_PANELS, jumpTo, type WorkspacePanel } from '@/lib/workspace'

interface ContractLite {
  id: string
  title: string
  type?: string | null
  status: string
  value?: number | null
  currency?: string | null
  matterId?: string | null
  currentVersionId: string | null
  externalEdit?: unknown
  metadata?: Record<string, unknown> | null
  versions: Array<{ id: string; versionNumber: number; htmlContent?: string | null; plainText?: string | null; createdAt: string; changeNote?: string | null }>
}

export function ContractWorkspacePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const changesMode = params.get('mode') === 'changes'
  const setChangesMode = (on: boolean) => setParams(p => { const n = new URLSearchParams(p); if (on) n.set('mode', 'changes'); else n.delete('mode'); return n }, { replace: true })
  const [panel, setPanel] = useState<WorkspacePanel>('review')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [submitOpen, setSubmitOpen] = useState(false)
  const [signatureOpen, setSignatureOpen] = useState(false)
  const [commentQuote, setCommentQuote] = useState<string | null>(null)

  const mayEdit = useCanRequest('PUT /contracts/:id/working-copy')
  const canEditFields = useCanRequest('PUT /contracts/:id/fields/:key')
  const canShare = useCanRequest('POST /contracts/:id/share')
  const canResetApprovals = usePermission('configure', 'workflow')

  const { data: contract, isLoading, isError } = useQuery<ContractLite>({
    queryKey: ['contract', id],
    queryFn: () => api.get(`/contracts/${id}`).then(r => r.data),
    enabled: !!id,
  })
  const { data: clausesData } = useQuery<{ data: Array<{ id: string; content: string; riskRating?: string | null }> }>({
    queryKey: ['contract-clauses', id],
    queryFn: () => api.get(`/contracts/${id}/clauses`).then(r => r.data),
    enabled: !!id,
    staleTime: 30_000,
  })
  const clauses = clausesData?.data ?? []
  const canEdit = mayEdit && !contract?.externalEdit

  // ── The document and its draft changes (C1) ──────────────────────────────
  const editorRef = useRef<Editor | null>(null)
  const draft = useWorkingCopy(id, {
    onSaveError: (err) => {
      const data = (err as { response?: { data?: { code?: string; detail?: string } } })?.response?.data
      if (data?.code === 'EDITING_IN_GOOGLE_DOCS') {
        toast.error('Not saved: this contract is being edited in Google Docs', { description: data.detail, durationMs: 9000 })
        qc.invalidateQueries({ queryKey: ['contract', id] })
      }
    },
  })
  // The draft changes the editor opens on, when there are any (else the version).
  const [draftHtml, setDraftHtml] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (!contract || loaded) return
    let gone = false
    draft.load(contract.currentVersionId).then(copy => {
      if (gone) return
      setDraftHtml(copy?.html ?? null)
      if (copy?.stale) toast.info('These draft changes were started on an older version', { description: `They were made on v${copy.baseVersionNumber ?? '?'}; a newer version was saved since.`, durationMs: 9000 })
    }).catch(() => {}).finally(() => { if (!gone) setLoaded(true) })
    return () => { gone = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract?.id])

  /** Put new text in the editor and the draft changes (a decision in Changes mode). */
  const replaceDocument = async (next: string) => {
    setDraftHtml(next)
    editorRef.current?.commands.setContent(next, { emitUpdate: false })
    draft.change(next)
    return draft.flush()
  }

  // Typing not yet saved when the tab closes; ⌘S saves now.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => { if (draft.hasPendingTyping()) { void draft.flush(); e.preventDefault() } }
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void draft.flush() } }
    window.addEventListener('beforeunload', onUnload)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('beforeunload', onUnload); window.removeEventListener('keydown', onKey) }
  }, [draft])

  const [saveOpen, setSaveOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const saveAsVersion = async (body: SaveVersionBody) => {
    if (!id) return
    setSaving(true)
    setSaveError(null)
    try {
      const r = await draft.saveVersion(body)
      setSaveOpen(false)
      setDraftHtml(null)
      invalidateApproval(qc, id)
      toast.success(r.created ? `Saved as v${r.version.versionNumber}` : 'No changes to save', { description: body.note })
      if (r.send?.portalUrl) {
        await navigator.clipboard?.writeText(r.send.portalUrl).catch(() => {})
        toast.success('Share link copied', { description: r.send.portalUrl, durationMs: 9000 })
      }
      afterSave.current?.()
      afterSave.current = null
    } catch (err) {
      setSaveError(serverMessage(err, (err as Error).message || 'Not saved. Try again.'))
    } finally {
      setSaving(false)
    }
  }
  const afterSave = useRef<(() => void) | null>(null)

  // Back to the contract page: ask first when there are draft changes.
  const [leaving, setLeaving] = useState(false)
  const [leaveBusy, setLeaveBusy] = useState<LeaveChoice | null>(null)
  const exitTo = `/contracts/${id}`
  const leave = () => { if (draft.hasDraft()) setLeaving(true); else navigate(exitTo) }
  const chooseLeave = async (choice: LeaveChoice) => {
    if (choice === 'save') { setLeaving(false); afterSave.current = () => navigate(exitTo); setSaveOpen(true); return }
    setLeaveBusy(choice)
    try {
      if (choice === 'keep') await draft.flush()
      else await draft.discard()
      setLeaving(false)
      navigate(exitTo)
    } catch (err) {
      toast.error(choice === 'discard' ? 'Not discarded' : 'Not saved', { description: serverMessage(err, 'Try again.') })
    } finally {
      setLeaveBusy(null)
    }
  }

  const showInDocument = (target: { clauseId?: string | null; quote?: string | null }) => {
    const found = jumpTo(target, { root: document, clauses, reveal: text => revealInCanvas(editorRef.current, text) })
    if (!found) toast.info('Not found in the document', { description: 'Its words may have changed since it was analysed.' })
  }

  if (isError) return <div className="p-8 text-body text-ink-700">This contract could not be opened. <Link to="/contracts" className="underline">Back to contracts</Link></div>
  if (isLoading || !contract || !id) return <div className="p-8 flex items-center gap-2 text-ink-500"><Loader2 className="size-4 animate-spin" />Opening…</div>

  const latest = currentVersionOf(contract.versions, contract.currentVersionId)
  const html = draftHtml ?? (latest?.htmlContent?.trim() ? latest.htmlContent : latest?.plainText?.trim() || '')
  const canvasState: CanvasState = !loaded ? { kind: 'loading' } : html.replace(/<[^>]*>/g, '').trim() || canEdit ? { kind: 'ready', html } : { kind: 'empty' }

  return (
    <div className="fixed inset-0 flex flex-col bg-paper-50" data-testid="contract-workspace">
      <header className="flex items-center gap-3 px-4 py-2 border-b border-paper-200 bg-card">
        <Button size="sm" variant="ghost" onClick={leave} data-testid="workspace-back" title="Back to the contract page"><ArrowLeft />Back</Button>
        <h1 className="text-body font-semibold text-ink-950 truncate" data-testid="workspace-title">{contract.title}</h1>
        {canEdit && <span className="text-[11.5px] text-ink-500" data-testid="workspace-draft-state">{draftStatusText(draft.saveState)}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant={changesMode ? 'default' : 'outline'} onClick={() => setChangesMode(!changesMode)} aria-pressed={changesMode} data-testid="workspace-changes-toggle">
            <GitCompareArrows />Changes
          </Button>
          {canEdit && <Button size="sm" variant="outline" onClick={() => setSaveOpen(true)} disabled={!draft.hasCopy && draft.saveState !== 'dirty'} data-testid="workspace-save-version">Save as version</Button>}
          <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(true)} data-testid="workspace-history"><History />History</Button>
        </div>
      </header>

      <StatusBanner
        contractId={id}
        onSubmit={() => setSubmitOpen(true)}
        onSendForSignature={() => setSignatureOpen(true)}
        onReviewChanges={() => setChangesMode(true)}
        onOpenHistory={() => setHistoryOpen(true)}
      />

      <div className="flex-1 min-h-0 flex">
        <main className="flex-1 min-w-0 overflow-y-auto" data-testid="workspace-document">
          <div className="max-w-[860px] mx-auto py-6 px-4">
            {changesMode ? (
              <ChangesView
                contractId={id}
                canEdit={canEdit}
                onApply={replaceDocument}
                onComment={quote => { setCommentQuote(`“${quote.slice(0, 400)}” `); setPanel('comments') }}
              />
            ) : (
              <DocumentCanvas
                state={canvasState}
                editable={canEdit && loaded}
                onReady={editor => { editorRef.current = editor }}
                onChange={next => { if (canvasState.kind === 'ready' && canEdit) draft.change(next) }}
                riskClauses={clauses.map(c => ({ id: c.id, content: c.content, riskRating: c.riskRating ?? null }))}
              />
            )}
          </div>
        </main>

        <aside className="w-[380px] shrink-0 border-l border-paper-200 bg-card flex flex-col min-h-0" data-testid="workspace-panel">
          <div role="tablist" aria-label="Panel" className="flex gap-1 px-3 pt-2 border-b border-paper-200">
            {WORKSPACE_PANELS.map(p => (
              <button
                key={p.id}
                role="tab"
                aria-selected={panel === p.id}
                onClick={() => setPanel(p.id)}
                className={cn('px-2.5 py-1.5 text-dense font-medium border-b-2 -mb-px', panel === p.id ? 'border-ink-950 text-ink-950' : 'border-transparent text-ink-500 hover:text-ink-950')}
                data-testid={`workspace-tab-${p.id}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-3">
            {panel === 'review' && (
              <ReviewPanel
                contractId={id}
                contractMetadata={contract.metadata ?? undefined}
                canEdit={canEdit}
                onJumpToClause={clauseId => showInDocument({ clauseId })}
                onShowText={quote => showInDocument({ quote })}
              />
            )}
            {panel === 'details' && (
              <WorkspaceDetails
                contractId={id}
                matterId={contract.matterId ?? null}
                canEdit={canEdit}
                canEditFields={canEditFields}
                beforeChange={() => draft.flush()}
              />
            )}
            {/* Temporary: C3 replaces this with threads in the margin. */}
            {panel === 'comments' && <CommentsPanel key={commentQuote ?? ''} contractId={id} initialBody={commentQuote ?? undefined} />}
          </div>
        </aside>
      </div>

      <HistoryDrawer
        contractId={id}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onCompare={() => { setHistoryOpen(false); setChangesMode(true) }}
        onDownload={versionId => {
          api.get(`/contracts/${id}/download`, { params: { versionId } })
            .then(r => window.open((r.data as { url: string }).url, '_blank', 'noopener'))
            .catch(err => toast.error('Not downloaded', { description: serverMessage(err, 'Try again.') }))
        }}
      />
      <SendForReviewDialog
        contractId={id} contractType={contract.type ?? undefined} contractValue={contract.value ?? undefined} contractCurrency={contract.currency ?? undefined}
        open={submitOpen} onClose={() => setSubmitOpen(false)} onSent={() => invalidateApproval(qc, id)}
      />
      <SendForSignatureDialog
        contractId={id} contractTitle={contract.title} contractStatus={contract.status} hasVersion={!!contract.currentVersionId}
        open={signatureOpen} onClose={() => setSignatureOpen(false)}
        onSent={() => { qc.invalidateQueries({ queryKey: ['contract', id] }); invalidateApproval(qc, id) }}
      />
      <SaveVersionDialog
        key={saveOpen ? 'open' : 'closed'}
        open={saveOpen}
        onClose={() => { setSaveOpen(false); afterSave.current = null }}
        onSave={saveAsVersion}
        saving={saving}
        error={saveError}
        canResetApprovals={canResetApprovals}
        canShare={canShare}
      />
      <LeaveDraftPrompt open={leaving} busy={leaveBusy} onChoose={chooseLeave} onClose={() => setLeaving(false)} />
      <WorkingCopyConflictDialog
        conflict={draft.conflict}
        onClose={draft.dismissConflict}
        onReload={async () => {
          const theirs = await draft.reloadTheirs()
          if (theirs != null) { setDraftHtml(theirs); editorRef.current?.commands.setContent(theirs, { emitUpdate: false }) }
        }}
        onOverwrite={() => { void draft.overwrite() }}
      />
    </div>
  )
}
