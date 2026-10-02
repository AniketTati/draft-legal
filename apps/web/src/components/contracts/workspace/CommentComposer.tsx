/**
 * docs/41 Part 16 — a new comment thread: Internal (the default) or External,
 * on the words selected in the document when there are some.
 */
import { useState } from 'react'
import { Globe, Lock, Loader2, X } from 'lucide-react'
import type { CommentAnchor, CommentVisibility } from '@clm/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toaster'
import { serverMessage } from '@/lib/approval-keys'
import { useCommentActions } from '@/lib/comments'

export interface CommentDraft {
  anchor?: CommentAnchor | null
  body?: string
  visibility?: CommentVisibility
}

export function CommentComposer({ contractId, draft, onDone }: {
  contractId: string
  draft?: CommentDraft | null
  onDone?: () => void
}) {
  const { add } = useCommentActions(contractId)
  const [body, setBody] = useState(draft?.body ?? '')
  const [visibility, setVisibility] = useState<CommentVisibility>(draft?.visibility ?? 'internal')
  const [anchor, setAnchor] = useState<CommentAnchor | null>(draft?.anchor ?? null)

  const post = () => add.mutate({ body: body.trim(), visibility, anchor }, {
    onSuccess: () => {
      setBody('')
      setAnchor(null)
      setVisibility('internal')
      toast.success(visibility === 'external' ? 'Comment shared with the counterparty' : 'Comment added')
      onDone?.()
    },
    onError: err => toast.error('Comment not added', { description: serverMessage(err, 'Try again.') }),
  })

  const choice = (v: CommentVisibility, label: string, Icon: typeof Lock) => (
    <button
      type="button"
      role="radio"
      aria-checked={visibility === v}
      onClick={() => setVisibility(v)}
      className={cn('inline-flex items-center gap-1 px-2 py-1 rounded-chip text-[11.5px] font-medium', visibility === v ? 'bg-card shadow-e1 text-ink-950' : 'text-ink-500 hover:text-ink-950')}
      data-testid={`composer-${v}`}
    >
      <Icon className="size-3" />{label}
    </button>
  )

  return (
    <div className="rounded-card border border-paper-200 p-2.5 space-y-2 bg-card" data-testid="comment-composer">
      {anchor && (
        <div className="flex items-start gap-1.5 text-[11.5px] text-ink-500 border-l-2 border-paper-300 pl-2">
          <span className="line-clamp-2 flex-1">“{anchor.quote.slice(0, 200)}”</span>
          <button type="button" aria-label="Comment on the whole document instead" onClick={() => setAnchor(null)} className="text-ink-400 hover:text-ink-950"><X className="size-3" /></button>
        </div>
      )}
      <textarea
        value={body}
        onChange={e => setBody(e.target.value)}
        rows={3}
        autoFocus={!!draft}
        placeholder={visibility === 'external' ? 'Write a comment the counterparty will see…' : 'Write a comment for your side…'}
        className="w-full text-dense bg-card border border-input rounded-md px-2 py-1.5 resize-none focus-visible:outline-none focus-visible:border-brand-700"
        data-testid="composer-body"
      />
      <div className="flex items-center gap-2">
        <div role="radiogroup" aria-label="Who can see it" className="inline-flex gap-0.5 p-0.5 bg-paper-100 rounded-md">
          {choice('internal', 'Internal', Lock)}
          {choice('external', 'External', Globe)}
        </div>
        <Button size="sm" className="ml-auto" disabled={!body.trim() || add.isPending} onClick={post} data-testid="composer-post">
          {add.isPending && <Loader2 className="animate-spin" />}Comment
        </Button>
      </div>
    </div>
  )
}
