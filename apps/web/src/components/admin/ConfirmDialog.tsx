/**
 * ConfirmDialog — the one guard for destructive admin actions.
 *
 * Before this existed, the admin surfaces guarded destruction three different
 * ways: `window.confirm()` (revoke API key, delete webhook, disconnect Slack,
 * delete BYOK key), a bare menu item with no guard at all (deactivate user),
 * and a bare trash icon with no guard at all (delete a custom field — which
 * drops that field's value from every contract in the org). A native confirm
 * cannot carry the design system, cannot name the consequence in more than one
 * line, and is styled by the OS; an unguarded click is worse still.
 *
 * So: one dialog, ink chrome, the destructive fill on the confirm, and a
 * `requireTyped` escape hatch for the handful of acts that cannot be undone at
 * all. Escape closes, focus lands inside and returns to the trigger, and the
 * backdrop is a sibling of the dialog rather than the dialog itself — the three
 * things the hand-rolled overlays in this area each got wrong somewhere.
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  /** Fill red only when the act destroys or cuts off access. */
  tone = 'destructive',
  /** When set, the confirm stays disabled until this exact string is typed. */
  requireTyped,
  requireTypedHint,
  isPending = false,
  error,
  onConfirm,
  onCancel,
  testId,
}: {
  open: boolean
  title: React.ReactNode
  body: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'destructive' | 'default'
  requireTyped?: string
  requireTypedHint?: React.ReactNode
  isPending?: boolean
  error?: string | null
  onConfirm: () => void
  onCancel: () => void
  testId?: string
}) {
  const [typed, setTyped] = React.useState('')
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const returnFocusRef = React.useRef<HTMLElement | null>(null)

  // Reset the typed gate every time the dialog is opened for a new target.
  React.useEffect(() => {
    if (open) setTyped('')
  }, [open, requireTyped])

  // Every call site passes an inline arrow for `onCancel`, so its identity
  // changes on every render of the parent. Depending on it directly tore this
  // effect down and set it up again on each of those renders, which did two
  // wrong things: the cleanup yanked focus out of the open dialog (mid-typing,
  // in the `requireTyped` case), and the setup re-captured
  // `document.activeElement` — by then the dialog's own input — so closing
  // returned focus to a node that no longer exists instead of to the trigger.
  // Hold it in a ref and key the effect on `open` alone.
  const onCancelRef = React.useRef(onCancel)
  React.useEffect(() => { onCancelRef.current = onCancel })

  React.useEffect(() => {
    if (!open) return
    returnFocusRef.current = document.activeElement as HTMLElement | null
    // Focus the panel, not the confirm button: a destructive default should
    // never be one stray Enter away.
    const t = window.setTimeout(() => {
      const field = panelRef.current?.querySelector<HTMLElement>('input')
      ;(field ?? panelRef.current)?.focus()
    }, 0)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancelRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      returnFocusRef.current?.focus?.()
    }
  }, [open])

  if (!open) return null

  const gated = requireTyped != null && typed.trim() !== requireTyped
  const confirmDisabled = isPending || gated

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-ink-950/50"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        tabIndex={-1}
        data-testid={testId}
        className="relative w-full max-w-md rounded-card border border-paper-200 bg-card shadow-e3 focus:outline-none"
      >
        <div className="flex items-start gap-3 px-5 pt-5">
          {tone === 'destructive' && (
            <span
              aria-hidden="true"
              className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-risk-50 text-risk-600"
            >
              <AlertTriangle className="size-4" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 id="confirm-dialog-title" className="text-section text-ink-950">
              {title}
            </h2>
            <div className="mt-1.5 text-dense leading-relaxed text-ink-700">{body}</div>
          </div>
        </div>

        {requireTyped != null && (
          <div className="mt-4 px-5">
            <label
              htmlFor="confirm-typed"
              className="mb-1.5 block text-[11.5px] font-semibold text-ink-950"
            >
              {requireTypedHint ?? (
                <>
                  Type <span className="font-mono text-ink-700">{requireTyped}</span> to confirm
                </>
              )}
            </label>
            <Input
              id="confirm-typed"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              data-testid="confirm-typed"
            />
          </div>
        )}

        {error && (
          <div className="mx-5 mt-4 flex items-start gap-2 rounded-md border border-risk-200 bg-risk-50 p-3">
            <AlertTriangle className="mt-px size-4 shrink-0 text-risk-600" />
            <p className="text-dense text-risk-700">{error}</p>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2 border-t border-paper-200 px-5 py-4">
          <Button variant="outline" onClick={onCancel} disabled={isPending}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'destructive' ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={confirmDisabled}
            data-testid="confirm-dialog-confirm"
          >
            {isPending && <Loader2 className="animate-spin" />}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
