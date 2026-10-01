/**
 * docs/41 P1 — the Review panel renders a review as the API sends it: the
 * recommendation with its reasons, the findings with their evidence and
 * actions, the labels with their definitions, and no "market" anywhere.
 * Rendered to a string (no browser), from a cached response.
 */
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReviewPanel } from './ReviewPanel'
import type { ContractReview } from '@/lib/review'

const REVIEW: ContractReview = {
  versionId: 'v2', versionNumber: 2, isCurrent: true,
  analysis: { kind: 'done' },
  run: { id: 'r', status: 'done', versionNumber: 2, failedStepLabel: null, error: null, current: null, stuck: false },
  stale: null,
  playbook: { id: 'pb', name: 'Sales NDA', why: 'default_for_type', explanation: 'Using Sales NDA, the default for NDA contracts.', candidates: [] },
  baseline: { versionId: 'v1', versionNumber: 1, reason: 'sent', words: 'the last version sent to the counterparty' },
  recommendation: { label: 'review', text: 'Review', definition: 'Something needs a person.', reasons: [{ code: 'review', text: 'Governing Law — deleted since v1 (required)', findingIds: ['f1'] }] },
  groups: {
    needsAttention: [{
      id: 'f1', kind: 'deleted', severity: 'high', status: 'open', source: 'deterministic',
      title: 'Governing Law — deleted since v1 (required)', explanation: 'This clause was in v1 and is not in this version.',
      evidence: { baselineQuote: 'This Agreement is governed by the laws of New York.' },
      clauseId: null, clauseType: 'governing_law', reviewStatus: 'deleted', label: 'Deleted since v1', definition: 'This clause was in v1 and is not in this version.',
      resolutionNote: null, actions: ['insert_standard', 'accept', 'resolve'],
    }, {
      id: 'f2', kind: 'position_fallback', severity: 'low', status: 'open', source: 'llm',
      title: 'Confidentiality: your fallback position', explanation: 'Three years is your fallback.',
      evidence: { quote: 'obligations last three years' },
      clauseId: 'c1', clauseType: 'confidentiality', reviewStatus: 'fallback', label: 'Fallback', definition: 'It reaches only your fallback position.',
      resolutionNote: null, actions: ['redline', 'accept', 'resolve'],
    }],
    notDetected: [],
    accepted: [],
  },
  clauses: [{ id: 'c2', clauseType: 'termination', clauseLabel: 'Termination', sectionRef: '4', excerpt: 'x', reviewStatus: 'standard', label: 'Standard', definition: 'From template Mutual NDA v3, unchanged.' }],
  counts: { needsAttention: 2, notDetected: 0, accepted: 0, standard: 1, clauses: 3, fixable: 1 },
}

function render(review: ContractReview, canEdit = true) {
  const qc = new QueryClient()
  qc.setQueryData(['contract-review', 'k1'], review)
  return renderToString(
    <QueryClientProvider client={qc}>
      <ReviewPanel contractId="k1" contractMetadata={{}} canEdit={canEdit} onJumpToClause={() => {}} />
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '')
}

describe('ReviewPanel', () => {
  it('shows the recommendation, the playbook and baseline, and each finding with its evidence and actions', () => {
    const html = render(REVIEW)
    expect(html).toContain('data-label="review"')
    expect(html).toContain('Worked out from the findings below by fixed rules, not by AI.')
    expect(html).toContain('Using Sales NDA, the default for NDA contracts.')
    expect(html).toContain('Compared with v1 (the last version sent to the counterparty).')
    expect(html).toContain('This Agreement is governed by the laws of New York.')
    expect(html).toContain('title="This clause was in v1 and is not in this version."')
    expect(html).toContain('Insert standard language')
    expect(html).toContain('Redline to your position')
    expect(html).toContain('Fix all fixable (1)')
    expect(html.toLowerCase()).not.toContain('market')
  })

  it('without the right to edit, offers no actions', () => {
    const html = render(REVIEW, false)
    expect(html).not.toContain('Accept as is')
    expect(html).not.toContain('Fix all fixable')
  })

  it("says when the analysis is for an older version", () => {
    const html = render({ ...REVIEW, analysis: { kind: 'stale', analysedVersionNumber: 1 }, recommendation: { label: 'cant_recommend', text: "Can't recommend", definition: 'x', reasons: [] }, stale: { analysedVersionNumber: 1, run: { ...REVIEW.run!, status: 'running', current: { label: 'reading', index: 1, of: 4 } } } })
    expect(html).toContain('Analysis is for v1 — v2 has changes. Re-analysing…')
  })
})
