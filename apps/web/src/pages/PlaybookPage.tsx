/**
 * Playbook Page — Phase 4.4 (SCR-036)
 * Manage preferred/acceptable/fallback/walkaway positions per clause category.
 * Test mode: paste a clause → agent scores it against playbook.
 */
import { useState, useEffect, useMemo } from 'react'
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

/** What each rung of the ladder is for, in the words a negotiator would use. */
const POSITION_BLURB: Record<string, string> = {
  preferred:  'What we open with.',
  acceptable: 'What we sign without escalating.',
  fallback:   'What we concede, reluctantly.',
  walkaway:   'What we refuse.',
}

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
      {/*
        The bar used to set `background: currentColor` inline on top of a wash
        class and a brightness filter, so it painted in whatever the inherited
        text colour happened to be — ink, in every position type — while the
        class said otherwise. And "threshold 50%" named a number without naming
        what it gates. It is the match score at which the agent will treat a
        counterparty's clause as landing on this rung, so it says so.
      */}
      <div className="flex items-center gap-2 mt-3">
        <span
          className="block h-1 w-20 shrink-0 overflow-hidden rounded-full bg-paper-200"
          role="meter"
          aria-valuenow={Math.round((position.riskThreshold ?? 0.5) * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Match threshold ${Math.round((position.riskThreshold ?? 0.5) * 100)} percent`}
        >
          <span
            className="block h-full rounded-full bg-ink-700"
            style={{ width: `${(position.riskThreshold ?? 0.5) * 100}%` }}
          />
        </span>
        <span className="text-[11px] tabular-nums text-ink-500">
          matches at {Math.round((position.riskThreshold ?? 0.5) * 100)}%+
        </span>
      </div>
    </div>
  )
}

// ─── Empty rung ───────────────────────────────────────────────────────────────

/**
 * A rung with nothing on it.
 *
 * The playbook's value is the ladder, and the gaps in the ladder are the thing
 * a GC most wants to see: "we have never written down what we walk away from on
 * indemnities" is a finding. Rendering only the rungs that exist hid exactly
 * that, and left a lone card floating in a two-column grid.
 */
function EmptyRung({ type, onAdd }: { type: string; onAdd: () => void }) {
  return (
    <button
      type="button"
      onClick={onAdd}
      data-testid={`playbook-empty-${type}`}
      className="rounded-card border border-dashed border-paper-300 p-4 text-left transition-colors hover:border-ink-400 hover:bg-paper-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="text-eyebrow uppercase text-ink-400">{type}</span>
      <p className="text-dense text-ink-500 mt-2">{POSITION_BLURB[type]}</p>
      <span className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-medium text-ink-950">
        <Plus className="size-3" /> Define this position
      </span>
    </button>
  )
}

// ─── Coverage ticks ───────────────────────────────────────────────────────────

/**
 * Four ticks: how many rungs of the ladder this category has written down.
 *
 * Ink, not colour — an incomplete playbook is a gap in the work, not a state
 * of a contract, and this rail sits next to nineteen of them. The accessible
 * name carries the number so the ticks are never the only signal.
 */
function CoverageTicks({ filled, name }: { filled: number; name: string }) {
  return (
    <span
      className="flex shrink-0 items-center gap-[3px]"
      role="img"
      aria-label={`${name}: ${filled} of 4 positions defined`}
      title={`${filled} of 4 positions defined`}
    >
      {POSITION_TYPES.map((_, i) => (
        <span
          key={i}
          className={cn('block h-2.5 w-[3px] rounded-full', i < filled ? 'bg-ink-700' : 'bg-paper-200')}
        />
      ))}
    </span>
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
            {/* bestMatch can come back as something not on the ladder (or
                absent) — cn() then emits a pill with no colour and the label
                reads "UNDEFINED MATCH". */}
            <span className={cn('px-3 py-1 rounded-full text-dense font-semibold', MATCH_COLORS[result.bestMatch] ?? 'text-ink-700 bg-paper-100')}>
              {result.bestMatch ? `${String(result.bestMatch).toUpperCase()} MATCH` : 'NO CLEAR MATCH'}
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
  // Which rung the editor should open on when the user adds from a gap card.
  const [addType, setAddType] = useState<PlaybookPosition['positionType'] | undefined>()
  const [pendingDelete, setPendingDelete] = useState<PlaybookPosition | undefined>()

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

  // The rail's coverage ticks are computed from the org-wide 'playbook-all'
  // query, so every write has to invalidate it too — otherwise adding the
  // missing walkaway leaves the rail still showing three of four.
  const refreshPlaybook = () => {
    qc.invalidateQueries({ queryKey: ['playbook'] })
    qc.invalidateQueries({ queryKey: ['playbook-all'] })
  }

  const createMutation = useMutation({
    mutationFn: (body: any) => api.post('/playbook/positions', body),
    onSuccess: () => { refreshPlaybook(); setShowEditor(false); setAddType(undefined) },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => api.patch(`/playbook/positions/${id}`, data),
    onSuccess: () => { refreshPlaybook(); setShowEditor(false); setEditPosition(undefined) },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/playbook/positions/${id}`),
    onSuccess: () => refreshPlaybook(),
  })

  const categories: (ClauseCategory & { children?: ClauseCategory[] })[] = categoriesData?.data ?? []
  const positions: PlaybookPosition[] = playbookData?.data ?? []
  const allPositions: PlaybookPosition[] = allPositionsData?.data ?? []
  const totalPositionsInOrg: number = allPositions.length

  /*
   * Coverage per category, from the org-wide fetch we already make.
   *
   * The rail listed nineteen clause types identically, so the only way to learn
   * that Governing Law has one position and Term & Termination has four was to
   * click nineteen times. Coverage is the playbook's whole health metric — an
   * unwritten walkaway is what gets conceded at 6pm on a Friday — so the rail
   * carries it.
   */
  const coverage = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const p of allPositions) {
      const set = m.get(p.clauseCategoryId) ?? new Set<string>()
      set.add(p.positionType)
      m.set(p.clauseCategoryId, set)
    }
    return m
  }, [allPositions])

  const coverageOf = (id: string) => coverage.get(id)?.size ?? 0

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

  // Escape backs out of the delete confirmation — the safe direction.
  useEffect(() => {
    if (!pendingDelete) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPendingDelete(undefined) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingDelete])

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
                <CoverageTicks filled={coverageOf(cat.id)} name={cat.name} />
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
                    <span className="flex-1 text-left truncate">{child.name}</span>
                    <CoverageTicks filled={coverageOf(child.id)} name={child.name} />
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
                      {categoryName(categories, selectedCategoryId) ?? 'Positions'}
                    </h2>
                    {/* Coverage first — it is the answer to "is this category
                        finished?", which is why the user opened it. */}
                    <p className="text-[11.5px] text-ink-500 mt-0.5">
                      {allFilled
                        ? `All 4 positions defined · ${positions.length} in total`
                        : `${POSITION_TYPES.length - missingTypes.length} of 4 positions defined — missing ${missingTypes.join(', ')}`}
                    </p>
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
                    {/*
                      No longer disabled when all four rungs exist. Three
                      categories in this org legitimately carry two positions on
                      one rung (a general cap and a carve-out, say), and the
                      button that adds them was greyed out with the tooltip
                      "All 4 positions defined" — a rule the data does not obey.
                    */}
                    <Button
                      onClick={() => { setEditPosition(undefined); setAddType(missingTypes[0]); setShowEditor(true) }}
                      title={allFilled ? 'Add another position to this category' : `Add ${missingTypes[0]} position`}
                      data-testid="playbook-add-position-btn"
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

            {/*
              This grid used to render `positions.find(p => p.positionType === t)`
              — the FIRST position of each rung, and nothing else. Three
              categories in this org carry a second position on a rung
              (Confidentiality and Limitation of Liability each have two
              `preferred`; Intellectual Property has two `acceptable`), and those
              were invisible: not listed, not editable, not deletable, but very
              much still fed to the agent that scores counterparty language. A
              playbook you cannot see all of is worse than no playbook. Every
              position renders, in ladder order; empty rungs render as gaps.
            */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {POSITION_TYPES.flatMap(type => {
                const forType = positions.filter(p => p.positionType === type)
                if (!forType.length) {
                  return [
                    <EmptyRung
                      key={`empty-${type}`}
                      type={type}
                      onAdd={() => { setEditPosition(undefined); setAddType(type); setShowEditor(true) }}
                    />,
                  ]
                }
                return forType.map(pos => (
                  <PositionCard
                    key={pos.id}
                    position={pos}
                    onEdit={() => { setEditPosition(pos); setShowEditor(true) }}
                    onDelete={() => setPendingDelete(pos)}
                  />
                ))
              })}
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
            defaultPositionType={editPosition ? undefined : (addType ?? missingTypes[0] ?? 'preferred')}
            onClose={() => { setShowEditor(false); setEditPosition(undefined); setAddType(undefined) }}
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

      {/* Deleting a negotiated position was a single unconfirmed click, and the
          position is what the agent scores counterparty language against. */}
      {pendingDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Delete position"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4"
          onClick={() => setPendingDelete(undefined)}
          data-testid="playbook-delete-dialog"
        >
          <div className="w-full max-w-sm bg-card rounded-card shadow-e3" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-paper-200">
              <h2 className="text-section text-ink-950">Delete this position?</h2>
              <p className="text-dense text-ink-500 mt-1">
                The <span className="font-medium text-ink-950 capitalize">{pendingDelete.positionType}</span> position
                for {categoryName(categories, selectedCategoryId) ?? 'this category'} will be removed, and drafting and
                review will stop scoring against it. This can't be undone.
              </p>
            </div>
            <div className="px-5 py-3 flex justify-end gap-2 bg-paper-50 rounded-b-card">
              <Button variant="outline" size="xs" onClick={() => setPendingDelete(undefined)}>Cancel</Button>
              <Button
                variant="destructive"
                size="xs"
                onClick={() => { deleteMutation.mutate(pendingDelete.id); setPendingDelete(undefined) }}
                data-testid="playbook-delete-confirm"
              >
                Delete position
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Category name by id, including nested children.
 *
 * The heading looked only at top-level categories, so selecting any child
 * category in the rail titled the panel "Positions" — the one word on screen
 * that says which playbook you are editing, blank exactly when the tree is
 * deep enough to need it.
 */
function categoryName(
  categories: (ClauseCategory & { children?: ClauseCategory[] })[],
  id: string | null,
): string | undefined {
  if (!id) return undefined
  for (const c of categories) {
    if (c.id === id) return c.name
    const child = c.children?.find(ch => ch.id === id)
    if (child) return child.name
  }
  return undefined
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
