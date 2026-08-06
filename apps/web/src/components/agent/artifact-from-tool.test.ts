/**
 * The playbook_check artifact renderer, against the response shape the API
 * actually sends.
 *
 * Phase 0 changed that shape: `passed` went from a COUNT of passing rules to a
 * boolean verdict, the counts moved to passedCount/failedCount, and the API
 * gained `summary` and `uncovered`. Typechecking the renderer proves nothing
 * here — `Number(someBoolean)` compiles perfectly and renders "1 passed" for
 * every clause in the document.
 *
 * These fixtures are copied from real `playbook_check` responses.
 */
import { describe, it, expect } from 'vitest'
import { artifactFromToolResult } from './artifact-from-tool'

/** Post-Phase-0 response: verdict booleans, explicit counts, summary, uncovered. */
const CURRENT = {
  name: 'playbook_check',
  result: {
    contract: { id: 'c1', title: 'Vendor MSA', type: 'MSA', totalClauses: 43 },
    summary: {
      // checkedClauses always equals checks.length — buildSummary derives it
      // from the same array. Keep the fixture consistent with what the API
      // can actually emit, or the test asserts against a response that does
      // not exist.
      worstSeverity: 'critical', deviationCount: 1, checkedClauses: 2,
      coveredClauses: 2, uncoveredClauses: 41, totalClauses: 43,
      truncated: false, requiresHumanGate: true,
    },
    checks: [
      {
        clauseId: 'cl1', clauseType: 'limitation_of_liability', sectionRef: '5.2',
        riskRating: 'unfavorable', worstSeverity: 'critical',
        category: { id: 'cat1', name: 'Limitation of Liability' },
        violations: [{ passed: false, severity: 'critical' }, { passed: true, severity: 'low' }],
        passed: false, passedCount: 1, failedCount: 1, failed: 1,
      },
      {
        clauseId: 'cl2', clauseType: 'governing_law', sectionRef: '12.1',
        riskRating: 'neutral', worstSeverity: null,
        category: { id: 'cat2', name: 'Governing Law' },
        violations: [{ passed: true, severity: 'high' }, { passed: true, severity: 'high' }],
        passed: true, passedCount: 2, failedCount: 0, failed: 0,
      },
    ],
    uncovered: [
      { clauseId: 'cl3', clauseType: 'confidentiality', sectionRef: '8.1', reason: 'positions_have_no_rules' },
    ],
    unmapped: ['exotic_clause'],
  },
}

describe('playbook_check artifact', () => {
  it('renders rule tallies from the counts, not from the verdict', () => {
    const a = artifactFromToolResult(CURRENT) as { rows: Array<Record<string, string>> }
    expect(a).toBeTruthy()
    // Reading `passed` as a number here would print "1 passed" for the first
    // row (Number(false) === 0 → "0 passed") and "1 passed" for the second.
    expect(a.rows[0].violations).toBe('1 failed / 1 passed')
    expect(a.rows[1].violations).toBe('0 failed / 2 passed')
  })

  it('reports how much of the document was actually examined', () => {
    const a = artifactFromToolResult(CURRENT) as { subtitle: string }
    // "3 clauses checked" alone was the misleading half — it read as full
    // coverage of a 43-clause contract.
    expect(a.subtitle).toContain('2 of 43 clauses checked')
    expect(a.subtitle).toContain('1 not covered by the playbook')
    expect(a.subtitle).toContain('1 unmapped clause type')
  })

  it('says so when results were truncated', () => {
    const truncated = {
      ...CURRENT,
      result: { ...CURRENT.result, summary: { ...CURRENT.result.summary, truncated: true } },
    }
    const a = artifactFromToolResult(truncated) as { subtitle: string }
    expect(a.subtitle).toContain('results truncated')
  })

  it('carries the worst severity per clause', () => {
    const a = artifactFromToolResult(CURRENT) as { rows: Array<Record<string, string>> }
    expect(a.rows[0].worstSeverity).toBe('critical')
    expect(a.rows[1].worstSeverity).toBe('—')
  })

  it('still renders a pre-Phase-0 payload without crashing', () => {
    // An agent turn can replay a tool result recorded before the API changed,
    // and a stale browser tab can receive one from a rolling deploy. Degrading
    // is fine; throwing is not.
    const legacy = {
      name: 'playbook_check',
      result: {
        contract: { id: 'c1', title: 'Old', type: 'NDA', totalClauses: 2 },
        checks: [{
          clauseType: 'limitation_of_liability', sectionRef: '5.2',
          riskRating: 'unfavorable', worstSeverity: 'high',
          category: { id: 'cat1', name: 'Limitation of Liability' },
          violations: [{ passed: false, severity: 'high' }],
          passed: 0, failed: 1,          // the old numeric semantics
        }],
        unmapped: [],
      },
    }
    const a = artifactFromToolResult(legacy) as { rows: Array<Record<string, string>>; subtitle: string }
    expect(a).toBeTruthy()
    expect(a.rows[0].violations).toBe('1 failed / 0 passed')
    expect(a.subtitle).toContain('clauses checked')
  })

  it('returns null when there is nothing to show', () => {
    expect(artifactFromToolResult({ name: 'playbook_check', result: { checks: [] } })).toBeNull()
  })
})
