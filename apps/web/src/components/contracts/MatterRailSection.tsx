/**
 * MatterRailSection (P7.4.2 / F-42)
 *
 * Surfaces the contract's parent matter on the rail. Without this the
 * user has to know to look at the small header "Add to matter" pill —
 * which is easy to miss + doesn't tell you anything about siblings.
 *
 * Renders only when the contract IS in a matter. The "add to matter"
 * empty path stays in the header (B.5.x ContractMatterPicker) where
 * it doesn't compete with the rich Matter card here.
 *
 * Layout (compact):
 *   ┌─────────────────────────────────────┐
 *   │ MATTER                          OPEN │
 *   │ ──────────────────────────────────── │
 *   │ 🛍 Zynga MSA — multi-year SaaS …     │  ← name, links to /matters/:id
 *   │ Master Services Agreement and all …  │  ← description (2 lines)
 *   │ ──────────────────────────────────── │
 *   │ 4 contracts · 0 requests · 0 threads │  ← sibling counts
 *   │ Counterparty: Zynga Holdings         │
 *   │ Owner: Maya Goldberg                 │
 *   │ #enterprise #saas #priority          │  ← tags
 *   └─────────────────────────────────────┘
 */
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { RailSection } from '@/components/contracts/RailSection'
import { StatusPill } from '@/components/ui/status-pill'
import { Briefcase, Building2, User as UserIcon, ArrowRight } from 'lucide-react'

// Shape returned by GET /api/v1/matters/:id — nested arrays + owner
// object, NOT pre-aggregated counts. We derive counts from .length.
interface MatterDetail {
  id: string
  name: string
  description?: string | null
  status: string
  counterpartyName?: string | null
  owner?: { id: string; name: string } | null
  tags?: string[]
  contracts?: Array<{ id: string }>
  requests?: Array<{ id: string }>
  threads?: Array<{ id: string }>
}

export function MatterRailSection({ matterId }: { matterId: string | null | undefined }) {
  const { data: matter, isLoading } = useQuery<MatterDetail>({
    queryKey: ['matter-rail', matterId],
    queryFn: () => api.get(`/matters/${matterId}`).then(r => r.data),
    enabled: !!matterId,
    staleTime: 30_000,
  })

  // No matter → don't render. The "Add to matter" pill in the header
  // is the empty-state surface; we don't compete with it here.
  if (!matterId) return null
  if (isLoading || !matter) {
    // Show a tiny placeholder so the rail layout doesn't shift on load
    return (
      <RailSection title="Matter" defaultOpen count={null}>
        <div className="text-[11px] text-muted-foreground italic">Loading…</div>
      </RailSection>
    )
  }

  const contractCount = matter.contracts?.length ?? 0
  const requestCount  = matter.requests?.length ?? 0
  const threadCount   = matter.threads?.length ?? 0
  const siblingContracts = Math.max(0, contractCount - 1)

  return (
    <RailSection title="Matter" defaultOpen count={null}>
      <div className="space-y-2" data-testid="matter-rail-section">
        {/* Matter name + status */}
        <div className="flex items-start justify-between gap-2">
          <Link
            to={`/matters/${matter.id}`}
            data-testid="matter-rail-link"
            className="flex items-start gap-1.5 text-[12.5px] font-medium text-ink-950 hover:text-brand-700 leading-tight min-w-0"
          >
            <Briefcase className="size-3.5 text-ink-400 mt-0.5 shrink-0" />
            <span className="truncate">{matter.name}</span>
          </Link>
          <StatusPill
            status={matter.status}
            className="shrink-0 text-[9.5px] font-semibold uppercase tracking-wider"
          >
            {matter.status}
          </StatusPill>
        </div>

        {/* Description */}
        {matter.description && (
          <p className="text-[11px] text-muted-foreground leading-snug line-clamp-2">
            {matter.description}
          </p>
        )}

        {/* Sibling counts */}
        <div className="text-[11px] text-ink-700 flex items-center gap-1.5 flex-wrap">
          {siblingContracts > 0 ? (
            <Link
              to={`/matters/${matter.id}`}
              className="text-ink-950 font-medium hover:underline inline-flex items-center gap-0.5"
              data-testid="matter-siblings-link"
            >
              {siblingContracts} other {siblingContracts === 1 ? 'contract' : 'contracts'} in this matter
              <ArrowRight className="size-3" />
            </Link>
          ) : (
            <span className="text-muted-foreground">Only contract in this matter</span>
          )}
          {requestCount > 0 && (
            <span className="text-muted-foreground">· {requestCount} {requestCount === 1 ? 'request' : 'requests'}</span>
          )}
          {threadCount > 0 && (
            <span className="text-muted-foreground">· {threadCount} {threadCount === 1 ? 'thread' : 'threads'}</span>
          )}
        </div>

        {/* Counterparty + Owner */}
        <div className="space-y-0.5">
          {matter.counterpartyName && (
            <div className="text-[11px] text-ink-700 flex items-center gap-1">
              <Building2 className="size-3 text-ink-400" />
              <span className="truncate">{matter.counterpartyName}</span>
            </div>
          )}
          {matter.owner?.name && (
            <div className="text-[11px] text-ink-700 flex items-center gap-1">
              <UserIcon className="size-3 text-ink-400" />
              <span className="truncate">{matter.owner.name}</span>
            </div>
          )}
        </div>

        {/* Tags */}
        {(matter.tags?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {matter.tags!.slice(0, 6).map(t => (
              <span
                key={t}
                className="inline-flex items-center text-[9.5px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-chip bg-paper-100 text-ink-700 border border-paper-200"
              >
                #{t}
              </span>
            ))}
          </div>
        )}
      </div>
    </RailSection>
  )
}
