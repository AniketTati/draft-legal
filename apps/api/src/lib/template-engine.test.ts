/**
 * docs/39 H2 — a drafted value stays marked with its variable, so the draft's
 * Variables panel can change it everywhere it appears.
 */
import { describe, it, expect } from 'vitest'
import { interpolateVariables } from './template-engine.js'

describe('interpolateVariables', () => {
  it('marks each value with its variable, escaped, and each blank with its key', () => {
    const { html, unfilled } = interpolateVariables(
      '<p>{{customer_name}} pays {{fees}} to {{supplier}} for {{customer_name}}.</p>',
      { customer_name: 'Smith & <Co>', fees: 1200, supplier: '' },
    )
    expect(html).toBe(
      '<p><span data-variable="customer_name">Smith &amp; &lt;Co&gt;</span> pays <span data-variable="fees">1200</span> to '
      + '<span class="template-variable-unfilled" data-variable="supplier" data-key="supplier">[[supplier]]</span> for '
      + '<span data-variable="customer_name">Smith &amp; &lt;Co&gt;</span>.</p>',
    )
    expect(unfilled).toEqual(['supplier'])
  })
})
