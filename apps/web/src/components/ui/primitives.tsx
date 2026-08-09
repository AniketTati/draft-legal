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

/** Removable filter chip. Selected chips invert to ink. */
export function Chip({
  children,
  selected = false,
  onRemove,
  onClick,
  className,
}: {
  children: React.ReactNode
  selected?: boolean
  onRemove?: () => void
  onClick?: () => void
  className?: string
}) {
  const Comp = onClick ? 'button' : 'span'
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
        <span
          role="button"
          tabIndex={0}
          aria-label="Remove filter"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              onRemove()
            }
          }}
          className={cn(
            'cursor-pointer leading-none',
            selected ? 'text-white/60 hover:text-white' : 'text-ink-400 hover:text-ink-700'
          )}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="size-[11px]">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </span>
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
        <span className="mb-3.5 inline-flex size-10 items-center justify-center rounded-card border border-paper-200 bg-paper-100 text-ink-400 [&_svg]:size-5">
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
