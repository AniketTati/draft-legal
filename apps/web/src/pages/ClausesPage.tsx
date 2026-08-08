/**
 * Clause Library Page — Phase 4.3 (SCR-016)
 * Category tree (left) + clause list (center) + clause editor (right)
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight, ChevronDown, Plus, Trash2,
  CheckCircle, Loader2, BookOpen,
} from 'lucide-react'
import { api } from '@/lib/api'
import { ContractEditor } from '@/components/editor/ContractEditor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/primitives'
import { StatusPill } from '@/components/ui/status-pill'
import type { Meaning } from '@/lib/status'
import type { ClauseCategory, ClauseLibraryItem } from '@clm/types'
import { cn } from '@/lib/utils'

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
  onSelect,
  onApprove,
  onDelete,
}: {
  clause: ClauseLibraryItem
  selected: boolean
  onSelect: () => void
  onApprove: (approved: boolean) => void
  onDelete: () => void
}) {
  /*
   * A risk rating is a risk reading, so it collapses onto the same five
   * meanings every other state uses: favorable is inside the playbook
   * (binding), unfavorable is exposure, and "standard"/"neutral" simply
   * describe a clause rather than flag anything — they stay neutral.
   */
  const RISK_MEANING: Record<string, Meaning> = {
    favorable: 'binding',
    unfavorable: 'risk',
    neutral: 'neutral',
    standard: 'neutral',
  }

  return (
    <div
      data-testid={`clause-row-${clause.id}`}
      data-clause-title={clause.title}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() }
      }}
      className={cn(
        'px-4 py-2 border-b border-paper-100 cursor-pointer hover:bg-paper-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/35',
        selected && 'bg-paper-100 border-l-2 border-l-ink-950',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-ink-950 truncate">{clause.title}</p>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {clause.riskRating && (
              <StatusPill meaning={RISK_MEANING[clause.riskRating] ?? 'neutral'}>
                {clause.riskRating}
              </StatusPill>
            )}
            {clause.isApproved && (
              <StatusPill meaning="binding">approved</StatusPill>
            )}
            <span className="text-[11px] tabular-nums text-ink-400">used {clause.usageCount}×</span>
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
            className={cn(
              'p-1 rounded-md hover:bg-paper-100 transition-colors',
              // An approved clause is binding — the only thing on this row
              // that earns the brand color.
              clause.isApproved ? 'text-brand-700 hover:text-brand-800' : 'text-ink-400 hover:text-brand-700',
            )}
            title={clause.isApproved ? 'Click to unapprove' : 'Click to approve'}
          >
            <CheckCircle className="size-3.5" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDelete() }}
            className="p-1 rounded-md hover:bg-risk-50 text-ink-400 hover:text-risk-600"
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

export function ClausesPage() {
  const qc = useQueryClient()
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [selectedClause, setSelectedClause] = useState<ClauseLibraryItem | null>(null)
  const [showNewClause, setShowNewClause] = useState(false)
  const [q, setQ] = useState('')

  const { data: categoriesData } = useQuery({
    queryKey: ['clause-categories'],
    queryFn: () => api.get('/clauses/categories').then(r => r.data),
  })

  const { data: clausesData, isLoading: clausesLoading } = useQuery({
    queryKey: ['clauses', selectedCategoryId, q],
    queryFn: () =>
      api.get('/clauses', {
        params: {
          ...(selectedCategoryId && { categoryId: selectedCategoryId }),
          ...(q && { q }),
          limit: 100,
        },
      }).then(r => r.data),
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['clauses'] }); setSelectedClause(null) },
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
  const clauses: ClauseLibraryItem[] = clausesData?.data ?? []

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
        <div className="flex items-center gap-2 px-3 py-3 border-b border-paper-200">
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

        <div className="flex-1 overflow-y-auto">
          {clausesLoading && (
            <div className="flex items-center justify-center h-16">
              <Loader2 className="size-5 text-ink-400 animate-spin" />
            </div>
          )}
          {!clausesLoading && !clauses.length && (
            <div className="flex flex-col items-center justify-center h-32 text-ink-400">
              <BookOpen className="size-6 mb-1" />
              <p className="text-[11.5px]">No clauses yet</p>
            </div>
          )}
          {clauses.map(c => (
            <ClauseRow
              key={c.id}
              clause={c}
              selected={selectedClause?.id === c.id}
              onSelect={() => { setSelectedClause(c); setShowNewClause(false) }}
              onApprove={(approved) => approveMutation.mutate({ id: c.id, approved })}
              onDelete={() => deleteMutation.mutate(c.id)}
            />
          ))}
        </div>
        <div className="px-3 py-2 border-t border-paper-200 bg-paper-50">
          <p className="text-[11px] tabular-nums text-ink-400">{clauses.length} clauses</p>
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
    </div>
  )
}
