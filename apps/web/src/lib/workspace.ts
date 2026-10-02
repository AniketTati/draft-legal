/**
 * docs/41 Parts 15, 16 (C2) — the contract workspace: where a contract opens.
 *
 * Decision: a contract being worked on (stage draft, negotiate or approve)
 * opens in the full-screen workspace at /contracts/:id/workspace: the
 * document in the middle, the Review / Details / Comments panel on the right,
 * the status banner on top. Every other stage (a request, a contract out for
 * signature, an active or closed one) opens the contract page, which is a
 * record to read more than a document to work on, and which offers "Open
 * workspace" for the times someone does want to work on it.
 */

/** The stages a contract opens in the workspace. */
export const WORKSPACE_STAGES = ['draft', 'negotiate', 'approve'] as const

export const workspacePath = (id: string, opts: { changes?: boolean } = {}) =>
  `/contracts/${id}/workspace${opts.changes ? '?mode=changes' : ''}`

/** Where a contract opens from a list or a link: the workspace while it is worked on. */
export function openPathFor(c: { id: string; stage?: string | null }): string {
  return c.stage && (WORKSPACE_STAGES as readonly string[]).includes(c.stage) ? workspacePath(c.id) : `/contracts/${c.id}`
}

export type WorkspacePanel = 'review' | 'details' | 'comments'
export const WORKSPACE_PANELS: Array<{ id: WorkspacePanel; label: string }> = [
  { id: 'review', label: 'Review' },
  { id: 'details', label: 'Details' },
  { id: 'comments', label: 'Comments' },
]

/** Briefly mark an element the person was taken to (a clause a finding is about). */
export function flash(el: HTMLElement, ms = 1500) {
  el.classList.add('ring-2', 'ring-attention-600')
  setTimeout(() => el.classList.remove('ring-2', 'ring-attention-600'), ms)
}

/**
 * Take the person to what a finding is about: the clause the risk layer
 * marked, else the clause's words, else the finding's quote. Returns whether
 * it was found in the document.
 */
export function jumpTo(
  target: { clauseId?: string | null; quote?: string | null },
  ctx: {
    root: ParentNode
    clauses: Array<{ id: string; content: string }>
    reveal: (text: string) => boolean
  },
): boolean {
  if (target.clauseId) {
    const el = ctx.root.querySelector(`[data-clause-id="${target.clauseId.replace(/["\\]/g, "\\$&")}"]`) as HTMLElement | null
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      flash(el)
      return true
    }
    const content = ctx.clauses.find(c => c.id === target.clauseId)?.content
    if (content && ctx.reveal(content)) return true
  }
  return !!target.quote && ctx.reveal(target.quote)
}
