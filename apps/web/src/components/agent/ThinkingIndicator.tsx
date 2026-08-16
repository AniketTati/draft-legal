import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Three dots rising and falling in sequence — the agent is alive and working.
 *
 * This replaces a pulsing diamond, which was the right SYMBOL but the wrong
 * kind of motion: a single mark fading in place reads as a static icon that
 * happens to flicker, not as something in progress. Sequenced dots are the
 * one loading idiom every user already knows from chat, so it needs no
 * learning.
 *
 * They stay assist indigo. In this system indigo means "a machine is doing
 * this", and the loader is the most machine-authored moment there is — the
 * diamond is still the mark on finished content, where provenance matters.
 * Motion carries the "working" signal; colour carries "who".
 */
function WaveDots({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-end gap-[3px]', className)} aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(
            'block size-[5px] rounded-full bg-assist-600',
            'animate-agent-wave motion-reduce:animate-none motion-reduce:opacity-60'
          )}
          // Staggered a third of the cycle apart so the crest travels left to
          // right instead of all three breathing together.
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  )
}

/**
 * What the user looks at while the agent is working.
 *
 * It replaces a static "thinking…", which was hiding a genuinely long wait.
 * Measured against the live orchestrator on a portfolio-wide question:
 *
 *     0.00s → 9.29s   silence — no frames at all
 *     9.29s           tool_call_start
 *     9.34s           tool_call_result   (the tool itself: 50ms)
 *     9.34s → 16.55s  silence again
 *    16.55s           first prose token
 *    24.22s           done
 *
 * So there are two dead windows totalling ~16s, and the tool chip — the one
 * piece of real progress — flashes past in 50ms. A spinner that says the same
 * thing at 1s and at 15s gives the user no way to tell "working" from "hung",
 * and the honest read of a frozen UI is that it broke.
 *
 * This cannot make the model faster. It can stop the wait being opaque:
 *
 *   • The PHASE is named, and it is derived from frames actually received —
 *     never a fake progress bar. Before any tool: the agent is choosing what
 *     to do. After a tool resolves but before prose: it is composing.
 *   • A clock ticks from 1s, so "still going" is distinguishable from "stuck".
 *   • Past a threshold the copy acknowledges the wait rather than pretending
 *     it is normal, because at 20s the user is deciding whether to reload.
 *
 * The label is polite fiction only in its wording, never in its state: every
 * phase shown corresponds to something the stream really reported.
 */
export type ThinkingPhase =
  /** Nothing back yet — the model is deciding what to do. */
  | 'deciding'
  /** A tool is in flight. The chip carries the detail; this is the fallback. */
  | 'working'
  /** Tools are done, prose has not started. */
  | 'composing'

const COPY: Record<ThinkingPhase, { label: string; slow: string }> = {
  deciding: {
    label: 'Working out how to answer',
    slow: 'Still working out how to answer',
  },
  working: {
    label: 'Searching your records',
    slow: 'Still searching your records',
  },
  composing: {
    label: 'Composing the answer',
    slow: 'Still composing the answer',
  },
}

/** Past this, silently claiming things are fine stops being credible. */
const SLOW_AFTER_S = 12

export function ThinkingIndicator({
  phase = 'deciding',
  compact = false,
  className,
}: {
  phase?: ThinkingPhase
  /** For the 420px rail: drops the skeleton, keeps the phase and the clock. */
  compact?: boolean
  className?: string
}) {
  const [elapsed, setElapsed] = useState(0)
  // Anchored on mount rather than accumulated, so a re-render mid-turn (which
  // happens on every token) cannot reset or double-count the clock.
  const startedAt = useRef(Date.now())

  useEffect(() => {
    const t = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt.current) / 1000))
    }, 1000)
    return () => clearInterval(t)
  }, [])

  const slow = elapsed >= SLOW_AFTER_S
  const copy = COPY[phase]

  return (
    <div
      className={cn('flex flex-col gap-2.5', className)}
      role="status"
      aria-live="polite"
      data-testid="agent-thinking"
    >
      <div className="flex items-center gap-2.5 text-dense text-ink-500">
        <WaveDots />
        <span>{slow ? copy.slow : copy.label}</span>
        {elapsed > 0 && (
          <span className="tabular-nums text-ink-400">{elapsed}s</span>
        )}
      </div>

      {/* Where the answer will land. Three lines of decreasing width read as
          a paragraph, so the space is committed rather than empty — an empty
          panel is what a broken page looks like. The rail is too narrow to
          spend this much vertical space on a placeholder, so it opts out. */}
      {!compact && (
      <div
        aria-hidden
        className="flex flex-col gap-2 motion-reduce:animate-none"
      >
        {['92%', '78%', '55%'].map((w, i) => (
          <span
            key={w}
            className="block h-2 rounded-full bg-paper-100 animate-pulse motion-reduce:animate-none"
            style={{ width: w, animationDelay: `${i * 140}ms` }}
          />
        ))}
      </div>
      )}

      {slow && (
        <p className="text-[11.5px] text-ink-400">
          Longer questions across the whole portfolio can take a while. Press
          Esc to stop.
        </p>
      )}
    </div>
  )
}
