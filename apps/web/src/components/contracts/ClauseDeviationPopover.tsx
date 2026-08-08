/**
 * ClauseDeviationPopover — P6.5 / docs/30 Wave G.5
 *
 * Click a margin badge from P6.2's ClauseClassifier → this popover
 * opens anchored at the badge with the full rationale + 3 actions:
 *
 *   • Rewrite to market — opens the P6.3 BubbleAiPopover on this
 *                         paragraph, seeded with the "simplify" action
 *   • Accept            — dismisses; the author explicitly chose this
 *                         language despite the flag
 *   • Dismiss           — closes without action
 *
 * Listens for the global `clause-deviation-click` CustomEvent that
 * the classifier dispatches on badge click.
 *
 * This is the "focused deviation drawer" moment for margin badges —
 * the equivalent of B.5.6's FocusedReviewDrawer for pre-extracted
 * risks, but for LIVE classifier signals during editing.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, Sparkles, CheckCircle2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Position = 'market' | 'aggressive' | 'weak' | 'off'

interface DeviationDetail {
  position:       Position | string
  category:       string
  reasoning:      string
  keyTerm:        string
  paragraphText:  string
  anchor:         { top: number; left: number }
}

/**
 * The four positions are a severity ramp, so they take the same three meanings
 * riskMeaning() uses for a score: at-market is healthy (binding), weaker-than-
 * market hands the call back to the drafter (turn), aggressive is real exposure
 * (risk). "Off playbook" says nothing about severity, so it stays neutral.
 */
const POS_HEADLINE: Record<string, { label: string; cls: string; tone: string }> = {
  market:     { label: 'In line with market practice',   cls: 'bg-brand-50 border-brand-200 text-brand-800',           tone: 'binding' },
  aggressive: { label: 'Aggressive — review before send', cls: 'bg-risk-50 border-risk-200 text-risk-900',             tone: 'risk' },
  weak:       { label: 'Weaker than market',             cls: 'bg-attention-50 border-attention-200 text-attention-700', tone: 'turn' },
  off:        { label: 'Off the standard playbook',      cls: 'bg-paper-50 border-paper-300 text-ink-950',             tone: 'neutral' },
}

export function ClauseDeviationPopover({
  onAskRewrite,
}: {
  /**
   * Called with the selected paragraph text when the user clicks
   * "Rewrite to market". The parent page wires this to open the
   * existing P6.3 BubbleAiPopover anchored at the paragraph.
   */
  onAskRewrite?: (paragraphText: string) => void
}) {
  const [detail, setDetail] = useState<DeviationDetail | null>(null)

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<DeviationDetail>
      setDetail(ce.detail)
    }
    window.addEventListener('clause-deviation-click', handler)
    return () => window.removeEventListener('clause-deviation-click', handler)
  }, [])

  useEffect(() => {
    if (!detail) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDetail(null) }
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement
      if (!el.closest('[data-testid="clause-deviation-popover"]') && !el.classList.contains('clause-classifier-badge')) {
        setDetail(null)
      }
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [detail])

  if (!detail) return null
  const meta = POS_HEADLINE[detail.position] ?? POS_HEADLINE.off

  // Nudge the popover back into the viewport if the anchor is near the right edge.
  const width = 380
  const left = Math.max(16, Math.min(detail.anchor.left, window.innerWidth - width - 16))

  return (
    <div
      className="fixed z-[60] rounded-card border border-paper-200 shadow-e2 bg-popover"
      style={{ top: detail.anchor.top, left, width }}
      data-testid="clause-deviation-popover"
    >
      <div className={`flex items-center gap-1.5 px-3 py-2 border-b ${meta.cls}`}>
        <AlertTriangle className="size-3.5" />
        <span className="text-dense font-semibold">{meta.label}</span>
        <button
          onClick={() => setDetail(null)}
          className="ml-auto p-0.5 rounded-chip hover:bg-black/5"
          aria-label="Close"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ink-500">
          <span className="font-mono">{detail.category || 'clause'}</span>
          {detail.keyTerm && (
            <>
              <span>·</span>
              <span className="font-medium text-ink-700 normal-case tracking-normal">
                Key: <span className="font-mono">{detail.keyTerm}</span>
              </span>
            </>
          )}
        </div>

        {detail.reasoning && (
          <p className="text-[12px] text-ink-950 leading-snug" data-testid="clause-deviation-reasoning">
            {detail.reasoning}
          </p>
        )}

        <div className="flex gap-1.5 pt-1">
          {detail.position !== 'market' && (
            <Button
              variant="assist"
              size="xs"
              onClick={() => {
                onAskRewrite?.(detail.paragraphText)
                setDetail(null)
              }}
              data-testid="clause-deviation-rewrite"
            >
              <Sparkles className="size-3" /> Rewrite to market
            </Button>
          )}
          <Button
            variant="outline"
            size="xs"
            onClick={() => setDetail(null)}
            data-testid="clause-deviation-accept"
          >
            <CheckCircle2 className="size-3" /> Accept as-is
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setDetail(null)}
            data-testid="clause-deviation-dismiss"
            className="ml-auto font-normal text-ink-500"
          >
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  )
}
