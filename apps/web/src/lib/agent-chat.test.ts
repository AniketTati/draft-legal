/**
 * C3 — /agent must not pin a model over the org's AI config, and the
 * "answered by" readout must report the resolved model, not the request.
 */
import { describe, it, expect } from 'vitest'
import { buildAgentChatBody, readProvenance } from './agent-chat'

describe('buildAgentChatBody', () => {
  it('sends no provider or model, so the org configuration decides', () => {
    const body = buildAgentChatBody({ message: 'hi', sessionId: 't1', skillSlug: null })
    expect(body).toEqual({ message: 'hi', sessionId: 't1', agentMode: true })
    expect(body).not.toHaveProperty('provider')
    expect(body).not.toHaveProperty('modelId')
  })

  it('passes an explicit pin and a skill through when given', () => {
    expect(buildAgentChatBody({ message: 'hi', skillSlug: 'review-nda', pin: { provider: 'anthropic', modelId: 'claude-sonnet-5' } }))
      .toMatchObject({ provider: 'anthropic', modelId: 'claude-sonnet-5', skillSlug: 'review-nda' })
  })
})

describe('readProvenance', () => {
  it('reports the resolved model from the done frame over the per-frame request stamp', () => {
    let p = readProvenance(undefined, { type: 'token', delta: 'a', provider: 'openai', model_id: 'gpt-4.1-mini' })
    expect(p?.model).toBe('gpt-4.1-mini')
    p = readProvenance(p, { type: 'done', provider: 'google', model: 'gemini-2.5-pro', model_id: 'gpt-4.1-mini', tier: 'default' })
    expect(p).toEqual({ provider: 'google', model: 'gemini-2.5-pro', tier: 'default' })
  })

  it('an unpinned turn (null request stamp) still ends with the resolved model', () => {
    let p = readProvenance(undefined, { type: 'token', delta: 'a', provider: null, model_id: null })
    expect(p).toBeUndefined()
    p = readProvenance(p, { type: 'done', provider: 'anthropic', model: 'claude-sonnet-5', tier: 'reasoning' })
    expect(p).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5', tier: 'reasoning' })
  })
})
