/**
 * Clause Library Page — Phase 4.3 (SCR-016)
 * Category tree (left) + clause list (center) + clause editor (right)
 */
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight, ChevronDown, Plus, Trash2,
  CheckCircle, Circle, Loader2, BookOpen,
} from 'lucide-react'
import { api } from '@/lib/api'
import { ContractEditor } from '@/components/editor/ContractEditor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Chip, EmptyState } from '@/components/ui/primitives'
import { StatusPill } from '@/components/ui/status-pill'
import type { ClauseLibraryItem, ClauseCategory } from '@clm/types'
import { cn } from '@/lib/utils'

/** A clause row carries its category when the list isn't already filtered to one. */
type ClauseRowItem = ClauseLibraryItem & { category?: { id: string; name: string } | null }

// ─── Category Tree ────────────────────────────────────────────────────────────

function CategoryTreeNode({
  category,
  selected,
  onSelect,
  onAdd,
}: {
  category: ClauseCategory & { children?: ClauseCategory[] }
  selected: string | null
  onSelect: (id: string) => void
  onAdd: (parentId: string) => void
}) {
  const [open, setOpen] = useState(true)
  const hasChildren = (category.children?.length ?? 0) > 0

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer group text-[12.5px]',
          // This tree is the page's navigation, so the active item takes the
          // system's nav-active treatment: ink fill, not a colored wash.
          selected === category.id
            ? 'bg-ink-950 text-white font-medium'
            : 'text-ink-700 hover:bg-paper-100',
        )}
        onClick={() => { onSelect(category.id); if (hasChildren) setOpen(o => !o) }}
      >
        {hasChildren
          ? (open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />)
          : <span className="size-3.5" />}
        <span className="flex-1 truncate">{category.name}</span>
        <button
          onClick={e => { e.stopPropagation(); onAdd(category.id) }}
          // No color of its own — it inherits the row's, so it stays legible
          // on both the ink-filled active row and the plain ones.
          className="opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      {hasChildren && open && (
        <div className="pl-4">
          {category.children!.map(child => (
            <CategoryTreeNode
              key={child.id}
              category={child as any}
              selected={selected}
              onSelect={onSelect}
              onAdd={onAdd}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Clause Row ───────────────────────────────────────────────────────────────

function ClauseRow({
  clause,
  selected,
  showCategory,
  onSelect,
  onApprove,
  onDelete,
}: {
  clause: ClauseRowItem
  selected: boolean
  /** The list is unfiltered, so each row has to say where it lives. */
  showCategory: boolean
  onSelect: () => void
  onApprove: (approved: boolean) => void
  onDelete: () => void
}) {
  /*
   * ─── Why this row lost most of its colour ────────────────────────────────
   *
   * Every row used to carry an emerald "approved" pill. 103 of the 106 clauses
   * in this library are approved, so the pill was on ~97% of rows: it cost a
   * line of every row to say "normal", and the three clauses that are NOT
   * signed off — the only ones anyone needs to find — looked exactly like the
   * rest, minus a badge nobody notices the absence of. Meanwhile `favorable`
   * was ALSO on the brand ramp, so a favourable approved clause showed two
   * different emeralds an inch apart, which teaches a reader that green here
   * means nothing in particular.
   *
   * So the row states exceptions only:
   *   · not approved  → a pill. Rare, and the reason to look.
   *   · unfavourable  → a risk pill. Real exposure in our own library.
   *   · favourable / neutral / standard → a plain tag, no meaning colour. A
   *     stance is a description of language, not a state of the workflow, and
   *     the five meanings are the workflow's vocabulary.
   *
   * "Unapproved" takes `inflight`, not `turn`: this library is org-wide and
   * knows nothing about who is looking, and lib/status is explicit that amber
   * is only for surfaces scoped to the current user.
   */
  const unfavorable = clause.riskRating === 'unfavorable'

  return (
    <div
      data-testid={`clause-row-${clause.id}`}
      data-clause-title={clause.title}
      data-approved={clause.isApproved ? 'true' : 'false'}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() }
      }}
      className={cn(
        'px-4 py-2 border-b border-paper-100 cursor-pointer hover:bg-paper-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'bg-paper-100 border-l-2 border-l-ink-950',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-ink-950 truncate" title={clause.title}>{clause.title}</p>
          {showCategory && clause.category?.name && (
            <p className="text-[11px] text-ink-500 truncate mt-0.5">{clause.category.name}</p>
          )}
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {!clause.isApproved && (
              <StatusPill meaning="inflight">Not approved</StatusPill>
            )}
            {unfavorable && <StatusPill meaning="risk">Unfavourable</StatusPill>}
            {clause.riskRating && !unfavorable && (
              <span className="text-[11px] px-1.5 py-0.5 rounded-chip border border-paper-200 bg-paper-100 text-ink-700 capitalize">
                {clause.riskRating}
              </span>
            )}
            {/* Every clause in this library is used 0 times, so "used 0×" on
                every row was a column of noise. It appears when it says something. */}
            {clause.usageCount > 0 && (
              <span className="text-[11px] tabular-nums text-ink-500">used {clause.usageCount}×</span>
            )}
          </div>
          {clause.tags.length > 0 && (
            <div className="flex gap-1 mt-1 flex-wrap">
              {clause.tags.slice(0, 3).map(t => (
                <span key={t} className="text-[11px] px-1 py-0.5 bg-paper-100 text-ink-500 rounded-chip">{t}</span>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-1 shrink-0">
          <button
            onClick={e => { e.stopPropagation(); onApprove(!clause.isApproved) }}
            aria-pressed={clause.isApproved}
            aria-label={clause.isApproved ? `Withdraw approval of ${clause.title}` : `Approve ${clause.title}`}
            className={cn(
              'p-1 rounded-md hover:bg-paper-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              // The toggle shows its state by glyph — filled vs hollow — not by
              // a third shade of green in a column of 106 rows.
              clause.isApproved ? 'text-ink-700 hover:text-ink-950' : 'text-info-700 hover:text-ink-950',
            )}
            title={clause.isApproved ? 'Approved — click to withdraw approval' : 'Not approved — click to approve'}
          >
            {clause.isApproved ? <CheckCircle className="size-3.5" /> : <Circle className="size-3.5" />}
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDelete() }}
            aria-label={`Delete ${clause.title}`}
            title="Delete clause"
            className="p-1 rounded-md hover:bg-risk-50 text-ink-400 hover:text-risk-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Clause Detail Panel ──────────────────────────────────────────────────────

function ClauseDetailPanel({
  clause,
  onSave,
  onCancel,
}: {
  clause?: ClauseLibraryItem
  onSave: (data: Partial<ClauseLibraryItem>) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(clause?.title ?? '')
  const [content, setContent] = useState(clause?.content ?? '')
  const [tags, setTags] = useState(clause?.tags.join(', ') ?? '')
  const [riskRating, setRiskRating] = useState(clause?.riskRating ?? '')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      await onSave({
        title,
        content,
        tags: tags.split(',').map(t => t.trim()).filter(Boolean),
        riskRating: (riskRating || null) as any,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-paper-200 flex items-center justify-between">
        <h3 className="text-section text-ink-950">{clause ? 'Edit Clause' : 'New Clause'}</h3>
        <div className="flex gap-2">
          {/* The editor pane's one primary — it is the only ink fill on screen
              whenever the pane is open. */}
          <Button size="xs" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Save
          </Button>
          <Button size="xs" variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </div>

      <div className="p-4 space-y-3 border-b border-paper-200">
        <Input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Clause title..."
          className="font-medium"
        />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] text-ink-500 mb-1 block">Risk Rating</label>
            <select
              value={riskRating}
              onChange={e => setRiskRating(e.target.value)}
              className="w-full h-8 rounded-md border border-input bg-card px-2 text-[12.5px] text-ink-950 outline-none"
            >
              <option value="">None</option>
              <option value="favorable">Favorable</option>
              <option value="neutral">Neutral</option>
              <option value="unfavorable">Unfavorable</option>
              <option value="standard">Standard</option>
            </select>
          </div>
          <div>
            <label className="text-[11px] text-ink-500 mb-1 block">Tags (comma-separated)</label>
            <Input
              value={tags}
              onChange={e => setTags(e.target.value)}
              placeholder="e.g. mutual, standard"
            />
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 p-4">
        <ContractEditor
          initialContent={content}
          onSave={setContent}
        />
      </div>

      {clause && (
        <div className="px-4 py-2 border-t border-paper-200 bg-paper-50">
          <p className="text-[11px] tabular-nums text-ink-400">
            {Array.isArray(clause.versions) ? clause.versions.length : 0} version(s) · used {clause.usageCount}×
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100

export function ClausesPage() {
  const qc = useQueryClient()
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [selectedClause, setSelectedClause] = useState<ClauseLibraryItem | null>(null)
  const [showNewClause, setShowNewClause] = useState(false)
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  // The two questions this library is actually searched with. Both are server
  // filters, so they hold across the whole 106, not just the loaded page.
  const [onlyUnapproved, setOnlyUnapproved] = useState(false)
  const [onlyUnfavorable, setOnlyUnfavorable] = useState(false)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [pendingDelete, setPendingDelete] = useState<ClauseLibraryItem | null>(null)

  // One request per pause, not one per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250)
    return () => clearTimeout(t)
  }, [q])

  // Escape backs out of the delete confirmation — the safe direction.
  useEffect(() => {
    if (!pendingDelete) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPendingDelete(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingDelete])

  // Any change of question starts the list over at one page.
  useEffect(() => {
    setLimit(PAGE_SIZE)
  }, [selectedCategoryId, debouncedQ, onlyUnapproved, onlyUnfavorable])

  const { data: categoriesData } = useQuery({
    queryKey: ['clause-categories'],
    queryFn: () => api.get('/clauses/categories').then(r => r.data),
  })

  const { data: clausesData, isLoading: clausesLoading, isFetching: clausesFetching } = useQuery({
    queryKey: ['clauses', selectedCategoryId, debouncedQ, onlyUnapproved, onlyUnfavorable, limit],
    queryFn: () =>
      api.get('/clauses', {
        params: {
          ...(selectedCategoryId && { categoryId: selectedCategoryId }),
          ...(debouncedQ && { q: debouncedQ }),
          ...(onlyUnapproved && { approved: 'false' }),
          ...(onlyUnfavorable && { riskRating: 'unfavorable' }),
          limit,
        },
      }).then(r => r.data),
    placeholderData: prev => prev,
  })

  const createMutation = useMutation({
    mutationFn: (body: any) => api.post('/clauses', { ...body, categoryId: selectedCategoryId! }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['clauses'] }); setShowNewClause(false); setSelectedClause(null) },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => api.patch(`/clauses/${id}`, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['clauses'] }); setSelectedClause(null) },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/clauses/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clauses'] })
      setSelectedClause(null)
      setPendingDelete(null)
    },
  })

  const approveMutation = useMutation({
    mutationFn: ({ id, approved }: { id: string; approved: boolean }) =>
      api.post(`/clauses/${id}/approve`, { approved }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['clauses'] }),
  })

  const addCategory = useMutation({
    mutationFn: (body: any) => api.post('/clauses/categories', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['clause-categories'] }),
  })

  const categories: (ClauseCategory & { children?: ClauseCategory[] })[] = categoriesData?.data ?? []
  const clauses: ClauseRowItem[] = clausesData?.data ?? []
  // The list is a page of a larger set. Saying "100 clauses" when 106 match is
  // how a reviewer concludes the library holds no unapproved clause and stops
  // looking six rows early.
  const total: number = clausesData?.total ?? clauses.length
  const hasMore = clauses.length < total
  const filtersOn = onlyUnapproved || onlyUnfavorable

  const handleAddCategory = (parentId?: string) => {
    const name = prompt('Category name:')
    if (!name?.trim()) return
    addCategory.mutate({ name, parentCategoryId: parentId ?? null })
  }

  return (
    <div className="flex h-full">
      {/* ── Category Tree (Left) ── */}
      <div className="w-56 shrink-0 border-r border-paper-200 bg-paper-50 flex flex-col">
        <div className="flex items-center justify-between px-3 py-3 border-b border-paper-200">
          <p className="text-eyebrow uppercase text-ink-700">Categories</p>
          <button onClick={() => handleAddCategory()} className="text-ink-400 hover:text-ink-950">
            <Plus className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          <div
            onClick={() => setSelectedCategoryId(null)}
            className={cn(
              'px-2 py-1.5 rounded-md text-[12.5px] cursor-pointer mb-1',
              !selectedCategoryId ? 'bg-ink-950 text-white font-medium' : 'text-ink-700 hover:bg-paper-100',
            )}
          >
            All Clauses
          </div>
          {categories.map(cat => (
            <CategoryTreeNode
              key={cat.id}
              category={cat}
              selected={selectedCategoryId}
              onSelect={setSelectedCategoryId}
              onAdd={handleAddCategory}
            />
          ))}
        </div>
      </div>

      {/* ── Clause List (Center) ── */}
      <div className="w-80 shrink-0 border-r border-paper-200 flex flex-col">
        <div className="flex items-center gap-2 px-3 pt-3 pb-2">
          <Input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search clauses..."
            className="flex-1"
          />
          {/*
            B.6.18 — "New clause" button is always visible when at
            least one category exists. If no category is currently
            selected we auto-pick the first one so the user isn't
            blocked with an obscure prerequisite.
          */}
          {/* Outline, not ink: the rail's create affordance sits beside the
              editor pane, which owns this screen's single ink primary. */}
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              if (!selectedCategoryId && categories[0]) setSelectedCategoryId(categories[0].id)
              setShowNewClause(true)
              setSelectedClause(null)
            }}
            disabled={categories.length === 0}
            data-testid="new-clause-button"
            title={categories.length === 0 ? 'Create a category first, then add clauses to it' : undefined}
            className="disabled:cursor-not-allowed"
          >
            <Plus /> New clause
          </Button>
        </div>

        {/*
          The job this library is opened for is almost never "read all 106".
          It is "find the one that isn't signed off yet" or "show me the
          language we've marked against us". Both are server-side filters, so
          they answer across the whole library rather than the loaded page.
        */}
        <div className="flex items-center gap-1.5 px-3 pb-3 border-b border-paper-200">
          <Chip
            selected={onlyUnapproved}
            onClick={() => setOnlyUnapproved(v => !v)}
            className="text-[11px]"
          >
            Not approved
          </Chip>
          <Chip
            selected={onlyUnfavorable}
            onClick={() => setOnlyUnfavorable(v => !v)}
            className="text-[11px]"
          >
            Unfavourable
          </Chip>
        </div>

        <div className="flex-1 overflow-y-auto">
          {clausesLoading && (
            <div className="flex items-center justify-center h-16">
              <Loader2 className="size-5 text-ink-400 animate-spin" />
            </div>
          )}
          {!clausesLoading && !clauses.length && (
            <div className="p-3">
              <EmptyState
                icon={<BookOpen />}
                title={filtersOn || debouncedQ ? 'Nothing matches' : 'No clauses in this category'}
                description={
                  filtersOn
                    ? 'Every clause here is approved and none is marked unfavourable.'
                    : debouncedQ
                      ? 'Try a different term, or clear the search.'
                      : 'Add the language your team reuses so drafting can pull from it.'
                }
              />
            </div>
          )}
          {clauses.map(c => (
            <ClauseRow
              key={c.id}
              clause={c}
              selected={selectedClause?.id === c.id}
              // With no category selected the list spans the whole library in
              // category order, and a bare title doesn't say which one.
              showCategory={!selectedCategoryId}
              onSelect={() => { setSelectedClause(c); setShowNewClause(false) }}
              onApprove={(approved) => approveMutation.mutate({ id: c.id, approved })}
              onDelete={() => setPendingDelete(c)}
            />
          ))}
          {hasMore && (
            <div className="p-3">
              <Button
                variant="outline"
                size="xs"
                className="w-full"
                onClick={() => setLimit(l => l + PAGE_SIZE)}
                disabled={clausesFetching}
                data-testid="clauses-load-more"
              >
                {clausesFetching && <Loader2 className="animate-spin" />}
                Load {Math.min(PAGE_SIZE, total - clauses.length)} more
              </Button>
            </div>
          )}
        </div>
        <div className="px-3 py-2 border-t border-paper-200 bg-paper-50">
          <p className="text-[11px] tabular-nums text-ink-400">
            {hasMore ? `Showing ${clauses.length} of ${total} clauses` : `${total} ${total === 1 ? 'clause' : 'clauses'}`}
          </p>
        </div>
      </div>

      {/* ── Clause Editor (Right) ── */}
      <div className="flex-1 min-w-0">
        {(selectedClause || showNewClause) ? (
          <ClauseDetailPanel
            key={showNewClause ? '__new__' : selectedClause?.id}
            clause={showNewClause ? undefined : selectedClause ?? undefined}
            onSave={(data) =>
              showNewClause
                ? createMutation.mutateAsync(data)
                : updateMutation.mutateAsync({ id: selectedClause!.id, data })
            }
            onCancel={() => { setShowNewClause(false); setSelectedClause(null) }}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState
              className="w-full max-w-sm border-0 bg-transparent"
              icon={<BookOpen />}
              title="Select a clause to edit, or create a new one."
              action={categories.length > 0 ? (
                // With the editor pane closed there is no other ink fill on
                // screen, so this empty state carries the primary.
                <Button
                  size="xs"
                  onClick={() => {
                    if (!selectedCategoryId && categories[0]) setSelectedCategoryId(categories[0].id)
                    setShowNewClause(true)
                  }}
                  data-testid="empty-new-clause-button"
                >
                  <Plus /> New clause
                </Button>
              ) : undefined}
            />
          </div>
        )}
      </div>

      {/*
        Deleting used to be one unconfirmed click on a 14px icon, next to the
        approve toggle, on a row the user clicked to READ. There is no undo and
        no trash: the clause and its versions are gone. A destructive action
        that cheap next to a benign one is a matter of time.
      */}
      {pendingDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Delete clause"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4"
          onClick={() => setPendingDelete(null)}
          data-testid="clause-delete-dialog"
        >
          <div className="w-full max-w-sm bg-card rounded-card shadow-e3" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-paper-200">
              <h2 className="text-section text-ink-950">Delete this clause?</h2>
              <p className="text-dense text-ink-500 mt-1">
                <span className="font-medium text-ink-950">{pendingDelete.title}</span> will be removed
                from the library, along with its version history. This can't be undone.
              </p>
            </div>
            <div className="px-5 py-3 flex justify-end gap-2 bg-paper-50 rounded-b-card">
              <Button variant="outline" size="xs" onClick={() => setPendingDelete(null)}>Cancel</Button>
              <Button
                variant="destructive"
                size="xs"
                onClick={() => deleteMutation.mutate(pendingDelete.id)}
                disabled={deleteMutation.isPending}
                data-testid="clause-delete-confirm"
              >
                {deleteMutation.isPending && <Loader2 className="animate-spin" />}
                Delete clause
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
