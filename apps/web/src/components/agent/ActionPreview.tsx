/**
 * ActionPreview (D.3.1)
 *
 * The "are you sure?" surface for every write the agent proposes. Reads
 * (contract_get, clause_search, etc.) go straight through and stream a
 * tool-trace chip. Writes (comment_add, request_create, contract_update,
 * ...) pause BEFORE execution and render this card inline in the thread.
 *
 * User sees — in this order, most-important-first:
 *   1. Plain-English summary of what the agent intends to do
 *   2. The target (contract title, clause ref, request title — whatever
 *      the tool touches)
 *   3. Before / after diff when the tool is an update
 *   4. Three clear buttons: Apply / Edit / Cancel
 *
 * Design reference:
 *   - Cursor's edit confirmation — plain-English summary above a colored
 *     diff. Keyboard Enter = Apply, Cmd-Shift-Enter = stream-continue
 *   - Claude.ai artifact confirmations — inline card, not modal
 *   - GitHub Copilot Chat — "apply in editor" preview with diff
 *   - Anthropic tool-use UX — "tool use: X with args Y" → user approves
 *
 * D.3.1 ships the UI. D.3.2 wires it to the first real write tool
 * (comment_add). Every subsequent write tool plugs in the same card.
 */
import { useEffect, useState } from 'react'
import { Loader2, Check, Pencil, X, AlertTriangle, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AssistMark } from '@/components/ui/assist'

export interface PendingAction {
  /** Unique id — ties the card back to a specific tool_call_awaiting_confirmation event. */
  id: string
  /** Tool name (matches the Python tool registry: comment_add, request_create, etc.). */
  toolName: string
  /** One-sentence human summary — "I'll add a comment to §9.2 asking about the cap". */
  summary: string
  /** The arguments the agent wants to pass. Rendered as formatted JSON in Edit mode. */
  args: Record<string, unknown>
  /** Optional target label — contract title, request subject, section ref, etc. */
  target?: string
  /** Optional structured diff for update-shaped actions. */
  diff?: {
    field: string
    before: string | number | null
    after:  string | number | null
  }[]
  /** True if the action is reversible; surfaces an "Undo within 15m" note. */
  reversible?: boolean
  /** Life-cycle: set by the rail as it walks the user through confirmation. */
  status: 'awaiting_confirmation' | 'running' | 'applied' | 'undone' | 'cancelled' | 'error'
  /** On success, the tool result preview (passes through to the trace chip). */
  resultPreview?: string
  /** On error or cancel, why. */
  errorMessage?: string
  /** D.3.5 — server-side tool-call id (set after Apply) so Undo can target it. */
  toolCallId?: string
  /** D.3.5 — when the action was Applied. Used to gate the 15-min undo window. */
  appliedAt?: number
}

interface ActionPreviewProps {
  action: PendingAction
  onApply:  (args: Record<string, unknown>) => void | Promise<void>
  onCancel: () => void
  /** D.3.5 — optional. When provided, Applied + reversible + within-window
   *  actions render an "Undo" button on the receipt. */
  onUndo?: () => void | Promise<void>
}

const UNDO_WINDOW_MS = 15 * 60 * 1000  // 15 minutes — matches server-side gate

export function ActionPreview({ action, onApply, onCancel, onUndo }: ActionPreviewProps) {
  const [editing, setEditing] = useState(false)
  const [draftJson, setDraftJson] = useState(() => JSON.stringify(action.args, null, 2))
  const [jsonError, setJsonError] = useState<string | null>(null)
  // D.3.5 — tick every 10s so the "Undo" button disappears once the window
  // closes without requiring a parent re-render.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (action.status !== 'applied' || !action.appliedAt) return
    const id = setInterval(() => setTick(t => t + 1), 10_000)
    return () => clearInterval(id)
  }, [action.status, action.appliedAt])

  const isRunning = action.status === 'running'
  const isApplied = action.status === 'applied'
  const isUndone = action.status === 'undone'
  const isCancelled = action.status === 'cancelled'
  const isError = action.status === 'error'
  const isDone = isApplied || isUndone || isCancelled || isError
  const isAwaiting = action.status === 'awaiting_confirmation'

  // Is the applied action still within the 15-min undo window?
  const canUndo = !!(
    isApplied && action.reversible && action.toolCallId && onUndo &&
    action.appliedAt && (Date.now() - action.appliedAt) < UNDO_WINDOW_MS
  )

  function apply() {
    try {
      const parsed = editing ? JSON.parse(draftJson) : action.args
      setJsonError(null)
      void onApply(parsed)
    } catch (e) {
      setJsonError((e as Error).message)
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────

  // Terminal states — compact receipt instead of the full card.
  if (isDone) {
    // Applied is binding — the write landed. Undone and Cancelled are both
    // "nothing stands", so both read neutral; the icon and the word carry the
    // difference rather than a second colour. Failed is real risk.
    const palette = isApplied
      ? { border: 'border-brand-200', bg: 'bg-brand-50', text: 'text-brand-700', icon: Check }
      : isUndone
        ? { border: 'border-paper-200', bg: 'bg-paper-50', text: 'text-ink-700', icon: Undo2 }
        : isCancelled
          ? { border: 'border-paper-200', bg: 'bg-paper-50', text: 'text-ink-500', icon: X }
          : { border: 'border-risk-200', bg: 'bg-risk-50', text: 'text-risk-700', icon: AlertTriangle }
    const Icon = palette.icon
    const label = isApplied ? 'Applied' : isUndone ? 'Undone' : isCancelled ? 'Cancelled' : 'Failed'
    return (
      <div
        data-testid="action-preview-receipt"
        data-status={action.status}
        className={`rounded-md border ${palette.border} ${palette.bg} ${palette.text} text-[11px] px-2.5 py-1.5 flex items-center gap-1.5`}
      >
        <Icon className="size-3 flex-shrink-0" />
        <span className="font-medium">{label}</span>
        <span className="opacity-75 truncate flex-1">· {action.summary}</span>
        {action.errorMessage && (
          <span className="opacity-90 font-mono text-[10px] truncate">· {action.errorMessage.slice(0, 80)}</span>
        )}
        {canUndo && (
          <button
            type="button"
            onClick={() => void onUndo?.()}
            data-testid="action-preview-undo"
            className="ml-auto flex-shrink-0 inline-flex items-center gap-1 text-[10.5px] font-medium text-ink-700 hover:text-ink-950 hover:bg-brand-100 rounded-chip px-1.5 py-0.5 transition-colors"
            title="Undo this action (within 15 minutes)"
          >
            <Undo2 className="size-2.5" />
            Undo
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      data-testid="action-preview"
      data-status={action.status}
      data-tool={action.toolName}
      // Attention, not assist: the card's whole reason to exist is that the
      // write is blocked on this user. The diamond still marks who authored
      // the proposal.
      className="rounded-card border border-attention-200 bg-attention-50 text-dense overflow-hidden"
    >
      {/* Header — tool + reversible badge */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-attention-200">
        <AssistMark className="flex-shrink-0" />
        <span className="font-semibold text-attention-700">About to run</span>
        <span className="font-mono text-[10.5px] text-ink-700">{action.toolName}</span>
        {action.reversible && (
          // Reversibility is a neutral fact about the tool, not a verdict.
          <span className="ml-auto text-[9.5px] uppercase tracking-wider font-medium text-ink-500 bg-paper-100 border border-paper-200 rounded-chip px-1.5 py-0.5">
            Undoable
          </span>
        )}
      </div>

      <div className="px-3 py-2.5 space-y-2">
        {/* Plain-English summary — always first, always visible */}
        <div className="text-ink-950 leading-relaxed">{action.summary}</div>

        {/* Target + diff */}
        {action.target && (
          <div className="text-[10.5px] text-ink-500">
            <span className="font-medium">Target:</span>{' '}
            <span className="font-mono">{action.target}</span>
          </div>
        )}

        {action.diff && action.diff.length > 0 && (
          <div className="rounded-chip border border-attention-200 bg-card divide-y divide-attention-200">
            <div className="px-2 py-1 text-[9.5px] font-medium uppercase tracking-wider text-ink-400">
              Changes
            </div>
            {action.diff.map(d => (
              <div key={d.field} className="px-2 py-1.5 text-[11px]">
                <div className="text-ink-700 font-medium">{d.field}</div>
                <div className="font-mono text-[10.5px] flex items-baseline gap-1.5">
                  <span className="line-through text-risk-700 bg-risk-50 px-1 rounded-chip">
                    {d.before === null || d.before === '' ? '∅' : String(d.before)}
                  </span>
                  <span className="text-ink-400">→</span>
                  <span className="text-brand-700 bg-brand-50 px-1 rounded-chip">
                    {d.after === null || d.after === '' ? '∅' : String(d.after)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Args editor — hidden until "Edit" is clicked */}
        {editing && (
          <div>
            <div className="text-[9.5px] font-medium uppercase tracking-wider text-ink-400 mb-1">
              Arguments
            </div>
            <textarea
              value={draftJson}
              onChange={e => { setDraftJson(e.target.value); setJsonError(null) }}
              data-testid="action-preview-args"
              className="w-full text-[10.5px] font-mono rounded-md border border-input bg-card p-2 text-ink-950 resize-y min-h-[6em] focus:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/12"
            />
            {jsonError && (
              <div className="text-[10.5px] text-risk-700 mt-1">Invalid JSON: {jsonError}</div>
            )}
          </div>
        )}

        {/* Buttons — Apply primary, Edit secondary, Cancel ghost */}
        {isAwaiting && (
          <div className="flex items-center justify-end gap-1.5 pt-1">
            <Button
              variant="ghost" size="sm"
              onClick={onCancel}
              data-testid="action-preview-cancel"
              className="h-7 text-[11px] gap-1 text-ink-700 hover:text-risk-700"
            >
              <X className="size-3" />
              Cancel
            </Button>
            <Button
              variant="outline" size="sm"
              onClick={() => setEditing(v => !v)}
              data-testid="action-preview-edit"
              className="h-7 text-[11px] gap-1"
            >
              <Pencil className="size-3" />
              {editing ? 'Review' : 'Edit'}
            </Button>
            {/* Apply is the card's one primary — ink acts. */}
            <Button
              size="sm"
              onClick={apply}
              data-testid="action-preview-apply"
              className="h-7 text-[11px] gap-1"
            >
              <Check className="size-3" />
              Apply
            </Button>
          </div>
        )}

        {/* Running state — disabled spinner row */}
        {isRunning && (
          <div className="flex items-center justify-end gap-1.5 pt-1 text-ink-500 text-[11px]">
            <Loader2 className="size-3 animate-spin" />
            Applying…
          </div>
        )}
      </div>
    </div>
  )
}
