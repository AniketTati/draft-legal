import { describe, it, expect } from 'vitest'
import { activityText } from './activity'
import { invalidateApproval, serverMessage } from './approval-keys'

describe('activityText (docs/41 P0.6)', () => {
  it('a returned approval shows who and why', () => {
    expect(activityText({ action: 'APPROVAL_DECIDED', userName: 'Priya', metadata: { decision: 'REJECTED', reason: 'Liability cap must be 1x fees' } }))
      .toEqual({ title: 'Returned for changes by Priya', detail: '“Liability cap must be 1x fees”' })
  })
  it('a status change in words', () => {
    expect(activityText({ action: 'CONTRACT_STATUS_CHANGED', metadata: { from: 'PENDING_APPROVAL', to: 'DRAFT', reason: 'Fix the cap' } }))
      .toEqual({ title: 'Waiting for approval → Draft', detail: '“Fix the cap”' })
  })
  it('anything else is still readable', () => {
    expect(activityText({ action: 'VERSION_CREATED', userName: 'Sam' }).title).toBe('Version created · Sam')
  })
})

describe('approval cache keys', () => {
  it('a decision clears every place the approval is read from', () => {
    const keys: unknown[] = []
    invalidateApproval({ invalidateQueries: (f: { queryKey: unknown }) => { keys.push(f.queryKey) } } as never, 'c1', 'i1')
    expect(keys).toEqual(expect.arrayContaining([
      ['approval-queue'], ['approval-all'], ['dashboard-stats'], ['approval-instance', 'i1'],
      ['contract-approval', 'c1'], ['contract', 'c1'], ['contract-timeline', 'c1'],
    ]))
  })
  it('the server\'s message', () => {
    expect(serverMessage({ response: { data: { error: 'Step not found or not assigned to you' } } })).toBe('Step not found or not assigned to you')
    expect(serverMessage(new Error('x'))).toBe('Something went wrong. Try again.')
  })
})
