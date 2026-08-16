/**
 * GlobalSearch — ⌘/ (or Ctrl-/) command palette for navigating to
 * contracts, counterparties, templates, clauses, and requests from
 * anywhere in the app.
 *
 * JTBD: "I need to find 'that Zynga NDA' fast — from anywhere. Not
 * just the Contracts list."
 *
 * Reference: Linear cmdk / Notion Quick Find / GitHub search. Keyboard-
 * first: type-ahead, arrow nav, Enter to go.
 *
 * Distinct from AiCommandPalette:
 *   - AiCommandPalette is on the detail page, scoped to the current
 *     contract, and ASKS (answers questions).
 *   - GlobalSearch is global, category-grouped, and NAVIGATES (takes
 *     you to an entity).
 *
 * Two different JTBDs → two different entry points. The header
 * exposes both ("Ask AI" + the search icon).
 *
 * B.6.25.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  Search, X, CornerDownLeft, ArrowUp, ArrowDown,
  FileText, Building2, Library, BookOpen, ClipboardList,
} from 'lucide-react'
import { Eyebrow } from '@/components/ui/primitives'

interface Hit {
  id: string
  title: string
  subtitle?: string
  kind: 'contract' | 'counterparty' | 'template' | 'clause' | 'request'
  to: string
}

const KIND_META: Record<Hit['kind'], { label: string; icon: typeof FileText }> = {
  contract:     { label: 'Contracts',     icon: FileText },
  counterparty: { label: 'Counterparties', icon: Building2 },
  template:     { label: 'Templates',      icon: Library },
  clause:       { label: 'Clause Library',  icon: BookOpen },
  request:      { label: 'Requests',       icon: ClipboardList },
}

function useDebounced<T>(value: T, delay = 200): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return v
}

export function GlobalSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query.trim(), 180)
  const [highlighted, setHighlighted] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setHighlighted(0)
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [open])

  // Parallel fetch from the existing list endpoints. Each of these
  // already respects org-scope + the caller's permissions.
  const { data: contracts = [] } = useQuery({
    queryKey: ['global-search', 'contract', debounced],
    queryFn: () =>
      api.get('/contracts', { params: { search: debounced, limit: 5 } })
        .then((r) => r.data?.data ?? []) as Promise<Array<{ id: string; title: string; counterpartyName?: string }>>,
    enabled: open && debounced.length > 0,
  })

  const { data: counterparties = [] } = useQuery({
    queryKey: ['global-search', 'counterparty', debounced],
    queryFn: () =>
      api.get('/counterparties', { params: { q: debounced, limit: 5 } })
        .then((r) => r.data?.data ?? []) as Promise<Array<{ id: string; name: string; contractCount?: number }>>,
    enabled: open && debounced.length > 0,
  })

  const { data: templates = [] } = useQuery({
    queryKey: ['global-search', 'template', debounced],
    queryFn: () =>
      api.get('/templates', { params: { q: debounced, limit: 5 } })
        .then((r) => r.data?.data ?? r.data ?? []) as Promise<Array<{ id: string; name: string; contractType?: string }>>,
    enabled: open && debounced.length > 0,
  })

  const { data: clauses = [] } = useQuery({
    queryKey: ['global-search', 'clause', debounced],
    queryFn: () =>
      api.get('/clauses', { params: { q: debounced, limit: 5 } })
        .then((r) => r.data?.data ?? []) as Promise<Array<{ id: string; title: string }>>,
    enabled: open && debounced.length > 0,
  })

  const { data: requests = [] } = useQuery({
    queryKey: ['global-search', 'request', debounced],
    queryFn: () =>
      api.get('/requests', { params: { search: debounced, limit: 5 } })
        .then((r) => r.data?.data ?? []) as Promise<Array<{ id: string; title: string; status?: string }>>,
    enabled: open && debounced.length > 0,
  })

  const hits: Hit[] = useMemo(() => {
    if (!debounced) return []
    return [
      ...contracts.map((c) => ({ id: c.id, title: c.title, subtitle: c.counterpartyName, kind: 'contract' as const, to: `/contracts/${c.id}` })),
      ...counterparties.map((c) => ({ id: c.id, title: c.name, subtitle: c.contractCount != null ? `${c.contractCount} contract${c.contractCount === 1 ? '' : 's'}` : undefined, kind: 'counterparty' as const, to: `/contracts?counterpartyId=${c.id}&filterLabel=${encodeURIComponent(c.name)}` })),
      ...templates.map((t) => ({ id: t.id, title: t.name, subtitle: t.contractType, kind: 'template' as const, to: '/templates' })),
      ...clauses.map((c) => ({ id: c.id, title: c.title, kind: 'clause' as const, to: '/clauses' })),
      ...requests.map((r) => ({ id: r.id, title: r.title, subtitle: r.status, kind: 'request' as const, to: '/requests' })),
    ]
  }, [debounced, contracts, counterparties, templates, clauses, requests])

  // Grouped for render but flat for keyboard nav
  const grouped = useMemo(() => {
    const map = new Map<Hit['kind'], Hit[]>()
    for (const h of hits) {
      const list = map.get(h.kind) ?? []
      list.push(h)
      map.set(h.kind, list)
    }
    return map
  }, [hits])

  function pick(h: Hit) {
    navigate(h.to)
    onClose()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted((i) => Math.min(i + 1, hits.length - 1)); return }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setHighlighted((i) => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter') {
      if (hits[highlighted]) {
        e.preventDefault()
        pick(hits[highlighted])
      }
    }
  }

  useEffect(() => { setHighlighted(0) }, [debounced])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-label="Search"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] bg-black/30 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl mx-4 bg-card rounded-card shadow-e3 overflow-hidden border border-paper-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-paper-200">
          <Search className="size-4 text-ink-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search contracts, counterparties, templates, clauses, requests…"
            data-testid="global-search-input"
            className="flex-1 outline-none text-[13px] text-ink-950 placeholder:text-ink-400 bg-transparent"
          />
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md hover:bg-paper-100 text-ink-400 hover:text-ink-700"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto">
          {!debounced ? (
            <p className="px-4 py-6 text-dense text-ink-500">
              Start typing to search across your workspace.
            </p>
          ) : hits.length === 0 ? (
            <p className="px-4 py-6 text-dense text-ink-500">
              No matches for <span className="font-medium text-ink-700">"{debounced}"</span>.
            </p>
          ) : (
            (Object.keys(KIND_META) as Hit['kind'][]).map((kind) => {
              const group = grouped.get(kind)
              if (!group?.length) return null
              const { label, icon: KindIcon } = KIND_META[kind]
              return (
                <div key={kind} className="py-1">
                  <Eyebrow className="px-4 py-1.5">{label}</Eyebrow>
                  {group.map((h) => {
                    const idx = hits.indexOf(h)
                    const isActive = idx === highlighted
                    return (
                      <button
                        key={h.id}
                        onMouseEnter={() => setHighlighted(idx)}
                        onClick={() => pick(h)}
                        data-testid={`global-search-hit-${h.kind}`}
                        className={cn(
                          'w-full flex items-center gap-3 px-4 py-2 text-left',
                          isActive ? 'bg-paper-100' : 'hover:bg-paper-100',
                        )}
                      >
                        <KindIcon className="size-4 text-ink-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-body text-ink-950 truncate">{h.title}</p>
                          {h.subtitle && (
                            <p className="text-[11px] text-ink-400 truncate">{h.subtitle}</p>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>

        <div className="flex items-center gap-4 px-4 py-2 border-t border-paper-200 text-[11px] text-ink-400 bg-paper-50">
          <span className="flex items-center gap-1"><CornerDownLeft className="size-3" /> Go</span>
          <span className="flex items-center gap-1"><ArrowUp className="size-3" /><ArrowDown className="size-3" /> Navigate</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  )
}
