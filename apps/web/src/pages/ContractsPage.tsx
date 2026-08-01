import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { UploadModal } from '@/components/contracts/UploadModal'
import { BulkImportDialog } from '@/components/contracts/BulkImportDialog'
import { NewContractFlow } from '@/components/contracts/NewContractFlow'
import { Upload, Search, FileText, ChevronRight, SlidersHorizontal, X, Loader2, PenSquare, RefreshCcw } from 'lucide-react'

// ─── Constants ────────────────────────────────────────────────────────────────

const IN_PROGRESS_STATUSES = ['PENDING', 'PARSING', 'SPLITTING', 'CLASSIFYING', 'EXTRACTING', 'INDEXING', 'ANALYZING']

const PHASE_LABEL: Record<string, string> = {
  PENDING:     'Queued',
  PARSING:     'Parsing',
  SPLITTING:   'Splitting',
  CLASSIFYING: 'Classifying',
  EXTRACTING:  'Extracting',
  ANALYZING:   'Analyzing',
  INDEXING:    'Indexing',
}

const TYPE_DOT: Record<string, string> = {
  NDA:              'bg-purple-400',
  MSA:              'bg-blue-400',
  SOW:              'bg-cyan-400',
  SLA:              'bg-teal-400',
  VENDOR_AGREEMENT: 'bg-orange-400',
  EMPLOYMENT:       'bg-green-400',
  PARTNERSHIP:      'bg-indigo-400',
  LICENSE:          'bg-yellow-400',
  OTHER:            'bg-gray-400',
}

const STATUS_PILL: Record<string, string> = {
  DRAFT:               'bg-gray-100 text-gray-600',
  PENDING_REVIEW:      'bg-amber-100 text-amber-700',
  UNDER_NEGOTIATION:   'bg-orange-100 text-orange-700',
  PENDING_APPROVAL:    'bg-blue-100 text-blue-700',
  APPROVED:            'bg-emerald-100 text-emerald-700',
  PENDING_SIGNATURE:   'bg-purple-100 text-purple-700',
  EXECUTED:            'bg-emerald-100 text-emerald-700',
  EXPIRED:             'bg-red-100 text-red-700',
  TERMINATED:          'bg-red-100 text-red-700',
  ARCHIVED:            'bg-gray-100 text-gray-500',
}

/**
 * B.6.8 — guard against placeholder titles leaking to the UI.
 * Historical rows (pre-fix) can still have "Unnamed Contract - No
 * Identified Parties" etc. as titles; render the filename from the
 * latest version if we find that. See also: apps/agents/app/routes/
 * review.py where we now refuse to write those titles in the first
 * place, and apps/api/scripts/backfill-titles.ts which cleans the
 * existing rows.
 */
const PLACEHOLDER_TITLE_RE = /^(unnamed|unidentified|untitled|unknown) contract\b|no identified parties|missing party/i
function displayTitle(c: { title?: string | null; versions?: Array<{ s3Key?: string | null }>; metadata?: unknown }): string {
  const t = (c.title ?? '').trim()
  if (t && !PLACEHOLDER_TITLE_RE.test(t)) return t
  const v = c.versions?.[0]
  const key = v?.s3Key ?? ''
  // S3 keys look like `${orgId}/contracts/${timestamp}-${filename}`
  // Pull out the tail and strip extension.
  const tail = key.split('/').pop() ?? ''
  const withoutPrefix = tail.replace(/^\d+-/, '')
  const stem = withoutPrefix.replace(/\.[^.]+$/, '').trim()
  return stem || t || 'Untitled contract'
}

const CLAUSE_FLAG_LABELS: Record<string, string> = {
  forceMajeure:          'Force Majeure',
  mfn:                   'MFN',
  changeOfControl:       'Change of Control',
  auditRights:           'Audit Rights',
  assignmentRestriction: 'Assignment Restriction',
  limitationOfLiability: 'Liability Cap',
  indemnification:       'Indemnification',
}

interface ActiveFilters {
  type?: string
  status?: string
  jurisdiction?: string
  riskBand?: string
  clauseFlags?: Record<string, boolean>
  expiryDateTo?: string
  counterpartyId?: string
  // U12 audit (2026-04-29). Numeric SLA facets — encoded as preset
  // bands so the chip surface stays simple. The buildQuery step
  // translates these into otdMax / uptimeSlaMin server params.
  // 'below_target'    → otdMax=95
  // 'meeting_target'  → otdMin=95
  otdBand?: 'below_target' | 'meeting_target'
  // 'three_nines'     → uptimeSlaMin=99.0
  // 'four_nines'      → uptimeSlaMin=99.99
  uptimeBand?: 'three_nines' | 'four_nines'
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ContractsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()

  // B.6.17 — row-level retry for Failed contracts. We track per-id
  // pending state so the spinner shows on just the row being retried.
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/contracts/${id}/analyze?full=true`).then((r) => r.data),
    onMutate: (id: string) => { setRetryingId(id) },
    onSettled: () => {
      setRetryingId(null)
      queryClient.invalidateQueries({ queryKey: ['contracts'] })
    },
  })
  const [showUpload, setShowUpload] = useState(false)
  const [showBulkImport, setShowBulkImport] = useState(false)
  const [showNewContract, setShowNewContract] = useState(false)
  const [showFacets, setShowFacets] = useState(false)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // B.6.5 + B.6.9 — seed filters from URL params so dashboard KPI
  // cards and the Counterparties page can deep link here with a
  // filter already applied. When the user dismisses a chip we strip
  // the param so refresh / back behaves predictably.
  const [filters, setFilters] = useState<ActiveFilters>(() => {
    const f: ActiveFilters = {}
    const expiryDateTo = searchParams.get('expiryDateTo')
    const type = searchParams.get('type')
    const status = searchParams.get('status')
    const riskBand = searchParams.get('riskBand')
    const counterpartyId = searchParams.get('counterpartyId')
    if (expiryDateTo) f.expiryDateTo = expiryDateTo
    if (type) f.type = type
    if (status) f.status = status
    if (riskBand) f.riskBand = riskBand
    if (counterpartyId) f.counterpartyId = counterpartyId
    return f
  })

  // The optional label carried in the URL overrides our default chip
  // text (so the dashboard can say "Expiring within 30 days" instead
  // of the raw ISO date). Only used for the expiry filter today.
  const filterLabelFromUrl = searchParams.get('filterLabel') ?? undefined

  // Keep URL in sync with filter state — so copy-paste / back / reload
  // round-trips cleanly.
  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    const syncKey = (key: keyof ActiveFilters) => {
      const v = filters[key]
      if (typeof v === 'string' && v) next.set(String(key), v)
      else next.delete(String(key))
    }
    syncKey('expiryDateTo')
    syncKey('type')
    syncKey('status')
    syncKey('riskBand')
    syncKey('counterpartyId')
    // Drop the label when no chip-labelled filter is active
    if (!filters.expiryDateTo && !filters.counterpartyId) next.delete('filterLabel')
    // Only replace if something actually changed — avoids an extra
    // history entry when React re-renders without change.
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.expiryDateTo, filters.type, filters.status, filters.riskBand, filters.counterpartyId])

  const activeFilterCount = Object.values(filters).filter(Boolean).length

  const { data: facetsData } = useQuery({
    queryKey: ['contract-facets'],
    queryFn: () => api.get('/search/facets').then(r => r.data),
    staleTime: 30_000,
  })

  const buildQuery = () => {
    const q: Record<string, any> = { limit: 50, mode: 'keyword' }
    if (debouncedSearch) q.q = debouncedSearch
    if (filters.type) q.type = filters.type
    if (filters.status) q.status = filters.status
    if (filters.jurisdiction) q.jurisdiction = filters.jurisdiction
    if (filters.riskBand === 'high') q.riskScoreMin = 0.67
    if (filters.riskBand === 'medium') { q.riskScoreMin = 0.34; q.riskScoreMax = 0.67 }
    if (filters.riskBand === 'low') q.riskScoreMax = 0.34
    if (filters.clauseFlags && Object.keys(filters.clauseFlags).length) q.clauseFlags = filters.clauseFlags
    if (filters.expiryDateTo) q.expiryDateTo = filters.expiryDateTo
    // B.6.9 — counterparty drill-through. Historical contracts often
    // only have counterpartyName (no FK), so we pass BOTH when we can.
    // filterLabelFromUrl carries the name from the Counterparties page.
    if (filters.counterpartyId) q.counterpartyId = filters.counterpartyId
    if (filters.counterpartyId && filterLabelFromUrl) q.counterpartyName = filterLabelFromUrl
    // U12 — numeric SLA facets. Map preset bands to absolute min/max.
    if (filters.otdBand === 'below_target')   q.otdMax = 95
    if (filters.otdBand === 'meeting_target') q.otdMin = 95
    if (filters.uptimeBand === 'three_nines') q.uptimeSlaMin = 99.0
    if (filters.uptimeBand === 'four_nines')  q.uptimeSlaMin = 99.99
    return q
  }

  const hasFilters = activeFilterCount > 0 || !!debouncedSearch

  // B.6.9 — Route choice.
  // Plain /contracts hits Postgres directly and is always correct for
  // structural filters; /search/advanced routes to Elasticsearch for
  // full-text + risk + clause-flag + jurisdiction queries. Use the
  // plain route whenever no ES-only filter is active — that way deep
  // links from Counterparties (counterpartyId) and Dashboard
  // (expiryDateTo, status) don't miss rows because of ES staleness.
  const needsEs =
    !!debouncedSearch ||
    !!filters.clauseFlags ||
    !!filters.riskBand ||
    !!filters.jurisdiction

  const { data, isLoading } = useQuery({
    queryKey: ['contracts', debouncedSearch, filters, needsEs],
    queryFn: () => {
      if (needsEs) {
        return api.post('/search/advanced', buildQuery()).then(r => r.data)
      }
      // Plain route — pass structural filters as GET params
      const params: Record<string, unknown> = { limit: 50 }
      if (filters.type) params.type = filters.type
      if (filters.status) params.status = filters.status
      if (filters.counterpartyId) params.counterpartyId = filters.counterpartyId
      if (filters.expiryDateTo) params.expiryDateTo = filters.expiryDateTo
      return api.get('/contracts', { params }).then(r => r.data)
    },
    // Poll every 5s while any contract in the list is being analyzed
    refetchInterval: (q) => {
      const contracts = q.state.data?.data ?? q.state.data ?? []
      return contracts.some((c: any) => IN_PROGRESS_STATUSES.includes(c.analysisStatus)) ? 5000 : false
    },
  })

  const handleSearch = (val: string) => {
    setSearch(val)
    clearTimeout((window as any).__searchDebounce)
    ;(window as any).__searchDebounce = setTimeout(() => setDebouncedSearch(val), 350)
  }

  const toggleFlag = (flag: string) => {
    setFilters(f => {
      const cur = f.clauseFlags ?? {}
      if (cur[flag]) {
        const next = { ...cur }; delete next[flag]
        return { ...f, clauseFlags: Object.keys(next).length ? next : undefined }
      }
      return { ...f, clauseFlags: { ...cur, [flag]: true } }
    })
  }

  const contracts = data?.data ?? []
  const total = data?.total ?? 0
  const facets = facetsData ?? {}
  // U3 — when ES returns highlights per row, surface "matched in
  // counterparty / summary / clause body" so a partial-match search
  // ("Iowa" → "Iora Health") feels confirmed instead of confusing.
  const highlights: Record<string, Record<string, string[]>> = data?.highlights ?? {}

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Contract Repository</h1>
            <p className="text-sm text-gray-400 mt-0.5">{total} contract{total !== 1 ? 's' : ''}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowFacets(!showFacets)}
              className={`gap-1.5 ${activeFilterCount > 0 ? 'border-blue-400 text-blue-600 bg-blue-50' : ''}`}
            >
              <SlidersHorizontal className="h-4 w-4" />
              Filters
              {activeFilterCount > 0 && (
                <span className="bg-blue-600 text-white rounded-full w-4 h-4 text-[10px] flex items-center justify-center">
                  {activeFilterCount}
                </span>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowBulkImport(true)}
              data-testid="bulk-import-button"
              title="Bulk import contracts from CSV"
              className="gap-2"
            >
              <Upload className="h-4 w-4" /> Bulk import
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowUpload(true)}
              data-testid="upload-pdf-button"
              title="Upload an existing signed or draft contract file"
              className="gap-2"
            >
              <Upload className="h-4 w-4" /> Upload PDF
            </Button>
            <Button
              onClick={() => setShowNewContract(true)}
              data-testid="draft-new-button"
              title="Start a new contract from a template"
              className="gap-2"
            >
              <PenSquare className="h-4 w-4" /> Draft new
            </Button>
          </div>
        </div>
      </div>

      {/* Search bar */}
      <div className="bg-white border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-lg">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              value={search}
              onChange={e => handleSearch(e.target.value)}
              placeholder="Search by title, counterparty, or content…"
              className="pl-9 bg-gray-50 border-gray-200"
            />
          </div>
          {hasFilters && (
            <button
              onClick={() => { setFilters({}); setSearch(''); setDebouncedSearch('') }}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600"
            >
              <X className="h-3.5 w-3.5" /> Clear all
            </button>
          )}
          {/* Active filter chips */}
          {filters.type && (
            <FilterChip label={filters.type} onRemove={() => setFilters(f => ({ ...f, type: undefined }))} />
          )}
          {filters.status && (
            <FilterChip label={filters.status.replace(/_/g, ' ')} onRemove={() => setFilters(f => ({ ...f, status: undefined }))} />
          )}
          {filters.riskBand && (
            <FilterChip label={`${filters.riskBand} risk`} onRemove={() => setFilters(f => ({ ...f, riskBand: undefined }))} />
          )}
          {filters.expiryDateTo && !filters.counterpartyId && (
            <FilterChip
              label={filterLabelFromUrl ?? `Expiring by ${new Date(filters.expiryDateTo).toLocaleDateString()}`}
              onRemove={() => setFilters(f => ({ ...f, expiryDateTo: undefined }))}
            />
          )}
          {filters.counterpartyId && (
            <FilterChip
              label={filterLabelFromUrl ?? 'Counterparty'}
              onRemove={() => setFilters(f => ({ ...f, counterpartyId: undefined }))}
            />
          )}
          {filters.otdBand && (
            <FilterChip
              label={filters.otdBand === 'below_target' ? 'OTD < 95%' : 'OTD ≥ 95%'}
              onRemove={() => setFilters(f => ({ ...f, otdBand: undefined }))}
            />
          )}
          {filters.uptimeBand && (
            <FilterChip
              label={filters.uptimeBand === 'three_nines' ? 'Uptime ≥ 99.0%' : 'Uptime ≥ 99.99%'}
              onRemove={() => setFilters(f => ({ ...f, uptimeBand: undefined }))}
            />
          )}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Facets sidebar */}
        {showFacets && (
          <aside className="w-52 border-r bg-white overflow-y-auto flex-shrink-0 p-4 space-y-5">
            <FacetGroup title="Type">
              {(facets.types ?? []).map((b: any) => (
                <FacetItem key={b.key} label={b.key.replace(/_/g, ' ')} count={b.doc_count}
                  active={filters.type === b.key}
                  onClick={() => setFilters(f => ({ ...f, type: f.type === b.key ? undefined : b.key }))} />
              ))}
            </FacetGroup>
            <FacetGroup title="Status">
              {(facets.statuses ?? []).map((b: any) => (
                <FacetItem key={b.key} label={b.key.replace(/_/g, ' ')} count={b.doc_count}
                  active={filters.status === b.key}
                  onClick={() => setFilters(f => ({ ...f, status: f.status === b.key ? undefined : b.key }))} />
              ))}
            </FacetGroup>
            {(facets.jurisdictions ?? []).length > 0 && (
              <FacetGroup title="Jurisdiction">
                {facets.jurisdictions.slice(0, 8).map((b: any) => (
                  <FacetItem key={b.key} label={b.key} count={b.doc_count}
                    active={filters.jurisdiction === b.key}
                    onClick={() => setFilters(f => ({ ...f, jurisdiction: f.jurisdiction === b.key ? undefined : b.key }))} />
                ))}
              </FacetGroup>
            )}
            <FacetGroup title="Risk">
              {(facets.riskRanges ?? []).map((b: any) => (
                <FacetItem key={b.key} label={b.key.charAt(0).toUpperCase() + b.key.slice(1)} count={b.doc_count}
                  active={filters.riskBand === b.key}
                  onClick={() => setFilters(f => ({ ...f, riskBand: f.riskBand === b.key ? undefined : b.key as any }))} />
              ))}
            </FacetGroup>
            <FacetGroup title="Clause Flags">
              {Object.entries(CLAUSE_FLAG_LABELS).map(([flag, label]) => {
                const count = facets.clauseFlags?.[flag] ?? 0
                if (!count) return null
                return <FacetItem key={flag} label={label} count={count}
                  active={!!filters.clauseFlags?.[flag]}
                  onClick={() => toggleFlag(flag)} />
              })}
            </FacetGroup>
            {/* U12 — SLA facets. Counts come from a lightweight client-side
                pass over visible contracts when the data is loaded;
                aggregated server-side counts can come later. */}
            <FacetGroup title="OTD SLA">
              <FacetItem
                label="Below 95% target"
                active={filters.otdBand === 'below_target'}
                onClick={() => setFilters(f => ({
                  ...f,
                  otdBand: f.otdBand === 'below_target' ? undefined : 'below_target',
                }))}
              />
              <FacetItem
                label="Meeting target (≥95%)"
                active={filters.otdBand === 'meeting_target'}
                onClick={() => setFilters(f => ({
                  ...f,
                  otdBand: f.otdBand === 'meeting_target' ? undefined : 'meeting_target',
                }))}
              />
            </FacetGroup>
            <FacetGroup title="Uptime SLA">
              <FacetItem
                label="≥ 99.0% (three nines)"
                active={filters.uptimeBand === 'three_nines'}
                onClick={() => setFilters(f => ({
                  ...f,
                  uptimeBand: f.uptimeBand === 'three_nines' ? undefined : 'three_nines',
                }))}
              />
              <FacetItem
                label="≥ 99.99% (four nines)"
                active={filters.uptimeBand === 'four_nines'}
                onClick={() => setFilters(f => ({
                  ...f,
                  uptimeBand: f.uptimeBand === 'four_nines' ? undefined : 'four_nines',
                }))}
              />
            </FacetGroup>
          </aside>
        )}

        {/* Contract list */}
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex items-center justify-center h-64 gap-2 text-gray-400">
              <div className="w-5 h-5 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
              <span className="text-sm">Loading contracts…</span>
            </div>
          ) : contracts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3">
              <div className="w-14 h-14 rounded-2xl bg-gray-100 flex items-center justify-center">
                <FileText className="h-7 w-7 text-gray-400" />
              </div>
              <div className="text-center">
                <p className="font-medium text-gray-700">
                  {hasFilters ? 'No contracts match your filters' : 'No contracts yet'}
                </p>
                <p className="text-sm text-gray-400 mt-1">
                  {hasFilters ? 'Try adjusting or clearing your filters' : 'Upload your first contract to get started'}
                </p>
              </div>
              {!hasFilters && (
                <Button onClick={() => setShowUpload(true)} className="gap-2 mt-1">
                  <Upload className="h-4 w-4" /> Upload Contract
                </Button>
              )}
            </div>
          ) : (
            <div className="bg-white">
              {/* Table header */}
              <div className="grid grid-cols-[minmax(0,2fr)_120px_160px_100px_80px_36px] gap-4 px-6 py-2.5 border-b bg-gray-50 sticky top-0">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Contract</span>
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Status</span>
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Counterparty</span>
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Expires</span>
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Risk</span>
                <span />
              </div>

              {/* Rows */}
              {contracts.map((c: any) => (
                // P48 a11y — remove role="button" + tabIndex on the wrapper
                // so nested <button>s (Retry, kebab, etc.) don't trip axe's
                // `nested-interactive`. Keyboard a11y is preserved by the
                // <Link> on the title cell below; mouse users still get the
                // full-row click target via onClick.
                <div
                  key={c.id}
                  data-testid={`contract-row-${c.id}`}
                  data-contract-title={c.title}
                  onClick={(e) => {
                    // Don't double-navigate when the click started on the
                    // <Link> or a button inside the row.
                    if ((e.target as HTMLElement).closest('a, button')) return
                    navigate(`/contracts/${c.id}`)
                  }}
                  className="grid grid-cols-[minmax(0,2fr)_120px_160px_100px_80px_36px] gap-4 items-center px-6 py-3.5 border-b border-gray-50 hover:bg-blue-50/40 cursor-pointer transition-colors group"
                >
                  {/* Title + type */}
                  <div className="min-w-0 flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${TYPE_DOT[c.type] ?? TYPE_DOT.OTHER}`} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Link
                          to={`/contracts/${c.id}`}
                          className="text-sm font-medium text-gray-900 truncate hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 rounded"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {displayTitle(c)}
                        </Link>
                        {IN_PROGRESS_STATUSES.includes(c.analysisStatus) && (
                          <span className="flex items-center gap-1 text-[10px] font-medium text-blue-600 bg-blue-50 border border-blue-100 rounded-full px-1.5 py-0.5 flex-shrink-0">
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            {PHASE_LABEL[c.analysisStatus] ?? 'Processing'}
                          </span>
                        )}
                        {c.analysisStatus === 'FAILED' && (
                          <span className="flex items-center gap-1 flex-shrink-0">
                            <span className="text-[10px] font-medium text-red-500 bg-red-50 border border-red-100 rounded-full px-1.5 py-0.5">
                              Failed
                            </span>
                            {/* B.6.17 — inline retry; don't make the user open the row */}
                            <button
                              type="button"
                              data-testid={`retry-${c.id}`}
                              disabled={retry.isPending && retryingId === c.id}
                              onClick={(e) => {
                                e.stopPropagation()
                                retry.mutate(c.id)
                              }}
                              className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-red-600 hover:bg-red-50 transition-colors disabled:opacity-60"
                              title="Re-run analysis"
                            >
                              {retry.isPending && retryingId === c.id
                                ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                : <RefreshCcw className="h-2.5 w-2.5" />}
                              Retry
                            </button>
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {c.type.replace(/_/g, ' ')} ·{' '}
                        <span title={new Date(c.createdAt).toLocaleString()}>{formatRelativeTime(c.createdAt)}</span>
                      </p>
                      {/* U3 — search-match field hint. When ES matched a
                          field other than the title (counterparty,
                          summary, clause body), tell the user — without
                          this, "Iowa" → "Iora Health" looks like a wrong
                          row instead of a partial-name match. */}
                      {(() => {
                        const h = highlights[c.id]
                        if (!h || !debouncedSearch) return null
                        const titleHas = (c.title ?? '').toLowerCase().includes(debouncedSearch.toLowerCase())
                        if (titleHas) return null  // already obvious
                        const matchedField =
                          h.counterpartyName ? 'counterparty'
                          : h.summary       ? 'summary'
                          : h.plainText     ? 'clause body'
                          : null
                        const fragment = (h.counterpartyName ?? h.summary ?? h.plainText ?? [])[0]
                        if (!matchedField || !fragment) return null
                        // The ES highlighter wraps matches in <em>; strip them
                        // for a plain-text excerpt rendering (no need to dangerously
                        // setInnerHTML for a small chip).
                        const plain = String(fragment).replace(/<\/?em>/g, '')
                        return (
                          <p
                            className="text-[10.5px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-1.5 py-0.5 mt-1 inline-block"
                            data-testid={`match-${c.id}`}
                            title={plain}
                          >
                            <span className="font-medium">Matched in {matchedField}:</span>{' '}
                            <span className="text-gray-700">{plain.length > 60 ? plain.slice(0, 60) + '…' : plain}</span>
                          </p>
                        )
                      })()}
                    </div>
                  </div>

                  {/* Status */}
                  <div>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_PILL[c.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {c.status.replace(/_/g, ' ')}
                    </span>
                  </div>

                  {/* Counterparty */}
                  <p className="text-sm text-gray-600 truncate">{c.counterpartyName ?? c.counterparty?.name ?? <span className="text-gray-300">—</span>}</p>

                  {/* Expiry */}
                  <p className="text-sm text-gray-500">
                    {c.expiryDate ? new Date(c.expiryDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : <span className="text-gray-300">—</span>}
                  </p>

                  {/* Risk */}
                  <div>
                    {c.riskScore != null ? (
                      <div className="flex items-center gap-1.5">
                        <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${c.riskScore >= 0.67 ? 'bg-red-400' : c.riskScore >= 0.34 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                            style={{ width: `${Math.round(c.riskScore * 100)}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500 w-7 text-right">{Math.round(c.riskScore * 100)}%</span>
                      </div>
                    ) : <span className="text-gray-300 text-xs">—</span>}
                  </div>

                  {/* Arrow */}
                  <ChevronRight className="h-4 w-4 text-gray-300 group-hover:text-gray-500 transition-colors" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showUpload && (
        <UploadModal onClose={() => setShowUpload(false)} onSuccess={() => setShowUpload(false)} />
      )}
      {showBulkImport && (
        <BulkImportDialog
          onClose={() => setShowBulkImport(false)}
          onSuccess={() => queryClient.invalidateQueries({ queryKey: ['contracts'] })}
        />
      )}
      {showNewContract && (
        <NewContractFlow
          onClose={() => setShowNewContract(false)}
          onCreated={(id) => { setShowNewContract(false); navigate(`/contracts/${id}`) }}
        />
      )}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function FacetGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">{title}</p>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function FacetItem({ label, count, active, onClick }: {
  label: string
  // U12 — count is optional now: SLA facets don't yet have aggregated
  // counts plumbed (the ES facet aggregator covers type/status/risk).
  // Render the row without a numeric badge when count is undefined.
  count?: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-xs transition-colors ${
        active ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      <span className="truncate">{label}</span>
      {count !== undefined && (
        <span className={`text-[10px] flex-shrink-0 ml-1 ${active ? 'text-blue-200' : 'text-gray-400'}`}>{count}</span>
      )}
    </button>
  )
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded-full text-xs font-medium">
      {label}
      <button onClick={onRemove} className="ml-0.5 hover:text-blue-900">
        <X className="h-3 w-3" />
      </button>
    </span>
  )
}
