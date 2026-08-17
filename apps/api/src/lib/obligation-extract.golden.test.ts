/**
 * Golden tests for the last transformation before obligations hit the database.
 *
 * The LLM half of extraction varies run to run and cannot be regression-tested.
 * This half must not vary at all, and every failure in it is SILENT: change
 * `toDate` and every due date becomes null, the reminder cron stops firing,
 * nothing errors, and no test notices. Before this file the only thing standing
 * between a change here and a production regression was the TypeScript compiler.
 *
 * These are GOLDEN tests — each pins an exact output for an exact input. A diff
 * is not automatically a bug; it is a change someone has to look at and either
 * fix or accept by updating the expectation.
 *
 * The Python side of the same pipeline is pinned in
 * apps/agents/tests/test_obligations_parse.py. Read them together: the two
 * layers disagree in three places, and each disagreement is asserted below so
 * that closing one is a deliberate act.
 */
import { describe, it, expect } from 'vitest'
import {
  toObligationRows,
  MAX_OBLIGATION_ROWS,
  MAX_TEXT_CHARS,
  MAX_TRIGGER_CHARS,
} from './obligation-extract.js'

const KEY = { orgId: 'org_1', contractId: 'con_1' }

describe('toObligationRows', () => {
  it('carries a well-formed obligation through unchanged', () => {
    expect(toObligationRows([{
      id: 'pay-monthly',
      type: 'payment',
      description: 'Pay $50,000 monthly on the 15th',
      owner: 'customer',
      dueDate: '2026-09-15',
      recurrence: 'monthly',
      trigger: 'invoice receipt',
      quote: 'Customer shall pay $50,000 on the 15th of each month.',
      severity: 'high',
      sectionRef: '4.1',
    }], KEY)).toEqual([{
      orgId: 'org_1',
      contractId: 'con_1',
      type: 'payment',
      description: 'Pay $50,000 monthly on the 15th',
      owner: 'customer',
      dueDate: new Date('2026-09-15'),
      recurrence: 'monthly',
      trigger: 'invoice receipt',
      quote: 'Customer shall pay $50,000 on the 15th of each month.',
      severity: 'high',
      sectionRef: '4.1',
    }])
  })

  it('applies the documented defaults to an empty entry', () => {
    expect(toObligationRows([{}], KEY)[0]).toEqual({
      orgId: 'org_1',
      contractId: 'con_1',
      type: 'other',
      description: '',
      owner: 'unknown',
      dueDate: null,
      recurrence: 'one-time',
      trigger: null,
      quote: '',
      severity: 'medium',
      sectionRef: null,
    })
  })

  it('lowercases the enum-ish fields and leaves prose alone', () => {
    const row = toObligationRows([{
      type: 'PAYMENT', owner: 'Customer', recurrence: 'Monthly', severity: 'HIGH',
      description: 'Pay Acme LLC by the 15th', quote: 'Customer SHALL pay.',
      sectionRef: '4.1(a)',
    }], KEY)[0]
    expect(row.type).toBe('payment')
    expect(row.owner).toBe('customer')
    expect(row.recurrence).toBe('monthly')
    expect(row.severity).toBe('high')
    // Prose keeps its case — lowercasing a quote would break the "verbatim
    // excerpt" contract the extractor prompt makes.
    expect(row.description).toBe('Pay Acme LLC by the 15th')
    expect(row.quote).toBe('Customer SHALL pay.')
    expect(row.sectionRef).toBe('4.1(a)')
  })

  it('trims whitespace-only values down to their default', () => {
    const row = toObligationRows([{ type: '   ', owner: '\n\t', severity: '' }], KEY)[0]
    expect(row.type).toBe('other')
    expect(row.owner).toBe('unknown')
    expect(row.severity).toBe('medium')
  })

  // ── Dates: the field whose failure is completely silent ──────────────────

  describe('dueDate', () => {
    it('parses an ISO date', () => {
      expect(toObligationRows([{ dueDate: '2026-09-15' }], KEY)[0].dueDate)
        .toEqual(new Date('2026-09-15'))
    })

    it.each([
      ['null', null],
      ['empty string', ''],
      ['unparseable text', 'sometime next quarter'],
      ['a number', 1_757_000_000_000],
      ['a Date object', new Date('2026-09-15')],
    ])('yields null for %s', (_label, value) => {
      // The last two are the sharp ones: `toDate` requires a STRING, so a
      // numeric timestamp or an already-parsed Date both become null rather
      // than the date they represent. Pinned because it looks like a bug and
      // is currently unreachable — the Python side always emits a string or
      // null — so anyone changing that contract needs to see this first.
      expect(toObligationRows([{ dueDate: value }], KEY)[0].dueDate).toBeNull()
    })
  })

  // ── Caps ─────────────────────────────────────────────────────────────────

  it('has the caps the schema and the prompt assume', () => {
    // Literal on purpose. Every cap assertion below is written against these
    // constants, so alone they would move WITH a change and catch nothing.
    expect(MAX_OBLIGATION_ROWS).toBe(100)
    expect(MAX_TEXT_CHARS).toBe(4000)
    expect(MAX_TRIGGER_CHARS).toBe(1000)
  })

  it('caps the number of rows, keeping the first N in order', () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ description: `d${i}` }))
    const rows = toObligationRows(many, KEY)
    expect(rows).toHaveLength(100)
    expect(rows[0].description).toBe('d0')
    expect(rows[99].description).toBe('d99')
  })

  it('truncates description, quote and trigger at their own boundaries', () => {
    const row = toObligationRows([{
      description: 'a'.repeat(5000), quote: 'b'.repeat(5000), trigger: 'c'.repeat(2000),
    }], KEY)[0]
    expect(row.description).toHaveLength(4000)
    expect(row.quote).toHaveLength(4000)
    expect(row.trigger).toHaveLength(1000)
  })

  // ── Where the two layers disagree ────────────────────────────────────────

  describe('disagreements with the Python layer, pinned deliberately', () => {
    it('the 4000-char quote cap can never bind, because Python already cut at 240', () => {
      // apps/agents/.../obligations.py caps `quote` at MAX_QUOTE_CHARS = 240
      // before this code ever sees it. So a quote is already lossy upstream and
      // this bound is dead. Raising the Python cap without raising this one
      // would silently start truncating here instead — this test is where that
      // shows up.
      const pythonCapped = 'q'.repeat(240)
      expect(toObligationRows([{ quote: pythonCapped }], KEY)[0].quote).toHaveLength(240)
      expect(MAX_TEXT_CHARS).toBeGreaterThan(240)
    })

    it("the 'one-time' recurrence default is unreachable in production", () => {
      // Python defaults a missing recurrence to the string 'unknown', which is
      // truthy, so norm() keeps it and 'one-time' never fires on a real
      // payload. It only appears when the field is genuinely absent — which
      // this test does, and the pipeline does not.
      expect(toObligationRows([{}], KEY)[0].recurrence).toBe('one-time')
      expect(toObligationRows([{ recurrence: 'unknown' }], KEY)[0].recurrence).toBe('unknown')
    })

    it('drops the id Python generated, so obligations are not addressable across a re-run', () => {
      // Python emits `id: "o_0"`, this layer has no `id` column and discards
      // it. Re-running extraction therefore cannot match a new obligation to
      // the row it replaces — which is why the caller deletes OPEN/OVERDUE and
      // re-inserts instead of upserting.
      const row = toObligationRows([{ id: 'o_0', description: 'x' }], KEY)[0]
      expect(row).not.toHaveProperty('id')
    })
  })

  // ── Shapes that must not crash ───────────────────────────────────────────

  it('returns an empty array for an empty payload', () => {
    expect(toObligationRows([], KEY)).toEqual([])
  })

  it('coerces non-string scalars rather than passing them through', () => {
    const row = toObligationRows([{ type: 12, severity: true, sectionRef: 9.2 }], KEY)[0]
    expect(row.type).toBe('12')
    expect(row.severity).toBe('true')
    expect(row.sectionRef).toBe('9.2')
  })

  it('stamps org and contract onto every row', () => {
    const rows = toObligationRows([{}, {}, {}], KEY)
    expect(rows.every(r => r.orgId === 'org_1' && r.contractId === 'con_1')).toBe(true)
  })
})
