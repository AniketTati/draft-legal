/**
 * SaveToLibraryPopover (docs/39 E4) — wording from a contract, saved to the
 * clause library where the reader found it.
 *
 * Good wording seen in a contract had to be copied out, and the library's
 * form filled in by hand, in another screen. Here the highlighted words are
 * saved as they are, filed under the clause type they read as, unapproved
 * until someone who approves clauses does, and linked back to this contract.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { rankClauseTypes } from '@/lib/clause-match'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/common/Toaster'
import { errorDetail } from './FieldsPanel'
import type { TextSelection } from './SelectionMenu'

const WIDTH = 360
const SAVED_CATEGORY = 'Saved from contracts'

interface Category { id: string; name: string; children?: Category[] }
interface Saved { clause: { id: string; title: string; category?: { name: string } }; duplicate: boolean }

function flatten(tree: Category[], depth = 0): Array<{ id: string; name: string; depth: number }> {
  return tree.flatMap(c => [{ id: c.id, name: c.name, depth }, ...flatten(c.children ?? [], depth + 1)])
}

/**
 * The selection grown to whole words at its ends: a drag that starts or ends
 * mid-word ("tomer shall pay…") saves the words ("Customer shall pay…").
 */
export function wholeWords(sel: Pick<TextSelection, 'text' | 'before' | 'after'>): string {
  let text = sel.text
  const head = (sel.before ?? '').match(/[\p{L}\p{N}]+$/u)?.[0] ?? ''
  const tail = (sel.after ?? '').match(/^[\p{L}\p{N}]+/u)?.[0] ?? ''
  if (head && /^[\p{L}\p{N}]/u.test(text)) text = head + text
  if (tail && /[\p{L}\p{N}]$/u.test(text)) text = text + tail
  return text
}

/** The first words, as a title when the wording reads as no clause type. */
function firstWords(text: string, n = 6): string {
  const words = text.split(/\s+/).slice(0, n).join(' ').replace(/[,;:.]+$/, '')
  return words.length < text.length ? `${words}…` : words
}

export function SaveToLibraryPopover({ contractId, selection, onClose }: {
  contractId: string
  selection: TextSelection
  onClose: () => void
}) {
  const qc = useQueryClient()
  const panelRef = useRef<HTMLDivElement>(null)
  const text = useMemo(() => wholeWords(selection), [selection])
  const best = useMemo(() => rankClauseTypes(text).find(m => m.score > 0) ?? null, [text])
  const [title, setTitle] = useState(() => best?.label ?? firstWords(text))
  const [categoryId, setCategoryId] = useState('')
  const [done, setDone] = useState<Saved | null>(null)

  const { data: tree } = useQuery({
    queryKey: ['clause-categories'],
    queryFn: async () => (await api.get<Category[] | { data: Category[] }>('/clauses/categories')).data,
  })
  const categories = useMemo(() => flatten(Array.isArray(tree) ? tree : tree?.data ?? []), [tree])
  // Where it goes when nothing is picked: the category named for its clause type, else Saved from contracts.
  const byType = best ? categories.find(c => c.name.toLowerCase() === best.label.toLowerCase()) : undefined
  const defaultName = byType?.name ?? SAVED_CATEGORY

  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const down = (e: MouseEvent) => { if (panelRef.current && !panelRef.current.contains(e.target as Node)) closeRef.current() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    const t = setTimeout(() => document.addEventListener('mousedown', down), 0)
    window.addEventListener('keydown', esc)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', down); window.removeEventListener('keydown', esc) }
  }, [])

  const save = useMutation({
    mutationFn: async () => (await api.post<Saved>('/clauses/from-contract', {
      contractId, text, title: title.trim(),
      ...(categoryId ? { categoryId } : {}),
      ...(best ? { clauseType: best.type } : {}),
    })).data,
    onSuccess: r => {
      setDone(r)
      qc.invalidateQueries({ queryKey: ['clauses'] })
      qc.invalidateQueries({ queryKey: ['clause-categories'] })
    },
    onError: err => toast.error("Couldn't save it", { description: errorDetail(err) }),
  })

  const height = done ? 150 : 330
  const below = selection.rect.bottom + 8 + height < window.innerHeight
  const top = below ? selection.rect.bottom + 8 : Math.max(8, selection.rect.top - 8 - height)
  const left = Math.min(Math.max(selection.rect.left, 16), window.innerWidth - WIDTH - 16)

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Save to the clause library"
      data-testid="save-to-library-popover"
      className="fixed z-50 rounded-lg border border-paper-200 bg-popover shadow-e3 overflow-hidden"
      style={{ top, left, width: WIDTH }}
    >
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-2 border-b border-paper-100">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-400">Save to the clause library</p>
          <p className="mt-0.5 text-[12px] italic text-ink-700 line-clamp-3" title={text}>“{text}”</p>
        </div>
        <button type="button" className="p-0.5 rounded-sm text-ink-400 hover:text-ink-950 hover:bg-paper-100" onClick={onClose} aria-label="Close">
          <X className="size-3.5" />
        </button>
      </div>

      {done ? (
        <div className="px-4 py-4 space-y-3" data-testid="save-to-library-done">
          <p className="flex items-start gap-2 text-[13px] text-ink-950">
            <CheckCircle2 className="size-4 text-brand-700 mt-0.5 shrink-0" />
            {done.duplicate
              ? <span>This wording is already in the library, as <span className="font-semibold">{done.clause.title}</span>.</span>
              : <span>Saved as <span className="font-semibold">{done.clause.title}</span>{done.clause.category ? <> in {done.clause.category.name}</> : null} — unapproved until someone who approves clauses does.</span>}
          </p>
          <div className="flex justify-end gap-1.5">
            <Link to={`/clauses?clause=${done.clause.id}`} className="inline-flex items-center h-[26px] px-2.5 rounded-sm border border-input text-[11.5px] text-ink-700 hover:bg-paper-100" onClick={onClose}>
              Open in the library
            </Link>
            <Button size="xs" onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form className="px-3 py-3 space-y-2.5" onSubmit={e => { e.preventDefault(); if (title.trim() && !save.isPending) save.mutate() }}>
          <label className="block">
            <span className="block text-[11px] text-ink-700 mb-1">Title</span>
            <Input value={title} onChange={e => setTitle(e.target.value)} autoFocus data-testid="save-to-library-title" />
          </label>
          <label className="block">
            <span className="block text-[11px] text-ink-700 mb-1">Category</span>
            <select
              value={categoryId}
              onChange={e => setCategoryId(e.target.value)}
              data-testid="save-to-library-category"
              className="h-8 w-full text-[12.5px] text-ink-950 rounded-md border border-input bg-card px-2 focus:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15"
            >
              <option value="">{defaultName}{byType ? '' : best ? ` (no ${best.label} category yet)` : ''}</option>
              {categories.filter(c => c.id !== byType?.id).map(c => (
                <option key={c.id} value={c.id}>{' '.repeat(c.depth * 2)}{c.name}</option>
              ))}
            </select>
          </label>
          <p className="text-[11px] text-ink-500">Saved unapproved, with a link back to this contract. Someone who approves clauses makes it standard wording.</p>
          <div className="flex justify-end gap-1.5 pt-0.5">
            <Button type="button" size="xs" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="xs" disabled={!title.trim() || save.isPending} data-testid="save-to-library-save">
              {save.isPending && <Loader2 className="animate-spin" />} Save
            </Button>
          </div>
        </form>
      )}
    </div>,
    document.body,
  )
}
