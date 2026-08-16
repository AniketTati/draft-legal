/**
 * RailSection — collapsible section primitive for the contract detail
 * right rail (B.1.5c+).
 *
 * Shape:
 *   [▸ HEADING   (count)]
 *   [  body content      ]
 *
 * Clicking the header toggles. Chevron rotates. Count chip is optional.
 * Kept stateless-ish via local useState so the parent doesn't have to
 * manage N toggle states; pass `defaultOpen` to force-open sections we
 * expect users to see every time (e.g. Overview).
 *
 * No Radix dep — a plain useState toggle is sufficient for an accordion
 * whose items are independent (not one-open-at-a-time).
 */
import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export function RailSection({
  title,
  count,
  defaultOpen = false,
  children,
  action,
}: {
  title: string
  count?: number | string | null
  defaultOpen?: boolean
  children: ReactNode
  /** Optional inline action (e.g. "Re-analyze") rendered to the right of the title. */
  action?: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const showCount = count != null && count !== '' && count !== 0
  // P15 audit (2026-04-29). Derive a stable testid from the title so the
  // contract-detail probe can find specific sections without relying on
  // text matching (which breaks under i18n and is fragile to wording).
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  // P29 audit (2026-05-01). The inline `action` slot is rendered as
  // a SIBLING of the toggle button, not a child. Callers commonly
  // pass a `<button>` (e.g. "View all") and a button-in-button is
  // an HTML / a11y violation that React surfaces as a console.error
  // (`validateDOMNesting: <button> cannot appear as a descendant of
  // <button>`). Wrapping the row in a flex `<div>` lets the toggle
  // and the action coexist without nesting.
  return (
    <section
      className="border-b border-paper-100 last:border-b-0"
      data-testid={`rail-section-${slug}`}
      data-state={open ? 'open' : 'closed'}
    >
      <div
        className={cn(
          'flex w-full items-center gap-2 px-5 py-3 text-left',
          'hover:bg-paper-50',
        )}
      >
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          data-testid={`rail-section-toggle-${slug}`}
          className={cn(
            'flex flex-1 items-center gap-2 text-left',
            'focus-visible:outline-none',
          )}
        >
          <ChevronRight
            className={cn(
              'size-3.5 text-ink-400 transition-transform flex-shrink-0',
              open && 'rotate-90',
            )}
            strokeWidth={2.5}
          />
          <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-700 flex-1">
            {title}
          </span>
          {showCount && (
            <span
              className="text-[11px] font-medium text-ink-400 tabular-nums"
              data-testid={`rail-section-count-${slug}`}
            >
              {count}
            </span>
          )}
        </button>
        {action && (
          <div
            className="flex-shrink-0"
            onClick={e => e.stopPropagation()}
            data-testid={`rail-section-action-${slug}`}
          >
            {action}
          </div>
        )}
      </div>
      {open && (
        <div className="px-5 pb-4 pt-0 text-dense text-ink-700" data-testid={`rail-section-body-${slug}`}>
          {children}
        </div>
      )}
    </section>
  )
}
