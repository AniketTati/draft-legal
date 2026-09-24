/**
 * Y2 — the one way the API sends text to a model: the agents service, or a
 * model provider directly (embeddings, reranking).
 *
 * Each call site redacts under the org's PII policy as it builds its body
 * (lib/pii-policy.ts), and eight leak paths were call sites that didn't
 * (X23, X27, X36, X37, X40, X52, X55, X67). `modelFetch` checks the whole
 * body once more before it leaves and replaces any raw value still there with
 * its marker (in tokenize mode, the org's token). When it has to, it records
 * a `PII_BOUNDARY_REDACTED` audit event and a warning naming the surface: that
 * call site's own redaction missed something.
 *
 * Left as they are:
 *   - the fields a caller names as typed by the user (a chat message, a
 *     question, drafting instructions): sent as typed, so a value the user
 *     asks for can be applied (X23);
 *   - ids and URLs;
 *   - round-trip tokens and markers, which no pattern matches.
 *
 * What an internal tool returns goes to the model too: routes/internal-ai.ts
 * passes each tool response through `toolResponseBackstop`. That leaves alone
 * the values the model already has: those the tool's request carried, and
 * those a model wrote during the call (X23: a redline proposal carrying a new
 * value the user asked for in the chat).
 *
 * lib/model-boundary.test.ts fails on any fetch in apps/api/src other than
 * this one and a list of calls that send no contract text to a model.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { moduleLogger } from './logger.js'
import { AuditAction } from '@clm/types'
import { backstopJson, getOrgPiiMode, type BackstopResult } from './pii-policy.js'
import type { PiiMode } from './pii-redactor.js'
import { createAuditEvent } from './audit.js'

const log = moduleLogger('model-boundary')

export interface ModelCall {
  orgId: string
  /** Where the call comes from, as the audit trail names it: `agent_chat`, `redline_propose`, … */
  surface: string
  /** Top-level body fields the user typed, sent as typed. */
  userAuthored?: string[]
  contractId?: string
  userId?: string
}

/**
 * Within an internal tool call, the text the model already has: the request,
 * as the agents service sent it, and what a model wrote during the call.
 */
const modelHas = new AsyncLocalStorage<string[]>()

/** Run an internal tool call with its own record of that text: a callback-style preHandler. */
export function recordingModelOutput(next: () => void): void {
  modelHas.run([], next)
}

/** `fetch` for a call to a model: the org's PII policy is checked once more over its JSON body. */
export async function modelFetch(url: string, init: RequestInit, call: ModelCall): Promise<Response> {
  let res: Response
  if (typeof init.body !== 'string') res = await fetch(url, init)
  else {
    const body = await backstopBody(init.body, call)
    res = await fetch(url, body === init.body ? init : { ...init, body })
  }
  await noteModelOutput(res)
  return res
}

/** Inside an internal tool call, what a model wrote may go back to it. */
async function noteModelOutput(res: Response): Promise<void> {
  const has = modelHas.getStore()
  if (!has || !res.ok || /event-stream/.test(res.headers.get('content-type') ?? '')) return
  has.push(await res.clone().text().catch(() => ''))
}

async function backstopBody(body: string, call: ModelCall): Promise<string> {
  let value: unknown
  try { value = JSON.parse(body) } catch { value = body }
  const userAuthored = new Set(call.userAuthored ?? [])
  const result = backstopJson(call.orgId, await getOrgPiiMode(call.orgId), value, {
    skip: (key, depth) => depth === 0 && userAuthored.has(key),
  })
  if (result.total === 0) return body
  await record(call, result)
  return typeof result.value === 'string' ? result.value : JSON.stringify(result.value)
}

/**
 * What an internal tool's response is checked against, settled before its
 * handler runs: the org's mode, and the text the model has (the request, and
 * as the handler runs, what a model writes). A value is judged by whether
 * that text contains it: detection can depend on context (a card number
 * needs the word "card" near it), which a value sent on its own lacks. The
 * check itself must not wait: a handler that sends without returning the
 * reply would be sent again in the meantime.
 */
export interface ToolCheck { orgId: string; mode: PiiMode; known: string[] }

export async function toolCheck(orgId: string | undefined, requestBody: unknown): Promise<ToolCheck | undefined> {
  if (!orgId) return undefined
  const mode = await getOrgPiiMode(orgId)
  const known = modelHas.getStore() ?? []
  known.push(JSON.stringify(requestBody ?? null))
  return { orgId, mode, known }
}

/**
 * The same check over an internal tool's response, which the agents service
 * hands to the model. `payload` is the serialized body, as an onSend hook has
 * it. Synchronous; the audit event is written behind it.
 */
export function toolResponseBackstop(check: ToolCheck | undefined, tool: string, payload: unknown): unknown {
  if (!check || check.mode === 'off' || typeof payload !== 'string' || !payload) return payload
  let value: unknown
  try { value = JSON.parse(payload) } catch { return payload }
  const result = backstopJson(check.orgId, check.mode, value, { allow: v => check.known.some(text => text.includes(v)) })
  if (result.total === 0) return payload
  void record({ orgId: check.orgId, surface: `tool:${tool}` }, result)
  return JSON.stringify(result.value)
}

async function record(call: Pick<ModelCall, 'orgId' | 'surface' | 'contractId' | 'userId'>, result: BackstopResult<unknown>): Promise<void> {
  const metadata = { surface: call.surface, mode: result.mode, counts: result.counts, total: result.total }
  log.warn({ orgId: call.orgId, ...metadata }, 'pii_boundary_redacted: a call site sent personal data its redaction missed')
  await createAuditEvent({
    orgId: call.orgId,
    userId: call.userId,
    action: AuditAction.PII_BOUNDARY_REDACTED,
    resourceType: call.contractId ? 'contract' : 'request',
    resourceId: call.contractId ?? 'system',
    metadata,
  }).catch((err: unknown) => {
    // The value is already replaced; a lost audit row mustn't fail the call.
    log.error({ err, surface: call.surface }, 'model boundary: the audit event was not written')
  })
}
