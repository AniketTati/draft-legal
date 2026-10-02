/**
 * docs/39 A12 — exhibits read as part of the contract: after its own text,
 * each under its name and within what the analysis reads; a quote found in
 * the exhibit it came from.
 */
import { describe, it, expect } from 'vitest'
import { withExhibits, exhibitFinder, attachmentsOf, EXHIBIT_READ_MAX, EXHIBITS_READ_MAX } from './exhibits.js'

describe('what the analysis reads', () => {
  it('is the contract, then each exhibit under its name', () => {
    const text = withExhibits('MASTER SERVICES AGREEMENT. Fees are set out in Exhibit B.', [
      { label: 'Exhibit B — Pricing', text: 'Platform fee: USD 48,000 per year, invoiced annually.' },
      { label: 'Exhibit C — SLA', text: 'Uptime: 99.9% each calendar month.' },
    ])
    expect(text).toBe('MASTER SERVICES AGREEMENT. Fees are set out in Exhibit B.\n\nEXHIBIT: Exhibit B — Pricing\n\nPlatform fee: USD 48,000 per year, invoiced annually.\n\nEXHIBIT: Exhibit C — SLA\n\nUptime: 99.9% each calendar month.')
  })

  it('reads no more of one exhibit, or of all, than it can', () => {
    const long = 'x'.repeat(EXHIBIT_READ_MAX + 5000)
    const text = withExhibits('Main.', Array.from({ length: 4 }, (_, i) => ({ label: `E${i}`, text: long })))
    expect(text.length).toBeLessThan('Main.'.length + EXHIBITS_READ_MAX + 200)
    expect(text).toContain('EXHIBIT: E2')
    expect(text).not.toContain('EXHIBIT: E3')
  })
})

describe('a quote in an exhibit', () => {
  it('is found in the exhibit it came from', () => {
    const find = exhibitFinder([
      { s3Key: 'k/b', label: 'Exhibit B — Pricing', text: 'Platform fee: USD 48,000 per year, invoiced annually.' },
      { s3Key: 'k/c', label: 'Exhibit C — SLA', text: 'Uptime: 99.9% each calendar month.' },
    ])
    expect(find('USD 48,000 per year')).toEqual({ s3Key: 'k/b', label: 'Exhibit B — Pricing' })
    expect(find('uptime: 99.9%')).toEqual({ s3Key: 'k/c', label: 'Exhibit C — SLA' })
    expect(find('a term nowhere')).toBeNull()
  })
})

describe('the contract’s attachments', () => {
  it('are read from what the contract lists, ignoring what isn’t one', () => {
    expect(attachmentsOf([{ filename: 'a.pdf', s3Key: 'k', mimeType: 'application/pdf', size: 1 }, null, 'x', { filename: 'b' }]))
      .toEqual([{ filename: 'a.pdf', s3Key: 'k', mimeType: 'application/pdf', size: 1 }])
    expect(attachmentsOf(null)).toEqual([])
  })
})
