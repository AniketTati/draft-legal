/**
 * docs/41 Part 16 — comment threads in the workspace: who wrote them, whether
 * the counterparty sees them, and where in the document they sit.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AnchorState, CommentAnchor, CommentVisibility } from '@clm/types'
import { api } from '@/lib/api'

export interface CommentReply {
  id: string
  authorId: string
  authorName?: string | null
  body: string
  createdAt: string
  visibility: CommentVisibility
}

export interface CommentThreadData extends CommentReply {
  resolved: boolean
  clauseRef?: string | null
  anchor: CommentAnchor | null
  anchorState: AnchorState | null
  anchorStart: number | null
  anchorEnd: number | null
  replies: CommentReply[]
}

export const threadsKey = (contractId: string) => ['contract-comments', contractId, 'threads'] as const

/** Every thread on the contract, placed in its newest version. */
export function useThreads(contractId: string) {
  return useQuery<{ data: CommentThreadData[]; total: number }>({
    queryKey: threadsKey(contractId),
    queryFn: () => api.get(`/contracts/${contractId}/comments`, { params: { limit: '200' } }).then(r => r.data),
    enabled: !!contractId,
    staleTime: 15_000,
  })
}

export interface NewComment {
  body: string
  visibility?: CommentVisibility
  anchor?: CommentAnchor | null
  parentId?: string
}

export function useCommentActions(contractId: string) {
  const qc = useQueryClient()
  const done = () => qc.invalidateQueries({ queryKey: ['contract-comments', contractId] })
  const add = useMutation({
    mutationFn: (c: NewComment) => api.post(`/contracts/${contractId}/comments`, c).then(r => r.data as CommentThreadData),
    onSuccess: done,
  })
  const update = useMutation({
    mutationFn: ({ id, ...patch }: { id: string; resolved?: boolean; visibility?: CommentVisibility }) =>
      api.patch(`/contracts/${contractId}/comments/${id}`, patch).then(r => r.data),
    onSuccess: done,
  })
  return { add, update }
}

/** Who has written in the discussion, for "Document discussion" by person. */
export function peopleIn(threads: CommentThreadData[]): Array<{ id: string; name: string; count: number }> {
  const by = new Map<string, { id: string; name: string; count: number }>()
  for (const c of threads.flatMap(t => [t, ...t.replies])) {
    const key = c.authorId.startsWith('portal:') ? 'portal' : c.authorId
    const name = key === 'portal' ? 'Counterparty' : c.authorName || 'Someone'
    const p = by.get(key) ?? { id: key, name, count: 0 }
    p.count++
    by.set(key, p)
  }
  return [...by.values()].sort((a, b) => b.count - a.count)
}

/** Whether a comment is by the person picked in the discussion filter. */
export function isBy(c: Pick<CommentReply, 'authorId'>, person: string | null): boolean {
  if (!person) return false
  return person === 'portal' ? c.authorId.startsWith('portal:') : c.authorId === person
}

export type ThreadFilter = { status: 'open' | 'resolved' | 'all'; visibility: 'all' | CommentVisibility }

export function filterThreads(threads: CommentThreadData[], f: ThreadFilter): CommentThreadData[] {
  return threads.filter(t =>
    (f.status === 'all' || (f.status === 'open' ? !t.resolved : t.resolved))
    && (f.visibility === 'all' || t.visibility === f.visibility))
}
