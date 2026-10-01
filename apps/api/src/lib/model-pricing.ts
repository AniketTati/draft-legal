/**
 * What a model's tokens cost (docs/39 A15), for spend reported in tokens: the
 * extraction's real use, which the agents service measures per model.
 *
 * List prices in USD per million tokens, input and output. A model not listed
 * is costed at the default, which errs high rather than low: this feeds the
 * org's daily cap, and a cap that under-counts is no cap. Update the table when
 * providers change their prices; the first match wins, so a more specific
 * pattern goes before a broader one.
 */
interface Price { input: number; output: number }

const PER_MILLION: Array<{ match: RegExp; price: Price }> = [
  { match: /gemini-2\.5-flash-lite/i, price: { input: 0.10, output: 0.40 } },
  { match: /gemini-2\.5-flash/i,      price: { input: 0.30, output: 2.50 } },
  { match: /gemini-2\.5-pro/i,        price: { input: 1.25, output: 10 } },
  { match: /claude.*haiku/i,          price: { input: 1, output: 5 } },
  { match: /claude.*sonnet/i,         price: { input: 3, output: 15 } },
  { match: /claude.*opus/i,           price: { input: 15, output: 75 } },
  { match: /gpt-4o-mini/i,            price: { input: 0.15, output: 0.60 } },
  { match: /gpt-4o/i,                 price: { input: 2.50, output: 10 } },
  { match: /gpt-4\.1-mini/i,          price: { input: 0.40, output: 1.60 } },
  { match: /gpt-4\.1/i,               price: { input: 2, output: 8 } },
  { match: /gpt-5-mini/i,             price: { input: 0.25, output: 2 } },
  { match: /gpt-5/i,                  price: { input: 1.25, output: 10 } },
]

const DEFAULT_PRICE: Price = { input: 3, output: 15 }

export function priceOf(model: string): Price {
  return PER_MILLION.find(p => p.match.test(model))?.price ?? DEFAULT_PRICE
}

/** USD for this many tokens of `model`, to the millionth of a dollar. */
export function tokenCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceOf(model)
  const usd = (Math.max(0, inputTokens) * p.input + Math.max(0, outputTokens) * p.output) / 1_000_000
  return Math.round(usd * 1_000_000) / 1_000_000
}
