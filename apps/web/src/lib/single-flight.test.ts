/**
 * X48 — the app logged people out when several requests met an expired
 * access token at once: each refreshed with the same refresh token, the
 * server rotates it on use, so every refresh after the first was refused.
 */
import { describe, it, expect, vi } from 'vitest'
import { singleFlight } from './single-flight'

describe('singleFlight', () => {
  it('concurrent callers share one run', async () => {
    let release!: (v: string) => void
    const fn = vi.fn(() => new Promise<string>(r => { release = r }))
    const refresh = singleFlight(fn)
    const calls = [refresh(), refresh(), refresh()]
    release('new-token')
    expect(await Promise.all(calls)).toEqual(['new-token', 'new-token', 'new-token'])
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('a call after the run settles starts a new one, after a failure too', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('refused'))
      .mockResolvedValueOnce('again')
    const refresh = singleFlight(fn)
    const [a, b] = [refresh(), refresh()]
    await expect(a).rejects.toThrow('refused')
    await expect(b).rejects.toThrow('refused')
    expect(await refresh()).toBe('again')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
