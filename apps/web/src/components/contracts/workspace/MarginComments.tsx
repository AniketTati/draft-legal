/**
 * docs/41 Part 16 — comment threads in the margin, each beside the words it
 * was left on. Threads are placed by finding their words in the document as
 * it is now (the draft changes included); a thread whose words are gone is
 * not placed here, and the Comments view says so.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { findInCanvas, viewOf } from '@/components/contracts/SourceHighlight'
import type { CommentThreadData } from '@/lib/comments'
import { CommentThreadCard } from './CommentThreadCard'

const GAP = 8

/** Each thread's words in the canvas, as a distance from the top of `box`. */
export function placeThreads(editor: Editor | null, box: HTMLElement | null, threads: CommentThreadData[]): Array<{ thread: CommentThreadData; top: number }> {
  const view = viewOf(editor)
  if (!view || !box) return []
  const origin = box.getBoundingClientRect().top
  const out: Array<{ thread: CommentThreadData; top: number }> = []
  for (const t of threads) {
    if (!t.anchor || t.anchorState === 'orphaned') continue
    const r = findInCanvas(editor, t.anchor.quote, t.anchorStart ?? t.anchor.start)
    if (!r) continue
    try { out.push({ thread: t, top: view.coordsAtPos(r.from).top - origin }) } catch { /* position outside the view */ }
  }
  return out.sort((a, b) => a.top - b.top)
}

/** Push cards down so none overlaps the one above it. */
export function stack(wanted: number[], heights: number[]): number[] {
  const tops: number[] = []
  wanted.forEach((w, i) => {
    const prev = i ? tops[i - 1] + (heights[i - 1] ?? 0) + GAP : -Infinity
    tops.push(Math.max(w, prev))
  })
  return tops
}

export function MarginComments({ contractId, editor, container, threads, canEdit, person, activeId, onActivate }: {
  contractId: string
  editor: Editor | null
  /** The element the document and the margin share (positions are measured from its top). */
  container: HTMLElement | null
  threads: CommentThreadData[]
  canEdit: boolean
  person: string | null
  activeId: string | null
  onActivate: (t: CommentThreadData) => void
}) {
  const [placed, setPlaced] = useState<Array<{ thread: CommentThreadData; top: number }>>([])
  const [tops, setTops] = useState<number[]>([])
  const cards = useRef<Array<HTMLDivElement | null>>([])

  const measure = useCallback(() => setPlaced(placeThreads(editor, container, threads.filter(t => !t.resolved))), [editor, container, threads])
  useEffect(() => {
    measure()
    if (!editor) return
    // Typing moves the words; re-place after the editor settles.
    let timer: ReturnType<typeof setTimeout> | null = null
    const later = () => { if (timer) clearTimeout(timer); timer = setTimeout(measure, 150) }
    editor.on('update', later)
    window.addEventListener('resize', later)
    return () => { editor.off('update', later); window.removeEventListener('resize', later); if (timer) clearTimeout(timer) }
  }, [editor, measure])

  useLayoutEffect(() => {
    setTops(stack(placed.map(p => p.top), cards.current.map(c => c?.offsetHeight ?? 0)))
  }, [placed])

  if (!placed.length) return null
  return (
    <div className="relative" data-testid="margin-comments">
      {placed.map((p, i) => (
        <div
          key={p.thread.id}
          ref={el => { cards.current[i] = el }}
          className="absolute inset-x-0 cursor-pointer"
          style={{ top: tops[i] ?? p.top }}
          onClick={() => onActivate(p.thread)}
          data-testid={`margin-thread-${p.thread.id}`}
        >
          <CommentThreadCard contractId={contractId} thread={p.thread} canEdit={canEdit} person={person} active={activeId === p.thread.id} compact />
        </div>
      ))}
    </div>
  )
}
