import { describe, it, expect, vi } from 'vitest'

vi.mock('@/store/auth', () => ({ useAuthStore: { getState: () => ({ user: null, accessToken: null }) } }))

import { apiErrorMessage, shouldToastMutationError } from './api'

describe('the global error toast (docs/41 P0.7)', () => {
  it('says what the server said', () => {
    expect(apiErrorMessage({ response: { status: 409, data: { detail: 'This contract hasn’t been analysed yet.' } } })).toBe('This contract hasn’t been analysed yet.')
    expect(apiErrorMessage({ response: { status: 403, data: { error: 'Step not found or not assigned to you' } } })).toBe('Step not found or not assigned to you')
    expect(apiErrorMessage({ response: { status: 502, data: {} } })).toMatch(/our side/)
    expect(apiErrorMessage(new Error('Network Error'))).toMatch(/could not be reached/)
  })

  it('only for a mutation whose screen shows nothing of it', () => {
    expect(shouldToastMutationError({}, { options: {} })).toBe(true)
    expect(shouldToastMutationError({}, { options: { onError: () => {} } })).toBe(false)
    expect(shouldToastMutationError({}, { options: { meta: { errorHandled: true } } })).toBe(false)
  })
})
