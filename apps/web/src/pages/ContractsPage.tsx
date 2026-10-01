import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { formatRelativeTime } from '@/lib/utils'
import { MEANING_CLASS, statusMeta, type Meaning } from '@/lib/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusPill } from '@/components/ui/status-pill'
import { Chip, CountBadge, EmptyState, Eyebrow, RiskMeter } from '@/components/ui/primitives'
import { UploadModal } from '@/components/contracts/UploadModal'
import { ImportWizard } from '@/components/contracts/ImportWizard'
import { NewContractFlow } from '@/components/contracts/NewContractFlow'
import { useCanRequest } from '@/lib/permissions'
import { useFieldCatalog } from '@/lib/field-catalog'
import { AddFieldFilter, FieldFilterChip } from '@/components/contracts/FieldFilters'
import { ColumnPicker } from '@/components/contracts/ColumnPicker'
import { ViewsMenu, useSavedViews, type SavedView, type ViewQuery } from '@/components/contracts/ViewsMenu'
import { VERIFICATION_LABELS, decodeFieldFilters, encodeFieldFilters, type CatalogField, type ContractSort, type FieldFilter } from '@clm/types'
import { Upload, Search, FileText, ChevronRight, SlidersHorizontal, X, Loader2, PenSquare, RefreshCcw, ArrowUp, ArrowDown, Download, CircleCheck } from 'lucide-react'
import { toast } from '@/components/common/Toaster'

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

// The type dot used to carry a hue per contract type. Type is a category, not a
// meaning, and the system spends color only on meaning — so the dot is neutral
// and the type is read from the subtitle line right beside it.
const TYPE_DOT = 'bg-paper-300'

// One screenful of rows per request. The plain /contracts route pages by cursor,
// so "Load more" appends; the advanced-search route takes a size but has no
// cursor or offset, which is why the Elasticsearch path asks for the server
// maximum in one go and then says so rather than pretending to be complete.
const PAGE_SIZE = 50
const ES_MAX = 100

/**
 * The grid: the fixed columns, then one per chosen field (docs/39 D3). Inline
 * because the field columns vary; past a few the table scrolls sideways
 * rather than squeezing the title.
 */
function gridStyle(fieldColumns: number): React.CSSProperties {
  return {
    gridTemplateColumns: [
      fieldColumns ? 'minmax(240px,2fr)' : 'minmax(0,2fr)', '120px', '160px', '100px', '80px',
      ...Array.from({ length: fieldColumns }, () => 'minmax(130px,1fr)'), '36px',
    ].join(' '),
  }
}

// docs/39 D3 — the chosen field columns, remembered on this browser when the URL doesn't name them.
const COLUMNS_KEY = 'clm.contracts.columns'
function storedColumns(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(COLUMNS_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []
  } catch { return [] }
}

function sortFrom(raw: string | null): ContractSort | null {
  const [key, dir] = (raw ?? '').split(':')
  return key && (dir === 'asc' || dir === 'desc') ? { key, dir } : null
}

// ─── Expiry urgency ───────────────────────────────────────────────────────────

/**
 * Whole days from today to `iso` — negative once the date is past. Both sides
 * are floored to local midnight so "tomorrow" is 1 all day, not 0 in the morning
 * and 1 after lunch.
 */
function daysUntil(iso: string): number | null {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((new Date(t).setHours(0, 0, 0, 0) - today.getTime()) / 86_400_000)
}

/**
 * Expiry is the one date in the repository that carries exposure: an auto-renewal
 * window closing in five days read exactly like one closing in two years, so the
 * column ranked nothing. Thresholds and vocabulary match /renewals — inside 30
 * days is `risk` (the notice period is going or gone), 31–90 days is `turn` (the
 * renewal decision is now the user's to make), beyond that neutral.
 *
 * The relative figure is only rendered where it changes what the user does; on a
 * 240-row table "in 812d" would be noise on every calm row.
 *
 * A closed record is exempt. /renewals scopes its whole query to EXECUTED, so a
 * terminated agreement never reaches it — but the repository lists every status,
 * and three terminated contracts sit inside the 90-day window today. Colouring
 * their expiry claimed a renewal decision was outstanding on an agreement that
 * had already ended, beside a pill saying "Terminated". Same call the obligations
 * table makes for COMPLETED/WAIVED: nothing discharged can also be overdue.
 */
const EXPIRY_DISCHARGED = new Set(['TERMINATED', 'ARCHIVED'])

function expiryMeta(iso: string | null | undefined, status?: string | null): {
  dateText: string
  relative: string | null
  meaning: Meaning
} | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const dateText = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
  if (status && EXPIRY_DISCHARGED.has(status.toUpperCase())) {
    return { dateText, relative: null, meaning: 'neutral' }
  }
  const d = daysUntil(iso)
  if (d == null) return { dateText, relative: null, meaning: 'neutral' }
  if (d < 0)    return { dateText, relative: `${-d}d ago`, meaning: 'risk' }
  if (d === 0)  return { dateText, relative: 'today',      meaning: 'risk' }
  if (d <= 30)  return { dateText, relative: `in ${d}d`,   meaning: 'risk' }
  if (d <= 90)  return { dateText, relative: `in ${d}d`,   meaning: 'turn' }
  return { dateText, relative: null, meaning: 'neutral' }
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
  /** docs/39 A16 — the contracts one import made (?import=). */
  importBatch?: string
  // U12 audit (2026-04-29). Numeric SLA facets — encoded as preset
  // bands so the chip surface stays simple. The listQuery step
  // translates these into otdMax / uptimeSlaMin server params.
  // 'below_target'    → otdMax=95
  // 'meeting_target'  → otdMin=95
  otdBand?: 'below_target' | 'meeting_target'
  // 'three_nines'     → uptimeSlaMin=99.0
  // 'four_nines'      → uptimeSlaMin=99.99
  uptimeBand?: 'three_nines' | 'four_nines'
  // docs/39 B3 — how much of each contract a person checked.
  checked?: CheckedState
}

type CheckedState = 'verified' | 'partly' | 'unverified'
const CHECKED_STATES: CheckedState[] = ['verified', 'partly', 'unverified']

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
  // X75, Y3 — importing, uploading and drafting all create a contract, which
  // the server refuses without what POST /contracts needs; a viewer was
  // offered all three.
  const canCreate = useCanRequest('POST /contracts')
  const [showUpload, setShowUpload] = useState(false)
  const [showBulkImport, setShowBulkImport] = useState(false)
  // Z6 — Counterparties › New contract links here with new=1 and the
  // counterparty: open "Draft new" with it filled in, once.
  const [newFor] = useState(() => {
    const id = searchParams.get('counterpartyId')
    const name = searchParams.get('counterpartyName')
    return searchParams.get('new') === '1' && id && name ? { id, name } : undefined
  })
  const [showNewContract, setShowNewContract] = useState(() => searchParams.get('new') === '1')
  useEffect(() => {
    if (!searchParams.has('new')) return
    const next = new URLSearchParams(searchParams)
    next.delete('new')
    setSearchParams(next, { replace: true })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
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
    const checked = searchParams.get('checked') as CheckedState | null
    const importBatch = searchParams.get('import')
    if (importBatch && /^imp_[0-9a-f]{12}$/.test(importBatch)) f.importBatch = importBatch
    if (expiryDateTo) f.expiryDateTo = expiryDateTo
    if (type) f.type = type
    if (status) f.status = status
    if (riskBand) f.riskBand = riskBand
    if (counterpartyId) f.counterpartyId = counterpartyId
    if (checked && CHECKED_STATES.includes(checked)) f.checked = checked
    return f
  })

  // docs/39 A16 — "Open the imported contracts" links here while the list is open: the import's filter applies then too.
  const importParam = searchParams.get('import')
  useEffect(() => {
    if (importParam && /^imp_[0-9a-f]{12}$/.test(importParam) && importParam !== filters.importBatch) setFilters(f => ({ ...f, importBatch: importParam }))
  }, [importParam])

  // docs/39 D3 — field filters (?ff=), field columns (?cols=) and the sort (?sort=key:dir).
  const [fieldFilters, setFieldFilters] = useState<FieldFilter[]>(() => decodeFieldFilters(searchParams.get('ff')))
  const [columns, setColumns] = useState<string[]>(() => {
    const cols = searchParams.get('cols')
    return cols !== null ? cols.split(',').filter(Boolean) : storedColumns()
  })
  const [sort, setSort] = useState<ContractSort | null>(() => sortFrom(searchParams.get('sort')))
  const { data: catalog = [] } = useFieldCatalog()
  const fieldOf = (key: string): CatalogField | undefined => catalog.find(f => f.key === key)
  const changeColumns = (next: string[]) => {
    setColumns(next)
    try { window.localStorage.setItem(COLUMNS_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
  }
  // Sorting by a column: ascending, then descending, then back to newest first.
  const cycleSort = (key: string) => setSort(s => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null))

  // docs/39 D3 — a saved view (?view=). A link with the view alone opens it
  // once the views load; with the list's state beside it, that state stands
  // (the view shows as edited).
  const [viewId, setViewId] = useState<string | null>(() => searchParams.get('view'))
  const [pendingView, setPendingView] = useState(() => !!searchParams.get('view')
    && !['ff', 'cols', 'sort', 'type', 'status', 'riskBand', 'expiryDateTo', 'counterpartyId', 'checked', 'import'].some(k => searchParams.has(k)))
  const { data: savedViews } = useSavedViews()
  const openView = (view: SavedView | null) => {
    const q = view?.query
    setViewId(view?.id ?? null)
    setFilters((q?.filters ?? {}) as ActiveFilters)
    setFieldFilters(q?.fieldFilters ?? [])
    // "All contracts" goes back to the columns this browser keeps; a view brings its own.
    setColumns(q ? q.columns ?? [] : storedColumns())
    setSort(q?.sort ?? null)
    setSearch(q?.q ?? '')
    setDebouncedSearch(q?.q ?? '')
    const next = new URLSearchParams(searchParams)
    if (q?.filterLabel) next.set('filterLabel', q.filterLabel); else next.delete('filterLabel')
    if (view) next.set('view', view.id); else next.delete('view')
    setSearchParams(next, { replace: true })
  }
  useEffect(() => {
    if (!pendingView || !savedViews) return
    setPendingView(false)
    const view = savedViews.find(v => v.id === viewId)
    if (view) openView(view)
    else setViewId(null)
  }, [pendingView, savedViews])

  // The optional label carried in the URL overrides our default chip
  // text (so the dashboard can say "Expiring within 30 days" instead
  // of the raw ISO date). Only used for the expiry filter today.
  const filterLabelFromUrl = searchParams.get('filterLabel') ?? undefined

  // What a saved view would keep of the list as it is now.
  const currentView: ViewQuery = {
    filters: filters as Record<string, unknown>,
    ...(filterLabelFromUrl && { filterLabel: filterLabelFromUrl }),
    fieldFilters, columns, sort,
    ...(debouncedSearch && { q: debouncedSearch }),
  }

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
    syncKey('checked')
    if (filters.importBatch) next.set('import', filters.importBatch); else next.delete('import')
    // Drop the label when no chip-labelled filter is active
    if (!filters.expiryDateTo && !filters.counterpartyId) next.delete('filterLabel')
    // docs/39 D3 — so a filtered, sorted list with its columns can be linked to.
    if (fieldFilters.length) next.set('ff', encodeFieldFilters(fieldFilters)); else next.delete('ff')
    if (columns.length) next.set('cols', columns.join(',')); else next.delete('cols')
    if (sort) next.set('sort', `${sort.key}:${sort.dir}`); else next.delete('sort')
    if (viewId) next.set('view', viewId); else next.delete('view')
    // Only replace if something actually changed — avoids an extra
    // history entry when React re-renders without change.
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.expiryDateTo, filters.type, filters.status, filters.riskBand, filters.counterpartyId, filters.checked, filters.importBatch, fieldFilters, columns, sort, viewId])

  const activeFilterCount = Object.values(filters).filter(Boolean).length

  const { data: facetsData } = useQuery({
    queryKey: ['contract-facets'],
    queryFn: () => api.get('/search/facets').then(r => r.data),
    staleTime: 30_000,
  })

  /*
   * docs/39 D3 — the search index only nominates candidates: the words, the
   * clause flags and jurisdiction (with type and status to narrow them), up to
   * ES_MAX. Every filter is then applied from Postgres — which is also where
   * the SLA bands, the counterparty and the expiry window now hold on a
   * search (the index ignored or bent them) — along with the field filters,
   * the sort and the field columns.
   */
  const searchQuery = () => {
    const q: Record<string, unknown> = { limit: ES_MAX, mode: 'keyword' }
    if (debouncedSearch) q.q = debouncedSearch
    if (filters.type) q.type = filters.type
    if (filters.status) q.status = filters.status
    if (filters.jurisdiction) q.jurisdiction = filters.jurisdiction
    if (filters.clauseFlags && Object.keys(filters.clauseFlags).length) q.clauseFlags = filters.clauseFlags
    return q
  }

  const listQuery = () => {
    const q: Record<string, unknown> = {}
    if (filters.type) q.type = filters.type
    if (filters.status) q.status = filters.status
    if (filters.jurisdiction) q.jurisdiction = filters.jurisdiction
    // Risk bands are 0-100, matching how riskScore is actually stored and what
    // riskBand()/normalizeRisk() use. These were 0.67/0.34 against 0-100 data,
    // so "high risk" matched almost nothing and the filter silently under-
    // reported instead of failing.
    if (filters.riskBand === 'high') q.riskScoreMin = 67
    if (filters.riskBand === 'medium') { q.riskScoreMin = 34; q.riskScoreMax = 67 }
    if (filters.riskBand === 'low') q.riskScoreMax = 34
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
    if (filters.checked) q.checked = filters.checked
    if (filters.importBatch) q.importBatch = filters.importBatch
    if (fieldFilters.length) q.where = fieldFilters
    if (columns.length) q.columns = columns
    if (sort) q.sort = sort
    return q
  }

  const hasFilters = activeFilterCount > 0 || !!debouncedSearch || fieldFilters.length > 0

  // B.6.9 — Route choice.
  // Plain /contracts hits Postgres directly and is always correct for
  // structural filters; /search/advanced routes to Elasticsearch for
  // full-text + risk + clause-flag + jurisdiction queries. Use the
  // plain route whenever no ES-only filter is active — that way deep
  // links from Counterparties (counterpartyId) and Dashboard
  // (expiryDateTo, status) don't miss rows because of ES staleness.
  //
  // riskBand is deliberately NOT in this list, though it used to be. Risk is a
  // plain numeric column in Postgres, so routing it through the index bought
  // nothing and cost correctness: the index holds a subset of contracts, so
  // "high risk AND expiring within 90 days" returned zero rows — rendered as a
  // calm "no contracts match your filters" — while 60 contracts were expiring.
  // On a renewal screen a false all-clear is worse than no filter at all: it
  // converts an unanswered question into a wrong answer someone acts on. Same
  // reasoning the comment above already applies to counterparty and expiry.
  const needsEs =
    !!debouncedSearch ||
    !!filters.clauseFlags ||
    !!filters.jurisdiction

  const {
    data,
    isLoading,
    error: listError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['contracts', debouncedSearch, filters, needsEs, fieldFilters, columns, sort],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      if (needsEs) {
        const found = (await api.post('/search/advanced', searchQuery())).data
        const ids: string[] = (found?.data ?? []).map((c: { id: string }) => c.id)
        const page = (await api.post('/contracts/query', { ...listQuery(), ids, limit: ES_MAX })).data
        // One page: the index can't page past ES_MAX, and the footer says so.
        return { ...page, hasMore: false, highlights: found?.highlights ?? {}, searchTotal: found?.total ?? ids.length }
      }
      // Risk MUST be in the list query. It was moved off the Elasticsearch path
      // because that index holds a subset of contracts and made "high risk AND
      // expiring" answer zero; if the bounds are then omitted here, the filter
      // is silently ignored and the list returns EVERYTHING while the chip
      // still says "High risk" — a wrong answer that looks like a right one,
      // which is worse than the empty result it replaced.
      return (await api.post('/contracts/query', { ...listQuery(), offset: pageParam, limit: PAGE_SIZE })).data
    },
    // Paged by offset (a field sort has no stable cursor); the search route
    // answers in one page, so hasNextPage is false there and the footer says why.
    getNextPageParam: (last: any) => (last?.hasMore ? (last.offset ?? 0) + (last.data?.length ?? 0) : undefined),
    // A field filter the server refuses (a field since deleted) is said, not retried.
    retry: (n, err: any) => err?.response?.status !== 400 && n < 2,
    // Poll every 5s while any contract in the list is being analyzed
    refetchInterval: (q) => {
      const loaded = (q.state.data?.pages ?? []).flatMap((p: any) => p?.data ?? [])
      return loaded.some((c: any) => IN_PROGRESS_STATUSES.includes(c.analysisStatus)) ? 5000 : false
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

  const pages: any[] = data?.pages ?? []
  const contracts = pages.flatMap((p) => p?.data ?? [])
  // `total` is how many rows MATCH — not how many are on screen. Both numbers
  // are shown in the footer, because the gap between them is the whole finding:
  // ten of the sixty contracts inside the 90-day cliff used to be silently
  // unreachable, and nothing on the page admitted it.
  const total = pages[0]?.total ?? 0
  const facets = facetsData ?? {}
  // U3 — when ES returns highlights per row, surface "matched in
  // counterparty / summary / clause body" so a partial-match search
  // ("Iowa" → "Iora Health") feels confirmed instead of confusing.
  const highlights: Record<string, Record<string, string[]>> = Object.assign(
    {},
    ...pages.map((p) => p?.highlights ?? {}),
  )
  // The search route caps at ES_MAX and cannot page past it. Say so rather than
  // letting the last row imply the list ended.
  //
  // Gated on needsEs because the message names search as the cause. The
  // Postgres route pages to completion, so any shortfall there is a bug in
  // paging, not a cap the user can narrow their way out of — and telling
  // someone to "narrow the filters" when they have no search active sends them
  // after a problem that isn't theirs. Seen live: a cursor that lost a row to a
  // createdAt tie printed "Search shows the first 374 matches" on an unfiltered
  // repository.
  //
  // docs/39 D3 — the index nominates at most ES_MAX candidates, which the
  // other filters then narrow, so the cap is the index's total, not the list's.
  const searchTotal: number = pages[0]?.searchTotal ?? 0
  const truncated = needsEs && searchTotal > ES_MAX
  const fieldColumns = columns.map(fieldOf).filter((f): f is CatalogField => !!f)
  const grid = gridStyle(fieldColumns.length)
  const listRefused: string | null = (listError as any)?.response?.status === 400 ? (listError as any).response.data?.detail ?? 'A filter is no longer valid.' : null

  // docs/39 D3 — the list as it stands (every matching contract, not just the
  // loaded rows) with its columns, as a spreadsheet. A search's matches are
  // the ones on screen: the index nominated them.
  const canExport = useCanRequest('POST /contracts/query/export')
  const [exporting, setExporting] = useState(false)
  const exportList = async () => {
    setExporting(true)
    try {
      const body = { ...listQuery(), ...(needsEs && { ids: contracts.map((c: { id: string }) => c.id) }) }
      const res = await api.post('/contracts/query/export', body, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `contracts-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
      const matched = Number(res.headers['x-total-count'] ?? 0)
      const exported = Number(res.headers['x-exported-count'] ?? 0)
      if (exported < matched) toast.info(`Exported the first ${exported.toLocaleString()} of ${matched.toLocaleString()} contracts`, { description: 'Narrow the filters to export the rest.' })
      else toast.success(`Exported ${exported.toLocaleString()} contract${exported === 1 ? '' : 's'}`)
    } catch {
      toast.error("Couldn't export the list", { description: 'Try again.' })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="h-full flex flex-col bg-paper-50">
      {/* Header */}
      <div className="bg-card border-b border-paper-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-title text-ink-950">Contract Repository</h1>
            <div className="mt-1 flex items-center gap-2">
              {/* docs/39 D3 — saved views of this list. */}
              <ViewsMenu current={currentView} activeId={viewId} onOpen={openView} />
              <span className="text-dense text-ink-500 tabular-nums">· {total} contract{total !== 1 ? 's' : ''}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowFacets(!showFacets)}
              className={`gap-1.5 ${activeFilterCount > 0 ? 'border-ink-950 text-ink-950' : ''}`}
            >
              <SlidersHorizontal className="size-4" />
              Filters
              {activeFilterCount > 0 && (
                // Not a "your turn" count — it just reports how many facets are
                // on, so it stays ink rather than attention.
                <CountBadge tone="ink" className="h-4 min-w-4 px-1 text-[10px]">
                  {activeFilterCount}
                </CountBadge>
              )}
            </Button>
            <ColumnPicker catalog={catalog} columns={columns} onChange={changeColumns} />
            {canExport && (
              <Button variant="outline" size="sm" className="gap-1.5" disabled={exporting || total === 0} onClick={exportList}
                title="Download this list, as filtered and sorted, with its columns" data-testid="export-contracts">
                {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Export
              </Button>
            )}
            {canCreate && (
              <>
                <Button
                  variant="outline"
                  onClick={() => setShowBulkImport(true)}
                  data-testid="bulk-import-button"
                  title="Import contracts from a spreadsheet, with their documents"
                  className="gap-2"
                >
                  <Upload className="size-4" /> Import
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowUpload(true)}
                  data-testid="upload-pdf-button"
                  title="Upload an existing signed or draft contract file"
                  className="gap-2"
                >
                  <Upload className="size-4" /> Upload PDF
                </Button>
                <Button
                  onClick={() => setShowNewContract(true)}
                  data-testid="draft-new-button"
                  title="Start a new contract from a template"
                  className="gap-2"
                >
                  <PenSquare className="size-4" /> Draft new
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Search bar */}
      <div className="bg-card border-b border-paper-200 px-6 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="relative flex-1 max-w-lg">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-ink-400" />
            <Input
              value={search}
              onChange={e => handleSearch(e.target.value)}
              placeholder="Search by title, counterparty, or content…"
              className="pl-9 bg-paper-50 border-paper-200"
            />
          </div>
          {hasFilters && (
            <button
              onClick={() => { setFilters({}); setFieldFilters([]); setSearch(''); setDebouncedSearch('') }}
              className="flex items-center gap-1 text-[11.5px] text-ink-400 hover:text-ink-700"
            >
              <X className="size-3.5" /> Clear all
            </button>
          )}
          {/* Active filter chips */}
          {filters.type && (
            <FilterChip label={filters.type.replace(/_/g, ' ')} onRemove={() => setFilters(f => ({ ...f, type: undefined }))} />
          )}
          {filters.status && (
            // One vocabulary: the chip must say what the pill on the row says.
            // It used to read "PENDING APPROVAL" next to a pill saying
            // "Awaiting approval" — the same state, named twice.
            <FilterChip label={statusMeta(filters.status).label} onRemove={() => setFilters(f => ({ ...f, status: undefined }))} />
          )}
          {filters.riskBand && (
            <FilterChip label={`${filters.riskBand} risk`} onRemove={() => setFilters(f => ({ ...f, riskBand: undefined }))} />
          )}
          {filters.checked && (
            <FilterChip label={VERIFICATION_LABELS[filters.checked]} onRemove={() => setFilters(f => ({ ...f, checked: undefined }))} />
          )}
          {filters.importBatch && (
            <FilterChip label="From an import" onRemove={() => setFilters(f => ({ ...f, importBatch: undefined }))} />
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
          {/* docs/39 D3 — any captured field, in its own terms. */}
          {fieldFilters.map((ff, i) => (
            <FieldFilterChip
              key={`${ff.key}-${i}`}
              field={fieldOf(ff.key)}
              filter={ff}
              onChange={next => setFieldFilters(all => all.map((x, j) => (j === i ? next : x)))}
              onRemove={() => setFieldFilters(all => all.filter((_, j) => j !== i))}
            />
          ))}
          {catalog.length > 0 && <AddFieldFilter catalog={catalog} onAdd={f => setFieldFilters(all => [...all, f])} />}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Facets sidebar */}
        {showFacets && (
          <aside className="w-facets border-r border-paper-200 bg-card overflow-y-auto flex-shrink-0 p-4 space-y-5">
            <FacetGroup title="Type">
              {(facets.types ?? []).map((b: any) => (
                <FacetItem key={b.key} label={b.key.replace(/_/g, ' ')} count={b.doc_count}
                  active={filters.type === b.key}
                  onClick={() => setFilters(f => ({ ...f, type: f.type === b.key ? undefined : b.key }))} />
              ))}
            </FacetGroup>
            <FacetGroup title="Status">
              {(facets.statuses ?? []).map((b: any) => (
                <FacetItem key={b.key} label={statusMeta(b.key).label} count={b.doc_count}
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
            {/* No counts on the risk bands. Every other facet here is both
                counted AND filtered by Elasticsearch, so its badge matches
                what clicking it returns. Risk is the exception: the filter
                was deliberately moved to Postgres (see listQuery) because
                the index holds a subset, but these doc_counts are still
                aggregated over that same partial index — so the badges read
                "Low 12 / Medium 6 / High 1" while the filters actually
                return 176 / 61 / 28. A count that disagrees with its own
                filter by an order of magnitude is the "wrong answer wearing
                the costume of a right one" this page was fixed to stop
                telling. Until the counts come from the same source as the
                rows, the band label alone is the honest control. */}
            <FacetGroup title="Risk">
              {(facets.riskRanges ?? []).map((b: any) => (
                <FacetItem key={b.key} label={b.key.charAt(0).toUpperCase() + b.key.slice(1)}
                  active={filters.riskBand === b.key}
                  onClick={() => setFilters(f => ({ ...f, riskBand: f.riskBand === b.key ? undefined : b.key as any }))} />
              ))}
            </FacetGroup>
            {/* docs/39 B3 — what a person set or checked, counted from Postgres like the rows. */}
            <FacetGroup title="Checked by a person">
              {CHECKED_STATES.map(state => (
                <FacetItem key={state} label={VERIFICATION_LABELS[state]}
                  active={filters.checked === state}
                  onClick={() => setFilters(f => ({ ...f, checked: f.checked === state ? undefined : state }))} />
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
            <div className="flex items-center justify-center h-64 gap-2 text-ink-400">
              <div className="size-5 border-2 border-paper-300 border-t-ink-950 rounded-full animate-spin" />
              <span className="text-body">Loading contracts…</span>
            </div>
          ) : contracts.length === 0 ? (
            <div className="flex items-center justify-center h-64 px-6">
              <EmptyState
                className="w-full max-w-md"
                icon={<FileText />}
                title={listRefused ? 'One of the filters can’t be used' : hasFilters ? 'No contracts match your filters' : 'No contracts yet'}
                description={listRefused ? `${listRefused}. Remove or change it above.` : hasFilters ? 'Try adjusting or clearing your filters'
                  : canCreate ? 'Upload your first contract to get started'
                  : 'Contracts appear here once your team adds them'}
                action={!hasFilters && canCreate ? (
                  <Button onClick={() => setShowUpload(true)} className="gap-2">
                    <Upload className="size-4" /> Upload Contract
                  </Button>
                ) : undefined}
              />
            </div>
          ) : (
            /*
             * The grid is a real table to anything that reads the page, via ARIA
             * rather than <table>: the column widths are a CSS grid and putting
             * one back on table layout would change the visual result. Before
             * this, a screen-reader user got 240 rows of values with no column
             * association at all — "Acme Corp, Executed, 96" with nothing saying
             * which was which. aria-rowcount is the MATCHING count, not the
             * loaded one, so the announcement agrees with the footer.
             */
            <div className="bg-card" style={fieldColumns.length ? { minWidth: 800 + fieldColumns.length * 146 } : undefined}>
              <div
                role="table"
                aria-label="Contracts"
                aria-rowcount={total ? total + 1 : undefined}
              >
                {/* `sticky` has to sit on the ROWGROUP, not the header row: a
                    sticky box is bounded by its own parent, so with the class on
                    the row it would only stick within a wrapper the height of one
                    row — i.e. scroll away instantly. The rowgroup spans the whole
                    table, which is what the header used to have before the ARIA
                    wrappers went in. */}
                <div role="rowgroup" className="sticky top-0 z-10">
                  {/* Table header — docs/39 D3: each column sorts, field columns included. */}
                  <div
                    role="row"
                    aria-rowindex={1}
                    style={grid}
                    className="grid gap-4 px-6 py-2 border-b border-paper-200 bg-paper-50"
                  >
                    <SortHeader label="Contract" sortKey="title" sort={sort} onSort={cycleSort} />
                    <SortHeader label="Status" sortKey="status" sort={sort} onSort={cycleSort} />
                    <SortHeader label="Counterparty" sortKey="counterpartyName" sort={sort} onSort={cycleSort} />
                    <SortHeader label="Expires" sortKey="expiryDate" sort={sort} onSort={cycleSort} />
                    <SortHeader label="Risk" sortKey="riskScore" sort={sort} onSort={cycleSort} />
                    {fieldColumns.map(f => (
                      <SortHeader key={f.key} label={f.label} sortKey={f.key} sort={sort} onSort={cycleSort} title={f.definition ?? undefined} />
                    ))}
                    {/* The chevron column is decorative, but a header cell with no
                        name leaves the row a cell short of the others. */}
                    <span role="columnheader"><span className="sr-only">Open</span></span>
                  </div>
                </div>

                {/* Rows */}
                <div role="rowgroup">
                  {contracts.map((c: any, i: number) => (
                  // P48 a11y — remove role="button" + tabIndex on the wrapper
                  // so nested <button>s (Retry, kebab, etc.) don't trip axe's
                  // `nested-interactive`. Keyboard a11y is preserved by the
                  // <Link> on the title cell below; mouse users still get the
                  // full-row click target via onClick.
                  <div
                    key={c.id}
                    role="row"
                    aria-rowindex={i + 2}
                    data-testid={`contract-row-${c.id}`}
                    data-contract-title={c.title}
                    onClick={(e) => {
                      // Don't double-navigate when the click started on the
                      // <Link> or a button inside the row.
                      if ((e.target as HTMLElement).closest('a, button')) return
                      navigate(`/contracts/${c.id}`)
                    }}
                    style={grid}
                    className="grid gap-4 items-center px-6 py-2 border-b border-paper-100 hover:bg-paper-50 cursor-pointer transition-colors group"
                  >
                    {/* Title + type */}
                    <div role="cell" className="min-w-0 flex items-center gap-3">
                      <div className={`size-2 rounded-full flex-shrink-0 ${TYPE_DOT}`} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/contracts/${c.id}`}
                            className="text-[13px] font-medium text-ink-950 truncate hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {displayTitle(c)}
                          </Link>
                          {IN_PROGRESS_STATUSES.includes(c.analysisStatus) && (
                            // Machine work in flight — the system's turn, not the
                            // user's, so info rather than attention.
                            <span className="flex items-center gap-1 text-[10px] font-medium text-info-700 bg-info-100 border border-info-200 rounded-full px-1.5 py-0.5 flex-shrink-0">
                              <Loader2 className="size-2.5 animate-spin" />
                              {PHASE_LABEL[c.analysisStatus] ?? 'Processing'}
                            </span>
                          )}
                          {c.analysisStatus === 'FAILED' && (
                            <span className="flex items-center gap-1 flex-shrink-0">
                              {/* The row-level wash exception: a document that did
                                  not get processed is real risk, not a note. */}
                              <StatusPill status="FAILED" tone="wash" className="py-0 pl-1.5 pr-2 text-[10px] font-medium" />
                              {/* B.6.17 — inline retry; don't make the user open the row */}
                              <button
                                type="button"
                                data-testid={`retry-${c.id}`}
                                disabled={retry.isPending && retryingId === c.id}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  retry.mutate(c.id)
                                }}
                                className="inline-flex items-center gap-1 rounded-full border border-risk-200 bg-card px-1.5 py-0.5 text-[10px] font-medium text-risk-700 hover:bg-risk-50 transition-colors disabled:opacity-60"
                                title="Re-run analysis"
                              >
                                {retry.isPending && retryingId === c.id
                                  ? <Loader2 className="size-2.5 animate-spin" />
                                  : <RefreshCcw className="size-2.5" />}
                                Retry
                              </button>
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-ink-400 mt-0.5">
                          {c.type.replace(/_/g, ' ')} ·{' '}
                          <span title={new Date(c.createdAt).toLocaleString()}>{formatRelativeTime(c.createdAt)}</span>
                          {/* docs/39 B3 — how much of it a person checked (nothing said: none of it). */}
                          {c.verification?.state === 'verified' && (
                            <span className="text-brand-700 font-medium" data-testid={`contract-checked-${c.id}`} title={`All ${c.verification.filled} values set or checked by a person`}>
                              {' '}· <CircleCheck className="inline size-2.5 -mt-px" /> Verified
                            </span>
                          )}
                          {c.verification?.state === 'partly' && (
                            <span className="tabular-nums" data-testid={`contract-checked-${c.id}`} title="Values set or checked by a person">
                              {' '}· {c.verification.checked} of {c.verification.filled} checked
                            </span>
                          )}
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
                            // Nothing is blocked on the user here — it just says
                            // which field matched — so this drops amber for neutral.
                            <p
                              className="text-[10.5px] text-ink-700 bg-paper-100 border border-paper-200 rounded-chip px-1.5 py-0.5 mt-1 inline-block"
                              data-testid={`match-${c.id}`}
                              title={plain}
                            >
                              <span className="font-medium">Matched in {matchedField}:</span>{' '}
                              <span className="text-ink-500">{plain.length > 60 ? plain.slice(0, 60) + '…' : plain}</span>
                            </p>
                          )
                        })()}
                      </div>
                    </div>

                    {/* Status */}
                    <div role="cell">
                      <StatusPill status={c.status} />
                    </div>

                    {/* Counterparty */}
                    <p role="cell" className="text-[12.5px] text-ink-700 truncate">{c.counterpartyName ?? c.counterparty?.name ?? <span className="text-ink-400">—</span>}</p>

                    {/* Expiry — the date carries its own urgency; see expiryMeta. */}
                    {(() => {
                      const e = expiryMeta(c.expiryDate, c.status)
                      if (!e) return <p role="cell" className="text-[12.5px] text-ink-400 tabular-nums">—</p>
                      return (
                        <p role="cell" className="text-[12.5px] tabular-nums">
                          <span className={`${MEANING_CLASS[e.meaning].fg}${e.meaning === 'risk' ? ' font-medium' : ''}`}>
                            {e.dateText}
                          </span>
                          {e.relative && (
                            <span className={`block text-[10.5px] ${MEANING_CLASS[e.meaning].fg}`}>{e.relative}</span>
                          )}
                        </p>
                      )
                    })()}

                    {/* Risk */}
                    <div role="cell">
                      {c.riskScore != null ? (
                        <RiskMeter score={c.riskScore} />
                      ) : <span className="text-ink-400 text-[12.5px]">—</span>}
                    </div>

                    {/* docs/39 D3 — the chosen fields. */}
                    {fieldColumns.map(f => <FieldCellView key={f.key} cell={c.fields?.[f.key]} />)}

                    {/* Arrow */}
                    <div role="cell">
                      <ChevronRight aria-hidden="true" className="size-4 text-paper-300 group-hover:text-ink-400 transition-colors" />
                    </div>
                  </div>
                  ))}
                </div>
              </div>

              {/* Counts + paging. The list used to stop dead at 50 rows with
                  nothing saying so, which on a renewals cliff reads as "that is
                  all of them". */}
              <div
                data-testid="contracts-pagination"
                className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-t border-paper-200 px-6 py-3"
              >
                <p className="text-dense text-ink-500 tabular-nums" aria-live="polite">
                  Showing {contracts.length} of {total} {total === 1 ? 'contract' : 'contracts'}
                </p>
                {hasNextPage && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchNextPage()}
                    disabled={isFetchingNextPage}
                    data-testid="load-more-contracts"
                  >
                    {isFetchingNextPage
                      ? <><Loader2 className="animate-spin" /> Loading…</>
                      : <>Load {Math.min(PAGE_SIZE, Math.max(total - contracts.length, 0)) || PAGE_SIZE} more</>}
                  </Button>
                )}
                {truncated && (
                  // Not decoration: an incomplete answer on the screen legal ops
                  // triages from is the user's problem to resolve, so it takes
                  // the "your turn" tone and says what to do about it.
                  <span className="text-dense text-attention-700">
                    Search looked at the first {ES_MAX} of {searchTotal} matches — narrow the search to see the rest.
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {showUpload && (
        <UploadModal onClose={() => setShowUpload(false)} onSuccess={() => setShowUpload(false)} />
      )}
      {showBulkImport && (
        <ImportWizard
          onClose={() => setShowBulkImport(false)}
          onImported={() => queryClient.invalidateQueries({ queryKey: ['contracts'] })}
        />
      )}
      {showNewContract && canCreate && (
        <NewContractFlow
          initialCounterparty={newFor}
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
      <Eyebrow className="mb-1.5">{title}</Eyebrow>
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
      className={`w-full flex items-center justify-between px-2 py-1.5 rounded-md text-dense transition-colors ${
        active ? 'bg-ink-950 text-white' : 'text-ink-700 hover:bg-paper-100'
      }`}
    >
      <span className="truncate">{label}</span>
      {count !== undefined && (
        <span className={`text-[10px] tabular-nums flex-shrink-0 ml-1 ${active ? 'text-white/60' : 'text-ink-400'}`}>{count}</span>
      )}
    </button>
  )
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return <Chip onRemove={onRemove}>{label}</Chip>
}

/** A column header that sorts: ascending, descending, then back to newest first (docs/39 D3). */
function SortHeader({ label, sortKey, sort, onSort, title }: {
  label: string
  sortKey: string
  sort: ContractSort | null
  onSort: (key: string) => void
  title?: string
}) {
  const dir = sort?.key === sortKey ? sort.dir : null
  return (
    <span role="columnheader" aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'} className="min-w-0">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={title ?? `Sort by ${label.toLowerCase()}`}
        className={`inline-flex max-w-full items-center gap-1 text-[10px] font-bold uppercase tracking-[0.09em] hover:text-ink-950 ${dir ? 'text-ink-950' : 'text-ink-400'}`}
        data-testid={`sort-${sortKey}`}
      >
        <span className="truncate">{label}</span>
        {dir === 'asc' && <ArrowUp className="size-3 shrink-0" aria-hidden="true" />}
        {dir === 'desc' && <ArrowDown className="size-3 shrink-0" aria-hidden="true" />}
      </button>
    </span>
  )
}

interface FieldCell { value: unknown; display: string; source: string | null; verified: boolean; confidence: number | null }

/**
 * One field's value in the list. A reading the AI wasn't sure of, and nobody
 * has checked, is marked so a sorted column doesn't pass it off as settled.
 */
function FieldCellView({ cell }: { cell: FieldCell | undefined }) {
  if (!cell?.display) return <p role="cell" className="text-[12.5px] text-ink-400">—</p>
  const unsure = cell.source === 'ai' && !cell.verified && cell.confidence != null && cell.confidence < 0.7
  return (
    <p
      role="cell"
      className={`text-[12.5px] text-ink-950 truncate tabular-nums ${unsure ? 'underline decoration-dotted decoration-attention-500 underline-offset-2' : ''}`}
      title={unsure ? `${cell.display} — the AI read this but isn’t sure (${Math.round((cell.confidence ?? 0) * 100)}%); nobody has checked it yet` : cell.display}
    >
      {cell.display}
    </p>
  )
}
