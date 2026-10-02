/**
 * Popover — a panel anchored under a trigger, for small forms (a field
 * filter, the column picker). The dropdown menu is for lists of actions: its
 * typeahead and roving focus fight text inputs, so forms get this instead.
 *
 * Portalled so a scrolling table can't clip it; placed under the anchor and
 * kept inside the viewport; closes on Escape and on a press outside both the
 * panel and its anchor (the anchor toggles it itself). Focus moves to the
 * panel's first field and back to the anchor on close.
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

export function Popover({
  open, onClose, anchor, children, align = 'start', width = 320, className, label,
}: {
  open: boolean
  onClose: () => void
  anchor: HTMLElement | null
  children: React.ReactNode
  align?: 'start' | 'end'
  width?: number
  className?: string
  /** Names the panel for assistive tech. */
  label: string
}) {
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null)
  const onCloseRef = React.useRef(onClose)
  React.useEffect(() => { onCloseRef.current = onClose })

  React.useLayoutEffect(() => {
    if (!open || !anchor) return
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const left = align === 'end' ? r.right - width : r.left
      setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(left, window.innerWidth - width - 8)) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, anchor, align, width])

  React.useEffect(() => {
    if (!open) return
    const returnTo = anchor
    const t = window.setTimeout(() => {
      const first = panelRef.current?.querySelector<HTMLElement>('input, select, textarea, button')
      ;(first ?? panelRef.current)?.focus()
    }, 0)
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || anchor?.contains(target)) return
      onCloseRef.current()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCloseRef.current() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      if (returnTo && document.activeElement && panelRef.current?.contains(document.activeElement)) returnTo.focus()
    }
  }, [open, anchor])

  if (!open || !pos) return null
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      style={{ top: pos.top, left: pos.left, width }}
      className={cn('fixed z-50 rounded-md border border-paper-200 bg-card shadow-e2 focus:outline-none', className)}
    >
      {children}
    </div>,
    document.body,
  )
}
