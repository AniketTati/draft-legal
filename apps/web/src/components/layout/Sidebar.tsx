import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { Wordmark } from '@/components/brand/Wordmark'
import {
  LayoutDashboard,
  FileText,
  ClipboardList,
  Library,
  BookOpen,
  Shield,
  CheckSquare,
  Building2,
  Settings,
  Users,
  UsersRound,
  ShieldCheck,
  Sparkles,
  Briefcase,
  PenSquare,
  ListTodo,
  CalendarDays,
  Receipt,
  BarChart2,
  FolderOpen,
  Plug,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'
import { usePermission } from '@/lib/permissions'
import { CountBadge } from '@/components/ui/primitives'
import type { LucideIcon } from 'lucide-react'

// ─── Nav structure ─────────────────────────────────────────────────────────────

interface NavSection {
  label?: string
  items: Array<{
    to: string
    icon: LucideIcon
    label: string
    // P7.4.9 / F-14 — explicit `staticBadge` keeps "Soon" UX-only
    // (no API hit). Use `badge` for runtime counts as before.
    badge?: 'pendingApprovals' | 'openRequests'
    staticBadge?: 'soon'
  }>
}

// IA principle: each section answers a single user question.
//   • (top, no label) — "Where do I start?"
//   • Workspace        — "What am I working ON?"  (the nouns)
//   • Queues           — "What needs my action right now?"
//   • Post-signature   — "What happens AFTER signing?"
//   • Library          — "What reusable assets do I reference?"
//   • Insights         — "How is the portfolio performing?"
//
// Extraction Queue (/review-queue) was demoted out of the sidebar —
// it's an internal AI-confidence-review tool with low daily-use
// frequency. Surfaced contextually via Contracts list badges instead.
// Route still exists; bookmarks + deep links unaffected.
const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
      // P7.3.2 — Genspark-style full-screen agent surface. Lives at
      // the top of the nav alongside Dashboard so the user can pick:
      // operational view (queues, KPIs) vs conversational view (chat).
      { to: '/agent',     icon: Sparkles,        label: 'Assistant' },
    ],
  },
  {
    // The work objects — the nouns the user manipulates daily.
    label: 'Workspace',
    items: [
      { to: '/matters',        icon: Briefcase,     label: 'Matters' },
      { to: '/contracts',      icon: FileText,      label: 'Contracts' },
      { to: '/requests',       icon: ClipboardList,  label: 'Requests', badge: 'openRequests' },
      { to: '/counterparties', icon: Building2,      label: 'Counterparties' },
    ],
  },
  {
    // Things needing user action — both have queues that drain to zero.
    label: 'Queues',
    items: [
      { to: '/approvals',    icon: CheckSquare, label: 'Approvals', badge: 'pendingApprovals' },
      // Phase 07 — Signatures promoted once the eSignature flow shipped.
      { to: '/signatures',   icon: PenSquare,   label: 'Signatures' },
    ],
  },
  {
    // Phase 08 — what we track on EXECUTED contracts.
    label: 'Post-signature',
    items: [
      { to: '/obligations',  icon: ListTodo,     label: 'Obligations' },
      { to: '/renewals',     icon: CalendarDays, label: 'Renewals' },
      { to: '/invoices',     icon: Receipt,      label: 'Invoices' },
    ],
  },
  {
    // Reusable drafting assets — the lawyer's reference shelf.
    label: 'Library',
    items: [
      { to: '/templates',    icon: Library,  label: 'Templates' },
      { to: '/clauses',      icon: BookOpen, label: 'Clauses' },
      { to: '/playbook',     icon: Shield,   label: 'Playbook' },
    ],
  },
  {
    // Phase 09 — cross-portfolio analysis.
    label: 'Insights',
    items: [
      { to: '/analytics',    icon: BarChart2,  label: 'Analytics' },
      // Diligence Rooms — bulk M&A contract review (Harvey Vault eq).
      { to: '/diligence',    icon: FolderOpen, label: 'Diligence' },
    ],
  },
]

// "Your turn" is the only count that earns color. Pending approvals sit in the
// signed-in user's own queue, so they are genuinely blocking them; open requests
// are a workload figure for the team, so they stay an informational count.
const BADGE_TONE: Record<string, 'neutral' | 'attention'> = {
  pendingApprovals: 'attention',
  openRequests:     'neutral',
}

// ─── Component ─────────────────────────────────────────────────────────────────

const ADMIN_SECTION: NavSection = {
  label: 'Admin',
  items: [
    { to: '/admin/users',  icon: Users,       label: 'Users' },
    { to: '/admin/roles',  icon: ShieldCheck, label: 'Roles' },
    { to: '/admin/org',    icon: Building2,   label: 'Organization' },
    { to: '/admin/integrations', icon: Plug,  label: 'Integrations' },
    { to: '/admin/skills', icon: Sparkles,    label: 'Skills' },
    { to: '/team',         icon: UsersRound,  label: 'Team' },
  ],
}

export function Sidebar() {
  const canAdmin = usePermission('configure', 'user')

  const { data: stats } = useQuery<{
    pendingApprovals: number
    openRequests: number
  }>({
    queryKey: ['dashboard-stats'],
    queryFn: () => api.get('/dashboard').then((r) => r.data),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  const badgeCounts: Record<string, number> = {
    pendingApprovals: stats?.pendingApprovals ?? 0,
    openRequests:     stats?.openRequests ?? 0,
  }

  // U.7 — sidebar auto-collapses to icon-only below lg (1024px). On
  // top of that, P10 added a manual toggle (button + Cmd/Ctrl+\) so
  // power users on wide screens can reclaim horizontal space. State
  // persists in localStorage so the choice survives reload.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('draftlegal:sidebar-collapsed') === '1'
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        setCollapsed(c => {
          const next = !c
          try { localStorage.setItem('draftlegal:sidebar-collapsed', next ? '1' : '0') } catch {/*ignore*/}
          return next
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggle = () => {
    setCollapsed(c => {
      const next = !c
      try { localStorage.setItem('draftlegal:sidebar-collapsed', next ? '1' : '0') } catch {/*ignore*/}
      return next
    })
  }

  // When manually collapsed, override the lg: classes that would
  // normally show labels on wide screens. Helpers keep the markup
  // readable — `showLabel` is "show full label", `hideMobile` is
  // "treat as collapsed".
  const showLabel  = collapsed ? 'hidden' : 'hidden lg:inline'
  const showLabelB = collapsed ? 'hidden' : 'hidden lg:block'
  const showLabelF = collapsed ? 'hidden' : 'hidden lg:flex'
  const showLabelI = collapsed ? 'hidden' : 'hidden lg:inline-flex'
  const showMark   = collapsed ? 'inline'  : 'lg:hidden'
  const layoutCls  = collapsed
    ? 'justify-center'
    : 'justify-center lg:justify-start'

  return (
    <aside
      data-testid="app-sidebar"
      data-collapsed={collapsed ? 'true' : 'false'}
      className={cn(
        'border-r border-border bg-card flex flex-col shrink-0 transition-[width] duration-150',
        collapsed ? 'w-nav-collapsed' : 'w-nav-collapsed lg:w-nav',
      )}
    >
      {/*
        B.6.13 — logo is a link to /dashboard. Matches the 25-year web
        convention (Notion, Linear, Figma, every other web app) so the
        user's muscle-memory "click the logo to go home" works.
      */}
      <div className={cn(
        'h-header flex items-center border-b border-border',
        collapsed ? 'justify-center' : 'justify-center lg:justify-start lg:px-5',
      )}>
        <NavLink
          to="/dashboard"
          data-testid="logo-home-link"
          aria-label="draftLegal — go to dashboard"
          title="draftLegal — Dashboard"
          className="hover:opacity-80 transition-opacity focus:outline-none focus:ring-2 focus:ring-ring/35 rounded-md"
        >
          <span className={showMark}><Wordmark size="xl" kind="mark" /></span>
          <span className={showLabel}><Wordmark size="2xl" kind="full" /></span>
        </NavLink>
      </div>

      {/* Nav */}
      <nav className={cn('flex-1 py-2 overflow-y-auto', collapsed ? 'px-2' : 'px-2 lg:px-3')}>
        {[...NAV_SECTIONS, ...(canAdmin ? [ADMIN_SECTION] : [])].map((section, i) => (
          <div key={i} className="mb-1">
            {section.label && (
              <p className={cn('px-3 pt-4 pb-1.5 text-[9.5px] font-bold text-ink-400 uppercase tracking-[0.12em]', showLabelB)}>
                {section.label}
              </p>
            )}
            <div className="space-y-0.5">
              {section.items.map(({ to, icon: Icon, label, badge, staticBadge }) => {
                const count = badge ? badgeCounts[badge] : 0
                // U.2.1 / decision 14a — Assistant keeps the assist accent at
                // rest, as the "Ask draftLegal" affordance. But assist is
                // machine-authored only, never a UI accent: the ACTIVE nav item
                // is an action, so it goes ink like every other route.
                const isAssistant = to === '/agent'
                // U13 — coming-soon items shouldn't be reachable via keyboard
                // tab order or screen-reader navigation; the nav stays in DOM
                // for visual context but is not interactive.
                const isComingSoon = staticBadge === 'soon'
                return (
                  <NavLink
                    key={to}
                    to={to}
                    data-testid={isComingSoon
                      ? `nav-${to.replace(/^\//, '').replace(/\//g, '-')}-coming-soon`
                      : `nav-${to.replace(/^\//, '').replace(/\//g, '-')}`}
                    aria-disabled={isComingSoon || undefined}
                    tabIndex={isComingSoon ? -1 : undefined}
                    onClick={isComingSoon ? (e) => e.preventDefault() : undefined}
                    title={label}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-3 py-2 rounded-md text-[12.5px] font-medium transition-colors relative',
                        layoutCls,
                        collapsed ? 'px-2' : 'px-2 lg:px-3',
                        isActive
                          ? 'bg-ink-950 text-white'
                          : isAssistant
                            ? 'text-assist-700 hover:bg-assist-50'
                            : 'text-ink-700 hover:bg-paper-100 hover:text-ink-950'
                      )
                    }
                  >
                    <Icon size={16} className="shrink-0" />
                    <span className={cn('flex-1', showLabel)}>{label}</span>
                    {badge && count > 0 && (
                      <CountBadge tone={BADGE_TONE[badge] ?? 'neutral'} className={showLabelF}>
                        {count > 99 ? '99+' : count}
                      </CountBadge>
                    )}
                    {/* Compact badge dot on collapsed sidebar so users still see "there's something here" */}
                    {badge && count > 0 && (
                      <span
                        aria-hidden
                        className={cn(
                          'absolute top-1 right-1 h-2 w-2 rounded-full',
                          collapsed ? 'inline' : 'lg:hidden',
                          BADGE_TONE[badge] === 'attention' ? 'bg-attention-600' : 'bg-ink-400',
                        )}
                      />
                    )}
                    {staticBadge === 'soon' && (
                      // "Soon" blocks nobody, so it is a neutral fact rather
                      // than an attention badge.
                      <span
                        data-testid={`badge-soon-${to.replace(/^\//, '')}`}
                        className={cn('text-[9.5px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-chip bg-paper-100 text-ink-500 border border-paper-200', showLabelI)}
                      >
                        Soon
                      </span>
                    )}
                  </NavLink>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Settings + collapse toggle at bottom */}
      <div className={cn('border-t border-border space-y-0.5', collapsed ? 'p-2' : 'p-2 lg:p-3')}>
        <NavLink
          to="/settings"
          title="Settings"
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 py-2 rounded-md text-[12.5px] font-medium transition-colors',
              layoutCls,
              collapsed ? 'px-2' : 'px-2 lg:px-3',
              isActive
                ? 'bg-ink-950 text-white'
                : 'text-ink-700 hover:bg-paper-100 hover:text-ink-950'
            )
          }
        >
          <Settings size={16} className="shrink-0" />
          <span className={showLabel}>Settings</span>
        </NavLink>
        {/* Collapse toggle — visible only on lg+ since narrower viewports
            are auto-collapsed already and the button would be confusing.
            Cmd/Ctrl+\ keyboard shortcut works at any width. */}
        <button
          type="button"
          onClick={toggle}
          data-testid="sidebar-collapse-toggle"
          aria-label={collapsed ? 'Expand sidebar (⌘\\)' : 'Collapse sidebar (⌘\\)'}
          title={collapsed ? 'Expand sidebar (⌘\\)' : 'Collapse sidebar (⌘\\)'}
          className={cn(
            'hidden lg:flex w-full items-center gap-3 py-2 rounded-md text-dense font-medium text-ink-500 hover:bg-paper-100 hover:text-ink-950 transition-colors',
            layoutCls,
            collapsed ? 'px-2' : 'px-2 lg:px-3',
          )}
        >
          {collapsed
            ? <PanelLeftOpen size={16} className="shrink-0" />
            : <PanelLeftClose size={16} className="shrink-0" />}
          <span className={showLabel}>Collapse</span>
          <span className={cn('ml-auto text-[10px] font-mono opacity-60', showLabel)}>⌘\</span>
        </button>
      </div>
    </aside>
  )
}
