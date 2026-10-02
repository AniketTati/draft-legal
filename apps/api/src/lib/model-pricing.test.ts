import { describe, it, expect } from 'vitest'
import { priceOf, tokenCostUsd } from './model-pricing.js'

describe('model pricing (docs/39 A15)', () => {
  it('prices a model by its family, the more specific name first', () => {
    expect(priceOf('gemini-2.5-flash')).toEqual({ input: 0.30, output: 2.50 })
    expect(priceOf('gemini-2.5-flash-lite')).toEqual({ input: 0.10, output: 0.40 })
    expect(priceOf('gpt-4o-mini-2024-07-18')).toEqual({ input: 0.15, output: 0.60 })
    expect(priceOf('gpt-4o')).toEqual({ input: 2.50, output: 10 })
  })

  it('costs an unknown model high rather than low', () => {
    expect(priceOf('some-new-model')).toEqual({ input: 3, output: 15 })
  })

  it('costs tokens in dollars', () => {
    // 100k in and 10k out of gemini-2.5-flash: 0.03 + 0.025
    expect(tokenCostUsd('gemini-2.5-flash', 100_000, 10_000)).toBeCloseTo(0.055, 6)
    expect(tokenCostUsd('gemini-2.5-flash', -5, 0)).toBe(0)
  })
})
