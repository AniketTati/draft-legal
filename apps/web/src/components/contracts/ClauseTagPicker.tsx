/**
 * ClauseTagPicker (docs/39 E1) — "Tag as clause ▸ type" for highlighted words.
 *
 * A clause the AI missed couldn't be added: the Clauses tab only listed what
 * it found. Here the words a reader selects become a clause of the type they
 * pick (the types the words read as first). Tagging words that overlap a
 * clause of the same type redraws it instead: how a clause the AI cut short
 * gets its whole text.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { rankClauseTypes } from '@/lib/clause-match'
import { useClauseTypes } from '@/lib/clause-types'
import { toast } from '@/components/common/Toaster'
import { errorDetail } from './FieldsPanel'
import type { TextSelection } from './SelectionMenu'

const WIDTH = 300
const BEST = 6

export function ClauseTagPicker({ contractId, selection, onClose, onTagged }: {
  contractId: string
  selection: TextSelection
  onClose: () => void
  onTagged?: () => void
}) {
  const qc = useQueryClient()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  // docs/39 E3 — the organization's own clause types too.
  const { custom } = useClauseTypes()
  const ranked = useMemo(() => rankClauseTypes(selection.text, custom), [selection.text, custom])
  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return ranked.filter(m => m.score > 0).slice(0, BEST).concat(ranked.every(m => m.score === 0) ? ranked.slice(0, BEST) : [])
    return ranked.filter(m => m.label.toLowerCase().includes(q) || m.type.includes(q.replace(/\s+/g, '_')))
  }, [query, ranked])
  useEffect(() => setActive(0), [query])

  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const down = (e: MouseEvent) => { if (panelRef.current && !panelRef.current.contains(e.target as Node)) closeRef.current() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    const t = setTimeout(() => document.addEventListener('mousedown', down), 0)
    window.addEventListener('keydown', esc)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', down); window.removeEventListener('keydown', esc) }
  }, [])

  const tag = useMutation({
    mutationFn: async (type: { type: string; label: string }) => ({
      type,
      r: (await api.post<{ action: 'tagged' | 'redrawn' | 'covered' }>(`/contracts/${contractId}/clauses/tag`, {
        clauseType: type.type, text: selection.text, occurrence: selection.occurrence,
      })).data,
    }),
    onSuccess: ({ type, r }) => {
      if (r.action === 'covered') {
        toast.info(`Already part of a ${type.label.toLowerCase()} clause`, { description: 'To change what the clause covers, select all of its words.' })
      } else {
        toast.success(r.action === 'redrawn' ? `${type.label} clause redrawn` : `Tagged as ${type.label}`, {
          description: r.action === 'redrawn' ? 'It now has the words you selected.' : 'A re-analysis keeps it.',
        })
      }
      qc.invalidateQueries({ queryKey: ['contract-clauses', contractId] })
      onTagged?.()
      onClose()
    },
    onError: err => toast.error("Couldn't tag the clause", { description: errorDetail(err) }),
  })

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, list.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
    if (e.key === 'Enter' && list[active]) { e.preventDefault(); tag.mutate(list[active]) }
  }

  const height = 320
  const below = selection.rect.bottom + 8 + height < window.innerHeight
  const top = below ? selection.rect.bottom + 8 : Math.max(8, selection.rect.top - 8 - height)
  const left = Math.min(Math.max(selection.rect.left, 16), window.innerWidth - WIDTH - 16)

  return createPortal(
    <div ref={panelRef} role="dialog" aria-label="Tag as clause" data-testid="clause-tag-picker"
      className="fixed z-50 rounded-lg border border-paper-200 bg-popover shadow-e3 overflow-hidden" style={{ top, left, width: WIDTH }}>
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-2 border-b border-paper-100">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-400">Tag as clause</p>
          <p className="mt-0.5 text-[12px] italic text-ink-700 line-clamp-2" title={selection.text}>“{selection.text}”</p>
        </div>
        <button type="button" className="p-0.5 rounded-sm text-ink-400 hover:text-ink-950 hover:bg-paper-100" onClick={onClose} aria-label="Close">
          <X className="size-3.5" />
        </button>
      </div>
      <div className="relative px-3 pt-2.5">
        <Search className="absolute left-5 top-[19px] size-3.5 text-ink-400" />
        <input autoFocus value={query} onChange={e => setQuery(e.target.value)} onKeyDown={keys} placeholder="Clause type" aria-label="Clause type"
          className="w-full h-8 rounded-md border border-input bg-card pl-7 pr-2 text-[12.5px] focus:outline-none focus:ring-1 focus:ring-ink-950" />
      </div>
      <div className="max-h-[210px] overflow-y-auto py-1.5" role="listbox" aria-label="Clause types">
        {list.length === 0 ? (
          <p className="px-3 py-2 text-dense text-ink-500">No clause type by that name.</p>
        ) : list.map((m, i) => (
          <button key={m.type} type="button" role="option" aria-selected={i === active}
            onMouseEnter={() => setActive(i)} onClick={() => tag.mutate(m)} disabled={tag.isPending}
            className={cn('w-full text-left px-3 py-1.5 text-[12.5px] text-ink-950', i === active ? 'bg-paper-100' : 'hover:bg-paper-50')}
            data-testid={`clause-tag-option-${m.type}`}>
            {m.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  )
}
