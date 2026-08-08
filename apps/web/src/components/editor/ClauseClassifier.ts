/**
 * ClauseClassifier — P6.2 / docs/30 Wave G.2
 *
 * Background clause classifier. For every paragraph that passes a
 * "looks like a clause" heuristic, fires POST /api/v1/agent/classify-clause
 * and renders a small margin badge to the LEFT of the paragraph.
 *
 * Labels:
 *   • market     — green   — in line with common practice
 *   • aggressive — red     — heavily favors one party
 *   • weak       — amber   — materially weaker than market
 *   • off        — gray    — not in the playbook's standard set
 *   (skip         — nothing rendered)
 *
 * Differs from RiskDecorations (B.5.5):
 *   • Risk deco = red/blue UNDERLINES on pre-extracted clauses
 *   • This     = left-margin BADGES computed live while editing
 *
 * Caching:
 *   • Per-paragraph text is hashed (djb2)
 *   • Results are keyed on the hash so we never re-fetch unchanged text
 *
 * Budget:
 *   • Classify at most 12 paragraphs per open document
 *   • Only paragraphs ≥ 80 chars (headings / signature lines stay skip)
 *   • New edits debounce 1500ms per paragraph
 */
import { Extension } from '@tiptap/react' // re-exported from @tiptap/core
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import { api } from '@/lib/api'

export type Position = 'market' | 'aggressive' | 'weak' | 'off' | 'skip'

export interface ClassifyResult {
  category: string
  position: Position
  reasoning: string
  keyTerm?: string
}

export interface ClauseClassifierOptions {
  contractType: string
  enabled:      boolean
  debounceMs:   number
  maxParagraphsPerDoc: number
}

/*
 * The badge is painted into a ProseMirror decoration as inline CSS, so the
 * palette has to be restated as hex rather than as classes. Every value below
 * is a stop from tailwind.config.ts, on the same five meanings the rest of the
 * product uses — these badges open ClauseDeviationPopover, and the two must not
 * disagree about what "weak" or "aggressive" looks like.
 *
 *   market     → brand   (binding: the language we'd sign)
 *   aggressive → risk    (exposure)
 *   weak       → attention (your turn: someone has to decide)
 *   off        → neutral (a fact about the clause, not a verdict)
 */
const POS_META: Record<Position, { label: string; bg: string; fg: string; border: string; title: string }> = {
  market:     { label: 'MARKET', bg: '#D1FAE5', fg: '#065F46', border: '#A7F3D0', title: 'In line with common market practice' },
  aggressive: { label: 'AGGR.',  bg: '#FEE2E2', fg: '#7F1D1D', border: '#FECACA', title: 'Heavily favors one side — review before sending' },
  weak:       { label: 'WEAK',   bg: '#FEF3C7', fg: '#B45309', border: '#FDE68A', title: 'Materially weaker than market — consider tightening' },
  off:        { label: 'OFF',    bg: '#F4F4F2', fg: '#57554F', border: '#D3D2CE', title: 'Not in the standard playbook — custom language' },
  skip:       { label: '',       bg: '',        fg: '',        border: '',        title: '' },
}

function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i) // eslint-disable-line no-bitwise
  return (h >>> 0).toString(36)  // eslint-disable-line no-bitwise
}

const ClassifierKey = new PluginKey<{
  decos:   DecorationSet
  results: Map<string, ClassifyResult>
  pending: Set<string>
}>('clauseClassifier')

function badgeElement(pos: Position, reasoning: string, keyTerm?: string, category?: string, paragraphText?: string): HTMLElement | null {
  if (pos === 'skip') return null
  const meta = POS_META[pos]
  const wrap = document.createElement('span')
  wrap.className = 'clause-classifier-badge'
  wrap.setAttribute('contenteditable', 'false')
  wrap.setAttribute('data-testid', `clause-badge-${pos}`)
  wrap.setAttribute('data-position', pos)
  wrap.style.cssText = `
    display: inline-flex; align-items: center; justify-content: center;
    background: ${meta.bg}; color: ${meta.fg}; border: 1px solid ${meta.border};
    font-size: 8.5px; font-weight: 600; letter-spacing: 0.04em;
    padding: 1px 4px; border-radius: 3px; margin-right: 6px;
    position: absolute; left: -64px; top: 4px;
    user-select: none; cursor: pointer; white-space: nowrap;
    pointer-events: auto;
  `
  wrap.textContent = meta.label
  const tip = [meta.title, reasoning, keyTerm ? `Key: ${keyTerm}` : '']
    .filter(Boolean).join('\n')
  wrap.title = tip
  // P6.5 — click dispatches a custom event; the container page listens
  // and opens the deviation popover anchored at the click point.
  wrap.addEventListener('click', (e) => {
    e.stopPropagation()
    e.preventDefault()
    const rect = wrap.getBoundingClientRect()
    const detail = {
      position: pos,
      category: category ?? '',
      reasoning,
      keyTerm:  keyTerm ?? '',
      paragraphText: paragraphText ?? '',
      anchor: { top: rect.bottom + window.scrollY + 4, left: rect.left + window.scrollX },
    }
    window.dispatchEvent(new CustomEvent('clause-deviation-click', { detail }))
  })
  return wrap
}

export const ClauseClassifier = Extension.create<ClauseClassifierOptions>({
  name: 'clauseClassifier',

  addOptions() {
    return {
      contractType: 'general commercial',
      enabled:      true,
      debounceMs:   1500,
      maxParagraphsPerDoc: 12,
    }
  },

  addProseMirrorPlugins() {
    const opts = this.options

    let timer: ReturnType<typeof setTimeout> | null = null
    const inflight = new Set<string>()

    const classify = async (view: EditorView, hash: string, text: string, sectionHint: string | null) => {
      if (inflight.has(hash)) return
      inflight.add(hash)
      try {
        const res = await api.post<ClassifyResult>('/agent/classify-clause', {
          clauseText:   text,
          contractType: opts.contractType,
          sectionHint:  sectionHint ?? undefined,
        })
        view.dispatch(view.state.tr.setMeta('classifierResult', { hash, result: res.data }))
      } catch { /* non-fatal */ }
      finally { inflight.delete(hash) }
    }

    // Walk paragraphs + schedule classification for fresh ones.
    const scheduleScan = (view: EditorView) => {
      if (!opts.enabled) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const plug = ClassifierKey.getState(view.state)
        if (!plug) return
        let budget = opts.maxParagraphsPerDoc
        let sectionHint: string | null = null

        view.state.doc.descendants((node, _pos) => {
          if (budget <= 0) return false
          // Track the most recent heading so we can pass a section hint
          if (node.type.name.startsWith('heading')) {
            sectionHint = (node.textContent || '').slice(0, 120) || sectionHint
            return false
          }
          if (node.type.name !== 'paragraph') return true
          const text = (node.textContent || '').trim()
          if (text.length < 80) return false        // too short to classify
          const h = djb2(text)
          if (plug.results.has(h) || plug.pending.has(h)) return false
          budget--
          plug.pending.add(h)
          classify(view, h, text, sectionHint)
          return false
        })
      }, opts.debounceMs)
    }

    const decorate = (state: import('@tiptap/pm/state').EditorState, results: Map<string, ClassifyResult>): DecorationSet => {
      const decos: Decoration[] = []
      state.doc.descendants((node, pos) => {
        if (node.type.name !== 'paragraph') return true
        const text = (node.textContent || '').trim()
        if (text.length < 80) return false
        const h = djb2(text)
        const r = results.get(h)
        if (!r || r.position === 'skip') return false
        const deco = Decoration.widget(
          pos + 1,
          () => {
            const el = badgeElement(r.position, r.reasoning, r.keyTerm, r.category, text)
            return el ?? document.createComment('')
          },
          { side: -1, ignoreSelection: true },
        )
        decos.push(deco)
        return false
      })
      return DecorationSet.create(state.doc, decos)
    }

    return [
      new Plugin({
        key: ClassifierKey,
        state: {
          init: () => ({
            decos:   DecorationSet.empty,
            results: new Map<string, ClassifyResult>(),
            pending: new Set<string>(),
          }),
          apply(tr, value, _old, newState) {
            const meta = tr.getMeta('classifierResult') as { hash: string; result: ClassifyResult } | undefined
            if (meta) {
              const results = new Map(value.results)
              const pending = new Set(value.pending)
              results.set(meta.hash, meta.result)
              pending.delete(meta.hash)
              return { decos: decorate(newState, results), results, pending }
            }
            if (tr.docChanged) {
              // Re-draw decorations against the new doc (results stay valid
              // since they're hashed by text).
              return { ...value, decos: decorate(newState, value.results) }
            }
            return value
          },
        },
        props: {
          decorations(state) { return this.getState(state)?.decos ?? DecorationSet.empty },
        },
        view(view) {
          // Kick an initial scan after mount.
          setTimeout(() => scheduleScan(view), 300)
          return {
            update(view, prev) {
              if (view.state.doc !== prev.doc) scheduleScan(view)
            },
            destroy() { if (timer) clearTimeout(timer) },
          }
        },
      }),
    ]
  },
})

export default ClauseClassifier
