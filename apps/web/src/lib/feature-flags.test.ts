import { describe, it, expect } from 'vitest'
import { MARGIN_CLASSIFIER_ENABLED } from './feature-flags'

describe('feature flags (docs/41 P0.5)', () => {
  it('the "market" margin badges are off unless the build turns them on', () => {
    expect(MARGIN_CLASSIFIER_ENABLED).toBe(false)
  })
})
