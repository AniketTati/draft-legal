/**
 * docs/39 A8/A14 — company names compared the way a person reads them.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { companyKey, sameCompany, companySimilarity, isPlaceholderName, directoryName, SIMILAR, LEGAL_FORMS } from './company-names.js'

describe('companyKey', () => {
  it('drops case, punctuation, a leading The and the legal form', () => {
    expect(companyKey('ACME CORPORATION, INC.')).toBe('acme')
    expect(companyKey('Acme Corp.')).toBe('acme')
    expect(companyKey('The Acme Corporation')).toBe('acme')
    expect(companyKey('Helix Systems, LLC')).toBe('helix systems')
    expect(companyKey('Helix Systems L.L.C.')).toBe('helix systems')
    expect(companyKey('Acme Holdings Private Limited')).toBe('acme holdings')
    expect(companyKey('Acme Holdings Private Ltd')).toBe('acme holdings')
    expect(companyKey('Shenzhen Widget Co., Ltd.')).toBe('shenzhen widget')
    expect(companyKey('Müller GmbH & Co. KG')).toBe('muller')
    expect(companyKey('Anthropic PBC')).toBe('anthropic')
  })

  it('drops the defined term, the "a Delaware corporation" tail and a trading name', () => {
    expect(companyKey('Acme Corporation (“Acme” or the “Supplier”)')).toBe('acme')
    expect(companyKey('Globex Inc., a Delaware corporation')).toBe('globex')
    expect(companyKey('Northwind LLC d/b/a Northwind Analytics')).toBe('northwind')
  })

  it('keeps words that tell companies apart, and never empties a name', () => {
    expect(companyKey('Acme Holdings')).toBe('acme holdings')
    expect(companyKey('Acme UK Ltd')).toBe('acme uk')
    expect(companyKey('Procter & Gamble Co.')).toBe('procter and gamble')
    expect(companyKey('Limited')).toBe('limited')
    expect(companyKey('  ')).toBe('')
  })
})

describe('sameCompany', () => {
  it('is one company for every spelling of it', () => {
    expect(sameCompany('GSK', 'gsk')).toBe(true)
    expect(sameCompany('Face Book, Inc.', 'Facebook')).toBe(true)
    expect(sameCompany('J.P. Morgan', 'JP Morgan')).toBe(true)
    expect(sameCompany('AT&T Inc.', 'AT & T')).toBe(true)
  })

  it('is not the same company with a word more', () => {
    expect(sameCompany('Acme', 'Acme Holdings')).toBe(false)
    expect(sameCompany('', '')).toBe(false)
  })
})

describe('companySimilarity', () => {
  it('asks about the same name plus words, initials and near spellings', () => {
    expect(companySimilarity('Acme Holdings Private Limited', 'Acme Corporation')).toBeGreaterThanOrEqual(SIMILAR)
    expect(companySimilarity('IBM', 'International Business Machines Corporation')).toBeGreaterThanOrEqual(SIMILAR)
    expect(companySimilarity('Brightwave Softwares', 'Brightwave Software Ltd')).toBeGreaterThanOrEqual(SIMILAR)
  })

  it('leaves different companies alone', () => {
    expect(companySimilarity('Globex', 'Initech')).toBeLessThan(SIMILAR)
    expect(companySimilarity('AB', 'AB Testing Co')).toBeLessThan(SIMILAR)
    expect(companySimilarity('Delta', 'Delta Dental of California')).toBeGreaterThanOrEqual(SIMILAR)
  })
})

describe('isPlaceholderName', () => {
  it('knows what a template calls a party', () => {
    expect(isPlaceholderName('[Company Name]')).toBe(true)
    expect(isPlaceholderName('Buyer, Inc.')).toBe(true)
    expect(isPlaceholderName('______')).toBe(true)
    expect(isPlaceholderName('Acme Corporation')).toBe(false)
  })
})

describe('directoryName', () => {
  it('takes off the defined term and the incorporation tail, keeping the words', () => {
    expect(directoryName('ACME CORPORATION, INC. (“Acme”)')).toBe('ACME CORPORATION, INC.')
    expect(directoryName('Globex Inc., a Delaware corporation')).toBe('Globex Inc.')
  })
})

describe('the agents service reads names the same way', () => {
  it('has the same legal forms (app/company_names.py)', () => {
    const py = readFileSync(join(process.cwd(), '..', 'agents', 'app', 'company_names.py'), 'utf8')
    const list = py.slice(py.indexOf('_LEGAL_FORMS = ['), py.indexOf(']', py.indexOf('_LEGAL_FORMS = [')))
    const forms = [...list.matchAll(/"([^"]+)"/g)].map(m => m[1])
    expect(new Set(forms)).toEqual(new Set(LEGAL_FORMS))
  })
})
