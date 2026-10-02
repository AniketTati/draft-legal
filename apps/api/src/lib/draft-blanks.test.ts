/**
 * docs/41 browser QA — a draft's open blanks read back by the analysis are no
 * values (273e23d, 9e6d57c), and the worker's bodiless writes carry no JSON
 * content type (20216d2).
 */
import { describe, it, expect } from 'vitest'
import { blankAsNull, extractedFieldsFromPatch } from './field-store.js'
import { internalWriteInit } from './internal-write.js'

describe('a draft blank read as a field value', () => {
  it('is no value, alone or inside other words', () => {
    expect(blankAsNull('[[Choose governing law: Delaware · New York · England and Wales]]')).toBeNull()
    expect(blankAsNull(' [[effectiveDate]] ')).toBeNull()
    expect(blankAsNull('courts located in [[venueLocation]]')).toBeNull()
    expect(blankAsNull('State of New York')).toBe('State of New York')
    expect(blankAsNull(30)).toBe(30)
    expect(blankAsNull(null)).toBeNull()
  })

  it('is stored as no value for the governing law, a column and a type field', () => {
    const fields = extractedFieldsFromPatch({
      keyTerms: { governingLaw: '[[Choose governing law: Delaware · New York]]', paymentTermsDays: 30 },
      counterpartyName: 'Initech Solutions',
      metadata: { _typeFields: { venue: { value: 'courts located in [[venueLocation]]' } } },
    }, new Set())
    const by = new Map(fields.map(f => [`${f.kind}:${f.key}`, f.value]))
    expect(by.get('core:governingLaw')).toBeNull()
    expect(by.get('core:paymentTermsDays')).toBe(30)
    expect(by.get('core:counterpartyName')).toBe('Initech Solutions')
    expect(by.get('type:venue')).toBeNull()
  })
})

describe("the worker's writes to this API", () => {
  it('say JSON only when they carry a body', () => {
    const bodiless = internalWriteInit('POST', 'org1', 's3cret')
    expect(bodiless.body).toBeUndefined()
    expect(bodiless.headers).not.toHaveProperty('content-type')
    expect(bodiless.headers).toMatchObject({ 'x-internal-service': 'agents', 'x-internal-secret': 's3cret', 'x-org-id': 'org1' })
    const patch = internalWriteInit('PATCH', 'org1', 's3cret', { summary: 'x' })
    expect(patch.headers).toMatchObject({ 'content-type': 'application/json' })
    expect(patch.body).toBe('{"summary":"x"}')
  })
})
