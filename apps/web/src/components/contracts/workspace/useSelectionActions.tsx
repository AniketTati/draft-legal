/**
 * docs/41 Part 16 — the selection menu's actions on a contract: Comment ·
 * Ask AI · Tag clause · Make variable · Request exception. Shared by the
 * workspace (bubble menu while editing, SelectionMenu while reading) and the
 * contract page (its document and the original PDF).
 */
import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Editor } from '@tiptap/react'
import { api } from '@/lib/api'
import { logAiEvent } from '@/lib/ai-events'
import { useCanRequest } from '@/lib/permissions'
import { approvalKeys, serverMessage } from '@/lib/approval-keys'
import type { ContractReview, ReviewFindingView } from '@/lib/review'
import type { DraftVariables } from '@/lib/draft-variables'
import { toast } from '@/components/common/Toaster'
import { ReasonDialog } from '@/components/common/ReasonDialog'
import { ExceptionApproverNote } from '@/components/contracts/review/ExceptionApproverNote'
import { ClauseTagPicker } from '@/components/contracts/ClauseTagPicker'
import { BubbleAiPopover } from '@/components/contracts/BubbleAiPopover'
import type { AskAiOutcome } from '@/components/contracts/AskAiDrafts'
import { charOffsetAt } from '@/components/contracts/SourceHighlight'
import type { SelectionActionsProps, TextSelection } from '@/components/contracts/SelectionMenu'
import type { CommentDraft } from './CommentComposer'
import { CommentPopover, VariablePicker, exceptionFindingAt } from './selection-pieces'

export interface SelectionActionsOptions {
  contractId: string
  editor: Editor | null
  clauses: Array<{ id: string; content: string }>
  /** The version a comment's anchor is in. */
  versionId: string | null
  canEdit: boolean
  /** Where a comment goes: the workspace's Comments view; absent, a box over the words. */
  onComment?: (draft: CommentDraft) => void
  /** Logs what became of Ask AI's drafts. */
  onAiOutcome?: (outcome: AskAiOutcome, suggestionId: string) => void
  /** Tag clause from here (the contract page has its own). */
  tag?: boolean
}

export function useSelectionActions(o: SelectionActionsOptions): { editorActions: SelectionActionsProps; pdfActions: SelectionActionsProps; ui: ReactNode } {
  const qc = useQueryClient()
  const mayComment = useCanRequest('POST /contracts/:id/comments')
  const mayAsk = useCanRequest('POST /contracts/:id/ask-ai')
  const mayTag = useCanRequest('POST /contracts/:id/clauses/tag')
  const mayException = useCanRequest('POST /contracts/:id/findings/:findingId/exception')
  const [tagFrom, setTagFrom] = useState<TextSelection | null>(null)
  const [varFrom, setVarFrom] = useState<{ sel: TextSelection; from: number; to: number } | null>(null)
  const [ai, setAi] = useState<{ text: string; from: number; to: number } | null>(null)
  const [commentAt, setCommentAt] = useState<{ sel: TextSelection; draft: CommentDraft } | null>(null)
  const [exceptionFor, setExceptionFor] = useState<Pick<ReviewFindingView, 'id' | 'title'> | null>(null)

  const review = useQuery({
    queryKey: ['contract-review', o.contractId],
    queryFn: () => api.get<ContractReview>(`/contracts/${o.contractId}/review`).then(r => r.data),
    enabled: !!o.contractId && o.canEdit && mayException,
    staleTime: 10_000,
  })
  const findings = review.data ? Object.values(review.data.groups).flat() : []
  const vars = useQuery({
    queryKey: ['contract-variables', o.contractId, 'menu'],
    queryFn: () => api.get<DraftVariables>(`/contracts/${o.contractId}/variables`).then(r => r.data),
    enabled: !!o.contractId && o.canEdit,
    staleTime: 60_000,
  })
  // Only a draft from one of our own templates has variables to mark.
  const templateVars = vars.data?.template ? vars.data.variables : []

  const askException = useMutation({
    meta: { errorHandled: true },
    mutationFn: (reason: string) => api.post(`/contracts/${o.contractId}/findings/${exceptionFor!.id}/exception`, { reason }),
    onSuccess: () => {
      setExceptionFor(null)
      toast.success('Exception requested')
      qc.invalidateQueries({ queryKey: ['contract-review', o.contractId] })
      qc.invalidateQueries({ queryKey: approvalKeys.contract(o.contractId) })
    },
  })

  const range = () => o.editor && !o.editor.isDestroyed ? { from: o.editor.state.selection.from, to: o.editor.state.selection.to } : null
  const anchorOf = (sel: TextSelection) => {
    const r = range()
    const start = r && o.editor ? charOffsetAt(o.editor, r.from) : 0
    return { quote: sel.text, start, end: start + sel.text.length, versionId: o.versionId }
  }
  const comment = (sel: TextSelection, fromEditor: boolean) => {
    const draft: CommentDraft = { anchor: fromEditor ? anchorOf(sel) : { quote: sel.text, start: 0, end: sel.text.length, versionId: o.versionId } }
    if (o.onComment) o.onComment(draft)
    else setCommentAt({ sel, draft })
  }
  const exceptionAt: SelectionActionsProps['exceptionAt'] = o.canEdit && mayException
    ? sel => {
        const f = exceptionFindingAt(sel.text, o.clauses, findings)
        return f ? { title: f.title, run: () => setExceptionFor(f) } : null
      }
    : undefined

  const base: SelectionActionsProps = {
    onTagClause: o.tag && o.canEdit && mayTag ? setTagFrom : undefined,
    exceptionAt,
  }
  const editorActions: SelectionActionsProps = {
    ...base,
    onComment: mayComment ? sel => comment(sel, true) : undefined,
    onAskAi: o.canEdit && mayAsk ? sel => { const r = range(); if (r) setAi({ text: sel.text, ...r }) } : undefined,
    onMakeVariable: o.canEdit && templateVars.length ? sel => { const r = range(); if (r) setVarFrom({ sel, ...r }) } : undefined,
  }
  // Over the original PDF there is no editor to rewrite or mark.
  const pdfActions: SelectionActionsProps = { ...base, onComment: mayComment ? sel => comment(sel, false) : undefined }

  const ui = (
    <>
      {tagFrom && <ClauseTagPicker contractId={o.contractId} selection={tagFrom} onClose={() => setTagFrom(null)} />}
      {varFrom && (
        <VariablePicker
          sel={varFrom.sel}
          variables={templateVars}
          onClose={() => setVarFrom(null)}
          onPick={key => {
            o.editor?.chain().focus().setTextSelection({ from: varFrom.from, to: varFrom.to }).setMark('variable', { key }).run()
            setVarFrom(null)
          }}
        />
      )}
      {commentAt && <CommentPopover sel={commentAt.sel} contractId={o.contractId} draft={commentAt.draft} onClose={() => setCommentAt(null)} />}
      <BubbleAiPopover
        editor={o.editor}
        open={!!ai}
        onClose={() => setAi(null)}
        selectedText={ai?.text}
        selectionRange={ai ? { from: ai.from, to: ai.to } : null}
        contractId={o.contractId}
        onOutcome={(outcome, suggestionId) => {
          logAiEvent({ contractId: o.contractId, versionId: o.versionId, feature: 'ask_ai', outcome, suggestionId })
          o.onAiOutcome?.(outcome, suggestionId)
        }}
      />
      <ReasonDialog
        open={!!exceptionFor}
        title="Request exception"
        intro={exceptionFor ? <ExceptionApproverNote contractId={o.contractId} findingId={exceptionFor.id} title={exceptionFor.title} /> : null}
        label="Why should this be allowed?"
        placeholder="For example: the customer is a public body and can't accept a cap above fees."
        confirmLabel="Request exception"
        pendingLabel="Requesting…"
        pending={askException.isPending}
        error={askException.isError ? serverMessage(askException.error) : null}
        onConfirm={reason => askException.mutate(reason)}
        onClose={() => { setExceptionFor(null); askException.reset() }}
      />
    </>
  )
  return { editorActions, pdfActions, ui }
}
