import { describe, it, expect } from 'vitest'
import { recommendationText } from './recommendation'

describe('recommendationText (docs/41 P0.2)', () => {
  it('"Ready to approve" only for the label the guard let through', () => {
    expect(recommendationText('approve')).toBe('Ready to approve')
    expect(recommendationText('cant_recommend', ['this contract has not been analysed'])).toBe("Can't recommend — this contract has not been analysed")
    expect(recommendationText('cant_recommend', [])).toBe("Can't recommend")
  })
  it('the policy\'s labels (docs/41 P1), with their first reason', () => {
    expect(recommendationText('ready_to_approve')).toBe('Ready to approve')
    expect(recommendationText('review', ['Governing Law — deleted since v4 (required)'])).toBe('Review — Governing Law — deleted since v4 (required)')
    expect(recommendationText('needs_exception', [])).toBe('Needs exception')
    expect(recommendationText('escalate', ['Limitation of Liability: not one of your positions'])).toBe('Escalate — Limitation of Liability: not one of your positions')
  })
  it('the labels of approvals decided before', () => {
    expect(recommendationText('review_required')).toBe('Review required')
    expect(recommendationText(null)).toBeNull()
    expect(recommendationText('something new')).toBe('Review')
  })
})
