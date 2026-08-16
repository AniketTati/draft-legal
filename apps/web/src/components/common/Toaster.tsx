/**
 * Toaster — tiny transient-notification system for mutation feedback.
 *
 * JTBD: "Tell me my save / delete / change worked — without modal
 * interruption. And if it failed, tell me why so I can retry."
 *
 * Reference: Sonner / Radix Toast / Linear. Bottom-right sliding
 * toasts, auto-dismiss after a few seconds, colour-coded by kind.
 *
 * Exposes a singleton store so any component can call:
 *   toast.success('Profile saved')
 *   toast.error('Save failed', { description: 'Network offline' })
 *
 * The provider is mounted once in the root <App/>.
 *
 * B.6.27.
 */
import { useEffect, useState } from 'react'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'

type Kind = 'success' | 'error' | 'info'

interface Toast {
  id: number
  kind: Kind
  title: string
  description?: string
  duration: number
}

// ─── Minimal pub-sub so any component can fire toasts ─────────────────────────

type Listener = (toasts: Toast[]) => void

const listeners = new Set<Listener>()
let state: Toast[] = []
let nextId = 1

function emit() {
  for (const l of listeners) l(state)
}

export const toast = {
  success(title: string, opts: { description?: string; durationMs?: number } = {}) {
    push({ kind: 'success', title, description: opts.description, duration: opts.durationMs ?? 3500 })
  },
  error(title: string, opts: { description?: string; durationMs?: number } = {}) {
    push({ kind: 'error', title, description: opts.description, duration: opts.durationMs ?? 6000 })
  },
  info(title: string, opts: { description?: string; durationMs?: number } = {}) {
    push({ kind: 'info', title, description: opts.description, duration: opts.durationMs ?? 4000 })
  },
  dismiss(id: number) {
    state = state.filter((t) => t.id !== id)
    emit()
  },
}

function push(args: Omit<Toast, 'id'>) {
  const id = nextId++
  state = [...state, { id, ...args }]
  emit()
  // Auto-dismiss
  if (args.duration > 0) {
    setTimeout(() => toast.dismiss(id), args.duration)
  }
}

// ─── React component ──────────────────────────────────────────────────────────

// An error reports a failure (risk) and an info toast describes a state the
// user didn't ask about (in flight). Success stays NEUTRAL: every toast.success
// in this product is an acknowledgement — "Profile saved", "Copied", "Cost cap
// updated" — and none of them is approved, executed or signed. Brand is the
// binding colour, spent sparingly; firing it on every settings write is exactly
// the generic success-green the system removed. (ProfilePage and SettingsPage
// already render their own inline "saved" state neutral for the same reason.)
const KIND_META: Record<Kind, { icon: typeof CheckCircle2; cls: string }> = {
  success: { icon: CheckCircle2, cls: 'bg-card border-paper-200 text-ink-950' },
  error:   { icon: AlertCircle,  cls: 'bg-card border-risk-200  text-risk-700' },
  info:    { icon: Info,         cls: 'bg-card border-info-200  text-info-700' },
}

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>(state)

  useEffect(() => {
    const l: Listener = (t) => setToasts([...t])
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])

  return (
    <div
      aria-live="polite"
      data-testid="toaster"
      className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 pointer-events-none"
    >
      {toasts.map((t) => {
        const { icon: Icon, cls } = KIND_META[t.kind]
        return (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            data-testid={`toast-${t.kind}`}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-card border px-3.5 py-3 shadow-e3 min-w-[18rem] max-w-[22rem] animate-in slide-in-from-right-4 fade-in-0 ${cls}`}
          >
            <Icon className="size-4 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-body font-medium">{t.title}</p>
              {t.description && (
                <p className="text-dense opacity-80 mt-0.5">{t.description}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => toast.dismiss(t.id)}
              aria-label="Dismiss notification"
              className="shrink-0 p-0.5 rounded-chip text-current opacity-60 hover:opacity-100 transition-opacity"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
