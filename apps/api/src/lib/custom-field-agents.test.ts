/**
 * X2 — the agents-service side of custom fields (source tripwires: the
 * Python service has no test harness here).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const agents = (...parts: string[]) => readFileSync(join(process.cwd(), '..', 'agents', ...parts), 'utf8')

describe('custom fields in the agents service', () => {
  it('extraction keeps each custom field\'s confidence and quote beside its value', () => {
    const review = agents('app', 'routes', 'review.py')
    expect(review).toContain('metadata_update["_customFieldEvidence"] = custom_evidence')
    expect(review).toContain('"quote":      extraction.get("quote")')
    // …and clears stale evidence on a run that produced output, like _typeFields.
    expect(review).toContain('metadata_update.setdefault("_customFieldEvidence", None)')
  })

  it('/extract-fields is mounted, keeps PII tokens and treats the contract as data', () => {
    expect(agents('main.py')).toContain('app.include_router(extract_fields.router)')
    const route = agents('app', 'routes', 'extract_fields.py')
    expect(route).toContain('@router.post("/extract-fields")')
    // docs/39 A5 — it runs the custom-field pass the review run uses, which holds both.
    expect(route).toContain('extract_custom_fields(')
    const pass = agents('app', 'agents', 'custom_fields.py')
    expect(pass).toContain('PII_TOKEN_RULE')
    expect(pass).toContain('wrap_untrusted_document(')
    expect(agents('app', 'agents', 'review_agent.py')).toContain('await extract_custom_fields(')
  })
})
