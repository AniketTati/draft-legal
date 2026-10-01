/**
 * docs/39 H2 — a draft's variables, kept in its text.
 *
 * The template engine marks each value it fills in, and each blank it
 * leaves, with its variable: <span data-variable="key">. The canvas keeps
 * those spans as a mark — TipTap drops spans it has no mark for, and the
 * draft forgot which words were its terms — so the draft's Variables panel
 * can find a term everywhere it appears and change it once. Drafts made
 * before values were marked mark only their blanks
 * (span.template-variable-unfilled with data-key); those are read too.
 */
import { Mark, type Editor } from '@tiptap/react'
import type { Node as PMNode } from '@tiptap/pm/model'

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

export const Variable = Mark.create({
  name: 'variable',
  // Words typed just after a term aren't the term.
  inclusive: false,

  addAttributes() {
    return {
      key: {
        default: null,
        parseHTML: el => el.getAttribute('data-variable') ?? el.getAttribute('data-key'),
        renderHTML: attrs => ({ 'data-variable': attrs.key }),
      },
      // Still the template's blank ("[[key]]"), as the engine left it.
      unfilled: {
        default: false,
        parseHTML: el => el.classList.contains('template-variable-unfilled'),
        renderHTML: attrs => (attrs.unfilled ? { class: 'template-variable-unfilled', 'data-key': attrs.key } : {}),
      },
    }
  },

  parseHTML() {
    return [
      { tag: 'span[data-variable]', getAttrs: el => (KEY.test(el.getAttribute('data-variable') ?? '') ? null : false) },
      { tag: 'span.template-variable-unfilled[data-key]', getAttrs: el => (KEY.test(el.getAttribute('data-key') ?? '') ? null : false) },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, 0]
  },
})

/** A place a variable appears: one run of its marked words. */
export interface VariablePlace {
  key: string
  from: number
  to: number
  text: string
  unfilled: boolean
}

/** Every place a variable appears, in the order the text has them. */
export function variablePlaces(doc: PMNode): VariablePlace[] {
  const out: VariablePlace[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    const mark = node.marks.find(m => m.type.name === 'variable')
    const key = mark?.attrs.key as string | null | undefined
    if (!key) return false
    const last = out[out.length - 1]
    // A term partly in bold is two text nodes, one place.
    if (last && last.key === key && last.to === pos) {
      last.to = pos + node.nodeSize
      last.text += node.text ?? ''
      last.unfilled = last.unfilled && !!mark!.attrs.unfilled
    } else {
      out.push({ key, from: pos, to: pos + node.nodeSize, text: node.text ?? '', unfilled: !!mark!.attrs.unfilled })
    }
    return false
  })
  return out
}

/**
 * Put `text` in every place `key` appears, as one change the editor can
 * undo; each place keeps its other marks (bold stays bold). Returns how
 * many places changed.
 */
export function setVariableText(editor: Editor, key: string, text: string): number {
  const type = editor.schema.marks.variable
  const places = variablePlaces(editor.state.doc).filter(p => p.key === key)
  if (!type || !places.length || !text) return 0
  const tr = editor.state.tr
  // The last first: a change leaves the places before it where they were.
  for (const p of [...places].reverse()) {
    tr.insertText(text, p.from, p.to)
    tr.removeMark(p.from, p.from + text.length, type)
    tr.addMark(p.from, p.from + text.length, type.create({ key, unfilled: false }))
  }
  editor.view.dispatch(tr)
  return places.length
}
