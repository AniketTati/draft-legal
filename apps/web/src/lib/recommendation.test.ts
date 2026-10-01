import { describe, it, expect } from 'vitest'
import { recommendationText } from './recommendation'

describe('recommendationText (docs/41 P0.2)', () => {
  it('"Ready to approve" only for the label the guard let through', () => {
    expect(recommendationText('approve')).toBe('Ready to approve')
    expect(recommendationText('cant_recommend', ['this contract has not been analysed'])).toBe("Can't recommend — this contract has not been analysed")
    expect(recommendationText('cant_recommend', [])).toBe("Can't recommend")
  })
  it('the other labels', () => {
    expect(recommendationText('review_required')).toBe('Review required')
    expect(recommendationText(null)).toBeNull()
    expect(recommendationText('something new')).toBe('Review required')
  })
})
