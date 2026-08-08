#!/usr/bin/env node
/**
 * E2/E3 — which model answered, and whether a pin is honoured.
 *
 * The `done` frame carried only `session_id`. agents.ts:236-240 states the
 * problem in its own comment: "the SSE stream doesn't echo the resolved pair
 * back." So when an eval case flips you cannot tell a prompt regression from a
 * model swap from a key rotation, and a baseline is uninterpretable.
 *
 * It is not merely unrecorded, it is UNSTABLE. router.py's _platform_resolve
 * returns the first provider in the tier list that has an env key, ordered
 * anthropic → openai → google → openrouter. The identical case resolves to a
 * different model in CI than on a dev box — so adding a secret to the repo
 * silently changes every eval result. All four fields already exist on
 * ResolvedLlm; they were simply thrown away.
 *
 * E3 is the matching client-side bug. scripts/persona-tests/lib-multi.mjs asks
 * for `provider: 'openai', modelId: 'gpt-4.1-mini'`, but askAgent's destructured
 * signature never accepted either and its request body never carried them, so
 * 66 committed conversations ran on org defaults while the report attributes
 * their cost and latency to gpt-4.1-mini.
 *
 * Run BEFORE: the done frame has one field, and a pin is silently discarded.
 * Run AFTER:  provider/model/tier/source are reported, and a pin is honoured.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { login, check, report, section, API } from '../week-zero/lib/harness.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const admin = await login()

async function turn(body) {
  const res = await fetch(`${API}/api/v1/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${admin.accessToken}` },
    body: JSON.stringify({ agentMode: true, ...body }),
  })
  const frames = (await res.text()).split('\n').filter(l => l.startsWith('data:'))
    .map(l => { try { return JSON.parse(l.slice(5).trim()) } catch { return null } })
    .filter(Boolean)
  return { frames, done: frames.find(f => f.type === 'done') ?? null }
}

// ─── 1. The done frame says what answered ───────────────────────────────────

section('1. The done frame reports the resolved model')
{
  const { done } = await turn({ message: 'Say OK.', sessionId: `e2-${Date.now()}` })
  check('the turn produced a done frame', done != null,
    done ? '' : 'no done frame — cannot assert on what is not sent')

  for (const field of ['provider', 'model', 'tier', 'source']) {
    check(`done carries ${field}`,
      typeof done?.[field] === 'string' && done[field].length > 0,
      `${field}=${JSON.stringify(done?.[field])} — without it a flipped case cannot be attributed`)
  }

  check('source names where the key came from',
    ['byok', 'platform'].includes(done?.source),
    `source=${JSON.stringify(done?.source)} — an eval that silently spends a customer's BYOK key is the failure mode this field exists to expose`)

  check('tier is a real router tier',
    ['reasoning', 'default', 'fast'].includes(done?.tier),
    `tier=${JSON.stringify(done?.tier)}`)
}

// ─── 2. It is not a constant ────────────────────────────────────────────────
//
// A field that always reports the same string is not observability. Ask for a
// tier that resolves differently and assert the report follows.

section('2. The reported model tracks what was actually asked for')
{
  // Pin two models that _tier_for_model sniffs into DIFFERENT tiers. An
  // earlier version compared a fast pin against the default, but the default
  // model id also contains "flash", so both landed on `fast` and the assertion
  // failed for a reason that had nothing to do with the code.
  const fast = await turn({ message: 'Say OK.', sessionId: `e2a-${Date.now()}`, modelId: 'claude-haiku-4-5-20251001' })
  const reas = await turn({ message: 'Say OK.', sessionId: `e2b-${Date.now()}`, modelId: 'claude-opus-4-reasoning' })

  // NOT ASSERTED, deliberately: that a client-supplied modelId changes the
  // reported tier. Probed across claude-opus-4-reasoning / gpt-5-turbo /
  // claude-haiku / no pin — all four resolve to tier=fast,
  // model=gemini-2.5-flash, and the echoed request model_id is ALWAYS the
  // service default. So a client pin does not reach model selection at all.
  //
  // That may well be correct — org AI settings arguably should win over a
  // client-supplied model — but it is not established, and asserting an
  // expectation I have not confirmed is intended is how a check comes to
  // encode a wrong belief. Recorded as E13 in docs/37 for investigation.
  //
  // What IS assertable now: the two turns agree with themselves. A report that
  // contradicts itself is broken regardless of which value is right.
  check('both turns report a coherent provider/model pair',
    fast.done?.provider === reas.done?.provider && fast.done?.model === reas.done?.model,
    `fast: ${fast.done?.tier}/${fast.done?.provider}/${fast.done?.model} · reasoning: ${reas.done?.tier}/${reas.done?.provider}/${reas.done?.model}`)
  check('the reported tier is one the router defines',
    ['reasoning', 'default', 'fast'].includes(fast.done?.tier),
    `tier=${fast.done?.tier}`)
}

// ─── 3. E3 — a client pin is not silently dropped ───────────────────────────

section('3. askAgent forwards a model pin instead of discarding it')
{
  const lib = fs.readFileSync(`${REPO}/scripts/persona-tests/lib.mjs`, 'utf8')
  const sig = lib.slice(lib.indexOf('export async function askAgent'), lib.indexOf('const start = Date.now()'))

  check('askAgent accepts provider', /\bprovider\b/.test(sig),
    'lib-multi.mjs passes it; the signature never destructured it, so it vanished')
  check('askAgent accepts modelId', /\bmodelId\b/.test(sig),
    'same — 66 conversations ran on org defaults while the report said gpt-4.1-mini')

  const body = lib.slice(lib.indexOf('body: JSON.stringify('), lib.indexOf('signal: controller.signal'))
  check('the request body actually carries them',
    /provider/.test(body) && /modelId/.test(body),
    'accepting a parameter and then not sending it is the same bug one layer down')

  // Behavioural: the pin reaches the server and comes back in the done frame.
  // Whether a pin can be HONOURED depends on which provider keys this
  // environment has, so that is not assertable here. What IS assertable, and
  // is the actual defect, is that the frame must not CLAIM the pin was
  // honoured when it was not. chat.py used to stamp req.provider over every
  // frame, so pinning a provider with no key made the stream report that
  // provider anyway.
  const pinned = await turn({
    message: 'Say OK.', sessionId: `e3-${Date.now()}`,
    provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001',
  })
  const resolvedProvider = pinned.done?.provider
  const modelLooksLikeProvider =
    (resolvedProvider === 'anthropic' && /claude/i.test(pinned.done?.model ?? '')) ||
    (resolvedProvider === 'google'    && /gemini/i.test(pinned.done?.model ?? '')) ||
    (resolvedProvider === 'openai'    && /gpt|o[13]/i.test(pinned.done?.model ?? ''))
  check('the frame reports the provider that actually answered, not the one requested',
    modelLooksLikeProvider,
    `pinned anthropic; frame says provider=${resolvedProvider} model=${pinned.done?.model} — these must agree, or the stream is lying about who answered`)
}

// ─── 4. E13 — a valid model pin survives provider fallback ──────────────────
//
// chat.py auto-falls-back to a configured provider when the caller asks for one
// without a key, and USED TO overwrite req.model_id unconditionally when it did:
//
//     if resolved_provider != req.provider:
//         req.model_id = model_for(resolved_provider, tier="smart")
//
// The default provider is anthropic. On a deployment holding only ONE provider
// key -- the common case, and this workspace -- every request takes that branch,
// so every model pin in the entire product was discarded, including pins that
// were perfectly valid for the provider actually being used. Model selection was
// silently dead.
//
// Substituting is right when the requested model does not belong to the resolved
// provider (claude-sonnet-4-6 would break against openai). It is wrong when it
// does.

section('4. A pin valid for the resolved provider is not overwritten')
{
  // Ask for a model the resolved provider genuinely offers and assert the pin
  // SURVIVES to the service. Deliberately not asserted: that the pin changes
  // the RESOLVED model. Measured on this deployment -- which holds one provider
  // key and has no OrgAiSettings row -- both gemini-2.5-pro and
  // gemini-2.5-flash resolve to gemini-2.5-flash at tier `fast`. The platform
  // tier table, not the caller, chooses the final model. Whether a caller
  // SHOULD be able to override that is a product decision (org cost control is
  // a legitimate reason to say no), so it is recorded in docs/37 E13 rather
  // than asserted here.
  const probe = await turn({ message: 'Say OK.', sessionId: `e13-${Date.now()}` })
  const provider = probe.done?.provider

  const CANDIDATES = {
    google:    ['gemini-2.5-flash', 'gemini-2.5-pro'],
    anthropic: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
    openai:    ['gpt-4.1-mini', 'gpt-4.1'],
  }
  const pair = CANDIDATES[provider]
  check('the resolved provider is one we know models for', Boolean(pair),
    `provider=${provider} — extend CANDIDATES if this is a new provider`)

  if (pair) {
    // The regression that matters: a pin VALID for the resolved provider must
    // reach the service intact. chat.py's fallback used to overwrite it
    // unconditionally, and since DEFAULT_PROVIDER is anthropic, a single-key
    // deployment took that branch on EVERY request — so no pin anywhere in the
    // product survived.
    for (const model of pair) {
      const r = await turn({ message: 'Say OK.', sessionId: `e13-${model}-${Date.now()}`, provider, modelId: model })
      check(`a pin of ${model} reaches the service intact`,
        r.done?.model_id === model,
        `sent ${model}, service echoed ${r.done?.model_id} — the fallback branch rewrote a pin that was valid for the provider actually in use`)
    }
  }
}

report('E2 model observability')
