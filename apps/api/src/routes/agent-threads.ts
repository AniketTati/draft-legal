/**
 * AgentThread CRUD (D.1.6a — lands D.0.4b's threads/messages/tool_calls surface)
 *
 *   GET    /api/v1/agent/threads?limit=20&scopeType=contract&scopeId=xxx
 *   GET    /api/v1/agent/threads/:id     — full thread + messages + tool calls
 *   POST   /api/v1/agent/threads          — create empty thread
 *   POST   /api/v1/agent/threads/:id/turns — append a user+assistant turn
 *   DELETE /api/v1/agent/threads/:id     — soft-archive
 *
 * Why client-side persistence (rail POSTs after stream completes) instead of
 * proxy-side (Node writes as it forwards the stream):
 *   - Rail already has the full message state + tool calls after stream ends
 *   - Python stays stateless — no DB dep in the agents service
 *   - Node proxy stays thin — just a passthrough, no frame parsing
 *   - One write per turn instead of one write per stream frame
 *
 * Trade-off: if the rail crashes mid-stream the turn isn't persisted. Given
 * the streams typically last 2-5s this is acceptable for v1; a server-side
 * capture is a future hardening when we turn threads into a "never lose a
 * conversation" guarantee.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { getPermissionsForRoles, evaluatePermission } from '../lib/permissions.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction } from '@clm/types'

// The API calling ITSELF, so localhost plus its own port is the correct value
// and needs no deploy config. It used to read API_URL ?? AGENTS_API_URL ??
// localhost:3001. Neither name is set on the API container — AGENTS_API_URL is
// set nowhere at all, and the API_URL in deploy.yml belongs to the smoke-test
// runner, not the service — so production fell through to :3001 while the
// container listens on PORT=8080 (Dockerfile:44). That broke write-tool
// execution (:387) and every undo URL below.
const AGENTS_INTERNAL_URL = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3001}`
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? ''

// D.3.2 — registry of write tools the ActionPreview can execute. Each entry
// is a thin pass-through to the matching /internal/ai/tools/:name endpoint.
// Adding a new write tool here + in internal-ai.ts is the full path.
//
// W0-1 — the value is the permission the tool's REST twin already enforces.
// This is the ONLY layer where the caller's role can be checked: the internal
// endpoints downstream authenticate the *service*, and requireAuth maps a
// valid internal secret to roles:['ADMIN']. Without this map, any authenticated
// user — VIEWER, FINANCE — could perform writes their own REST routes reject.
const WRITE_TOOLS = new Map<string, [action: string, resource: string]>([
  ['comment_add',                   ['edit',   'contract']], // comments.ts:52
  ['request_create',                ['create', 'request']],  // requests.ts:82
  ['contract_update',               ['edit',   'contract']], // contracts.ts:1001
  ['approval_route',                ['edit',   'contract']], // contracts.ts:1907
  ['contract_create_from_template', ['create', 'contract']], // contracts.ts:306
  ['redline_apply',                 ['edit',   'contract']], // contracts.ts:625
  ['approval_decide',               ['approve', 'workflow']], // approvals.ts:277
])

/**
 * Evaluate the permission a write tool requires for the calling user.
 *
 * `requirePermission` can't be used as a preHandler here because the required
 * permission depends on the request body (apply) or on a database row (undo),
 * neither of which is known at route-registration time — so we call the same
 * underlying pair it does.
 */
async function checkToolPermission(
  req: FastifyRequest,
  reply: FastifyReply,
  toolName: string,
): Promise<boolean> {
  const mapped = WRITE_TOOLS.get(toolName)
  if (!mapped) {
    reply.status(400).send({ detail: `Tool "${toolName}" is not a registered write tool` })
    return false
  }
  const [action, resource] = mapped
  const { orgId, roles } = req.user
  const permissions = req.user.apiPermissions ?? await getPermissionsForRoles(orgId, roles)
  if (!evaluatePermission(permissions, action, resource).granted) {
    reply.status(403).send({
      type:   'https://httpstatuses.com/403',
      title:  'Forbidden',
      status: 403,
      detail: `Missing permission: ${action}:${resource}`,
    })
    return false
  }
  return true
}

// D.5.5 — contract_update actions that are reversible (we snapshot the
// before-value in the tool-call output + an undo handler restores it).
// Actions NOT listed here kick off async pipelines that can't cleanly
// unwind inside the 15-min window (retype, re_analyze).
const REVERSIBLE_CONTRACT_UPDATE_ACTIONS = new Set([
  'set_status', 'assign_owner', 'add_tag', 'remove_tag',
])

const ScopeSchema = z.object({
  scopeType: z.enum(['matter', 'contract', 'request']).optional(),
  scopeId:   z.string().optional(),
}).refine(
  (s) => (s.scopeType && s.scopeId) || (!s.scopeType && !s.scopeId),
  { message: 'scopeType and scopeId must be provided together' },
)

const CreateThreadSchema = z.object({
  // Optional explicit id — lets the caller (the chat UI) reuse the agents
  // service's session_id (a UUID) as the thread id, so session continuity
  // and thread-row identity stay aligned. Without this, the UI persists a
  // thread under a fresh cuid and the next GET /threads/{session_id} 404s,
  // wiping the user's just-streamed conversation.
  id:           z.string().min(8).max(64).optional(),
  title:        z.string().min(1).max(200).optional(),
  scopeType:    z.enum(['matter', 'contract', 'request']).optional(),
  scopeId:      z.string().optional(),
  providerHint: z.string().optional(),
})

const ApplyActionSchema = z.object({
  toolName:  z.string().min(1),
  args:      z.record(z.unknown()),
  // Optional — pass the assistant message id the action was proposed from
  // so the resulting ToolCall row can be linked back for audit replay.
  messageId: z.string().optional(),
  // Optional — echo back to the client so it can match response → card.
  actionId:  z.string().optional(),
})

const AppendTurnSchema = z.object({
  userMessage: z.string().min(1).max(10_000),
  assistant:   z.object({
    content:      z.string(),
    provider:     z.string().optional(),
    model:        z.string().optional(),
    tier:         z.string().optional(),
    inputTokens:  z.number().int().optional(),
    outputTokens: z.number().int().optional(),
    costUsd:      z.number().optional(),
    traceId:      z.string().optional(),
  }),
  toolCalls: z.array(z.object({
    id:        z.string().optional(),            // SSE id; kept for cross-ref
    toolName:  z.string().min(1),
    args:      z.record(z.unknown()).default({}),
    status:    z.enum(['success', 'error']),
    result:    z.string().optional(),
    error:     z.string().optional(),
    latencyMs: z.number().int().optional(),
  })).default([]),
})

// Keep the title derived from the first user message — trimmed to a sane length.
function defaultTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim().replace(/\s+/g, ' ')
  return trimmed.length <= 60 ? trimmed : trimmed.slice(0, 57) + '…'
}

export async function agentThreadRoutes(app: FastifyInstance) {
  // Every route here requires an authenticated user + scopes to their org.
  app.addHook('preHandler', requireAuth)

  // ── GET /threads — list recent (non-archived) threads ──────────────────────
  app.get('/', async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const q = req.query as { limit?: string; scopeType?: string; scopeId?: string }
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20))

    const where: Record<string, unknown> = { orgId, userId, archivedAt: null }
    if (q.scopeType && q.scopeId) {
      where.scopeType = q.scopeType
      where.scopeId = q.scopeId
    }

    const threads = await prisma.agentThread.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        id: true, title: true, scopeType: true, scopeId: true,
        originSkillId: true, providerHint: true,
        createdAt: true, updatedAt: true,
        _count: { select: { messages: true, toolCalls: true } },
      },
    })
    return reply.send({
      threads: threads.map(t => ({
        ...t,
        messageCount: t._count.messages,
        toolCallCount: t._count.toolCalls,
        _count: undefined,
      })),
    })
  })

  // ── GET /threads/:id — full thread + messages + tool calls ─────────────────
  app.get('/:id', async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id } = req.params as { id: string }

    const thread = await prisma.agentThread.findFirst({
      where: { id, orgId, userId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        toolCalls: { orderBy: { createdAt: 'asc' } },
      },
    })
    if (!thread) {
      return reply.status(404).send({ detail: 'Thread not found' })
    }
    return reply.send(thread)
  })

  // ── POST /threads — create empty thread ────────────────────────────────────
  app.post('/', async (req, reply) => {
    let body
    try { body = CreateThreadSchema.parse(req.body ?? {}) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid body', issues: (err as { issues?: unknown }).issues })
    }
    const { orgId, sub: userId } = req.user

    // Idempotent on the explicit id: if a thread with this id already exists
    // for this user/org, return it instead of erroring on the unique
    // constraint. This handles the chat-UI case where the same session_id is
    // sent on every turn — the first call creates, subsequent calls just
    // return the existing row.
    if (body.id) {
      const existing = await prisma.agentThread.findFirst({
        where: { id: body.id, orgId, userId },
      })
      if (existing) return reply.send(existing)
    }

    const thread = await prisma.agentThread.create({
      data: {
        ...(body.id ? { id: body.id } : {}),
        orgId, userId,
        title:        body.title ?? 'New chat',
        scopeType:    body.scopeType,
        scopeId:      body.scopeId,
        providerHint: body.providerHint,
      },
    })
    return reply.send(thread)
  })

  // ── POST /threads/:id/turns — append a user+assistant turn ─────────────────
  // Called by the rail after the SSE stream completes so the full exchange
  // (user message, final assistant text, all tool invocations) is persisted
  // in a single atomic write. This is cheaper than persisting frame-by-frame
  // and keeps Python stateless.
  app.post('/:id/turns', async (req, reply) => {
    let body
    try { body = AppendTurnSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid body', issues: (err as { issues?: unknown }).issues })
    }
    const { orgId, sub: userId } = req.user
    const { id: threadId } = req.params as { id: string }

    // Scope check — cross-tenant or cross-user writes are silently 404.
    const thread = await prisma.agentThread.findFirst({
      where: { id: threadId, orgId, userId },
      select: { id: true, title: true },
    })
    if (!thread) {
      return reply.status(404).send({ detail: 'Thread not found' })
    }

    // Single transaction: user message + assistant message + tool_calls +
    // thread title backfill + updatedAt bump. If any insert fails, the whole
    // turn is rejected — we never end up with a half-persisted exchange.
    const result = await prisma.$transaction(async (tx) => {
      const userMsg = await tx.agentMessage.create({
        data: {
          threadId,
          role: 'user',
          content: [{ type: 'text', text: body.userMessage }],
        },
      })

      const assistantMsg = await tx.agentMessage.create({
        data: {
          threadId,
          role: 'assistant',
          content: [{ type: 'text', text: body.assistant.content }],
          provider: body.assistant.provider,
          model:    body.assistant.model,
          tier:     body.assistant.tier,
          inputTokens:  body.assistant.inputTokens,
          outputTokens: body.assistant.outputTokens,
          costUsd:      body.assistant.costUsd,
          traceId:      body.assistant.traceId,
        },
      })

      const toolCallsCreated = body.toolCalls.length > 0 ? await Promise.all(
        body.toolCalls.map(tc => tx.toolCall.create({
          data: {
            threadId,
            messageId: assistantMsg.id,
            toolName:  tc.toolName,
            // Prisma's Json columns don't accept Record<string, unknown>
            // without a narrowing cast. The shape is validated by Zod above,
            // so widening to the Prisma-blessed InputJsonValue is safe.
            input:     tc.args as unknown as Record<string, never>,
            status:    tc.status,
            output:    tc.result ? { preview: tc.result } : undefined,
            error:     tc.error,
            latencyMs: tc.latencyMs,
          },
        }))
      ) : []

      // Backfill title from the first user message if we're still on the
      // default, and bump updatedAt so list ordering is fresh.
      await tx.agentThread.update({
        where: { id: threadId },
        data: {
          title: thread.title === 'New chat' ? defaultTitle(body.userMessage) : thread.title,
          updatedAt: new Date(),
        },
      })

      return { userMsg, assistantMsg, toolCalls: toolCallsCreated }
    })

    return reply.send({
      userMessageId:      result.userMsg.id,
      assistantMessageId: result.assistantMsg.id,
      toolCallIds:        result.toolCalls.map(tc => tc.id),
    })
  })

  // ── POST /threads/:id/actions/apply (D.3.2) ────────────────────────────────
  // Called by the rail's ActionPreview Apply button. Validates the thread
  // belongs to the caller, looks up the tool in the write-tool allowlist,
  // dispatches to the matching internal endpoint, and records a ToolCall
  // row for audit + D.3.5 undo.
  //
  // Why route through Node instead of letting the rail call the internal
  // endpoint directly:
  //   - orgId comes from the JWT, not the client — can't be forged
  //   - authorId defaults to the caller — user can't post as someone else
  //   - ToolCall row links action to messageId for D.3.4 receipt thread
  //   - Audit event fires regardless of which tool ran (D.3.6)
  app.post('/:id/actions/apply', async (req, reply) => {
    let body
    try { body = ApplyActionSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid body', issues: (err as { issues?: unknown }).issues })
    }
    const { orgId, sub: userId } = req.user
    const { id: threadId } = req.params as { id: string }

    // W0-1 — allowlist *and* per-tool permission. Both replies are sent by the
    // helper, so an early return here is a completed response.
    if (!await checkToolPermission(req, reply, body.toolName)) return

    const thread = await prisma.agentThread.findFirst({
      where: { id: threadId, orgId, userId },
      select: { id: true },
    })
    if (!thread) return reply.status(404).send({ detail: 'Thread not found' })

    // Inject invariants — orgId + the caller-identity field come from the
    // JWT, never the client. Each write tool names the user field
    // differently (authorId for comment_add, requestedById for
    // request_create, userId for contract_update / approval_route);
    // we pick the right one per tool so the downstream Zod schema
    // validates.
    const userField =
      body.toolName === 'request_create'              ? 'requestedById'
      : body.toolName === 'contract_update'            ? 'userId'
      : body.toolName === 'approval_route'             ? 'userId'
      : body.toolName === 'contract_create_from_template' ? 'userId'
      : body.toolName === 'redline_apply'              ? 'userId'
      // L9 — approval_decide's userId is not a convenience field: the endpoint
      // matches the step's approverId against it, so this is what stops the
      // agent approving on someone else's behalf.
      : body.toolName === 'approval_decide'            ? 'userId'
      : 'authorId'
    const enforcedArgs: Record<string, unknown> = {
      ...(body.args ?? {}),
      orgId,
      [userField]: userId,
    }

    const startedAt = Date.now()
    let toolCall
    try {
      const res = await fetch(`${AGENTS_INTERNAL_URL}/api/internal/ai/tools/${body.toolName}`, {
        method:  'POST',
        headers: {
          'x-internal-secret':  INTERNAL_SECRET,
          'x-internal-service': 'agents',
          'content-type':       'application/json',
        },
        body: JSON.stringify(enforcedArgs),
      })
      const text = await res.text()
      let parsed: unknown = text
      try { parsed = JSON.parse(text) } catch { /* keep as string */ }
      const latencyMs = Date.now() - startedAt

      toolCall = await prisma.toolCall.create({
        data: {
          threadId,
          messageId: body.messageId ?? threadId, // best-effort link; schema requires string
          toolName:  body.toolName,
          input:     enforcedArgs as Record<string, never>,
          status:    res.ok ? 'success' : 'error',
          output:    res.ok ? (parsed as object) : undefined,
          error:     res.ok ? null : (typeof parsed === 'object' ? JSON.stringify(parsed).slice(0, 500) : String(text).slice(0, 500)),
          latencyMs,
          reversible: (() => {
            if (body.toolName === 'comment_add')     return true
            if (body.toolName === 'request_create')  return true
            if (body.toolName === 'approval_route')  return true
            if (body.toolName === 'contract_create_from_template') return true
            if (body.toolName === 'redline_apply')   return true
            if (body.toolName === 'contract_update') {
              // Per-action — read the action off the args since the
              // handler's response carries a server-computed flag too.
              const action = (enforcedArgs.action as string | undefined) ?? ''
              const serverSaid = (parsed as { reversible?: boolean } | string | null)
              if (typeof serverSaid === 'object' && serverSaid !== null && typeof serverSaid.reversible === 'boolean') {
                return serverSaid.reversible
              }
              return REVERSIBLE_CONTRACT_UPDATE_ACTIONS.has(action)
            }
            return false
          })(),
        },
      })

      // D.3.6 — audit trail for every agent tool invocation, win or lose.
      // Written outside the tool-specific ToolCall row so org-wide audit
      // reports (the D.0.6 AuditEvent table) can surface "agent X wrote
      // Y" in the same view as user actions.
      await createAuditEvent({
        orgId,
        userId,
        action: AuditAction.AGENT_TOOL_APPLIED,
        resourceType: 'agent_tool_call',
        resourceId: toolCall.id,
        metadata: {
          threadId,
          toolName: body.toolName,
          status: res.ok ? 'success' : 'error',
          latencyMs,
          args: enforcedArgs,
          messageId: body.messageId,
        },
        ipAddress: req.ip,
        userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 500),
      })

      if (!res.ok) {
        return reply.status(res.status).send({
          ok: false,
          toolCallId: toolCall.id,
          error: typeof parsed === 'object' ? parsed : { detail: String(text).slice(0, 500) },
        })
      }
      return reply.send({
        ok: true,
        toolCallId: toolCall.id,
        actionId: body.actionId,
        result: parsed,
      })
    } catch (e) {
      const latencyMs = Date.now() - startedAt
      await prisma.toolCall.create({
        data: {
          threadId,
          messageId: body.messageId ?? threadId,
          toolName:  body.toolName,
          input:     enforcedArgs as Record<string, never>,
          status:    'error',
          error:     (e as Error).message.slice(0, 500),
          latencyMs,
        },
      })
      return reply.status(502).send({ ok: false, error: (e as Error).message })
    }
  })

  // ── POST /threads/:id/actions/:toolCallId/undo (D.3.5) ────────────────────
  // Reverses a previously-applied write tool if it was flagged reversible +
  // landed within the 15-minute undo window. Routes to the matching
  // tool-specific /undo endpoint (e.g. /tools/comment_add/undo) and
  // stamps rolledBackAt on the ToolCall row.
  app.post('/:id/actions/:toolCallId/undo', async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id: threadId, toolCallId } = req.params as { id: string; toolCallId: string }

    // Thread ownership gate
    const thread = await prisma.agentThread.findFirst({
      where: { id: threadId, orgId, userId },
      select: { id: true },
    })
    if (!thread) return reply.status(404).send({ detail: 'Thread not found' })

    // Find the ToolCall row; verify it's reversible + hasn't already been
    // undone + is within the 15-minute undo window.
    const toolCall = await prisma.toolCall.findFirst({
      where: { id: toolCallId, threadId },
    })
    if (!toolCall) return reply.status(404).send({ detail: 'Tool call not found' })

    // W0-1 — undoing a write is itself a write: it needs the same permission
    // the original tool did. The tool name is only knowable from the row, which
    // is why this check lives here rather than in a preHandler.
    if (!await checkToolPermission(req, reply, toolCall.toolName)) return

    if (!toolCall.reversible) {
      return reply.status(400).send({ detail: 'This action is not reversible' })
    }
    if (toolCall.rolledBackAt) {
      return reply.status(409).send({ detail: 'Already undone', rolledBackAt: toolCall.rolledBackAt })
    }
    const ageMs = Date.now() - toolCall.createdAt.getTime()
    const UNDO_WINDOW_MS = 15 * 60 * 1000
    if (ageMs > UNDO_WINDOW_MS) {
      return reply.status(410).send({
        detail: 'Undo window expired (15 minutes)',
        ageMs, windowMs: UNDO_WINDOW_MS,
      })
    }

    // Per-tool undo adapter — build the undo request from the original
    // tool call's output. Each new reversible tool adds a case here + its
    // /tools/<name>/undo endpoint in internal-ai.ts.
    let undoUrl: string
    let undoBody: Record<string, unknown>
    if (toolCall.toolName === 'comment_add') {
      const out = (toolCall.output ?? {}) as { comment?: { id?: string } }
      const commentId = out?.comment?.id
      if (!commentId) {
        return reply.status(400).send({ detail: 'Original tool call result missing commentId — cannot undo' })
      }
      undoUrl = `${AGENTS_INTERNAL_URL}/api/internal/ai/tools/comment_add/undo`
      undoBody = { orgId, commentId }
    } else if (toolCall.toolName === 'request_create') {
      const out = (toolCall.output ?? {}) as { request?: { id?: string } }
      const requestId = out?.request?.id
      if (!requestId) {
        return reply.status(400).send({ detail: 'Original tool call result missing requestId — cannot undo' })
      }
      undoUrl = `${AGENTS_INTERNAL_URL}/api/internal/ai/tools/request_create/undo`
      undoBody = { orgId, requestId }
    } else if (toolCall.toolName === 'contract_update') {
      const out = (toolCall.output ?? {}) as {
        action?: string
        contractId?: string
        snapshot?: Record<string, unknown>
      }
      const { action, contractId, snapshot } = out
      if (!action || !REVERSIBLE_CONTRACT_UPDATE_ACTIONS.has(action)) {
        return reply.status(400).send({ detail: `contract_update action "${action}" is not reversible` })
      }
      if (!contractId || !snapshot) {
        return reply.status(400).send({ detail: 'Original tool call result missing contractId or snapshot — cannot undo' })
      }
      undoUrl = `${AGENTS_INTERNAL_URL}/api/internal/ai/tools/contract_update/undo`
      undoBody = { orgId, contractId, action, snapshot }
    } else if (toolCall.toolName === 'approval_route') {
      const out = (toolCall.output ?? {}) as {
        instanceId?: string
        contractId?: string
        previousStatus?: string
      }
      if (!out.instanceId || !out.contractId || !out.previousStatus) {
        return reply.status(400).send({ detail: 'Original tool call result missing instanceId/contractId/previousStatus — cannot undo' })
      }
      undoUrl = `${AGENTS_INTERNAL_URL}/api/internal/ai/tools/approval_route/undo`
      undoBody = {
        orgId,
        instanceId: out.instanceId,
        contractId: out.contractId,
        previousStatus: out.previousStatus,
      }
    } else if (toolCall.toolName === 'contract_create_from_template') {
      const out = (toolCall.output ?? {}) as { contractId?: string }
      if (!out.contractId) {
        return reply.status(400).send({ detail: 'Original tool call result missing contractId — cannot undo' })
      }
      undoUrl = `${AGENTS_INTERNAL_URL}/api/internal/ai/tools/contract_create_from_template/undo`
      undoBody = { orgId, contractId: out.contractId }
    } else if (toolCall.toolName === 'redline_apply') {
      const out = (toolCall.output ?? {}) as {
        contractId?: string
        previousVersionId?: string
        newVersionId?: string
      }
      if (!out.contractId || !out.previousVersionId || !out.newVersionId) {
        return reply.status(400).send({ detail: 'Original tool call result missing contractId / previousVersionId / newVersionId — cannot undo' })
      }
      undoUrl = `${AGENTS_INTERNAL_URL}/api/internal/ai/tools/redline_apply/undo`
      undoBody = {
        orgId,
        contractId:        out.contractId,
        previousVersionId: out.previousVersionId,
        newVersionId:      out.newVersionId,
      }
    } else {
      return reply.status(400).send({ detail: `No undo adapter for tool "${toolCall.toolName}"` })
    }

    try {
      const r = await fetch(undoUrl, {
        method: 'POST',
        headers: {
          'x-internal-secret':  INTERNAL_SECRET,
          'x-internal-service': 'agents',
          'content-type':       'application/json',
        },
        body: JSON.stringify(undoBody),
      })
      const text = await r.text()
      let parsed: unknown = text
      try { parsed = JSON.parse(text) } catch { /* keep as string */ }
      if (!r.ok) {
        return reply.status(r.status).send({ ok: false, error: parsed })
      }
      const updated = await prisma.toolCall.update({
        where: { id: toolCallId },
        data:  { rolledBackAt: new Date(), rolledBackById: userId },
      })
      // D.3.6 — audit trail for undo too.
      await createAuditEvent({
        orgId,
        userId,
        action: AuditAction.AGENT_TOOL_UNDONE,
        resourceType: 'agent_tool_call',
        resourceId: toolCallId,
        metadata: {
          threadId,
          toolName: toolCall.toolName,
          originalAppliedAt: toolCall.createdAt,
          undoLatencyMs: Date.now() - toolCall.createdAt.getTime(),
        },
        ipAddress: req.ip,
        userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 500),
      })
      return reply.send({ ok: true, toolCallId: updated.id, rolledBackAt: updated.rolledBackAt })
    } catch (e) {
      return reply.status(502).send({ ok: false, error: (e as Error).message })
    }
  })

  // ── DELETE /threads/:id — soft-archive ─────────────────────────────────────
  app.delete('/:id', async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id } = req.params as { id: string }

    const existing = await prisma.agentThread.findFirst({
      where: { id, orgId, userId },
      select: { id: true },
    })
    if (!existing) {
      return reply.status(404).send({ detail: 'Thread not found' })
    }
    await prisma.agentThread.update({
      where: { id },
      data: { archivedAt: new Date() },
    })
    return reply.send({ id, archived: true })
  })
}
