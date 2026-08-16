import * as React from 'react'
import { cn } from '@/lib/utils'
import { RISK_BAND_CLASS, normalizeRisk, riskBand } from '@/lib/status'

/*
 * The small, repeated pieces — design system §04. Each one exists because the
 * same markup was being re-derived per page with slightly different padding,
 * and those differences are what a design system is for eliminating.
 */

/** Section label: 11px, 600, uppercase, 0.08em. Rails and card headings. */
export function Eyebrow({
  children,
  count,
  className,
}: {
  children: React.ReactNode
  /** Rail sections carry their count on the right. */
  count?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="flex-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-700">
        {children}
      </span>
      {count != null && (
        <span className="text-[11px] tabular-nums text-ink-400">{count}</span>
      )}
    </div>
  )
}

/**
 * Flattens a node to its text, so a control can name what it acts on. Only
 * walks strings, numbers and arrays — a chip whose label is an element should
 * pass `removeLabel` rather than have us guess at how it renders.
 */
function textOf(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return ''
}

/** Removable filter chip. Selected chips invert to ink. */
export function Chip({
  children,
  selected = false,
  onRemove,
  onClick,
  removeLabel,
  className,
}: {
  children: React.ReactNode
  selected?: boolean
  onRemove?: () => void
  onClick?: () => void
  /**
   * Accessible name for the remove control. Defaults to the chip's own text —
   * a row of five chips must not announce "Remove filter" five times.
   */
  removeLabel?: string
  className?: string
}) {
  const Comp = onClick ? 'button' : 'span'
  /*
   * A button inside a button is invalid and swallows the inner activation, so
   * the remove control can only be a real <button> when the chip itself isn't
   * one. In the clickable case it stays a role="button" span with its own key
   * handling.
   */
  const RemoveComp = onClick ? 'span' : 'button'
  const chipText = textOf(children).trim()
  const removeName = removeLabel ?? (chipText ? `Remove filter: ${chipText}` : 'Remove filter')
  const removeProps = {
    'aria-label': removeName,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      onRemove?.()
    },
    ...(onClick
      ? {
          role: 'button' as const,
          tabIndex: 0,
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              onRemove?.()
            }
          },
        }
      : { type: 'button' as const }),
  }
  return (
    <Comp
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={cn(
        'inline-flex w-fit items-center gap-1.5 rounded-full border py-0.5 pl-2.5 text-[11.5px]',
        onRemove ? 'pr-2' : 'pr-2.5',
        selected
          ? 'border-ink-950 bg-ink-950 text-white'
          : 'border-paper-200 bg-paper-100 text-ink-950',
        onClick && 'transition-colors hover:border-paper-300',
        className
      )}
    >
      {children}
      {onRemove && (
        <RemoveComp
          {...removeProps}
          className={cn(
            /*
             * The glyph stays 11px but the target is 24x24 — WCAG 2.5.8's
             * minimum, and this control sits inside a chip that may itself be
             * clickable, so a near-miss used to remove the wrong filter or
             * toggle the chip. -6.5px on every side gives the box back exactly
             * the 11px of layout the bare glyph used to occupy, so the target
             * grows into the chip's existing padding and nothing moves.
             */
            '-m-[6.5px] inline-flex size-6 shrink-0 items-center justify-center',
            'cursor-pointer rounded-full leading-none',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            selected ? 'text-white/60 hover:text-white' : 'text-ink-400 hover:text-ink-700'
          )}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
            className="size-[11px] shrink-0"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </RemoveComp>
      )}
    </Comp>
  )
}

/**
 * CountBadge — "your turn" is the only count that gets color. Everything else
 * is an informational count and stays neutral, so a colored badge in the nav
 * always means the same thing: you are the blocker.
 */
export function CountBadge({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'attention' | 'ink'
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5',
        'text-[11px] font-semibold tabular-nums',
        tone === 'attention' && 'bg-attention-100 text-attention-700',
        tone === 'ink' && 'bg-ink-950 text-white',
        tone === 'neutral' && 'bg-paper-100 text-ink-700',
        className
      )}
    >
      {children}
    </span>
  )
}

/** Risk meter: a 4px rule that agrees with the risk thresholds in lib/status. */
export function RiskMeter({
  score,
  showValue = true,
  className,
}: {
  /** 0–100. */
  score: number
  showValue?: boolean
  className?: string
}) {
  // Accepts either scale — see normalizeRisk. Callers must NOT pre-multiply.
  const pct = normalizeRisk(score)
  if (pct == null) return null
  const band = riskBand(pct)
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <span
        className="block h-1 flex-1 overflow-hidden rounded-full bg-paper-100"
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Risk score ${pct} of 100, ${band}`}
      >
        <span
          className={cn('block h-full rounded-full', RISK_BAND_CLASS[band])}
          style={{ width: `${pct}%` }}
        />
      </span>
      {showValue && (
        <span className="w-6 text-right text-[11px] tabular-nums text-ink-500">{pct}</span>
      )}
    </span>
  )
}

/** Keyboard hint. Mono, because a machine reads it. */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'rounded-chip border border-paper-200 bg-paper-50 px-1.5 py-0.5',
        'font-mono text-[10.5px] font-normal text-ink-700',
        className
      )}
    >
      {children}
    </kbd>
  )
}

/** Machine-generated identifier — ids, hashes, timestamps. */
export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[11px] text-ink-400', className)}>{children}</span>
}

/**
 * EmptyState — an empty list should say what would fill it and offer the one
 * action that gets there, rather than apologising.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'rounded-md border border-paper-200 bg-paper-50 px-5 py-8 text-center',
        className
      )}
    >
      {icon && (
        // Decorative: the title below already says what the empty list is.
        <span
          aria-hidden="true"
          className="mb-3.5 inline-flex size-10 items-center justify-center rounded-card border border-paper-200 bg-paper-100 text-ink-400 [&_svg]:size-5"
        >
          {icon}
        </span>
      )}
      <p className="text-[13.5px] font-semibold text-ink-950">{title}</p>
      {description && <p className="mt-1 text-dense text-ink-500">{description}</p>}
      {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
    </div>
  )
}

/** Card — border before shadow. Nothing on a page surface lifts past e1. */
export function Card({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-card border border-paper-200 bg-card', className)}
      {...props}
    >
      {children}
    </div>
  )
}
