/**
 * buildESQuery — S2: an own-scope caller's contract ids must be a query
 * FILTER (applied before top-k), since ES docs carry no ownerId.
 */
import { describe, it, expect } from 'vitest'
import { buildESQuery } from './elasticsearch.js'

describe('buildESQuery ids filter', () => {
  it('pushes the ids into the bool filter alongside orgId', () => {
    const q = buildESQuery('org-1', { q: 'indemnity', ids: ['c1', 'c2'] })
    expect(q.bool.filter).toContainEqual({ term: { orgId: 'org-1' } })
    expect(q.bool.filter).toContainEqual({ ids: { values: ['c1', 'c2'] } })
  })

  it('an empty id list matches nothing rather than everything', () => {
    const q = buildESQuery('org-1', { q: 'indemnity', ids: [] })
    expect(q.bool.filter).toContainEqual({ ids: { values: [] } })
  })

  it('adds no ids clause for org-scope callers', () => {
    const q = buildESQuery('org-1', { q: 'indemnity' })
    expect(JSON.stringify(q)).not.toContain('"ids"')
  })
})
