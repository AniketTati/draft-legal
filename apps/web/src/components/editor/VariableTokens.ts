/**
 * docs/39 H1 — a template's {{key}} tokens, shown as what they are.
 *
 * In the template editor a variable was only its typed text. Each {{key}}
 * is now drawn as a chip (a decoration: the stored HTML is unchanged), and
 * one the variables list lacks — or typed with spaces, which the engine
 * doesn't fill — is marked so the author sees it won't be filled.
 */
import { Extension } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const variableTokensKey = new PluginKey('variableTokens')

const TOKEN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g
const KNOWN = 'rounded-sm bg-paper-100 px-0.5 font-mono text-[0.9em] text-ink-700 ring-1 ring-paper-300'
const UNKNOWN = 'rounded-sm bg-attention-50 px-0.5 font-mono text-[0.9em] text-attention-800 ring-1 ring-attention-200'

export const VariableTokens = Extension.create<{ known: () => ReadonlySet<string> }>({
  name: 'variableTokens',
  addOptions() {
    return { known: () => new Set<string>() }
  },
  addProseMirrorPlugins() {
    const known = this.options.known
    return [new Plugin({
      key: variableTokensKey,
      props: {
        decorations: state => {
          const decos: Decoration[] = []
          const keys = known()
          state.doc.descendants((node, pos) => {
            if (!node.isText || !node.text) return
            for (const m of node.text.matchAll(TOKEN)) {
              const from = pos + (m.index ?? 0)
              const filled = keys.has(m[1]) && m[0] === `{{${m[1]}}}`
              decos.push(Decoration.inline(from, from + m[0].length, {
                class: filled ? KNOWN : UNKNOWN,
                title: filled ? `Variable: ${m[1]}` : keys.has(m[1]) ? 'Written with spaces: the draft won’t fill it' : 'Not in the variables list: the draft won’t fill it',
              }))
            }
          })
          return DecorationSet.create(state.doc, decos)
        },
      },
    })]
  },
})
