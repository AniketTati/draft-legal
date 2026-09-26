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

describe('buildESQuery diligence scoping (C11)', () => {
  it('excludes diligence-room documents from ordinary search', () => {
    const q = buildESQuery('org-1', { q: 'indemnity' })
    expect(q.bool.must_not).toContainEqual({ exists: { field: 'diligenceRoomId' } })
  })

  it('a room-scoped search filters to that room instead', () => {
    const q = buildESQuery('org-1', { q: 'indemnity', diligenceRoomId: 'room-1' })
    expect(q.bool.filter).toContainEqual({ term: { diligenceRoomId: 'room-1' } })
    expect(q.bool.must_not).toBeUndefined()
  })
})
