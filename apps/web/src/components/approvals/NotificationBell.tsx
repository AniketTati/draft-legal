/**
 * NotificationBell — Phase 06
 * Header bell icon with unread count badge + dropdown of recent notifications.
 * Polls every 30s. Mark-all-read button.
 */
import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Bell, CheckCircle2, AlertTriangle, ArrowRight, Clock, X, CalendarClock, Repeat, FileUp } from 'lucide-react'

interface Notification {
  id:           string
  type:         string
  title:        string
  body:         string
  resourceType: string
  resourceId:   string
  read:         boolean
  createdAt:    string
}

/**
 * Icon colour is the notification's meaning, not its category: a request or a
 * due date is the user's turn, a decision is binding, a hand-off is in flight.
 * COUNTERPARTY_VERSION loses its indigo — a human on the other side sent that
 * file, and indigo belongs to the machine.
 */
const TYPE_ICON: Record<string, React.ReactNode> = {
  APPROVAL_REQUEST: <Clock className="size-3.5 text-attention-600" />,
  APPROVAL_DECIDED: <CheckCircle2 className="size-3.5 text-brand-700" />,
  ESCALATION:       <AlertTriangle className="size-3.5 text-attention-600" />,
  DELEGATION:       <ArrowRight className="size-3.5 text-info-600" />,
  OBLIGATION_DUE:   <CalendarClock className="size-3.5 text-attention-600" />,
  RENEWAL_DUE:      <Repeat className="size-3.5 text-attention-600" />,
  // Counterparty returned a revised version via the portal or inbound email.
  COUNTERPARTY_VERSION: <FileUp className="size-3.5 text-info-600" />,
}

function relativeTime(d: string) {
  const ms = Date.now() - new Date(d).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

export function NotificationBell() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const { data } = useQuery<{ data: Notification[]; unreadCount: number }>({
    queryKey: ['notifications'],
    queryFn:  () => api.get('/approvals/notifications?limit=10').then(r => r.data),
    refetchInterval: 30_000,
    staleTime: 15_000,
  })

  const notifications = data?.data ?? []
  const unreadCount = data?.unreadCount ?? 0

  const markRead = useMutation({
    mutationFn: (ids?: string[]) =>
      api.post('/approvals/notifications/mark-read', { ids }).then(r => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  })

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(v => !v)}
        className="relative p-2 rounded-md hover:bg-paper-100 transition-colors"
        aria-label="Notifications"
        data-testid="notification-bell"
      >
        <Bell className="size-4 text-ink-700" />
        {/* Unread notifications are things waiting on this user — the one count
            in the shell that earns a meaning colour. */}
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-attention-600 text-white text-[9px] font-bold leading-none tabular-nums">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-80 bg-card rounded-card shadow-e2 border border-paper-200 z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-paper-200 bg-paper-50">
            <span className="text-dense font-semibold text-ink-950">Notifications</span>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  onClick={() => markRead.mutate(undefined)}
                  className="text-[11.5px] font-medium text-ink-950 hover:underline underline-offset-2"
                >
                  Mark all read
                </button>
              )}
              <button onClick={() => setOpen(false)} className="p-0.5 rounded-chip hover:bg-paper-200">
                <X className="size-3.5 text-ink-500" />
              </button>
            </div>
          </div>

          {/* List */}
          {notifications.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <Bell className="size-6 text-ink-400 mx-auto mb-2" />
              <p className="text-dense text-ink-500">No notifications</p>
            </div>
          ) : (
            <div className="divide-y divide-paper-200 max-h-96 overflow-y-auto">
              {notifications.map(n => (
                <div
                  key={n.id}
                  data-testid={`notification-${n.type}`}
                  className={`flex gap-2.5 px-3 py-2 hover:bg-paper-100 transition-colors cursor-pointer ${!n.read ? 'bg-paper-50' : ''}`}
                  onClick={() => {
                    if (!n.read) markRead.mutate([n.id])
                    setOpen(false)
                    if (n.resourceType === 'contract') { navigate(`/contracts/${n.resourceId}`); return }
                    // APPROVAL_REQUEST -- the most actionable notification in
                    // the product -- is emitted with resourceType
                    // 'approval_step' by both workflow-engine.ts and
                    // notification.worker.ts. It matched neither branch, so the
                    // row simply greyed out and went nowhere.
                    //
                    // Both approval types go to the queue, not to
                    // /approvals/<id>: App.tsx registers `approvals` and has no
                    // :id child, so the old link rendered an empty page.
                    if (n.resourceType === 'approval_step' || n.resourceType === 'approval_instance') {
                      navigate('/approvals'); return
                    }
                  }}
                >
                  <div className="shrink-0 mt-0.5">
                    {TYPE_ICON[n.type] ?? <Bell className="size-3.5 text-ink-400" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-[11.5px] font-medium leading-snug ${n.read ? 'text-ink-700' : 'text-ink-950'}`}>
                      {n.title}
                    </p>
                    <p className="text-[11.5px] text-ink-500 truncate mt-0.5">{n.body}</p>
                    <p className="text-[11px] text-ink-400 mt-0.5">{relativeTime(n.createdAt)}</p>
                  </div>
                  {!n.read && (
                    <div className="shrink-0 mt-1.5 size-1.5 rounded-full bg-attention-600" />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
