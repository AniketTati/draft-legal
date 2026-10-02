/**
 * docs/41 Part 16 — margin comments: a thread says who can see it (lock or
 * globe) and offers the other choice; the list filters by status, visibility
 * and person; cards in the margin never overlap. Rendered to a string.
 */
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { filterThreads, isBy, peopleIn, threadsBy, threadsKey, type CommentThreadData } from '@/lib/comments'
import { CommentThreadCard } from './CommentThreadCard'
import { CommentsView } from './CommentsView'
import { stack } from './MarginComments'

const t = (over: Partial<CommentThreadData>): CommentThreadData => ({
  id: 't', authorId: 'u1', authorName: 'Asha', body: 'Body', createdAt: new Date().toISOString(), visibility: 'internal',
  resolved: false, anchor: null, anchorState: null, anchorStart: null, anchorEnd: null, replies: [], ...over,
})

const render = (el: React.ReactElement, qc = new QueryClient()) =>
  renderToString(<QueryClientProvider client={qc}>{el}</QueryClientProvider>).replace(/<!-- -->/g, '')

describe('a thread card', () => {
  it('internal: a lock, and Mark thread as external', () => {
    const html = render(<CommentThreadCard contractId="k" thread={t({})} canEdit />)
    expect(html).toContain('data-testid="thread-internal"')
    expect(html).toContain('Mark thread as external')
  })

  it('external: a globe, and Mark thread as internal; none for a thread the counterparty started', () => {
    expect(render(<CommentThreadCard contractId="k" thread={t({ visibility: 'external' })} canEdit />)).toContain('Mark thread as internal')
    const theirs = render(<CommentThreadCard contractId="k" thread={t({ visibility: 'external', authorId: 'portal:l1', authorName: 'Pat' })} canEdit />)
    expect(theirs).toContain('data-testid="thread-external"')
    expect(theirs).not.toContain('Mark thread as')
  })

  it('without the right to edit, no actions', () => {
    expect(render(<CommentThreadCard contractId="k" thread={t({})} canEdit={false} />)).not.toContain('Mark thread as')
  })

  it('says when its words are no longer in the document', () => {
    const html = render(<CommentThreadCard contractId="k" thread={t({ anchor: { quote: 'old words', start: 0, end: 9, versionId: 'v1' }, anchorState: 'orphaned' })} canEdit />)
    expect(html).toContain('Text no longer in the document')
  })
})

describe('the Comments view', () => {
  it('offers Document discussion by person, and a composer that defaults to Internal', () => {
    const qc = new QueryClient()
    qc.setQueryData(threadsKey('k'), { data: [t({ id: 'a' }), t({ id: 'b', authorId: 'portal:x', authorName: 'Pat', visibility: 'external' })], total: 2 })
    const html = render(<CommentsView contractId="k" canEdit person={null} onPerson={() => {}} />, qc)
    expect(html).toContain('Document discussion')
    expect(html).toContain('Counterparty (1)')
    expect(html.match(/<button[^>]*data-testid="composer-internal"[^>]*>/)?.[0]).toContain('aria-checked="true"')
    expect(html).toContain('data-testid="thread-a"')
  })
})

describe('"Only this person" (fix-up 22)', () => {
  const threads = [
    t({ id: 'a' }),
    t({ id: 'b', authorId: 'portal:x', authorName: 'Pat', visibility: 'external' }),
    t({ id: 'c', authorId: 'u2', authorName: 'Ravi', replies: [{ id: 'r', authorId: 'portal:y', body: 'x', createdAt: '', visibility: 'external' }] }),
  ]

  it('keeps the threads the person started or replied in', () => {
    expect(threadsBy(threads, 'portal').map(x => x.id)).toEqual(['b', 'c'])
    expect(threadsBy(threads, 'u1').map(x => x.id)).toEqual(['a'])
    expect(threadsBy(threads, null)).toHaveLength(3)
  })

  it('offers the toggle once a person is picked, and hides everyone else when it is on', () => {
    const qc = new QueryClient()
    qc.setQueryData(threadsKey('k'), { data: threads, total: 3 })
    expect(render(<CommentsView contractId="k" canEdit={false} person={null} onPerson={() => {}} onOnlyPerson={() => {}} />, qc)).not.toContain('comments-only-person')
    const highlighted = render(<CommentsView contractId="k" canEdit={false} person="u1" onPerson={() => {}} onOnlyPerson={() => {}} />, qc)
    expect(highlighted).toContain('Only this person')
    for (const id of ['a', 'b', 'c']) expect(highlighted).toContain(`data-testid="thread-${id}"`)
    const only = render(<CommentsView contractId="k" canEdit={false} person="u1" onPerson={() => {}} onlyPerson onOnlyPerson={() => {}} />, qc)
    expect(only).toContain('data-testid="thread-a"')
    expect(only).not.toContain('data-testid="thread-b"')
    expect(only).not.toContain('data-testid="thread-c"')
  })
})

describe('filters and people', () => {
  const threads = [t({ id: 'a' }), t({ id: 'b', resolved: true, visibility: 'external' }), t({ id: 'c', authorId: 'portal:l', replies: [{ id: 'r', authorId: 'u1', body: 'x', createdAt: '', visibility: 'external' }] })]
  it('filters by status and visibility', () => {
    expect(filterThreads(threads, { status: 'open', visibility: 'all' }).map(x => x.id)).toEqual(['a', 'c'])
    expect(filterThreads(threads, { status: 'all', visibility: 'external' }).map(x => x.id)).toEqual(['b'])
  })
  it('counts each person once across threads and replies, the counterparty as one', () => {
    expect(peopleIn(threads)).toEqual([{ id: 'u1', name: 'Asha', count: 3 }, { id: 'portal', name: 'Counterparty', count: 1 }])
    expect(isBy({ authorId: 'portal:zz' }, 'portal')).toBe(true)
    expect(isBy({ authorId: 'u1' }, null)).toBe(false)
  })
})

describe('margin cards', () => {
  it('stay at their words, pushed down only to clear the card above', () => {
    expect(stack([0, 10, 300], [100, 50, 50])).toEqual([0, 108, 300])
  })
})
