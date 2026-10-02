/**
 * docs/41 Part 16 — the Comments view beside the document: every thread in
 * one list, filtered by status, by who can see it, and by person ("Document
 * discussion"). The same threads sit in the margin by their words; this is
 * also where threads with no words in the document (or no longer any) live.
 */
import { useMemo, useState } from 'react'
import { Loader2, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { filterThreads, peopleIn, useThreads, type CommentThreadData, type ThreadFilter } from '@/lib/comments'
import { CommentThreadCard } from './CommentThreadCard'
import { CommentComposer, type CommentDraft } from './CommentComposer'

function Seg<T extends string>({ value, options, onChange, label }: {
  value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 p-0.5 bg-paper-100 rounded-md">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn('px-2 py-0.5 rounded-chip text-[11.5px] font-medium', value === v ? 'bg-card shadow-e1 text-ink-950' : 'text-ink-500 hover:text-ink-950')}
          data-testid={`comments-filter-${v}`}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

export function CommentsView({ contractId, canEdit, draft, onDraftDone, person, onPerson, activeId, onShow }: {
  contractId: string
  canEdit: boolean
  /** A comment started from the document (a selection, a change, a finding). */
  draft?: CommentDraft | null
  onDraftDone?: () => void
  /** "Document discussion" by person: their comments are highlighted here and in the margin. */
  person: string | null
  onPerson: (p: string | null) => void
  activeId?: string | null
  onShow?: (t: CommentThreadData) => void
}) {
  const { data, isLoading } = useThreads(contractId)
  const [filter, setFilter] = useState<ThreadFilter>({ status: 'open', visibility: 'all' })
  const threads = useMemo(() => data?.data ?? [], [data])
  const people = useMemo(() => peopleIn(threads), [threads])
  const shown = filterThreads(threads, filter)

  return (
    <div className="flex flex-col gap-3" data-testid="comments-view">
      {canEdit && <CommentComposer key={JSON.stringify(draft ?? null)} contractId={contractId} draft={draft} onDone={onDraftDone} />}

      <div className="flex flex-wrap items-center gap-1.5">
        <Seg label="Status" value={filter.status} onChange={status => setFilter(f => ({ ...f, status }))} options={[['open', 'Open'], ['resolved', 'Resolved'], ['all', 'All']]} />
        <Seg label="Who can see it" value={filter.visibility} onChange={visibility => setFilter(f => ({ ...f, visibility }))} options={[['all', 'Everyone'], ['internal', 'Internal'], ['external', 'External']]} />
      </div>
      {people.length > 0 && (
        <label className="flex items-center gap-2 text-[11.5px] text-ink-500">
          Document discussion
          <select
            value={person ?? ''}
            onChange={e => onPerson(e.target.value || null)}
            className="flex-1 h-7 rounded-md border border-input bg-card px-1.5 text-[12px] text-ink-950"
            data-testid="comments-person"
          >
            <option value="">Everyone</option>
            {people.map(p => <option key={p.id} value={p.id}>{p.name} ({p.count})</option>)}
          </select>
        </label>
      )}

      {isLoading ? (
        <div className="flex justify-center py-6"><Loader2 className="size-4 animate-spin text-ink-400" /></div>
      ) : shown.length === 0 ? (
        <p className="flex items-center gap-2 text-dense text-ink-500 py-4" data-testid="comments-empty">
          <MessageSquare className="size-4" />{threads.length ? 'No threads match.' : 'No comments yet. Select words in the document to comment on them.'}
        </p>
      ) : (
        <div className="space-y-2">
          {shown.map(t => (
            <CommentThreadCard key={t.id} contractId={contractId} thread={t} canEdit={canEdit} person={person} active={activeId === t.id} onShow={onShow} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The contract page's Comments tab: the threads to read. Commenting happens
 * in the workspace, beside the words (docs/41 Part 16).
 */
export function CommentsReadList({ contractId, onOpenWorkspace }: { contractId: string; onOpenWorkspace?: () => void }) {
  const { data, isLoading } = useThreads(contractId)
  const threads = data?.data ?? []
  return (
    <div className="flex flex-col gap-3" data-testid="comments-read-list">
      <div className="flex items-center gap-2 text-dense text-ink-500">
        <span>{threads.length ? `${threads.length} thread${threads.length === 1 ? '' : 's'}` : 'No comments yet.'}</span>
        {onOpenWorkspace && (
          <button type="button" onClick={onOpenWorkspace} className="ml-auto underline hover:text-ink-950" data-testid="comments-open-workspace">
            Comment in the workspace
          </button>
        )}
      </div>
      {isLoading ? <Loader2 className="size-4 animate-spin text-ink-400" /> : threads.map(t => (
        <CommentThreadCard key={t.id} contractId={contractId} thread={t} canEdit={false} />
      ))}
    </div>
  )
}
