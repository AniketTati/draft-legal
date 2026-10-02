/**
 * docs/41 Part 15 (C2) — Changes mode: the changes in a diff, what each
 * decision does to the draft changes, the finding a change is about, and the
 * view that lists them with their actions (rendered to a string, the API
 * mocked by cached responses).
 */
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { applyDecisions, changeKey, changesOf, findingFor, taggedDiff } from './changes'
import { ChangesView, changesKey, type ChangesResponse } from '@/components/contracts/workspace/ChangesView'
import type { ContractReview } from './review'

// DOMPurify needs a browser; the markup here is the test's own.
vi.mock('@/lib/sanitize', () => ({ sanitizeHtml: (s: string) => s }))

const DIFF = '<p>Liability is <del>capped at the fees paid</del><ins>uncapped</ins>.</p><p>Notices by <ins>email or </ins>post.</p><p><del>Each party bears its own costs.</del></p>'

describe('the changes in a diff', () => {
  it('pairs words replaced, and keeps insertions and deletions on their own', () => {
    expect(changesOf(DIFF).map(c => [c.id, c.before, c.after])).toEqual([
      ['ch0', 'capped at the fees paid', 'uncapped'],
      ['ch1', '', 'email or'],
      ['ch2', 'Each party bears its own costs.', ''],
    ])
    expect(changeKey(changesOf(DIFF)[0])).toBe('capped at the fees paid\u0000uncapped')
  })

  it('tags each change\'s marks so the document can scroll to it', () => {
    expect(taggedDiff(DIFF)).toContain('<del data-change-id="ch0">capped')
    expect(taggedDiff(DIFF)).toContain('<ins data-change-id="ch0">uncapped')
    expect(taggedDiff(DIFF)).toContain('<ins data-change-id="ch1">')
  })
})

describe('a decision applied to the draft changes', () => {
  it('leaves the document as it stands while nothing is decided (their words)', () => {
    expect(applyDecisions(DIFF, {})).toBe('<p>Liability is uncapped.</p><p>Notices by email or post.</p><p></p>')
    expect(applyDecisions(DIFF, { ch0: { kind: 'accept' } })).toBe(applyDecisions(DIFF, {}))
  })

  it('puts the baseline\'s words back on Keep original, and only for that change', () => {
    expect(applyDecisions(DIFF, { ch0: { kind: 'keep' } })).toBe('<p>Liability is capped at the fees paid.</p><p>Notices by email or post.</p><p></p>')
    expect(applyDecisions(DIFF, { ch1: { kind: 'keep' }, ch2: { kind: 'keep' } })).toBe('<p>Liability is uncapped.</p><p>Notices by post.</p><p>Each party bears its own costs.</p>')
  })

  it('puts the counter wording in place of both, as text', () => {
    expect(applyDecisions(DIFF, { ch0: { kind: 'counter', text: 'capped at 2x fees <b>' } }))
      .toBe('<p>Liability is capped at 2x fees &lt;b&gt;.</p><p>Notices by email or post.</p><p></p>')
  })
})

const finding = (over: Record<string, unknown>) => ({
  id: 'f1', kind: 'modified', severity: 'medium', status: 'open', source: 'deterministic', title: 'Limitation of liability — changed since v1',
  explanation: 'The words of this clause changed since v1.', evidence: { quote: 'Liability is uncapped.', baselineQuote: 'Liability is capped at the fees paid.' },
  clauseId: 'c1', clauseType: 'liability', reviewStatus: 'changed', label: 'Changed since v1', definition: '', resolutionNote: null, actions: ['accept', 'resolve'], ...over,
}) as ContractReview['groups']['needsAttention'][number]

describe('the finding a change is about', () => {
  it('is the change finding whose quote holds the new words, else whose baseline quote holds the old', () => {
    const [replaced, , deleted] = changesOf(DIFF)
    const f1 = finding({})
    const f2 = finding({ id: 'f2', kind: 'deleted', evidence: { baselineQuote: 'Each party bears its own costs.' } })
    const other = finding({ id: 'f3', kind: 'drafting', evidence: { quote: 'Liability is uncapped.' } })
    expect(findingFor(replaced, [other, f1, f2])?.id).toBe('f1')
    expect(findingFor(deleted, [other, f1, f2])?.id).toBe('f2')
    expect(findingFor({ before: '', after: 'email or' }, [f1, f2])).toBeNull()
  })
})

describe('the Changes view', () => {
  it('lists each change with its finding, the model\'s advice and the four actions', () => {
    const qc = new QueryClient()
    const changes: ChangesResponse = {
      baseline: { versionId: 'v1', versionNumber: 1, reason: 'sent', words: 'the last version sent to the counterparty' },
      against: { kind: 'version', versionId: 'v2', versionNumber: 2 },
      diffHtml: DIFF, stats: { insertions: 2, deletions: 2 },
      options: { originVersionId: 'v1', versions: [{ id: 'v2', versionNumber: 2, changeNote: null, fromCounterparty: true }, { id: 'v1', versionNumber: 1, changeNote: null, fromCounterparty: false }] },
    }
    qc.setQueryData(changesKey('k1', ''), changes)
    qc.setQueryData(['contract-review', 'k1'], { groups: { needsAttention: [finding({ advice: { recommendation: 'counter', reasoning: 'An uncapped liability is outside your playbook.' } })], notDetected: [], accepted: [], compliance: [], drafting: [] } })
    const html = renderToString(<QueryClientProvider client={qc}><ChangesView contractId="k1" canEdit onApply={vi.fn()} onComment={vi.fn()} /></QueryClientProvider>).replace(/<!-- -->/g, '')
    expect(html).toContain('v1 · the last version sent to the counterparty')
    expect(html).toContain('The template’s first draft')
    expect(html).toMatch(/3 changes to decide/)
    expect(html).toContain('data-testid="change-finding-ch0"')
    expect(html).toContain('AI: Counter. An uncapped liability is outside your playbook.')
    for (const a of ['accept', 'keep', 'counter', 'comment']) expect(html).toContain(`data-testid="change-${a}-ch0"`)
    expect(html).toContain('Word with tracked changes')
    // docs/41 Part 4 — a choice between their words and ours, not an approval verdict: never "Reject".
    const labels = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim())
    expect(labels).toContain('Accept change')
    expect(labels).toContain('Keep original')
    expect(labels.some(l => /reject/i.test(l))).toBe(false)
  })
})
