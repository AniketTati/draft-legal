/**
 * Playbook Page — Phase 4.4 (SCR-036)
 * Manage preferred/acceptable/fallback/walkaway positions per clause category.
 * Test mode: paste a clause → agent scores it against playbook.
 */
import { useState, useEffect } from 'react'
import { sanitizeHtml } from '@/lib/sanitize'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Shield, Plus, Edit2, Trash2, Loader2,
  ChevronDown, ChevronRight, Play, X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ContractEditor } from '@/components/editor/ContractEditor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ClauseCategory, PlaybookPosition } from '@clm/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const POSITION_TYPES: PlaybookPosition['positionType'][] = ['preferred', 'acceptable', 'fallback', 'walkaway']

/*
 * The four positions are a ladder, so they read as one: inside the playbook →
 * tolerable → needs a decision → stop. `acceptable` loses its blue and goes
 * neutral, because "acceptable" doesn't mean anything is in flight — it means
 * nothing is happening, which is exactly what neutral says.
 */
const POSITION_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  preferred:  { bg: 'bg-brand-50',     text: 'text-brand-700',     border: 'border-brand-200' },
  acceptable: { bg: 'bg-paper-50',     text: 'text-ink-700',       border: 'border-paper-200' },
  fallback:   { bg: 'bg-attention-50', text: 'text-attention-700', border: 'border-attention-200' },
  walkaway:   { bg: 'bg-risk-50',      text: 'text-risk-700',      border: 'border-risk-200' },
}

// ─── Position Card ────────────────────────────────────────────────────────────

function PositionCard({
  position,
  onEdit,
  onDelete,
}: {
  position: PlaybookPosition
  onEdit: () => void
  onDelete: () => void
}) {
  const c = POSITION_COLORS[position.positionType]
  return (
    <div
      data-testid={`playbook-position-${position.id}`}
      data-position-type={position.positionType}
      className={cn('rounded-card border p-4', c.bg, c.border)}
    >
      <div className="flex items-start justify-between">
        <span className={cn('text-eyebrow uppercase', c.text)}>
          {position.positionType}
        </span>
        <div className="flex gap-1">
          <button onClick={onEdit} className={cn('p-1 rounded-md hover:opacity-80', c.text)}><Edit2 className="size-3.5" /></button>
          <button onClick={onDelete} className="p-1 rounded-md text-ink-400 hover:text-risk-600"><Trash2 className="size-3.5" /></button>
        </div>
      </div>
      {position.content && (
        <div
          className="text-body text-ink-700 mt-2 prose prose-sm max-w-none line-clamp-4"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(position.content) }}
        />
      )}
      {position.notes && (
        <p className="text-[11.5px] text-ink-500 mt-2 italic">{position.notes}</p>
      )}
      <div className="flex items-center gap-3 mt-2">
        <div className="flex items-center gap-1">
          <div className="w-20 h-1 rounded-full bg-paper-200 overflow-hidden">
            <div
              className={cn('h-full rounded-full', c.bg, 'brightness-90')}
              style={{ width: `${(position.riskThreshold ?? 0.5) * 100}%`, background: 'currentColor' }}
            />
          </div>
          <span className="text-[11px] tabular-nums text-ink-500">threshold {Math.round((position.riskThreshold ?? 0.5) * 100)}%</span>
        </div>
      </div>
    </div>
  )
}

// ─── Position Editor Modal ────────────────────────────────────────────────────

function PositionEditor({
  position,
  categoryId,
  defaultPositionType,
  onClose,
  onSave,
}: {
  position?: PlaybookPosition
  categoryId: string
  defaultPositionType?: PlaybookPosition['positionType']
  onClose: () => void
  onSave: (data: any) => Promise<void>
}) {
  const [positionType, setPositionType] = useState<PlaybookPosition['positionType']>(
    position?.positionType ?? defaultPositionType ?? 'preferred'
  )
  const [content, setContent] = useState(position?.content ?? '')
  const [notes, setNotes] = useState(position?.notes ?? '')
  const [riskThreshold, setRiskThreshold] = useState(position?.riskThreshold ?? 0.5)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave({ clauseCategoryId: categoryId, positionType, content, notes, riskThreshold })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40">
      <div className="w-full max-w-3xl h-[90vh] bg-card rounded-card shadow-e3 overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-paper-200">
          <h2 className="text-section text-ink-950">{position ? 'Edit Position' : 'New Position'}</h2>
          <button onClick={onClose}><X className="size-4 text-ink-400 hover:text-ink-700" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
          <div>
            <label className="text-[11px] font-medium text-ink-700 mb-1 block">Position Type</label>
            <div className="flex gap-2">
              {POSITION_TYPES.map(t => (
                <button
                  key={t}
                  onClick={() => setPositionType(t)}
                  className={cn(
                    'px-3 py-1.5 rounded-md text-[12.5px] font-semibold border transition-colors',
                    positionType === t
                      ? cn(POSITION_COLORS[t].bg, POSITION_COLORS[t].text, POSITION_COLORS[t].border)
                      : 'border-paper-200 text-ink-500 hover:bg-paper-50',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-[11px] font-medium text-ink-700 mb-1 block">Position Language</label>
            <div className="border border-paper-200 rounded-md overflow-hidden" style={{ height: 280 }}>
              <ContractEditor
                initialContent={content}
                onChange={setContent}
                readOnly={false}
              />
            </div>
          </div>
          <div>
            <label className="text-[11px] font-medium text-ink-700 mb-1 block">Legal Team Notes</label>
            <Input
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Guidance for the legal team..."
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-ink-700 mb-1 block">
              Risk Threshold: {Math.round(riskThreshold * 100)}%
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={riskThreshold}
              onChange={e => setRiskThreshold(Number(e.target.value))}
              className="w-full accent-ink-950"
            />
            <div className="flex justify-between text-[11px] text-ink-400 mt-0.5">
              <span>Walk away</span>
              <span>Preferred</span>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-paper-200 bg-paper-50">
          <Button variant="outline" size="md" onClick={onClose}>Cancel</Button>
          <Button size="md" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Save Position
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Test Panel ───────────────────────────────────────────────────────────────

function TestPanel({ categoryId }: { categoryId: string }) {
  const [clauseText, setClauseText] = useState('')
  const [result, setResult] = useState<any>(null)
  const [testing, setTesting] = useState(false)

  // Same ladder as POSITION_COLORS — the verdict pill must agree with the card
  // it points at.
  const MATCH_COLORS: Record<string, string> = {
    preferred: 'text-brand-700 bg-brand-50',
    acceptable: 'text-ink-700 bg-paper-100',
    fallback: 'text-attention-700 bg-attention-50',
    walkaway: 'text-risk-700 bg-risk-50',
  }

  const handleTest = async () => {
    if (!clauseText.trim()) return
    setTesting(true)
    setResult(null)
    try {
      const res = await api.post('/playbook/test', { clauseText, clauseCategoryId: categoryId })
      setResult(res.data)
    } catch (e: any) {
      setResult({ error: e.response?.data?.detail ?? 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="border border-paper-200 rounded-card p-4 bg-paper-50">
      <div className="flex items-center gap-2 mb-3">
        <Play className="size-4 text-ink-500" />
        <h3 className="text-section text-ink-950">Test Mode</h3>
      </div>
      <textarea
        value={clauseText}
        onChange={e => setClauseText(e.target.value)}
        rows={4}
        placeholder="Paste a clause to test against your playbook..."
        className="w-full border border-input rounded-md px-3 py-2 text-[13px] text-ink-950 bg-card placeholder:text-ink-400 outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15 resize-none"
      />
      {/* Outline, not ink — "Add Position" is this screen's one primary. */}
      <Button
        variant="outline"
        className="mt-2"
        onClick={handleTest}
        disabled={testing || !clauseText.trim()}
      >
        {testing ? <Loader2 className="animate-spin" /> : <Play />}
        {testing ? 'Analyzing...' : 'Test Clause'}
      </Button>

      {result?.error && (
        <div className="mt-3 p-3 bg-risk-50 border border-risk-200 rounded-md text-dense text-risk-700">
          {result.error}
        </div>
      )}

      {result && !result.error && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className={cn('px-3 py-1 rounded-full text-dense font-semibold', MATCH_COLORS[result.bestMatch])}>
              {result.bestMatch?.toUpperCase()} MATCH
            </span>
            <span className="text-dense tabular-nums text-ink-500">Score: {Math.round((result.score ?? 0) * 100)}%</span>
          </div>
          <p className="text-body text-ink-700">{result.explanation}</p>
          {result.deviations?.length > 0 && (
            <div className="space-y-1">
              {result.deviations.map((d: any, i: number) => (
                <div key={i} className={cn(
                  'flex items-start gap-2 p-2 rounded-md text-[11.5px]',
                  d.severity === 'high' ? 'bg-risk-50 text-risk-700' :
                  d.severity === 'medium' ? 'bg-attention-50 text-attention-700' :
                  'bg-paper-100 text-ink-700',
                )}>
                  <span className="font-semibold capitalize">{d.positionType}:</span>
                  <span>{d.deviation}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export function PlaybookPage() {
  const qc = useQueryClient()
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [showEditor, setShowEditor] = useState(false)
  const [editPosition, setEditPosition] = useState<PlaybookPosition | undefined>()
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const [showTest, setShowTest] = useState(false)

  const { data: categoriesData } = useQuery({
    queryKey: ['clause-categories'],
    queryFn: () => api.get('/clauses/categories').then(r => r.data),
  })

  // P7.4.12 / F-63 — fetch the org-wide position count so we can decide
  // whether this is a brand-new playbook (show explainer) or a populated
  // one (auto-select the first category). Cheap query — runs once.
  const { data: allPositionsData } = useQuery({
    queryKey: ['playbook-all'],
    queryFn: () => api.get('/playbook/positions').then(r => r.data),
    staleTime: 30_000,
  })

  const { data: playbookData } = useQuery({
    queryKey: ['playbook', selectedCategoryId],
    queryFn: () =>
      api.get('/playbook/positions', {
        params: selectedCategoryId ? { clauseCategoryId: selectedCategoryId } : {},
      }).then(r => r.data),
    enabled: !!selectedCategoryId,
  })

  const createMutation = useMutation({
    mutationFn: (body: any) => api.post('/playbook/positions', body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['playbook'] }); setShowEditor(false) },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => api.patch(`/playbook/positions/${id}`, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['playbook'] }); setShowEditor(false); setEditPosition(undefined) },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/playbook/positions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['playbook'] }),
  })

  const categories: (ClauseCategory & { children?: ClauseCategory[] })[] = categoriesData?.data ?? []
  const positions: PlaybookPosition[] = playbookData?.data ?? []
  const totalPositionsInOrg: number = (allPositionsData?.data ?? []).length

  // P7.4.12 / F-63 — auto-select the first category once categories
  // load IF the org already has positions (i.e. not a brand-new
  // playbook). This drops the user straight into actionable content
  // instead of the EXAMPLE intro panel.
  useEffect(() => {
    if (selectedCategoryId) return
    if (totalPositionsInOrg === 0) return
    if (categories.length === 0) return
    // Prefer a top-level category that actually has positions
    // configured — if nothing matches, fall back to the first one.
    const positionCategoryIds = new Set((allPositionsData?.data ?? []).map((p: PlaybookPosition) => p.clauseCategoryId))
    const populated = categories.find(c => positionCategoryIds.has(c.id))
      ?? categories.find(c => c.children?.some(ch => positionCategoryIds.has(ch.id)))
    setSelectedCategoryId(populated?.id ?? categories[0].id)
  }, [categories, totalPositionsInOrg, selectedCategoryId, allPositionsData])

  const toggleCategory = (id: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  return (
    <div className="flex h-full">
      {/* ── Category Tree ── */}
      <div className="w-64 shrink-0 border-r border-paper-200 bg-paper-50 flex flex-col">
        <div className="px-4 py-4 border-b border-paper-200">
          <div className="flex items-center gap-2">
            <Shield className="size-4 text-ink-400" />
            <h1 className="text-title text-ink-950">Playbook</h1>
          </div>
          <p className="text-[11.5px] text-ink-500 mt-0.5">Negotiation positions per clause type</p>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {categories.map(cat => (
            <div key={cat.id}>
              <button
                onClick={() => { setSelectedCategoryId(cat.id); toggleCategory(cat.id) }}
                className={cn(
                  'w-full flex items-center gap-1.5 px-2 py-2 rounded-md text-[12.5px] transition-colors',
                  // Selected is a state, not an action, so it stays quiet. The
                  // ink fill is the app sidebar's; a second one here would
                  // compete with "Add Position" for the eye.
                  selectedCategoryId === cat.id
                    ? 'bg-paper-100 text-ink-950 font-medium'
                    : 'text-ink-700 hover:bg-paper-100',
                )}
              >
                {(cat.children?.length ?? 0) > 0
                  ? (expandedCategories.has(cat.id) ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />)
                  : <span className="w-3.5" />}
                <span className="flex-1 text-left truncate">{cat.name}</span>
              </button>
              {expandedCategories.has(cat.id) && cat.children?.map(child => (
                <div key={child.id} className="ml-3 border-l-2 border-paper-200 pl-2">
                  <button
                    onClick={() => setSelectedCategoryId(child.id)}
                    className={cn(
                      'w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[12.5px] transition-colors',
                      selectedCategoryId === child.id
                        ? 'bg-paper-100 text-ink-950 font-medium'
                        : 'text-ink-500 hover:bg-paper-100',
                    )}
                  >
                    <span className="truncate">{child.name}</span>
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ── Positions Panel ── */}
      <div className="flex-1 overflow-y-auto p-6">
        {!selectedCategoryId ? (
          <PlaybookExplainer
            categoryCount={categories.length}
            onPickFirst={() => categories[0] && setSelectedCategoryId(categories[0].id)}
          />
        ) : (
          <div className="max-w-3xl space-y-4">
            {(() => {
              const missingTypes = POSITION_TYPES.filter(t => !positions.find(p => p.positionType === t))
              const allFilled = missingTypes.length === 0
              return (
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-title text-ink-950">
                      {categories.find(c => c.id === selectedCategoryId)?.name ?? 'Positions'}
                    </h2>
                    {positions.length > 0 && !showTest && (
                      <p className="text-[11.5px] text-muted-foreground mt-0.5">
                        Tip: paste a clause into <span className="font-semibold">Test playbook</span> to see which position it matches.
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2 items-center">
                    {/* P7.4.13 / F-65 — Test Mode promoted from outline
                        button to a primary-tier CTA (filled when active,
                        emphasised border when off). It's a major UX win
                        the audit said was buried; this makes it
                        equally discoverable to "Add Position". */}
                    {/* Still equally discoverable — same size, same row — but
                        the "on" state is an ink border and paper fill rather
                        than a second ink-filled primary. */}
                    <Button
                      variant="outline"
                      onClick={() => setShowTest(t => !t)}
                      data-testid="playbook-test-btn"
                      aria-pressed={showTest}
                      className={cn(showTest && 'border-ink-950 bg-paper-100 text-ink-950')}
                    >
                      <Play />
                      {showTest ? 'Hide test panel' : 'Test playbook'}
                    </Button>
                    <Button
                      onClick={() => { setEditPosition(undefined); setShowEditor(true) }}
                      disabled={allFilled}
                      title={allFilled ? 'All 4 positions defined — edit existing cards' : `Add ${missingTypes[0]} position`}
                      data-testid="playbook-add-position-btn"
                      className="disabled:cursor-not-allowed"
                    >
                      <Plus />
                      Add Position
                      {!allFilled && <span className="text-[11px] font-normal opacity-70">({missingTypes.length} left)</span>}
                    </Button>
                  </div>
                </div>
              )
            })()}

            {showTest && <TestPanel categoryId={selectedCategoryId} />}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {POSITION_TYPES.map(type => {
                const pos = positions.find(p => p.positionType === type)
                if (!pos) return null
                return (
                  <PositionCard
                    key={pos.id}
                    position={pos}
                    onEdit={() => { setEditPosition(pos); setShowEditor(true) }}
                    onDelete={() => deleteMutation.mutate(pos.id)}
                  />
                )
              })}
              {!positions.length && (
                <div className="col-span-2 flex flex-col items-center justify-center py-12 text-ink-400 border-2 border-dashed border-paper-200 rounded-card">
                  <Shield className="size-6 mb-2" />
                  <p className="text-dense">No positions defined yet</p>
                  <p className="text-[11.5px] mt-1">Add preferred → acceptable → fallback → walkaway positions</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Position Editor Modal ── */}
      {showEditor && selectedCategoryId && (() => {
        const missingTypes = POSITION_TYPES.filter(t => !positions.find(p => p.positionType === t))
        return (
          <PositionEditor
            position={editPosition}
            categoryId={selectedCategoryId}
            defaultPositionType={editPosition ? undefined : (missingTypes[0] ?? 'preferred')}
            onClose={() => { setShowEditor(false); setEditPosition(undefined) }}
            onSave={async (data) => {
              if (editPosition) {
                await updateMutation.mutateAsync({ id: editPosition.id, data })
              } else {
                await createMutation.mutateAsync(data)
              }
            }}
          />
        )
      })()}
    </div>
  )
}

// ─── Empty-state explainer (B.6.19) ───────────────────────────────────────────

interface PlaybookExplainerProps {
  categoryCount: number
  onPickFirst: () => void
}

/** Sample data keyed by position type — shown as ghost cards so the user
 *  sees what a populated playbook looks like before committing to fill one. */
const SAMPLE_POSITIONS = [
  { type: 'preferred',  title: 'Ideal',        body: 'Limit of Liability capped at 1× fees paid in the prior 12 months. Mutual carve-outs for confidentiality + IP infringement.' },
  { type: 'acceptable', title: 'Acceptable',   body: 'Cap at 2× fees. Carve-out for confidentiality only. Explicit exclusion of lost profits + consequential damages.' },
  { type: 'fallback',   title: 'Fallback',     body: 'Cap at 12 months fees, no carve-outs. Tolerate uncapped liability if counterparty accepts our indemnity cap.' },
  { type: 'walkaway',   title: 'Walk away',    body: 'Any uncapped liability with no carve-outs. Indemnities without a corresponding cap. Escalate to CLO.' },
]

function PlaybookExplainer({ categoryCount, onPickFirst }: PlaybookExplainerProps) {
  return (
    <div className="max-w-3xl mx-auto space-y-5" data-testid="playbook-explainer">
      {/* Short "why" paragraph */}
      <div className="rounded-card border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          <div className="size-10 rounded-card bg-primary/10 flex items-center justify-center shrink-0">
            <Shield className="size-4 text-primary" />
          </div>
          <div className="flex-1">
            <h2 className="text-section text-foreground">What's a playbook?</h2>
            <p className="text-body text-muted-foreground mt-1 leading-relaxed">
              A playbook captures your preferred, acceptable, and
              reject-worthy <em>positions</em> for each clause type.
              When AI drafts, reviews, or negotiates a contract it uses
              these as ground truth — no more "ask Legal what we
              normally do on liability caps."
            </p>
            {/* The only ink fill on this state of the screen. */}
            {categoryCount > 0 && (
              <Button
                size="xs"
                onClick={onPickFirst}
                data-testid="pick-first-category"
                className="mt-3"
              >
                Start with your first clause category
                <ChevronRight />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Ghost preview — 4 sample positions */}
      <div>
        <p className="text-eyebrow uppercase text-ink-700 mb-2">
          Example — Limitation of Liability
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {SAMPLE_POSITIONS.map((p) => {
            const c = POSITION_COLORS[p.type as PlaybookPosition['positionType']]
            return (
              <div
                key={p.type}
                className={cn('rounded-card border p-4 opacity-70', c.bg, c.border)}
                aria-hidden
              >
                <span className={cn('text-eyebrow uppercase', c.text)}>
                  {p.type}
                </span>
                <p className="text-body text-ink-700 mt-2 leading-relaxed">{p.body}</p>
              </div>
            )
          })}
        </div>
        <p className="text-[11px] text-muted-foreground mt-2 italic">
          Preview — pick a category on the left to start defining your own positions.
        </p>
      </div>
    </div>
  )
}
