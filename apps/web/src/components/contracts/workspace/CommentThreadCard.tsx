/**
 * docs/41 Part 16 — one comment thread, in the margin or in the Comments list.
 * Internal threads (our side only) carry a lock; external ones, which the
 * counterparty reads in the portal, a globe and a different tint.
 */
import { useState } from 'react'
import { Check, Globe, Lock, Reply } from 'lucide-react'
import { ORPHANED_ANCHOR_TEXT } from '@clm/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toaster'
import { serverMessage } from '@/lib/approval-keys'
import { isBy, useCommentActions, type CommentReply, type CommentThreadData } from '@/lib/comments'

function when(iso: string) {
  const d = Date.now() - new Date(iso).getTime()
  if (d < 60_000) return 'just now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
  return `${Math.floor(d / 86_400_000)}d ago`
}

const nameOf = (c: CommentReply) => c.authorName || (c.authorId.startsWith('portal:') ? 'Counterparty' : 'Someone')

export function VisibilityBadge({ visibility }: { visibility: CommentThreadData['visibility'] }) {
  return visibility === 'external' ? (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-700" title="The counterparty can see this thread" data-testid="thread-external">
      <Globe className="size-3" />External
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-500" title="Only your side can see this thread" data-testid="thread-internal">
      <Lock className="size-3" />Internal
    </span>
  )
}

export function CommentThreadCard({ contractId, thread, canEdit, person, active, onShow, compact }: {
  contractId: string
  thread: CommentThreadData
  canEdit: boolean
  /** The person picked in "Document discussion": their comments are highlighted. */
  person?: string | null
  active?: boolean
  /** Show the thread's words in the document. */
  onShow?: (t: CommentThreadData) => void
  compact?: boolean
}) {
  const { add, update } = useCommentActions(contractId)
  const [replying, setReplying] = useState(false)
  const [reply, setReply] = useState('')
  const external = thread.visibility === 'external'
  const fromThem = thread.authorId.startsWith('portal:')
  const orphaned = thread.anchorState === 'orphaned'
  const fail = (title: string) => (err: unknown) => toast.error(title, { description: serverMessage(err, 'Try again.') })

  const send = () => add.mutate({ body: reply.trim(), parentId: thread.id }, {
    onSuccess: () => { setReply(''); setReplying(false) },
    onError: fail('Reply not posted'),
  })
  const flip = () => update.mutate({ id: thread.id, visibility: external ? 'internal' : 'external' }, {
    onSuccess: () => toast.success(external ? 'Thread is internal now' : 'The counterparty can see this thread now'),
    onError: fail('Not changed'),
  })

  const line = (c: CommentReply, head: boolean) => (
    <div key={c.id} className={cn('rounded px-1 -mx-1', isBy(c, person ?? null) && 'bg-amber-100/70')} data-testid={head ? undefined : `thread-reply-${c.id}`}>
      <div className="flex items-baseline gap-1.5">
        <span className={cn('font-semibold text-ink-950', head ? 'text-dense' : 'text-[11.5px]')}>{nameOf(c)}</span>
        <span className="text-[11px] text-ink-400">{when(c.createdAt)}</span>
      </div>
      <p className="text-dense text-ink-700 whitespace-pre-wrap">{c.body}</p>
    </div>
  )

  return (
    <div
      className={cn(
        'rounded-card border p-2.5 space-y-1.5 bg-card',
        external ? 'border-brand-200 bg-brand-50/40' : 'border-paper-200',
        thread.resolved && 'opacity-60',
        active && 'ring-2 ring-brand-700/30',
      )}
      data-testid={`thread-${thread.id}`}
      data-visibility={thread.visibility}
    >
      <div className="flex items-center gap-2">
        <VisibilityBadge visibility={thread.visibility} />
        {thread.resolved && <span className="text-[11px] text-ink-500">Resolved</span>}
        {onShow && thread.anchor && !orphaned && (
          <button type="button" className="ml-auto text-[11px] text-ink-500 underline hover:text-ink-950" onClick={() => onShow(thread)} data-testid={`thread-show-${thread.id}`}>
            Show in document
          </button>
        )}
      </div>
      {thread.anchor && !compact && (
        <p className={cn('text-[11.5px] border-l-2 pl-2 line-clamp-2', orphaned ? 'border-paper-300 text-ink-400 italic' : 'border-paper-300 text-ink-500')}>
          {orphaned ? `${ORPHANED_ANCHOR_TEXT}: “${thread.anchor.quote.slice(0, 120)}”` : `“${thread.anchor.quote.slice(0, 160)}”`}
        </p>
      )}
      {line(thread, true)}
      {thread.replies.length > 0 && <div className="pl-2 border-l border-paper-200 space-y-1">{thread.replies.map(r => line(r, false))}</div>}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          <Button size="xs" variant="ghost" onClick={() => setReplying(r => !r)} data-testid={`thread-reply-btn-${thread.id}`}><Reply />Reply</Button>
          {!thread.resolved && (
            <Button size="xs" variant="ghost" onClick={() => update.mutate({ id: thread.id, resolved: true }, { onError: fail('Not resolved') })}><Check />Resolve</Button>
          )}
          {!(fromThem && external) && (
            <Button size="xs" variant="ghost" className="ml-auto" disabled={update.isPending} onClick={flip} data-testid={`thread-visibility-${thread.id}`}>
              {external ? <><Lock />Mark thread as internal</> : <><Globe />Mark thread as external</>}
            </Button>
          )}
        </div>
      )}
      {replying && (
        <div className="space-y-1">
          <textarea
            value={reply}
            onChange={e => setReply(e.target.value)}
            rows={2}
            autoFocus
            placeholder={external ? 'Reply (the counterparty will see it)…' : 'Reply…'}
            className="w-full text-dense bg-card border border-input rounded-md px-2 py-1.5 resize-none focus-visible:outline-none focus-visible:border-brand-700"
            data-testid={`thread-reply-input-${thread.id}`}
          />
          <div className="flex justify-end gap-1">
            <Button size="xs" variant="ghost" onClick={() => setReplying(false)}>Cancel</Button>
            <Button size="xs" disabled={!reply.trim() || add.isPending} onClick={send}>Reply</Button>
          </div>
        </div>
      )}
    </div>
  )
}
