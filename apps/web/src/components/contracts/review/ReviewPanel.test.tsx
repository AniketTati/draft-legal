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
import type { ContractReview, ReviewFindingView } from '@/lib/review'

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
    compliance: [],
    drafting: [],
    accepted: [],
  },
  clauses: [{ id: 'c2', clauseType: 'termination', clauseLabel: 'Termination', sectionRef: '4', excerpt: 'x', reviewStatus: 'standard', label: 'Standard', definition: 'From template Mutual NDA v3, unchanged.' }],
  counts: { needsAttention: 2, notDetected: 0, compliance: 0, drafting: 0, accepted: 0, standard: 1, clauses: 3, fixable: 1 },
}

function render(review: ContractReview, canEdit = true, definedTerms?: React.ReactNode) {
  const qc = new QueryClient()
  qc.setQueryData(['contract-review', 'k1'], review)
  return renderToString(
    <QueryClientProvider client={qc}>
      <ReviewPanel contractId="k1" contractMetadata={{}} canEdit={canEdit} onJumpToClause={() => {}} onShowText={() => {}} definedTerms={definedTerms} />
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '')
}

const COMPLIANCE_GAP = {
  id: 'f3', kind: 'compliance', severity: 'high' as const, status: 'open', source: 'llm' as const,
  title: 'GDPR: Breach notice — missing', explanation: 'No breach notice. Add one. GDPR applies to this contract: personal data.',
  evidence: { relatedQuote: 'Supplier will process employee personal data' },
  clauseId: null, clauseType: null, reviewStatus: 'compliance_gap', label: 'Compliance gap', definition: 'A requirement of a compliance framework that applies.',
  resolutionNote: null, actions: ['accept' as const, 'resolve' as const],
}
const DRAFTING = {
  id: 'f4', kind: 'drafting', severity: 'low' as const, status: 'open', source: 'deterministic' as const,
  title: '“Exclusions” is defined but not used.', explanation: 'Remove the definition, or check whether the clause that used it was deleted.',
  evidence: { quote: '“Exclusions” means the matters in Schedule 2.' },
  clauseId: null, clauseType: null, reviewStatus: 'drafting', label: 'Drafting', definition: 'How the contract is written.',
  resolutionNote: null, actions: ['accept' as const, 'resolve' as const],
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

  it('lists compliance gaps and drafting problems in groups of their own, with the glossary under Drafting', () => {
    const html = render({
      ...REVIEW,
      groups: { ...REVIEW.groups, compliance: [COMPLIANCE_GAP], drafting: [DRAFTING] },
      counts: { ...REVIEW.counts, compliance: 1, drafting: 1 },
    }, true, <div data-testid="glossary-slot">Defined terms (4)</div>)
    expect(html).toContain('data-testid="review-group-compliance"')
    expect(html).toContain('GDPR: Breach notice — missing')
    expect(html).toContain('Why it applies')
    expect(html).toContain('data-testid="review-group-drafting"')
    expect(html).toContain('“Exclusions” is defined but not used.')
    expect(html).toContain('title="Show in the document"')
    expect(html).toContain('data-testid="glossary-slot"')
    // Drafting problems aren't counted in the panel's header; compliance gaps are.
    expect(html).toMatch(/data-testid="rail-section-count-review"[^>]*>3</)
  })

  it('says so when no defined-term problems were found', () => {
    const html = render(REVIEW, true, <div>glossary</div>)
    expect(html).toContain('No problems with defined terms.')
  })

  it('offers "Request exception" where the API does, and says who a requested one waits for (docs/41 Part 7)', () => {
    const asking = { ...REVIEW.groups.needsAttention[1], actions: ['redline', 'accept', 'request_exception', 'resolve'] as ReviewFindingView['actions'] }
    const waiting = { ...REVIEW.groups.needsAttention[1], id: 'f5', status: 'exception_requested', categoryId: 'cat-child', actions: ['accept', 'resolve'] as ReviewFindingView['actions'] }
    const declined = { ...REVIEW.groups.needsAttention[1], id: 'f6', status: 'exception_declined', actions: ['request_exception', 'resolve'] as ReviewFindingView['actions'] }
    const qc = new QueryClient()
    qc.setQueryData(['contract-review', 'k1'], { ...REVIEW, groups: { ...REVIEW.groups, needsAttention: [asking, waiting, declined] } })
    // Who a pending one waits for comes with it from the API (the clause approver when it was asked).
    qc.setQueryData(['contract-approval', 'k1'], { current: null, history: [], exceptions: [
      { id: 's5', findingId: 'f5', clauseType: 'confidentiality', title: 'x', status: 'PENDING', requestedBy: 'Sam', reason: 'Needed', decidedBy: null, comment: null, decidedAt: null, createdAt: '', waitingFor: 'anyone with the Legal role' },
      { id: 's6', findingId: 'f6', clauseType: 'confidentiality', title: 'x', status: 'DECLINED', requestedBy: 'Sam', reason: 'Needed', decidedBy: 'Priya Shah', comment: 'Keep five years', decidedAt: null, createdAt: '' },
    ] })
    const html = renderToString(
      <QueryClientProvider client={qc}>
        <ReviewPanel contractId="k1" contractMetadata={{}} canEdit onJumpToClause={() => {}} />
      </QueryClientProvider>,
    ).replace(/<!-- -->/g, '')
    expect(html).toContain('data-testid="finding-request-exception-f2"')
    expect(html).toContain('>Request exception<')
    expect(html).toContain('Exception requested — waiting for anyone with the Legal role')
    expect(html).toContain('Exception declined by Priya Shah: “Keep five years”')
    expect(html).toContain('Request exception again')
  })

  it("says when the analysis is for an older version", () => {
    const html = render({ ...REVIEW, analysis: { kind: 'stale', analysedVersionNumber: 1 }, recommendation: { label: 'cant_recommend', text: "Can't recommend", definition: 'x', reasons: [] }, stale: { analysedVersionNumber: 1, run: { ...REVIEW.run!, status: 'running', current: { label: 'reading', index: 1, of: 4 } } } })
    expect(html).toContain('Analysis is for v1 — v2 has changes. Re-analysing…')
  })
})
