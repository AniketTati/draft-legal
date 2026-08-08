/**
 * WelcomeChecklist — dashboard card that surfaces remaining setup tasks
 * after the user finishes the 2-step OnboardingWizard.
 *
 * Modern SaaS onboarding pattern: get the user to first-value fast (the
 * wizard does that), then nudge them to round out their setup without ever
 * blocking the product. Each item links to the right page; none of them are
 * required.
 *
 * Auto-hides when 4 of the 4 items are complete, or when the user dismisses
 * it explicitly. The "dismissed" flag is persisted to
 * org.settings.welcomeChecklistDismissed so it stays gone across sessions.
 *
 * Items + how we detect completion:
 *   1. Industry pack installed   → org.settings.installedIndustryPacks not empty
 *   2. Invite a teammate         → /users?limit=2 returns 2+ rows
 *   3. Upload your first contract → /contracts?limit=1 returns 1+ row
 *   4. Configure approvals       → /approvals/workflows returns 1+ row
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/auth'
import { Button } from '@/components/ui/button'
import {
  Briefcase,
  CheckCircle2,
  Circle,
  Upload,
  Users,
  GitBranch,
  ArrowRight,
  X,
  Sparkles,
} from 'lucide-react'

type Org = {
  settings?: {
    installedIndustryPacks?: string[]
    welcomeChecklistDismissed?: boolean
    onboardingCompleted?: boolean
    [k: string]: unknown
  }
}

export function WelcomeChecklist() {
  const qc = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const isAdmin = (user?.roles as string[] | undefined)?.includes('ADMIN')

  // Local optimistic-hide so the card disappears the moment the user clicks
  // dismiss, even before the PATCH lands.
  const [locallyHidden, setLocallyHidden] = useState(false)

  const { data: org } = useQuery<Org>({
    queryKey: ['organization'],
    queryFn: () => api.get('/organization').then((r) => r.data),
    staleTime: 60_000,
  })

  const onboardingDone   = org?.settings?.onboardingCompleted === true
  const dismissed        = org?.settings?.welcomeChecklistDismissed === true
  const shouldRunQueries = isAdmin && onboardingDone && !dismissed && !locallyHidden

  // Cheap, parallel probes — each enabled only when the card is visible
  const { data: usersData } = useQuery<{ data?: Array<unknown> } | Array<unknown>>({
    queryKey: ['users-min'],
    queryFn: () => api.get('/users?limit=2').then((r) => r.data),
    enabled: shouldRunQueries,
    staleTime: 30_000,
  })
  const { data: contractsData } = useQuery<{ data?: Array<unknown> }>({
    queryKey: ['contracts-min'],
    queryFn: () => api.get('/contracts?limit=1').then((r) => r.data),
    enabled: shouldRunQueries,
    staleTime: 30_000,
  })
  const { data: workflowsData } = useQuery<Array<unknown> | { data?: Array<unknown> }>({
    queryKey: ['approval-workflows-min'],
    queryFn: () => api.get('/approvals/workflows').then((r) => r.data),
    enabled: shouldRunQueries,
    staleTime: 30_000,
  })

  const dismiss = useMutation({
    mutationFn: () => {
      const current = (org?.settings ?? {}) as Record<string, unknown>
      return api
        .patch('/organization', { settings: { ...current, welcomeChecklistDismissed: true } })
        .then((r) => r.data)
    },
    onMutate: () => setLocallyHidden(true),
    onSettled: () => qc.invalidateQueries({ queryKey: ['organization'] }),
  })

  const items = useMemo(() => {
    const userRows = Array.isArray(usersData) ? usersData : (usersData?.data ?? [])
    const contractRows = contractsData?.data ?? []
    const workflowRows = Array.isArray(workflowsData) ? workflowsData : (workflowsData?.data ?? [])
    const packs = org?.settings?.installedIndustryPacks ?? []

    return [
      {
        id: 'industry',
        label: 'Install an industry pack',
        sub: 'Auto-seed contract types, templates, clauses, and playbook positions.',
        icon: Briefcase,
        done: Array.isArray(packs) && packs.length > 0,
        to: '/settings',
        cta: 'Open Settings',
      },
      {
        id: 'invite',
        label: 'Invite a teammate',
        sub: 'Add legal, ops, or procurement so they can collaborate on contracts.',
        icon: Users,
        done: Array.isArray(userRows) && userRows.length >= 2,
        to: '/admin/users',
        cta: 'Invite users',
      },
      {
        id: 'upload',
        label: 'Upload your first contract',
        sub: 'Parse, classify, extract key terms, and index for AI search — about 30 seconds.',
        icon: Upload,
        done: Array.isArray(contractRows) && contractRows.length > 0,
        to: '/contracts',
        cta: 'Go to Contracts',
      },
      {
        id: 'approvals',
        label: 'Configure an approval workflow',
        sub: 'Route contracts to the right approvers by value, type, or counterparty.',
        icon: GitBranch,
        done: Array.isArray(workflowRows) && workflowRows.length > 0,
        to: '/approvals',
        cta: 'Configure',
      },
    ]
  }, [usersData, contractsData, workflowsData, org])

  const doneCount = items.filter((i) => i.done).length

  if (!isAdmin) return null
  if (!onboardingDone) return null
  if (dismissed || locallyHidden) return null
  if (doneCount === items.length) return null

  return (
    // The emerald wash this card used to carry meant nothing — setup progress
    // isn't a binding state — so the card is a plain paper card now and the
    // colored elements are gone with it.
    <div
      className="relative overflow-hidden rounded-card border border-paper-200 bg-card p-5"
      data-testid="welcome-checklist"
    >
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => dismiss.mutate()}
        className="absolute right-3 top-3 text-ink-400"
        aria-label="Dismiss welcome checklist"
        data-testid="welcome-checklist-dismiss"
      >
        <X />
      </Button>

      <div className="flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-md bg-paper-100 text-ink-500">
          <Sparkles className="size-3.5" />
        </span>
        <div>
          <h2 className="text-section text-ink-950">Get the most out of draftLegal</h2>
          <p className="text-dense text-ink-500">
            {doneCount} of {items.length} done — these all live on their own pages so you can
            come back any time.
          </p>
        </div>
      </div>

      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <li
              key={item.id}
              className={`flex items-start gap-3 rounded-md border border-paper-200 bg-card p-3 transition-colors ${
                item.done ? 'opacity-60' : 'hover:border-paper-300'
              }`}
            >
              {/* A finished setup step is a neutral fact — the strike-through
                  and the dimmed row carry "done", so the tick stays ink. */}
              <span className="mt-0.5">
                {item.done ? (
                  <CheckCircle2 className="size-4 text-ink-700" />
                ) : (
                  <Circle className="size-4 text-ink-400" />
                )}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Icon className="size-3.5 text-ink-400" />
                  <span
                    className={`text-body font-medium ${
                      item.done ? 'line-through text-ink-500' : 'text-ink-950'
                    }`}
                  >
                    {item.label}
                  </span>
                </div>
                <p className="mt-0.5 text-dense text-ink-500">{item.sub}</p>
                {!item.done && (
                  <Button
                    asChild
                    variant="link"
                    size="sm"
                    className="mt-1 h-auto p-0 text-[12.5px] font-medium"
                  >
                    <Link to={item.to}>
                      {item.cta} <ArrowRight className="ml-1 size-3" />
                    </Link>
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
