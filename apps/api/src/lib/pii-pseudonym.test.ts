/**
 * X23 — tokenize mode must not be reversible by whoever receives the text,
 * and the background jobs' calls to the agents service must go through the
 * org's PII policy, with the values put back in what returns.
 */
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pseudonym, redactPii } from './pii-redactor.js'

describe('tokenize pseudonyms are keyed', () => {
  it('is not the bare SHA-256 anyone could recompute from a guessed value', () => {
    const ssn = '123-45-6789'
    const bare = crypto.createHash('sha256').update(ssn).digest('hex').slice(0, 8)
    expect(pseudonym(ssn)).not.toBe(bare)
    expect(pseudonym(ssn)).toMatch(/^[0-9a-f]{8}$/)
  })

  it('stays stable for the same value, and differs across values', () => {
    expect(pseudonym('123-45-6789')).toBe(pseudonym('123-45-6789'))
    expect(pseudonym('123-45-6789')).not.toBe(pseudonym('987-65-4321'))
    expect(redactPii('SSN 123-45-6789', 'tokenize').text).toContain(pseudonym('123-45-6789'))
  })
})

describe('background jobs apply the policy on the way out, and restore on the way back', () => {
  it('callAgents redacts the request body before fetching, and restores the reply after', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'workers', 'agent.worker.ts'), 'utf8')
    const start = src.indexOf('async function callAgents(')
    const fn = src.slice(start, src.indexOf('\n}\n', start))
    const fetchAt = fn.indexOf('fetch(')
    expect(fn.indexOf('redactJson(')).toBeGreaterThan(-1)
    expect(fn.indexOf('redactJson(')).toBeLessThan(fetchAt)
    expect(fn.indexOf('restorePii(')).toBeGreaterThan(fetchAt)
  })
})

describe('the agents service keeps round-trip tokens intact (source tripwires)', () => {
  const py = (...parts: string[]) => readFileSync(join(process.cwd(), '..', 'agents', 'app', ...parts), 'utf8')

  it('every prompt whose output is stored tells the model to copy tokens verbatim', () => {
    expect(py('pii_tokens.py')).toMatch(/copy the placeholder exactly/)
    const review = py('agents', 'review_agent.py')
    expect(review).toContain('_EXTRACT_PROMPT + extra_prompt + PII_TOKEN_RULE')
    // …and the recall, validate and score passes, whose output is stored too.
    expect(review).toContain('second_prompt + PII_TOKEN_RULE')
    expect(review).toContain('_VALIDATE_PROMPT + payload + PII_TOKEN_RULE')
    expect(review).toContain('_SCORE_PROMPT + payload + PII_TOKEN_RULE')
    expect(py('routes', 'assist.py')).toContain('_REDLINE_SYSTEM + PII_TOKEN_RULE')
    expect(py('routes', 'assist.py')).toContain('_BATCH_REDLINE_SYSTEM + PII_TOKEN_RULE')
    expect(py('agents', 'playbook_review_agent.py')).toContain(') + PII_TOKEN_RULE')
    expect(py('agents', 'draft_agent.py').match(/PII_TOKEN_RULE\)/g)?.length).toBe(2)
  })

  it('the extraction names the version it read, so the API restores against that one', () => {
    expect(py('routes', 'review.py')).toContain('params={"versionId": version_id}')
  })
})
