/**
 * CollabStatusBadge (P10C) — collaboration-server connection indicator.
 *
 * Wave 2.4 (2026-07): the Hocuspocus server now DURABLY PERSISTS each
 * contract's Y.Doc (server onLoadDocument/onStoreDocument → collab_states),
 * verified end-to-end. What is NOT yet wired is the in-editor Collaboration
 * binding (live multi-cursor co-editing), which is deliberately deferred
 * because it's high-blast-radius surgery on the single-user editor and needs
 * multi-browser QA. So this badge honestly shows the connection state to the
 * collaboration server — it does NOT claim live co-editing ("Live") that isn't
 * happening yet.
 */
import { useCollabProvider } from '@/lib/collab'
import { Wifi, WifiOff, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MEANING_CLASS } from '@/lib/status'

export function CollabStatusBadge({ contractId }: { contractId: string }) {
  const collab = useCollabProvider(contractId)
  if (!collab) return null

  const { status } = collab
  // Connecting is the system's turn, not the user's, so it reads inflight
  // rather than attention.
  //
  // "Connected" is deliberately NEUTRAL, not binding. Emerald means a legal
  // state — approved, executed, signed — and the design system spends it
  // sparingly; a websocket that is merely working is the ordinary case, and a
  // permanently-green badge in the contract header would burn the brand color
  // on the one thing that is true almost all of the time.
  const config = {
    connecting:   { icon: Loader2,  meaning: 'inflight' as const, label: 'Connecting…', spin: true  },
    connected:    { icon: Wifi,     meaning: 'neutral'  as const, label: 'Sync on',     spin: false },
    disconnected: { icon: WifiOff,  meaning: 'neutral'  as const, label: 'Offline',     spin: false },
  }[status]
  const Icon = config.icon
  const m = MEANING_CLASS[config.meaning]

  return (
    <span
      data-testid="collab-status-badge"
      title={
        status === 'connected'
          ? 'Connected to the collaboration server — document changes are persisted. Live multi-cursor co-editing is rolling out.'
          : `Collaboration server: ${config.label}`
      }
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-dense font-medium border',
        m.wash, m.washFg, m.washBorder,
      )}
    >
      <Icon className={cn('size-3', config.spin && 'animate-spin')} />
      {config.label}
    </span>
  )
}
