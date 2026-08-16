/**
 * CommentsPanel — threaded comments on contracts.
 * Used internally (requireAuth) and in portal mode (token-gated, no auth).
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, EmptyState } from '@/components/ui/primitives'
import { MessageSquare, Check, Trash2, Reply, Loader2, ChevronDown, ChevronRight } from 'lucide-react'

interface Comment {
  id: string
  authorId: string
  body: string
  clauseRef?: string | null
  resolved: boolean
  resolvedAt?: string | null
  createdAt: string
  replies: Comment[]
}

interface CommentsPanelProps {
  contractId: string
  versionId?: string
  clauseRef?: string
  portalMode?: boolean
  portalToken?: string
  permissions?: string[]
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function authorDisplay(authorId: string) {
  if (authorId.startsWith('portal:')) return 'External reviewer'
  return authorId.slice(0, 8)
}

function CommentThread({
  comment, contractId, portalMode, portalToken, canComment, onResolve, onDelete,
}: {
  comment: Comment
  contractId: string
  portalMode: boolean
  portalToken?: string
  canComment: boolean
  onResolve: (id: string) => void
  onDelete: (id: string) => void
}) {
  const qc = useQueryClient()
  const [showReply, setShowReply] = useState(false)
  const [replyBody, setReplyBody] = useState('')
  const [replyName, setReplyName] = useState('')
  const [expanded, setExpanded] = useState(true)

  const replyMutation = useMutation({
    mutationFn: async () => {
      if (portalMode && portalToken) {
        return api.post(`/portal/${portalToken}/comments`, {
          body: replyBody.trim(),
          clauseRef: comment.clauseRef,
          authorName: replyName || undefined,
        })
      }
      return api.post(`/contracts/${contractId}/comments`, {
        body: replyBody.trim(),
        parentId: comment.id,
        clauseRef: comment.clauseRef,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract-comments', contractId] })
      setReplyBody('')
      setReplyName('')
      setShowReply(false)
    },
  })

  return (
    <div className={`border border-paper-200 rounded-card overflow-hidden ${comment.resolved ? 'opacity-60' : ''}`}>
      <div className="px-4 py-3 bg-card">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2.5 flex-1 min-w-0">
            <div className="size-7 rounded-full border border-paper-200 bg-paper-100 flex-shrink-0 flex items-center justify-center text-ink-700 text-[11px] font-semibold">
              {authorDisplay(comment.authorId)[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-body font-semibold text-ink-950">{authorDisplay(comment.authorId)}</span>
                {comment.clauseRef && (
                  // A section pointer, not a state — mono and neutral.
                  <span className="text-[11px] bg-paper-100 text-ink-700 px-1.5 py-0.5 rounded-chip font-mono">
                    {comment.clauseRef}
                  </span>
                )}
                <span className="text-[11px] text-ink-400">{timeAgo(comment.createdAt)}</span>
                {comment.resolved && <span className="text-[11px] text-brand-700 font-medium">Resolved</span>}
              </div>
              <p className="text-body text-ink-700 mt-1 leading-relaxed">{comment.body}</p>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {comment.replies.length > 0 && (
              <button
                onClick={() => setExpanded(e => !e)}
                className="p-1 text-ink-400 hover:text-ink-700 rounded-chip"
              >
                {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              </button>
            )}
            {!portalMode && !comment.resolved && (
              <button
                onClick={() => onResolve(comment.id)}
                title="Mark resolved"
                className="p-1 text-ink-400 hover:text-brand-700 rounded-chip transition-colors"
              >
                <Check className="size-3.5" />
              </button>
            )}
            {!portalMode && (
              <button
                onClick={() => onDelete(comment.id)}
                title="Delete"
                className="p-1 text-ink-400 hover:text-risk-600 rounded-chip transition-colors"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
            {canComment && (
              <button
                onClick={() => setShowReply(r => !r)}
                className="p-1 text-ink-400 hover:text-ink-950 rounded-chip transition-colors"
                title="Reply"
              >
                <Reply className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Replies */}
        {expanded && comment.replies.length > 0 && (
          <div className="mt-3 pl-9 space-y-2.5 border-l-2 border-paper-200 ml-3.5">
            {comment.replies.map(reply => (
              <div key={reply.id} className="flex items-start gap-2">
                <div className="size-6 rounded-full border border-paper-200 bg-paper-100 flex-shrink-0 flex items-center justify-center text-ink-700 text-[11px] font-semibold">
                  {authorDisplay(reply.authorId)[0].toUpperCase()}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-ink-700">{authorDisplay(reply.authorId)}</span>
                    <span className="text-[11px] text-ink-400">{timeAgo(reply.createdAt)}</span>
                  </div>
                  <p className="text-dense text-ink-700 mt-0.5">{reply.body}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Reply input */}
        {showReply && (
          <div className="mt-3 pl-9 ml-1 space-y-2">
            {portalMode && (
              <Input
                value={replyName}
                onChange={e => setReplyName(e.target.value)}
                placeholder="Your name (optional)"
              />
            )}
            <div className="flex gap-2">
              <textarea
                value={replyBody}
                onChange={e => setReplyBody(e.target.value)}
                placeholder="Write a reply…"
                rows={2}
                className="flex-1 text-[13px] text-ink-950 bg-card border border-input rounded-md px-[11px] py-1.5 placeholder:text-ink-400 focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15 resize-none"
              />
              <Button
                size="sm"
                disabled={!replyBody.trim() || replyMutation.isPending}
                onClick={() => replyMutation.mutate()}
                className="self-end"
              >
                {replyMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : 'Post'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function CommentsPanel({
  contractId, versionId, clauseRef, portalMode = false, portalToken, permissions = [],
}: CommentsPanelProps) {
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const [authorName, setAuthorName] = useState('')
  const [clauseRefInput, setClauseRefInput] = useState(clauseRef ?? '')
  const [filter, setFilter] = useState<'all' | 'unresolved' | 'resolved'>('unresolved')

  const canComment = portalMode ? permissions.includes('comment') : true

  const commentsQuery = useQuery({
    queryKey: ['contract-comments', contractId, clauseRef],
    queryFn: () => {
      if (portalMode && portalToken) {
        // Portal mode: comments are loaded with the contract — we don't have a separate endpoint
        // Return empty for now; portal shows existing comments inline
        return { data: [] }
      }
      const params: Record<string, string> = {}
      if (clauseRef) params.clauseRef = clauseRef
      if (filter !== 'all') params.resolved = String(filter === 'resolved')
      return api.get(`/contracts/${contractId}/comments`, { params }).then(r => r.data)
    },
    enabled: !!contractId && !portalMode,
  })

  const addComment = useMutation({
    mutationFn: () => {
      if (portalMode && portalToken) {
        return api.post(`/portal/${portalToken}/comments`, {
          body: body.trim(),
          clauseRef: clauseRefInput || undefined,
          authorName: authorName || undefined,
        })
      }
      return api.post(`/contracts/${contractId}/comments`, {
        body: body.trim(),
        clauseRef: clauseRefInput || undefined,
        versionId,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract-comments', contractId] })
      setBody('')
      setAuthorName('')
    },
  })

  const resolveComment = useMutation({
    mutationFn: (commentId: string) =>
      api.patch(`/contracts/${contractId}/comments/${commentId}`, { resolved: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contract-comments', contractId] }),
  })

  const deleteComment = useMutation({
    mutationFn: (commentId: string) =>
      api.delete(`/contracts/${contractId}/comments/${commentId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contract-comments', contractId] }),
  })

  const comments: Comment[] = commentsQuery.data?.data ?? []
  const filtered = filter === 'all' ? comments
    : filter === 'resolved' ? comments.filter(c => c.resolved)
    : comments.filter(c => !c.resolved)

  return (
    <div className="flex flex-col gap-4">
      {/* Filter tabs (internal mode only) */}
      {!portalMode && (
        <div className="flex items-center gap-1 p-0.5 bg-paper-100 rounded-md w-fit">
          {(['unresolved', 'all', 'resolved'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded-chip text-[11.5px] font-semibold transition-colors capitalize ${
                filter === f ? 'bg-card shadow-e1 text-ink-950' : 'text-ink-500 hover:text-ink-950'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      )}

      {/* Add comment */}
      {canComment && (
        <Card className="p-4 space-y-3">
          <p className="text-section text-ink-950">Add a comment</p>
          {portalMode && (
            <Input
              value={authorName}
              onChange={e => setAuthorName(e.target.value)}
              placeholder="Your name (optional)"
            />
          )}
          <Input
            value={clauseRefInput}
            onChange={e => setClauseRefInput(e.target.value)}
            placeholder="Clause / Section (optional, e.g. Section 5.2)"
          />
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Write your comment…"
            rows={3}
            className="w-full text-[13px] text-ink-950 bg-card border border-input rounded-md px-[11px] py-2 placeholder:text-ink-400 focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15 resize-none"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!body.trim() || addComment.isPending}
              onClick={() => addComment.mutate()}
            >
              {addComment.isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null}
              Post comment
            </Button>
          </div>
        </Card>
      )}

      {/* Comment threads */}
      {commentsQuery.isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-ink-400" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<MessageSquare />} title="No comments yet" />
      ) : (
        <div className="space-y-3">
          {filtered.map(comment => (
            <CommentThread
              key={comment.id}
              comment={comment}
              contractId={contractId}
              portalMode={portalMode}
              portalToken={portalToken}
              canComment={canComment}
              onResolve={(id) => resolveComment.mutate(id)}
              onDelete={(id) => deleteComment.mutate(id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
