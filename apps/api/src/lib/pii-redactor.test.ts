/**
 * Tests for PII Redactor (P7.5.1).
 *
 * Mix of true-positive coverage + false-positive guards. The
 * regex-based detector is necessarily a balance — these tests pin
 * the behaviour we want before we tune.
 */
import { describe, it, expect } from 'vitest'
import { redactPii } from './pii-redactor.js'

describe('redactPii', () => {
  describe('mode: off', () => {
    it('passes through unchanged', () => {
      const r = redactPii('My SSN is 123-45-6789', 'off')
      expect(r.text).toBe('My SSN is 123-45-6789')
      expect(r.total).toBe(0)
    })
  })

  describe('SSN', () => {
    it('redacts a plain SSN', () => {
      const r = redactPii('SSN: 123-45-6789', 'redact')
      expect(r.text).toBe('SSN: [REDACTED:SSN]')
      expect(r.counts.SSN).toBe(1)
    })
    it('does NOT redact 000- or 666- (invalid SSN ranges) as SSN', () => {
      // Note: 9XX-XX-XXXX is the ITIN range, so it'll be tagged as
      // ITIN (which is correct + intentional). The 000- and 666-
      // patterns aren't valid US identifiers and should pass through.
      const r = redactPii('Counter: 000-12-3456 / 666-12-3456', 'redact')
      expect(r.text).toBe('Counter: 000-12-3456 / 666-12-3456')
      expect(r.counts.SSN ?? 0).toBe(0)
      expect(r.counts.ITIN ?? 0).toBe(0)
    })

    it('redacts 9XX-XX-XXXX as ITIN, not SSN', () => {
      const r = redactPii('Tax id: 912-34-5678', 'redact')
      expect(r.text).toContain('[REDACTED:ITIN]')
      expect(r.counts.ITIN).toBe(1)
      expect(r.counts.SSN ?? 0).toBe(0)
    })
    it('handles multiple SSNs', () => {
      const r = redactPii('Two: 111-22-3333 and 444-55-6666', 'redact')
      expect(r.text).toBe('Two: [REDACTED:SSN] and [REDACTED:SSN]')
      expect(r.counts.SSN).toBe(2)
    })
  })

  describe('Credit Card', () => {
    it('redacts a Luhn-valid Visa', () => {
      // 4111 1111 1111 1111 — canonical test number, Luhn valid
      const r = redactPii('Card: 4111 1111 1111 1111 expires 12/27', 'redact')
      expect(r.text).toContain('[REDACTED:CC]')
      expect(r.counts.CC).toBe(1)
    })
    it('does NOT redact a 16-digit string that fails Luhn', () => {
      const r = redactPii('Order ref 1234567890123456', 'redact')
      expect(r.text).toBe('Order ref 1234567890123456')
      expect(r.counts.CC ?? 0).toBe(0)
    })
    it('handles dashed format', () => {
      // Mastercard test number
      const r = redactPii('Card: 5555-5555-5555-4444', 'redact')
      expect(r.text).toContain('[REDACTED:CC]')
    })
  })

  // Email and phone are opt-in — see CONTRACT_TEXT_EXEMPT. In a contract, a
  // notice-clause email is an operative term, not incidental personal data, so
  // redacting it by default breaks the answer to "where do I send notice?".
  // These tests pin that the detection still works when a caller asks for it.
  describe('Email (opt-in)', () => {
    it('redacts a standard email', () => {
      const r = redactPii('Contact me at jane@example.com', 'redact', { kinds: ['EMAIL'] })
      expect(r.text).toBe('Contact me at [REDACTED:EMAIL]')
      expect(r.counts.EMAIL).toBe(1)
    })
    it('handles plus-addressing', () => {
      const r = redactPii('Email: alice+work@example.com', 'redact', { kinds: ['EMAIL'] })
      expect(r.text).toContain('[REDACTED:EMAIL]')
    })
    it('is NOT redacted by default, so notice clauses survive', () => {
      const notice = 'All notices shall be sent to legal@acmecorp.com.'
      expect(redactPii(notice, 'redact').text).toBe(notice)
    })
  })

  describe('Phone (opt-in)', () => {
    it('redacts a US phone with parentheses', () => {
      const r = redactPii('Call (415) 555-0142', 'redact', { kinds: ['PHONE'] })
      expect(r.text).toContain('[REDACTED:PHONE]')
    })
    it('replaces the WHOLE parenthesised number, leaving no orphan bracket', () => {
      // The old pattern put \b before the optional '(', where a word boundary
      // can never match, so it matched from the digits on and left '(' behind —
      // corrupting the sentence it was meant to protect.
      const r = redactPii('Phone: (415) 555-0142.', 'redact', { kinds: ['PHONE'] })
      expect(r.text).toBe('Phone: [REDACTED:PHONE].')
    })
    it('redacts an E.164 number', () => {
      const r = redactPii('Reach out: +1 415 555 0142', 'redact', { kinds: ['PHONE'] })
      expect(r.text).toContain('[REDACTED:PHONE]')
    })
    it('redacts a dashed US phone', () => {
      const r = redactPii('Phone 555-123-4567', 'redact', { kinds: ['PHONE'] })
      expect(r.text).toContain('[REDACTED:PHONE]')
    })
    it('is NOT redacted by default, so signature blocks survive', () => {
      const sig = 'By: Jane Doe, General Counsel. Phone: (415) 555-0142.'
      expect(redactPii(sig, 'redact').text).toBe(sig)
    })
  })

  // Long digit runs and uppercase reference codes are everywhere in contracts.
  // Luhn is only a 1-in-10 filter, so without a context anchor roughly one in
  // ten agreement/invoice numbers was being rewritten as a card number.
  describe('false positives on ordinary contract language', () => {
    it('leaves a Luhn-passing agreement reference alone', () => {
      const ref = 'This Agreement (Ref. No. 4532015112830366) supersedes all prior agreements.'
      expect(redactPii(ref, 'redact').text).toBe(ref)
    })
    it('still redacts a card number when the context says card', () => {
      const r = redactPii('Charge the corporate credit card 4532015112830366 monthly.', 'redact')
      expect(r.text).toContain('[REDACTED:CC]')
    })
    it('leaves an uppercase invoice code alone', () => {
      const inv = 'Invoice AB1234567890123456 is payable within 30 days.'
      expect(redactPii(inv, 'redact').text).toBe(inv)
    })
    it('still redacts an IBAN when the context says wire/IBAN', () => {
      const r = redactPii('Wire to IBAN GB29NWBK60161331926819 at Barclays.', 'redact')
      expect(r.text).toContain('[REDACTED:IBAN]')
    })
    it('leaves section numbers and money amounts alone', () => {
      const t = 'See Sections 5.2, 9.1 and Exhibit A for the cap of $1,500,000.'
      expect(redactPii(t, 'redact').text).toBe(t)
    })
  })

  describe('Passport', () => {
    it('redacts a US passport number after the keyword', () => {
      const r = redactPii('Passport: A12345678', 'redact')
      expect(r.text).toContain('[REDACTED:PASSPORT]')
    })
    it('does NOT redact a 9-digit number not anchored to passport', () => {
      const r = redactPii('Reference 123456789 for the matter', 'redact')
      expect(r.counts.PASSPORT ?? 0).toBe(0)
    })
  })

  describe('IBAN', () => {
    it('redacts a German IBAN', () => {
      const r = redactPii('IBAN: DE89370400440532013000', 'redact')
      expect(r.text).toContain('[REDACTED:IBAN]')
    })
  })

  describe('IP', () => {
    it('redacts an IPv4 address', () => {
      const r = redactPii('Server 192.168.1.42 was offline', 'redact')
      expect(r.text).toContain('[REDACTED:IP]')
    })
    it('does NOT redact something that looks like an IP but is out of range', () => {
      const r = redactPii('Code 999.888.777.666 is not an IP', 'redact')
      expect(r.counts.IP ?? 0).toBe(0)
    })
  })

  describe('API key', () => {
    it('redacts an OpenAI-style sk- key', () => {
      const r = redactPii('Token: sk-abcdefghijklmnopqrstuvwxyz12', 'redact')
      expect(r.text).toContain('[REDACTED:API_KEY]')
    })
    it('redacts a Stripe live publishable key', () => {
      const r = redactPii('Key pk_live_abcdefghijklmnopqrstuvwxyz', 'redact')
      expect(r.text).toContain('[REDACTED:API_KEY]')
    })
  })

  describe('DOB', () => {
    it('redacts when keyword-anchored', () => {
      const r = redactPii('DOB: 1985-07-23', 'redact')
      expect(r.text).toContain('[REDACTED:DOB]')
    })
    it('does NOT redact a date without DOB context', () => {
      const r = redactPii('Effective date 2026-01-15', 'redact')
      expect(r.counts.DOB ?? 0).toBe(0)
    })
  })

  describe('mode: tokenize', () => {
    it('emits stable pseudonyms for the same value', () => {
      const r = redactPii('Email a@b.com today, then a@b.com tomorrow.', 'tokenize', { kinds: ['EMAIL'] })
      const matches = r.text.match(/\[PII:EMAIL:([0-9a-f]+)\]/g)
      expect(matches?.length).toBe(2)
      expect(matches?.[0]).toBe(matches?.[1])
    })
    it('emits different pseudonyms for different values', () => {
      const r = redactPii('Two emails: foo@a.com and bar@a.com', 'tokenize', { kinds: ['EMAIL'] })
      const matches = r.text.match(/\[PII:EMAIL:([0-9a-f]+)\]/g)
      expect(matches?.length).toBe(2)
      expect(matches?.[0]).not.toBe(matches?.[1])
    })
  })

  describe('counts.total', () => {
    it('aggregates counts across kinds', () => {
      const r = redactPii('Email a@b.com, SSN 555-12-3456, IP 10.0.0.1', 'redact',
        { kinds: ['EMAIL', 'SSN', 'IP'] })
      expect(r.total).toBe(3)
      expect(r.counts.EMAIL).toBe(1)
      expect(r.counts.SSN).toBe(1)
      expect(r.counts.IP).toBe(1)
    })

    it('counts only the kinds enabled by default', () => {
      // Same input, default kinds: the email is left alone, so the total drops.
      const r = redactPii('Email a@b.com, SSN 555-12-3456, IP 10.0.0.1', 'redact')
      expect(r.total).toBe(2)
      expect(r.counts.EMAIL).toBeUndefined()
    })
  })

  describe('legal-text false-positive guards', () => {
    it('does NOT redact contract numbers, exhibit refs, or section refs', () => {
      const r = redactPii(
        'See Exhibit A, Section 4.2.1, paragraph 3. Order #847291. Effective 2026-01-15.',
        'redact',
      )
      expect(r.text).toBe(
        'See Exhibit A, Section 4.2.1, paragraph 3. Order #847291. Effective 2026-01-15.',
      )
      expect(r.total).toBe(0)
    })
  })
})
