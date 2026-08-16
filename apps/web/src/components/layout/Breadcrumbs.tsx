/**
 * Breadcrumbs — auto-derived from the current URL. Rendered inside
 * AppShell above the <Outlet> so every page has a consistent way
 * "up the hierarchy" (distinct from browser-history back).
 *
 * JTBD: "Where am I, and what's my parent?"
 *
 * Reference: Notion / GitHub / Jira — text segments separated by "/"
 * or "›", every segment clickable except the last.
 *
 * We intentionally hide the breadcrumb on pages where it'd be
 * redundant (root list pages like /contracts itself — breadcrumb
 * would just read "Contracts" which the H1 already says) or wrong
 * (Auth pages, portals).
 *
 * B.6.26.
 */
import { Link, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { ChevronRight } from 'lucide-react'

interface Crumb {
  label: string
  to?: string
}

const PRIMARY_LABELS: Record<string, string> = {
  dashboard:        'Dashboard',
  contracts:        'Contracts',
  requests:         'Requests',
  counterparties:   'Counterparties',
  templates:        'Templates',
  clauses:          'Clause Library',
  playbook:         'Playbook',
  approvals:        'Approvals',
  // U.8 — URL stays /review-queue (back-compat) but the human label is
  // "Extraction Queue" so users don't conflate it with contract review.
  'review-queue':   'Extraction Queue',
  settings:         'Settings',
  profile:          'Profile',
  team:             'Team',
  admin:            'Admin',
  users:            'Users',
  roles:            'Roles',
  org:              'Organization',
}

function prettyLabel(seg: string) {
  return PRIMARY_LABELS[seg] ?? seg.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function Breadcrumbs() {
  // FIX (2026-04-30 audit): all hooks MUST be called before any early
  // return. The previous order (early `return null` then `useQuery`) was
  // a Rules-of-Hooks violation — when the path matched the hide list
  // (e.g. /login), React saw 1 hook on that render and 4 hooks on the
  // next render, triggering "change in the order of Hooks" + "Internal
  // React error: Expected static flag was missing" warnings. Moving the
  // useQuery calls above the early returns keeps the hook count stable.
  const { pathname } = useLocation()
  const segments = pathname.split('/').filter(Boolean)

  // Pre-fetch contract title when we're on /contracts/:id so the
  // breadcrumb reads "Contracts › WPT Enterprises — Zynga Agreement"
  // instead of "Contracts › cmn…". `enabled` is derived from segments
  // so the query no-ops when we're not on a relevant route.
  const contractId = segments[0] === 'contracts' && segments[1] ? segments[1] : null
  const { data: contract } = useQuery<{ title?: string }>({
    queryKey: ['contract-title', contractId],
    queryFn: () => api.get(`/contracts/${contractId}`).then((r) => r.data),
    enabled: Boolean(contractId),
    staleTime: 60_000,
  })

  const counterpartyId = segments[0] === 'counterparties' && segments[1] ? segments[1] : null
  const { data: counterparty } = useQuery<{ name?: string }>({
    queryKey: ['cp-name', counterpartyId],
    queryFn: () => api.get(`/counterparties/${counterpartyId}`).then((r) => r.data),
    enabled: Boolean(counterpartyId),
    staleTime: 60_000,
  })

  const matterId = segments[0] === 'matters' && segments[1] ? segments[1] : null
  const { data: matter } = useQuery<{ name?: string }>({
    queryKey: ['matter-name', matterId],
    queryFn: () => api.get(`/matters/${matterId}`).then((r) => r.data),
    enabled: Boolean(matterId),
    staleTime: 60_000,
  })

  // Hide on paths where breadcrumb adds nothing or isn't wanted.
  // These early-returns are SAFE here because they come AFTER all hooks.
  if (segments.length === 0) return null
  if (segments.length === 1 && PRIMARY_LABELS[segments[0]]) return null
  if (segments[0] === 'sign' || segments[0] === 'portal' || segments[0] === 'login' || segments[0] === 'register' || segments[0] === 'accept-invite') return null

  // Build crumbs
  const crumbs: Crumb[] = []
  // Root
  const root = segments[0]
  if (PRIMARY_LABELS[root]) {
    crumbs.push({ label: PRIMARY_LABELS[root], to: `/${root}` })
  } else {
    crumbs.push({ label: prettyLabel(root), to: `/${root}` })
  }

  // Second segment — if it's a resource id (contracts/:id) use the
  // fetched title; otherwise prettify.
  if (segments.length > 1) {
    const sub = segments[1]
    if (root === 'contracts' && contract?.title) {
      crumbs.push({ label: contract.title })
    } else if (root === 'counterparties' && counterparty?.name) {
      crumbs.push({ label: counterparty.name })
    } else if (root === 'matters' && matter?.name) {
      crumbs.push({ label: matter.name })
    } else if (root === 'admin') {
      // admin/<sub> like admin/users → "Users"
      crumbs.push({ label: prettyLabel(sub), to: `/${root}/${sub}` })
    } else {
      crumbs.push({ label: prettyLabel(sub) })
    }
  }

  // The last crumb is the current page → non-clickable
  return (
    <nav
      aria-label="Breadcrumb"
      data-testid="breadcrumbs"
      className="flex items-center gap-1 px-6 py-2 text-dense text-ink-500 border-b border-paper-200 bg-paper-50"
    >
      {crumbs.map((c, i) => {
        const isLast = i === crumbs.length - 1
        return (
          <div key={i} className="flex items-center gap-1 min-w-0">
            {i > 0 && <ChevronRight className="size-3 text-ink-400 shrink-0" />}
            {c.to && !isLast ? (
              <Link to={c.to} className="hover:text-ink-950 transition-colors truncate">
                {c.label}
              </Link>
            ) : (
              <span
                className={`truncate ${isLast ? 'text-ink-950 font-medium' : ''}`}
                aria-current={isLast ? 'page' : undefined}
              >
                {c.label}
              </span>
            )}
          </div>
        )
      })}
    </nav>
  )
}
