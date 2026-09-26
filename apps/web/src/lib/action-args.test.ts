/**
 * X68 — an action card's edit reached Apply only while the editor was open;
 * "Review" closed it and Apply sent the original arguments.
 */
import { describe, it, expect } from 'vitest'
import { argsJson, argsToApply } from './action-args'

const args = { contractId: 'c1', body: 'Please review clause 4.' }

describe('argsToApply', () => {
  it('sends the proposal as it came when nothing was edited', () => {
    expect(argsToApply(args, argsJson(args))).toBe(args)
  })

  it('sends the edit, however the card is showing it', () => {
    const edited = argsJson({ ...args, body: 'Please review clause 5.' })
    expect(argsToApply(args, edited)).toEqual({ contractId: 'c1', body: 'Please review clause 5.' })
  })

  it('refuses a draft that is not a JSON object', () => {
    expect(() => argsToApply(args, '{ "contractId": ')).toThrow()
    expect(() => argsToApply(args, '["c1"]')).toThrow(/JSON object/)
    expect(() => argsToApply(args, 'null')).toThrow(/JSON object/)
  })
})
