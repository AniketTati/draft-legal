/**
 * UserPicker — type-ahead people-picker.
 *
 * JTBD: "Pick a teammate by name — not by UUID." Used for Delegate
 * (approvals), Assign (future), and wherever we route work to a
 * person in the org.
 *
 * Behaviour follows Linear / GitHub review-request / Gmail To:
 *   - Input shows placeholder "Search by name or email…"
 *   - Autocomplete dropdown below on focus / keystroke
 *   - Rows: avatar + bold name + email + role pill
 *   - ↑ ↓ to navigate, Enter to pick, Esc to close, mouse click to pick
 *   - When a user is selected, the input shows their name with an
 *     × affordance to clear and pick again
 *   - `excludeUserIds` lets callers hide people who can't receive
 *     the work (e.g. the current approver from the delegate list)
 *
 * B.6.11.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Check, X, User as UserIcon } from 'lucide-react'

export interface OrgUser {
  id: string
  name: string
  email: string
  roles?: string[]
}

interface Props {
  /** Currently-picked user id (controlled). */
  value: string
  /** Fires when the user picks or clears a selection. */
  onChange: (userId: string, user?: OrgUser) => void
  /** Placeholder text for the input. */
  placeholder?: string
  /** User ids to hide from the list (e.g. the current approver). */
  excludeUserIds?: string[]
  /** Stable id used for automation / a11y. */
  testId?: string
  /** Render a red ring when invalid. */
  invalid?: boolean
  /** Focus the input as soon as the component mounts. */
  autoFocus?: boolean
  /** Optional className for the outer container. */
  className?: string
}

// A role is a neutral fact about a person, not one of the five meanings — it is
// not in flight, not your turn, not binding. The per-role palette went with the
// migration: five colors in one row means none of them read.
const ROLE_PILL = 'rounded-chip px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-paper-100 text-ink-700'

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || 'U'
}

export function UserPicker({
  value,
  onChange,
  placeholder = 'Search by name or email…',
  excludeUserIds = [],
  testId,
  invalid,
  autoFocus,
  className,
}: Props) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const { data } = useQuery({
    queryKey: ['org-users'],
    queryFn: () => api.get('/users').then((r) => r.data),
    staleTime: 60_000,
  })
  const users: OrgUser[] = data?.data ?? data ?? []

  const selected = useMemo(
    () => users.find((u) => u.id === value),
    [users, value],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const pool = users.filter((u) => !excludeUserIds.includes(u.id))
    if (!q) return pool
    return pool.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q),
    )
  }, [users, excludeUserIds, query])

  // Close on outside click
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  useEffect(() => {
    if (autoFocus && inputRef.current && !selected) {
      inputRef.current.focus()
      setOpen(true)
    }
  }, [autoFocus, selected])

  // Reset highlight whenever the filter changes
  useEffect(() => { setHighlighted(0) }, [query])

  function pick(u: OrgUser) {
    onChange(u.id, u)
    setQuery('')
    setOpen(false)
  }

  function clear() {
    onChange('', undefined)
    setQuery('')
    setOpen(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted(i => Math.min(i + 1, filtered.length - 1)); setOpen(true); return }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setHighlighted(i => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter' && filtered[highlighted]) {
      e.preventDefault()
      pick(filtered[highlighted])
    }
  }

  // Render the input — differs when we have a selection vs. not
  return (
    <div ref={rootRef} className={cn('relative', className)}>
      {selected ? (
        <div
          data-testid={testId}
          className={cn(
            'flex items-center gap-2 rounded-md border px-2.5 py-1.5 bg-card',
            invalid ? 'border-risk-600 ring-1 ring-risk-200' : 'border-input',
          )}
        >
          <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-paper-100 ring-1 ring-paper-200 text-[10px] font-semibold text-ink-700">
            {initials(selected.name)}
          </div>
          <div className="flex-1 min-w-0 leading-tight">
            <p className="text-[13px] font-medium text-ink-950 truncate">{selected.name}</p>
            <p className="text-[11px] text-ink-500 truncate">{selected.email}</p>
          </div>
          <button
            type="button"
            onClick={clear}
            aria-label="Clear selected user"
            className="p-1 rounded-md hover:bg-paper-100 text-ink-400 hover:text-ink-700"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          data-testid={testId}
          className={cn(
            'w-full rounded-md border bg-card px-3 py-1.5 text-[13px] text-ink-950 placeholder:text-ink-400',
            'focus:outline-none focus:ring-1',
            invalid
              ? 'border-risk-600 focus:ring-risk-600'
              : 'border-input focus:ring-ring',
          )}
        />
      )}

      {open && !selected && (
        <div
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-72 overflow-auto rounded-md border border-paper-200 bg-card shadow-e2"
          role="listbox"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-2.5 text-dense text-ink-500">
              {users.length === 0 ? 'Loading teammates…' : 'No teammates match that search.'}
            </div>
          ) : (
            filtered.map((u, i) => {
              const primaryRole = u.roles?.[0]
              return (
                <button
                  key={u.id}
                  type="button"
                  role="option"
                  aria-selected={i === highlighted}
                  onMouseEnter={() => setHighlighted(i)}
                  onClick={() => pick(u)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors',
                    i === highlighted ? 'bg-paper-100' : 'hover:bg-paper-100',
                  )}
                >
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-paper-100 ring-1 ring-paper-200 text-[10px] font-semibold text-ink-700">
                    {initials(u.name)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-[13px] font-medium text-ink-950 truncate">{u.name}</p>
                      {primaryRole && (
                        <span className={ROLE_PILL}>
                          {primaryRole.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                    <p className="text-dense text-ink-500 truncate">{u.email}</p>
                  </div>
                  {i === highlighted && (
                    <Check className="size-4 text-ink-400 shrink-0" />
                  )}
                </button>
              )
            })
          )}
          <div className="border-t border-paper-200 px-3 py-1.5 text-[10px] text-ink-400 bg-paper-50 flex items-center gap-3">
            <span>↑ ↓ navigate</span>
            <span>↵ select</span>
            <span>esc close</span>
            <span className="ml-auto inline-flex items-center gap-1"><UserIcon className="size-3" /> {filtered.length} teammate{filtered.length === 1 ? '' : 's'}</span>
          </div>
        </div>
      )}
    </div>
  )
}
