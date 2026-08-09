/**
 * RedlinePreview (P1.6 / docs/30 D.5.4)
 *
 * Inline UI for a `redline_propose` tool result. Renders three variant
 * rewrites (least / moderate / aggressive) as tabs, shows each variant's
 * rationale + per-change before/after diffs, and exposes an
 * "Apply variant" button that fires the `redline_apply` Intent Preview.
 *
 * Design reference:
 *   - Cursor's diff preview with Accept/Reject per hunk
 *   - Ironclad Workflow's multi-variant redline picker (Least/Moderate/
 *     Aggressive tabs)
 *   - GitHub Copilot Chat's "Apply in editor" diff panel
 *
 * Lifecycle:
 *   1. SideAgentRail sees `tool_call_result` with name=redline_propose
 *   2. Stores the parsed JSON alongside the tool-trace chip
 *   3. Renders this component INSTEAD of the generic chip's result block
 *   4. User picks a variant tab → reviews → clicks "Apply variant"
 *   5. We dispatch a `rail-inject-action` CustomEvent with a
 *      redline_apply PendingAction, reusing the ActionPreview surface
 */
import { useState } from 'react'
import { ChevronRight, Check, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AssistMark } from '@/components/ui/assist'
import type { PendingAction } from './ActionPreview'

export interface RedlineChange {
  before: string
  after:  string
  reason?: string
}

export interface RedlineVariant {
  aggression:   'least' | 'moderate' | 'aggressive'
  proposedText: string
  rationale:    string
  changes:      RedlineChange[]
}

export interface RedlineProposal {
  contract: { id: string; title: string; type: string }
  clause:   { id: string; clauseType: string; sectionRef: string | null; originalText: string }
  category: { id: string; name: string } | null
  hasPlaybook: boolean
  variants: RedlineVariant[]
  error?:   string
}

// Aggression is a picker, not a status: "Least" is not binding and
// "Aggressive" is not legal exposure, so the old emerald/amber/red ramp
// spent meaning colours on a preference. The selected tab is a selection,
// which the system renders in ink; the label carries the aggression.
const TONE: Record<RedlineVariant['aggression'], { label: string; hint: string }> = {
  least:      { label: 'Least',      hint: 'Minimal edits; preserves counterparty language' },
  moderate:   { label: 'Moderate',   hint: 'Balanced rewrite toward playbook acceptable'    },
  aggressive: { label: 'Aggressive', hint: 'Full rewrite to playbook preferred position'    },
}

export function RedlinePreview({
  proposal,
  onApplyVariant,
}: {
  proposal: RedlineProposal
  /** Called when user clicks "Apply variant" — caller injects a redline_apply PendingAction. */
  onApplyVariant: (variant: RedlineVariant, action: PendingAction) => void
}) {
  const variants = proposal.variants ?? []
  const [activeIdx, setActiveIdx] = useState(
    Math.max(0, variants.findIndex(v => v.aggression === 'moderate')),
  )
  const active = variants[activeIdx] ?? variants[0]

  if (proposal.error || variants.length === 0) {
    return (
      <div
        data-testid="redline-preview-error"
        className="rounded-md border border-risk-200 bg-risk-50 text-risk-900 text-[11px] px-2.5 py-1.5 flex items-center gap-1.5"
      >
        <AlertTriangle className="size-3 flex-shrink-0" />
        <span>Redline generation failed{proposal.error ? `: ${proposal.error}` : ''}</span>
      </div>
    )
  }

  function fireApply(variant: RedlineVariant) {
    const action: PendingAction = {
      id: `redline_apply_${proposal.clause.id}_${variant.aggression}_${Date.now()}`,
      toolName: 'redline_apply',
      summary: `Apply ${variant.aggression} redline to ${proposal.clause.clauseType}${proposal.clause.sectionRef ? ` (${proposal.clause.sectionRef})` : ''}.`,
      args: {
        contractId:   proposal.contract.id,
        clauseId:     proposal.clause.id,
        proposedText: variant.proposedText,
        aggression:   variant.aggression,
        rationale:    variant.rationale,
        changes:      variant.changes,
      },
      target: `${proposal.contract.title} · ${proposal.clause.sectionRef ?? proposal.clause.clauseType}`,
      reversible: true,
      status: 'awaiting_confirmation',
      diff: [
        { field: 'clause content', before: 'original', after: `rewritten (${variant.aggression})` },
      ],
    }
    onApplyVariant(variant, action)
  }

  return (
    <div
      data-testid="redline-preview"
      data-clause-id={proposal.clause.id}
      // The whole card is machine-authored, so it takes the assist wash — this
      // is the surface the indigo exists for.
      className="rounded-card border border-assist-200 bg-assist-50 text-dense overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-assist-200">
        <AssistMark className="flex-shrink-0" />
        <span className="font-semibold text-assist-700">Redline proposal</span>
        <span className="font-mono text-[10.5px] text-assist-700 truncate">
          {proposal.clause.clauseType}
          {proposal.clause.sectionRef && ` · ${proposal.clause.sectionRef}`}
        </span>
        {!proposal.hasPlaybook && (
          // A missing playbook is a caveat about the input, not the user's turn.
          <span className="ml-auto text-[9.5px] uppercase tracking-wider font-medium text-ink-500 bg-paper-100 border border-paper-200 rounded-chip px-1.5 py-0.5">
            No playbook
          </span>
        )}
      </div>

      {/* Tabs */}
      <div role="tablist" aria-label="Redline aggression" className="flex gap-1 px-3 pt-2 pb-1.5">
        {variants.map((v, i) => {
          const active = i === activeIdx
          const tone = TONE[v.aggression]
          return (
            <button
              key={v.aggression}
              role="tab"
              aria-selected={active}
              onClick={() => setActiveIdx(i)}
              data-testid={`redline-preview-tab-${v.aggression}`}
              className={`text-[11px] rounded-md border px-2 py-1 font-medium transition-colors ${
                active
                  ? 'border-ink-950 bg-ink-950 text-white'
                  : 'bg-card border-paper-200 text-ink-700 hover:bg-paper-100 hover:text-ink-950'
              }`}
              title={tone.hint}
            >
              {tone.label}
            </button>
          )
        })}
      </div>

      <div className="px-3 pb-3 space-y-2">
        {/* Rationale */}
        <div className="text-[11px] text-assist-900 leading-relaxed">
          <span className="text-[9.5px] font-medium uppercase tracking-wider text-assist-700 block mb-0.5">
            Rationale
          </span>
          {active?.rationale}
        </div>

        {/* Changes */}
        {active?.changes && active.changes.length > 0 && (
          <div className="rounded-md border border-assist-200 bg-card divide-y divide-assist-200">
            <div className="px-2 py-1 text-[9.5px] font-medium uppercase tracking-wider text-ink-500">
              Changes ({active.changes.length})
            </div>
            {active.changes.map((ch, i) => (
              <div
                key={i}
                className="px-2 py-1.5 text-[11px] space-y-0.5"
                data-testid={`redline-change-${i}`}
              >
                <div className="text-[10.5px] font-mono flex items-start gap-1.5">
                  <span className="line-through text-risk-700 bg-risk-50 px-1 rounded-chip flex-1 break-words">
                    {ch.before || '∅'}
                  </span>
                </div>
                <div className="text-[10.5px] font-mono flex items-start gap-1.5">
                  <span className="text-brand-700 bg-brand-50 px-1 rounded-chip flex-1 break-words">
                    {ch.after || '∅'}
                  </span>
                </div>
                {ch.reason && (
                  <div className="text-[10px] text-ink-500 italic">
                    <ChevronRight className="inline size-2.5" /> {ch.reason}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Proposed full text — collapsed by default */}
        <ProposedText text={active?.proposedText ?? ''} />

        {/* GROUNDING — say plainly when there is no playbook behind this.
            `hasPlaybook: false` means the rewrite is the model's own view of
            market terms, not the organisation's recorded position, and that
            is the single most important thing a reviewer can know before
            putting the text into a contract. It was a grey "No playbook"
            chip in the header, easy to read as a filing detail. */}
        {!proposal.hasPlaybook && (
          <div
            data-testid="redline-preview-ungrounded"
            className="flex items-start gap-1.5 rounded-md border border-dashed border-assist-200 bg-card px-2 py-1.5 text-[10.5px] text-ink-700"
          >
            <AlertTriangle className="size-3 mt-px flex-shrink-0 text-ink-500" />
            <span>
              No playbook position exists for{' '}
              <span className="font-medium text-ink-950">{proposal.clause.clauseType}</span>, so this
              wording is the model&rsquo;s own — not your organisation&rsquo;s agreed fallback.
              Read it before applying.
            </span>
          </div>
        )}

        {/* Apply button */}
        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="text-[10.5px] text-ink-500">
            Applying creates ContractVersion (n+1). Reversible via Undo.
          </div>
          {/* Asking the machine to write its own proposal into the document —
              the one place the assist fill belongs on a button. */}
          <Button
            variant="assist"
            size="sm"
            onClick={() => active && fireApply(active)}
            data-testid={`redline-preview-apply-${active?.aggression}`}
            className="h-7 gap-1 text-[11px]"
          >
            <Check className="size-3" />
            Apply {TONE[active?.aggression ?? 'moderate'].label}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ProposedText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <div className="rounded-md border border-paper-200 bg-card">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        data-testid="redline-preview-proposed-toggle"
        className="w-full px-2 py-1 text-left text-[10.5px] font-medium text-ink-700 hover:bg-paper-100 flex items-center gap-1"
      >
        <ChevronRight className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        Full proposed text ({text.length} chars)
      </button>
      {open && (
        <pre
          data-testid="redline-preview-proposed-text"
          className="px-2 py-1.5 text-[10.5px] font-mono whitespace-pre-wrap break-words border-t border-paper-200 max-h-60 overflow-y-auto text-ink-700"
        >
          {text}
        </pre>
      )}
    </div>
  )
}
