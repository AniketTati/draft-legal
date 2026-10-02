/**
 * docs/41 Part 16 — the selection menu: Comment · Ask AI · Tag clause · Make
 * variable · Request exception, each only for who may use it; Request
 * exception only inside a clause with an open finding. Ask AI's drafts are
 * paged "1 of 3" with a reason each. Rendered to a string (no browser).
 */
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { selectionItems, type TextSelection } from '@/components/contracts/SelectionMenu'
import { AskAiDrafts, pageOf } from '@/components/contracts/AskAiDrafts'
import { exceptionFindingAt } from './selection-pieces'

const sel = (text = 'Liability is capped at fees paid in the prior twelve months.'): TextSelection =>
  ({ text, occurrence: 0, rect: { top: 100, bottom: 120, left: 10, right: 200 } })
const noop = () => {}

describe('what the selection menu offers', () => {
  it('in order: Comment · Ask AI · Tag clause · Make variable · Request exception', () => {
    const ids = selectionItems(sel(), {
      onComment: noop, onAskAi: noop, onTagClause: noop, onMakeVariable: noop,
      exceptionAt: () => ({ title: 'Cap below our floor', run: noop }),
    }).map(i => i.id)
    expect(ids).toEqual(['comment', 'ask-ai', 'tag-clause', 'make-variable', 'request-exception'])
  })

  it('leaves out what someone may not do, and Make variable outside our own template drafts', () => {
    // A reader: comment only (the hook passes nothing else).
    expect(selectionItems(sel(), { onComment: noop }).map(i => i.id)).toEqual(['comment'])
    expect(selectionItems(sel(), { onComment: noop, onAskAi: noop }).map(i => i.id)).not.toContain('make-variable')
  })

  it('offers Request exception only when the words lie in a clause with an open finding', () => {
    expect(selectionItems(sel(), { onComment: noop, exceptionAt: () => null }).map(i => i.id)).toEqual(['comment'])
  })

  it('keeps the field actions after, and Save to library only for a sentence', () => {
    const ids = selectionItems(sel('USD 1,000'), { onComment: noop, onSetField: noop, onSaveToLibrary: noop }).map(i => i.id)
    expect(ids).toEqual(['comment', 'set-field'])
  })
})

describe('the finding a selection can ask an exception for', () => {
  const clauses = [
    { id: 'c1', content: 'Liability is capped at fees paid in the   prior twelve months. No indirect losses.' },
    { id: 'c2', content: 'This Agreement is governed by the laws of England.' },
  ]
  const findings = [
    { id: 'f1', title: 'Cap below our floor', clauseId: 'c1', actions: ['accept', 'request_exception', 'resolve'] as const },
    { id: 'f2', title: 'Governing law', clauseId: 'c2', actions: ['resolve'] as const },
  ].map(f => ({ ...f, actions: [...f.actions] }))

  it('is the open finding of the clause holding the words, whitespace ignored', () => {
    expect(exceptionFindingAt('capped at fees paid in the prior twelve', clauses, findings)?.id).toBe('f1')
  })
  it('is none in a clause whose finding offers no exception, or outside any clause', () => {
    expect(exceptionFindingAt('governed by the laws', clauses, findings)).toBeNull()
    expect(exceptionFindingAt('words not in any clause', clauses, findings)).toBeNull()
  })
})

describe('Ask AI drafts', () => {
  const initial = {
    suggestionId: 's1',
    drafts: [
      { id: 'd1', text: 'Either party may terminate on 30 days notice.', rationale: 'Mutual, with a month to prepare.' },
      { id: 'd2', text: 'Either party may terminate on 60 days notice.', rationale: 'Longer.' },
      { id: 'd3', text: 'Either party may terminate for convenience.', rationale: 'Simplest.' },
    ],
  }
  it('shows the first of three with its reason and the three actions', () => {
    const html = renderToString(
      <QueryClientProvider client={new QueryClient()}>
        <AskAiDrafts contractId="k" selectedText="x" initial={initial} onInsertTracked={noop} onReplace={noop} />
      </QueryClientProvider>,
    ).replace(/<!-- -->/g, '')
    expect(html).toContain('1 of 3')
    expect(html).toContain('Why: Mutual, with a month to prepare.')
    for (const a of ['Insert as tracked change', 'Replace', 'Copy']) expect(html).toContain(a)
    expect(html).toContain('data-testid="ask-ai-instruction"')
  })
  it('pages round: next from the last is the first, back from the first is the last', () => {
    expect(pageOf(3, 3)).toBe(0)
    expect(pageOf(-1, 3)).toBe(2)
    expect(pageOf(1, 3)).toBe(1)
    expect(pageOf(5, 0)).toBe(0)
  })
})
