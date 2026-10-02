/**
 * docs/41 Part 16 — the pieces the selection menu opens: which finding a
 * selection could ask an exception for, the variable picker, and a comment
 * box over the words (on the contract page, where there is no margin).
 */
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Braces, X } from 'lucide-react'
import type { ReviewFindingView } from '@/lib/review'
import type { TextSelection } from '@/components/contracts/SelectionMenu'
import { CommentComposer, type CommentDraft } from './CommentComposer'

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * The open finding of the clause the selected words lie in, that an exception
 * can be asked for — or null. Deterministic: the clause whose text holds the
 * words, and its finding offering "request_exception".
 */
export function exceptionFindingAt(
  text: string,
  clauses: Array<{ id: string; content: string }>,
  findings: Array<Pick<ReviewFindingView, 'id' | 'title' | 'clauseId' | 'actions'>>,
): Pick<ReviewFindingView, 'id' | 'title' | 'clauseId' | 'actions'> | null {
  const words = norm(text)
  if (words.length < 2) return null
  const open = findings.filter(f => f.clauseId && f.actions.includes('request_exception'))
  if (!open.length) return null
  for (const c of clauses) {
    if (!norm(c.content).includes(words)) continue
    const f = open.find(x => x.clauseId === c.id)
    if (f) return f
  }
  return null
}

/** A small box placed below (or above) the selection. */
function Floating({ sel, width, height, label, onClose, children }: {
  sel: TextSelection; width: number; height: number; label: string; onClose: () => void; children: React.ReactNode
}) {
  const below = sel.rect.bottom + 8 + height < window.innerHeight
  const top = below ? sel.rect.bottom + 8 : Math.max(8, sel.rect.top - 8 - height)
  const left = Math.min(Math.max(sel.rect.left, 16), window.innerWidth - width - 16)
  return createPortal(
    <div role="dialog" aria-label={label} className="fixed z-50 rounded-lg border border-paper-200 bg-popover shadow-e3 p-2" style={{ top, left, width }}>
      <div className="flex items-center justify-between pb-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-400">{label}</p>
        <button type="button" aria-label="Close" onClick={onClose} className="p-0.5 rounded hover:bg-paper-100"><X className="size-3.5 text-ink-500" /></button>
      </div>
      {children}
    </div>,
    document.body,
  )
}

/** "Make variable": the words become one of the template's variables. */
export function VariablePicker({ sel, variables, onPick, onClose }: {
  sel: TextSelection
  variables: Array<{ key: string; label: string }>
  onPick: (key: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const list = useMemo(() => variables.filter(v => !q || `${v.label} ${v.key}`.toLowerCase().includes(q.toLowerCase())), [variables, q])
  return (
    <Floating sel={sel} width={280} height={260} label="Make variable" onClose={onClose}>
      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        autoFocus
        placeholder="Find a variable"
        className="w-full h-7 rounded-md border border-input bg-card px-2 text-dense mb-1.5"
        data-testid="variable-picker-search"
      />
      <ul className="max-h-[190px] overflow-y-auto" data-testid="variable-picker">
        {list.map(v => (
          <li key={v.key}>
            <button type="button" onClick={() => onPick(v.key)} className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded text-left text-dense hover:bg-paper-100" data-testid={`variable-pick-${v.key}`}>
              <Braces className="size-3 text-ink-400" />{v.label}
            </button>
          </li>
        ))}
        {!list.length && <li className="px-1.5 py-1 text-dense text-ink-500">No variable of this template matches.</li>}
      </ul>
    </Floating>
  )
}

/** A comment box over the words, for a page with no margin. */
export function CommentPopover({ sel, contractId, draft, onClose }: {
  sel: TextSelection; contractId: string; draft: CommentDraft; onClose: () => void
}) {
  return (
    <Floating sel={sel} width={340} height={200} label="Comment" onClose={onClose}>
      <CommentComposer contractId={contractId} draft={draft} onDone={onClose} />
    </Floating>
  )
}
