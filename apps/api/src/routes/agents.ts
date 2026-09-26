import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { requireUserOrAdminKey, isLimitedApiKey } from '../middleware/auth.js'
// Wave 1.7 — AI-consuming endpoints are gated on view:contract so a scopeless
// public-API key (or a non-contract principal) can't burn the org's LLM
// budget. Per-turn cost enforcement is tightened separately in Wave 3.
import { requirePermission } from '../middleware/permissions.js'
import { getPermissionsForRoles, evaluatePermission } from '../lib/permissions.js'
import { createAuditEvent } from '../lib/audit.js'
import { ChatMessageSchema, AuditAction } from '@clm/types'
import { prisma } from '../lib/prisma.js'
import { queueClassifyDocument } from '../lib/queue.js'
import { indexContract } from '../lib/elasticsearch.js'
import { actingUserId, NO_ACTING_USER } from '../lib/acting-user.js'
import { assertCostCapNotExceeded, recordCost, estimateCostUsd, CostCapExceededError, recordUsage } from '../lib/costCap.js'
import { postScore, findTraceBySession, langfuseConfigured } from '../lib/langfuse.js'
import { redactJson, restorePii, streamRestorer, unresolvedPiiTokens, dropPartialToken, sliceOutsideTokens, getOrgPiiMode, plainSpacesHtml, htmlTextForms, valueLeftInMarkup, valueAcross } from '../lib/pii-policy.js'
import { htmlToText } from '../lib/html-text.js'
import { modelFetch } from '../lib/model-boundary.js'
import { lockOf, lockedBody } from '../lib/external-edit.js'

const AGENTS_URL = process.env.AGENTS_URL ?? 'http://localhost:8002'
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? ''

const FeedbackSchema = z.object({
  sessionId: z.string().min(1),
  /** Optional: the exact turn. Without it we resolve the session's latest trace. */
  traceId:   z.string().optional(),
  rating:    z.enum(['up', 'down']),
  comment:   z.string().max(2000).optional(),
})

const AssistSchema = z.object({
  selectedText: z.string().min(1),
  action: z.enum(['rewrite', 'simplify', 'expand', 'check_compliance', 'suggest_alternative', 'fix_layout', 'rewrite_document']),
  contractType: z.string().optional().default('general commercial'),
  governingLaw: z.string().optional().default('Delaware'),
  provider: z.string().optional(),
  modelId: z.string().optional(),
})

export async function agentRoutes(app: FastifyInstance) {
  // GET /api/v1/agent/models — list supported providers + models
  app.get('/models', { preHandler: requireUserOrAdminKey }, async (_req: unknown, reply) => {
    const upstream = await fetch(`${AGENTS_URL}/agent/models`, {
      headers: { 'x-internal-secret': INTERNAL_SECRET },
    }).catch(() => null)
    if (!upstream?.ok) {
      return reply.status(502).send({ detail: 'Agent service unavailable' })
    }
    return reply.send(await upstream.json())
  })

  // POST /api/v1/agent/feedback — what the user thought of an answer.
  //
  // The only quality signal that comes from a real person rather than a rubric,
  // and the cheapest one there is. It lands in Langfuse as a `user_feedback`
  // score on the turn's trace, so it sits beside the judge scores and can be
  // compared with them — a turn the judge liked and the user did not is the
  // most interesting row in the dataset.
  //
  // Fails OPEN: if Langfuse is unconfigured or unreachable this returns 200
  // with recorded:false. A thumbs-up must never show the user an error, and an
  // observability outage must not look like a broken product.
  app.post('/feedback', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const body = FeedbackSchema.parse(req.body)
    const { sub: userId, orgId } = req.user

    if (!langfuseConfigured()) {
      return reply.send({ recorded: false, reason: 'observability_disabled' })
    }

    // The browser knows its chat session, never a Langfuse trace id — the
    // agents service sets session_id from the thread, which is what makes this
    // resolvable without threading trace ids through the UI. X22 — either way,
    // only a trace of the caller's own counts (both ids come from the client).
    const traceId = await findTraceBySession(body.sessionId, { orgId, userId }, body.traceId)
    if (!traceId) {
      return reply.send({ recorded: false, reason: 'trace_not_found' })
    }

    const ok = await postScore({
      name: 'user_feedback',
      value: body.rating === 'up' ? 1 : 0,
      dataType: 'BOOLEAN',
      traceId,
      comment: body.comment,
      metadata: { source: 'app', userId, orgId, sessionId: body.sessionId },
    })
    return reply.send({ recorded: ok, ...(ok ? {} : { reason: 'langfuse_write_failed' }) })
  })

  // POST /api/v1/agent/chat — proxy to Python agent service with SSE streaming
  app.post('/chat', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const body = ChatMessageSchema.parse(req.body)
    const { sub: userId, orgId } = req.user

    // P23 production audit (2026-04-29). Block before we proxy so a
    // cap-busted org doesn't burn another LLM round-trip. This gate reads the
    // same Redis counter that recordCost() writes. Wave 3.6 — the chat path now
    // records its own spend after the stream completes (see the finally block
    // below); previously it read the counter but never wrote it, so chat could
    // blow past the daily cap indefinitely.
    try {
      await assertCostCapNotExceeded(orgId)
    } catch (e) {
      if (e instanceof CostCapExceededError) {
        return reply.status(429).send({
          error:  'cost_cap_exceeded',
          detail: 'Daily AI spend cap reached for this organization. Contact your admin to raise the cap or wait for the daily reset (UTC midnight).',
          usedUsd: Number(e.usedUsd.toFixed(4)),
          capUsd:  Number(e.capUsd.toFixed(2)),
        })
      }
      throw e
    }

    // D.4.1 — if a skillSlug is set, resolve the Skill row, snapshot
    // `{systemPrompt, allowedTools, version}`, and record a SkillInvocation
    // row. The forwarded payload carries the snapshot so the Python side
    // never has to query Postgres for the skill definition (keeps the
    // agents service ignorant of our DB schema).
    //
    // Lookup priority: org's own skill first, then built-in (orgId=null).
    // This lets an admin override a built-in slug (e.g. customise
    // `@review-nda`) without us having to fork the record.
    // Permission-derived tool denials, evaluated once per turn.
    // `contract_create_from_template` now proposes an ActionPreview like the
    // other write tools (C12), so checkToolPermission runs on Apply. It is
    // still withheld from anyone who could not create a contract through the
    // REST route: a tool the caller can never apply is not worth offering.
    const callerPermissions = req.user.apiPermissions ?? await getPermissionsForRoles(orgId, req.user.roles)
    const deniedTools: string[] = []
    if (!evaluatePermission(callerPermissions, 'create', 'contract').granted) {
      deniedTools.push('contract_create_from_template')
    }
    // X9 — read tools that need more than view:contract refuse the caller
    // server-side (internal-ai.ts); don't offer them either.
    if (!evaluatePermission(callerPermissions, 'edit', 'contract').granted) {
      deniedTools.push('redline_propose', 'redline_propose_batch')
    }
    if (!evaluatePermission(callerPermissions, 'view', 'playbook').granted) deniedTools.push('playbook_check')
    if (!evaluatePermission(callerPermissions, 'view', 'workflow').granted) deniedTools.push('approval_list')
    // X44 — the member directory is refused to API keys without the admin scope
    // (GET /users); user_search must not hand it to them through chat.
    if (isLimitedApiKey(req.user)) deniedTools.push('user_search')

    let skillPromptOverride: string | undefined
    let skillAllowedTools: string[] | undefined
    if (body.skillSlug) {
      const skill = await prisma.skill.findFirst({
        where: {
          slug: body.skillSlug,
          deletedAt: null,
          isPublished: true,
          OR: [
            { orgId },
            { orgId: null, ownerType: 'built_in' },
          ],
        },
        // Prefer org-owned over built-in on a tie.
        orderBy: [{ orgId: 'desc' }, { updatedAt: 'desc' }],
      })
      if (skill) {
        skillPromptOverride = skill.systemPrompt
        skillAllowedTools = skill.allowedTools
        // Record invocation for telemetry + audit. Skill-version freezes
        // behaviour: an edit mid-run can't change this row's effective prompt.
        // X45 — the invoker is a user: for an API key, the one who made it
        // (no row when there is none; this is telemetry, not a gate).
        const invokerId = actingUserId(req.user)
        if (invokerId) await prisma.skillInvocation.create({
          data: {
            skillId: skill.id,
            skillVersion: skill.version,
            threadId: body.sessionId ?? 'anonymous', // rail uses sessionId == threadId
            userId: invokerId,
            orgId,
            contextType: body.pageContext?.type,
            contextId: body.pageContext?.id,
            inputMessage: body.message.slice(0, 5_000),
          },
        }).catch(err => {
          // Don't fail the chat if telemetry write fails.
          app.log.warn({ err, skillSlug: body.skillSlug }, 'skill invocation write failed')
        })
      } else {
        app.log.info({ skillSlug: body.skillSlug, orgId }, 'skill slug not found — falling through')
      }
    }

    const upstream = await modelFetch(`${AGENTS_URL}/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
      body: JSON.stringify({
        message: body.message,
        session_id: body.sessionId,
        contract_id: body.contractId,
        provider: body.provider,
        model_id: body.modelId,
        user_id: userId,
        org_id: orgId,
        // D.1.4a — forward agent-mode + page-context for tool-binding path.
        // Absence/false falls through to the legacy fake-streamed behavior.
        agent_mode: body.agentMode ?? false,
        page_context: body.pageContext ?? null,
        // D.4.1 — skill overrides. Python uses these when present; otherwise
        // falls back to the default system prompt + full read-tool catalog.
        skill_system_prompt: skillPromptOverride ?? null,
        skill_allowed_tools: skillAllowedTools ?? null,
        // Tools this caller may not use. The agent's write tools stop at an
        // ActionPreview, where checkToolPermission evaluates the caller's role;
        // withholding a tool the caller could never apply also keeps the model
        // from offering (or claiming) it.
        denied_tools: deniedTools.length ? deniedTools : null,
        skill_slug: body.skillSlug ?? null,
        // P4.3 — structured entity mentions flow through to the
        // orchestrator; it prepends them as a hint to the user turn
        // so the LLM sees "the user mentioned @contract:X (id=cmod…)"
        // before the actual message.
        mentions: body.mentions ?? null,
      }),
    }, { orgId, surface: 'agent_chat', userId, contractId: body.contractId, userAuthored: ['message'] })

    if (!upstream.ok) {
      const err = await upstream.text()
      return reply.status(upstream.status === 400 ? 400 : 502).send({ detail: err || 'Agent service unavailable' })
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // L10 — Python sets this and the proxy used to drop it. Behind nginx or
      // an ALB the whole SSE response can otherwise be buffered into a single
      // write, at which point the tool chips and the answer land together and
      // real token streaming is invisible to the user.
      'X-Accel-Buffering': 'no',
    })
    // Stop Fastify from also sending its own response — the SSE stream
    // is being driven through reply.raw directly.
    reply.hijack()

    const reader = upstream.body?.getReader()
    if (!reader) { try { reply.raw.end() } catch { /* */ } return }

    // P-runtime audit (2026-05-02). The previous loop crashed the
    // entire API process with ERR_HTTP_HEADERS_SENT when the client
    // closed the stream early (Body Timeout, browser unload, probe
    // process exit). Both the writer call and the upstream cancel
    // need to be safe against a closed socket.
    let clientGone = false
    // Wave 3.6 — track response size so we can record spend against the daily
    // cap. Includes SSE/JSON framing, so this biases the estimate slightly HIGH
    // — the safe direction for a budget guard.
    //
    // L10 — counted in BYTES now that the hop forwards bytes. For multi-byte
    // text this reads slightly higher than the old char count, which is the
    // same direction the framing already biases, and the estimate is
    // deliberately high-biased for exactly this kind of slack.
    let streamedChars = 0
    reply.raw.on('close', () => {
      clientGone = true
      try { reader.cancel() } catch { /* */ }
    })
    try {
      while (true) {
        if (clientGone) break
        const { done, value } = await reader.read()
        if (done) break
        // L10 — forward the raw bytes. This used to be
        // `decoder.decode(value)` with no { stream: true }, which decodes each
        // chunk in isolation: any multi-byte sequence straddling a chunk
        // boundary became U+FFFD. With 20 000-char tool payloads, frames
        // routinely span TCP segments, and contract text is dense with
        // em-dashes, curly quotes, ellipses, bullets and currency symbols.
        // The result looked like a model quality problem rather than a proxy
        // bug because it was load-dependent. This hop only forwards bytes, so
        // not decoding at all is both correct and cheaper than decoding
        // correctly.
        streamedChars += value.byteLength
        if (!reply.raw.writableEnded) {
          try { reply.raw.write(Buffer.from(value)) } catch { break }
        }
      }
    } catch (err) {
      app.log.warn({ err }, 'agent-chat upstream read failed')
    } finally {
      if (!reply.raw.writableEnded) {
        try { reply.raw.end() } catch { /* */ }
      }
      // Record chat spend to the same counter the 429 gate reads, and to the
      // table the admin usage panel aggregates. Estimate on input + output
      // size, mirroring the compliance/obligation/renewal paths.
      // Fire-and-forget — a failure must not affect the already-sent reply.
      recordUsage(orgId, estimateCostUsd(body.message.length + streamedChars), {
        // What the caller asked for. The router may resolve to a different
        // model for the tier, and the SSE stream doesn't echo the resolved
        // pair back, so treat this as the requested model rather than a
        // billing record — same caveat as the cost estimate itself.
        provider: body.provider ?? 'requested-default',
        model:    body.modelId  ?? 'requested-default',
        tier:     'default',
        toolName: 'agent_chat',
        inputChars:  body.message.length,
        outputChars: streamedChars,
      }).catch(e => app.log.warn({ err: e }, '[costCap] recordUsage(agent_chat) failed'))
    }
  })

  // POST /api/v1/agent/draft — AI draft generation → saves as ContractVersion
  app.post('/draft', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const body = req.body as {
      userMessage: string
      // P61 audit (2026-05-02). Accept an explicit templateId from
      // the UI's NewContractFlow → forward to the Python agent so it
      // skips template-matching and uses the user's selection. Without
      // this the agent re-does the selection from scratch and often
      // returns NO_TEMPLATE_MATCH for org-authored templates without
      // a contractType.
      templateId?: string
      context?: Record<string, unknown>
      // Z6 — `counterpartyId` links a new contract to the counterparty it
      // was started from (Counterparties › New contract).
      saveAs?: { contractId?: string; title?: string; counterpartyId?: string }
    }

    if (!body.userMessage?.trim()) {
      return reply.status(400).send({ detail: 'userMessage is required' })
    }

    // `saveAs.contractId` arrives from an unvalidated request body and was used
    // directly in `contractVersion.create` below with no ownership check, so any
    // authenticated user could append an attacker-controlled version to ANY
    // contract in ANY organisation. Every sibling write scopes by org —
    // internal-ai.ts:2388 and clause-apply.ts:242,477 all filter
    // `{ id, orgId, deletedAt: null }`; this route was the exception.
    //
    // Checked here, before the agent call, so a request that will be refused
    // does not also cost a paid LLM run. 404 rather than 403: a caller outside
    // the org should not learn whether the id exists.
    // Saving is a WRITE, and this route is gated only on `view:contract`
    // because drafting without saving is a read-shaped operation. Evaluate the
    // write permission here rather than tightening the preHandler, which would
    // also block a viewer from previewing a draft they never persist.
    //
    // Without this a VIEWER — who POST /api/v1/contracts refuses outright —
    // could create contracts through this route. Reproduced: 200, row created.
    if (body.saveAs?.contractId || body.saveAs?.title) {
      const permissions = req.user.apiPermissions ?? await getPermissionsForRoles(orgId, req.user.roles)
      const action = body.saveAs.contractId ? 'edit' : 'create'
      if (!evaluatePermission(permissions, action, 'contract').granted) {
        return reply.status(403).send({
          type:   'https://httpstatuses.com/403',
          title:  'Forbidden',
          status: 403,
          detail: `Missing permission: ${action}:contract`,
        })
      }
    }

    if (body.saveAs?.contractId) {
      const target = await prisma.contract.findFirst({
        where:  { id: body.saveAs.contractId, orgId, deletedAt: null },
        select: { id: true, externalEdit: true },
      })
      if (!target) return reply.status(404).send({ detail: 'Contract not found' })
      // BB3 — no new version while a Google Docs copy is out.
      const lock = lockOf(target.externalEdit)
      if (lock) return reply.status(409).send(lockedBody(lock))
    }
    let counterparty: { id: string; name: string } | null = null
    if (body.saveAs?.counterpartyId && !body.saveAs.contractId) {
      counterparty = await prisma.counterparty.findFirst({
        where:  { id: body.saveAs.counterpartyId, orgId, deletedAt: null },
        select: { id: true, name: true },
      })
      if (!counterparty) return reply.status(404).send({ detail: 'Counterparty not found' })
    }
    // X45 — a draft saved as a new contract needs a user to own it: for an API
    // key, the user who made the key. Checked before the agent call, as above.
    let ownerId: string | null = null
    if (body.saveAs?.title && !body.saveAs.contractId) {
      ownerId = actingUserId(req.user)
      if (!ownerId) return reply.status(422).send(NO_ACTING_USER)
    }

    const ctx: Record<string, unknown> = { ...(body.context ?? {}) }
    if (body.templateId) ctx.template_id = body.templateId

    const upstream = await modelFetch(`${AGENTS_URL}/draft`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': INTERNAL_SECRET,
      },
      body: JSON.stringify({
        user_message: body.userMessage,
        org_id: orgId,
        user_id: userId,
        context: ctx,
      }),
    }, { orgId, surface: 'draft', userId, userAuthored: ['user_message', 'context'] }).catch(err => {
      app.log.error({ err }, 'Draft agent unreachable')
      return null
    })

    if (!upstream?.ok) {
      const err = upstream ? await upstream.text() : 'Agent service unavailable'
      return reply.status(502).send({ detail: err })
    }

    const result = await upstream.json() as any

    // A.1 — if the agent returned a typed error (e.g. NO_TEMPLATE_MATCH),
    // reject the request instead of saving garbage. See
    // docs/25-CONTRACT-FLOW-FIX-PLAN.md §Phase A.
    if (result.error || !result.html?.trim()) {
      const code = result.error ?? 'DRAFT_FAILED'
      const detail =
        code === 'NO_TEMPLATE_MATCH'
          ? 'No template matches this contract type. Create a template for this type first, then retry.'
          : `Draft generation failed: ${result.error ?? 'agent returned no HTML'}`
      return reply.status(422).send({ error: code, detail })
    }

    // Optionally save the draft as a ContractVersion
    if (body.saveAs && result.html) {
      try {
        const { contractId, title } = body.saveAs

        if (contractId) {
          // Add a new version to existing contract
          const existing = await prisma.contractVersion.findFirst({
            where: { contractId },
            orderBy: { versionNumber: 'desc' },
          })
          const nextVersion = (existing?.versionNumber ?? 0) + 1

          const version = await prisma.contractVersion.create({
            data: {
              contractId,
              versionNumber: nextVersion,
              htmlContent: result.html,
              plainText: htmlToText(result.html),
              changeNote: `AI-generated draft (${result.usedTemplateName ?? 'no template'})`,
              createdById: userId,
            },
          })
          result.versionId = version.id
        } else if (title) {
          // Create a new contract with this draft.
          //
          // Owned by the CALLER. This used to be
          // prisma.user.findFirst({ where: { orgId } }) -- whichever user the
          // org happened to list first -- so an agent-drafted contract showed
          // up in a stranger's 'my contracts' and the person who asked for it
          // could not find their own draft. (X45: for an API key, the user
          // who made the key.)
          const owner = ownerId && { id: ownerId }
          if (owner) {
            const plainText = htmlToText(result.html)
            const contract = await prisma.contract.create({
              data: {
                orgId,
                ownerId: owner.id,
                title,
                type: result.contractType ?? 'OTHER',
                status: 'DRAFT',
                createdBy: userId,
                ...(counterparty && { counterpartyId: counterparty.id, counterpartyName: counterparty.name }),
                analysisStatus: plainText ? 'CLASSIFYING' : 'DONE',
                versions: {
                  create: {
                    versionNumber: 1,
                    htmlContent: result.html,
                    plainText,
                    changeNote: `AI-generated draft (${result.usedTemplateName ?? 'no template'})`,
                    createdById: userId,
                  },
                },
              },
              include: { versions: true },
            })
            result.contractId = contract.id
            // An AI-drafted contract is a real contract and must be traceable
            // to whoever asked for it. The manual REST create audits
            // (contracts.ts); this path did not, so an agent-created contract
            // appeared in the org with no record of who caused it.
            createAuditEvent({
              orgId,
              userId,
              action:       AuditAction.CONTRACT_CREATED,
              resourceType: 'contract',
              resourceId:   contract.id,
              metadata:     { source: 'agent_draft', template: result.usedTemplateName ?? null },
            }).catch(err => app.log.warn({ err }, 'audit on agent draft create failed'))
            // Wave 3.2 — index so the AI-drafted contract is searchable. We have
            // the real plainText here, so index it directly (a later classify →
            // chunk-and-index will refresh it). Fire-and-forget.
            indexContract(contract.id, {
              orgId,
              title:     contract.title,
              type:      contract.type,
              status:    contract.status,
              counterpartyName: contract.counterpartyName ?? undefined,
              plainText,
              tags:      contract.tags,
              createdAt: contract.createdAt.toISOString(),
            }).catch(err => app.log.warn({ err }, 'ES index on legacy draft save failed'))
            if (plainText && contract.versions[0]) {
              queueClassifyDocument({ contractId: contract.id, versionId: contract.versions[0].id, orgId })
            }
          }
        }
      } catch (err) {
        app.log.warn({ err }, 'Failed to save draft as ContractVersion')
      }
    }

    return reply.send(result)
  })

  // POST /api/v1/agent/assist-stream — P6.3 streaming bubble-menu AI.
  // Pipes the Python NDJSON stream straight through to the browser so
  // the bubble popover can render tokens as they arrive. No buffering,
  // no JSON-parse — just raw bytes forwarded.
  app.post('/assist-stream', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      selectedText?: string
      action?:       string
      contractType?: string
      governingLaw?: string
    }
    if (typeof body.selectedText !== 'string' || body.selectedText.trim().length === 0) {
      return reply.status(400).send({ detail: 'selectedText is required' })
    }
    // X27 — the editor's selection is contract text: it goes to the model
    // under the org's PII policy, and the rewrite streams back with the values.
    const { orgId } = req.user
    const scope = randomUUID()   // tokens mean nothing outside this request
    // Cut to the agents service's 6,000-character limit here, where a cut
    // can't split a token.
    const selected = sliceOutsideTokens(await redactJson(orgId, body.selectedText, { surface: 'assist_stream', roundTrip: scope }), 0, 6000)
    const upstream = await modelFetch(`${AGENTS_URL}/assist_stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': INTERNAL_SECRET,
      },
      body: JSON.stringify({
        selected_text: selected,
        action:        body.action ?? 'rewrite',
        contract_type: body.contractType ?? 'general commercial',
        governing_law: body.governingLaw ?? 'Delaware',
        orgId:         req.user.orgId,   // per-org BYOK key + Langfuse tracing
      }),
    }, { orgId, surface: 'assist_stream' }).catch(() => null)
    if (!upstream || !upstream.ok || !upstream.body) {
      return reply.status(502).send({ detail: 'Agent service unavailable' })
    }
    // Fastify-friendly: send the web Response body directly (node 18+).
    reply.raw.setHeader('Content-Type', 'application/x-ndjson')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('X-Accel-Buffering', 'no')  // nginx: disable buffering
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    // NDJSON: {type:'delta', text} lines carry the rewrite. Tokens can split
    // across deltas, so each delta is restored through a buffer that holds a
    // possible partial token back; other events pass through after a flush.
    const restorer = streamRestorer(body.selectedText, scope)
    let streamed = ''
    let ended = false
    const write = (event: Record<string, unknown>) => reply.raw.write(Buffer.from(JSON.stringify(event) + '\n'))
    const onLine = (line: string) => {
      if (!line.trim()) return
      let event: { type?: string; text?: string } & Record<string, unknown>
      try { event = JSON.parse(line) } catch { return }
      if (event.type === 'delta' && typeof event.text === 'string') {
        const text = restorer.push(event.text)
        streamed += text
        if (text) write({ ...event, text })
        return
      }
      const rest = restorer.flush()
      streamed += rest
      if (rest) write({ type: 'delta', text: rest })
      if (event.type === 'done' || event.type === 'error') ended = true
      // A placeholder the model mangled would be inserted where a value was:
      // end with an error instead, and the popover won't offer to apply it.
      if (event.type === 'done' && unresolvedPiiTokens(streamed, body.selectedText).length) {
        write({ type: 'error', message: 'The suggestion lost a redacted value from your text. Try again.' })
        return
      }
      write(event)
    }
    let partial = ''
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value) continue
        partial += decoder.decode(value, { stream: true })
        const lines = partial.split('\n')
        partial = lines.pop() ?? ''
        lines.forEach(onLine)
      }
      onLine(partial)
    } catch (err) {
      req.log.warn({ err }, 'assist-stream: the agents service stream failed')
    }
    // The agents service ends every stream with done or error: one that just
    // stops (or resets) was cut off, and what the restorer still holds may be
    // half a token.
    if (!ended) write({ type: 'error', message: 'The suggestion was cut off. Try again.' })
    reply.raw.end()
    return reply
  })

  // POST /api/v1/agent/classify-clause — P6.2 background classifier.
  // Fires per-paragraph from the editor. Low-latency fast-tier upstream.
  // Rate-limited by the per-paragraph hash cache on the client.
  app.post('/classify-clause', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      clauseText?:   string
      contractType?: string
      sectionHint?:  string
    }
    if (typeof body.clauseText !== 'string' || body.clauseText.trim().length < 30) {
      return reply.send({ category: 'skip', position: 'skip', reasoning: '' })
    }
    // X27 — the paragraph goes to the model under the org's PII policy:
    // values found in the whole paragraph, then cut to size without
    // splitting a token.
    const clauseText = body.clauseText
    const scope = randomUUID()
    const sent = sliceOutsideTokens(await redactJson(req.user.orgId, clauseText, { surface: 'classify_clause', roundTrip: scope }), 0, 2400)
    const upstream = await modelFetch(`${AGENTS_URL}/classify_clause`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': INTERNAL_SECRET,
      },
      body: JSON.stringify({
        clauseText:   sent,
        contractType: body.contractType ?? 'general commercial',
        sectionHint:  body.sectionHint ?? null,
      }),
    }, { orgId: req.user.orgId, surface: 'classify_clause' }).catch(() => null)
    if (!upstream?.ok) {
      return reply.send({ category: 'skip', position: 'skip', reasoning: '', error: 'upstream_unavailable' })
    }
    return reply.send(dropPartialToken(restorePii(await upstream.json(), clauseText, scope)))
  })

  // POST /api/v1/agent/complete — P6.1 ghost-text completion.
  // Called by the editor when the user pauses mid-sentence. Proxies
  // straight to the Python fast-tier /complete. Abort-friendly — the
  // client cancels in-flight requests on new keystrokes so we must
  // not do any heavy work here beyond the upstream fetch.
  app.post('/complete', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      contextBefore?: string
      contextAfter?:  string
      contractType?:  string
      maxChars?:      number
    }
    if (typeof body.contextBefore !== 'string' || body.contextBefore.length < 10) {
      return reply.send({ completion: '', reason: 'too_short' })
    }
    // X27 — the text around the cursor goes to the model under the org's PII
    // policy; the completion comes back with the values (it is typed into the
    // document).
    // Values are found in all the text the editor sent, before the window is
    // cut: cutting first sent fragments of a value, and a card number whose
    // "card" fell outside the window went out whole.
    // The cursor is a cut too: values are also found across it (a date of
    // birth whose keyword is before it), and one it splits sends nothing.
    const context = [body.contextBefore, body.contextAfter ?? '']
    const source = [context.join(''), ...context]
    const scope = randomUUID()
    const [fullBefore, fullAfter] = await redactJson(req.user.orgId, context, { surface: 'complete', roundTrip: scope, valuesFrom: source })
    if (await getOrgPiiMode(req.user.orgId) !== 'off' && valueAcross(fullBefore, fullAfter)) {
      return reply.send({ completion: '' })
    }
    const before = sliceOutsideTokens(fullBefore, fullBefore.length - 1400, fullBefore.length)
    const after = sliceOutsideTokens(fullAfter, 0, 400)
    const upstream = await modelFetch(`${AGENTS_URL}/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': INTERNAL_SECRET,
      },
      body: JSON.stringify({
        contextBefore: before,
        contextAfter:  after,
        contractType:  body.contractType ?? 'general commercial',
        maxChars:      Math.max(40, Math.min(body.maxChars ?? 160, 320)),
      }),
    }, { orgId: req.user.orgId, surface: 'complete' }).catch(() => null)
    if (!upstream?.ok) {
      return reply.send({ completion: '', error: 'upstream_unavailable' })
    }
    const out = dropPartialToken(restorePii(await upstream.json() as { completion?: string }, source, scope))
    // Ghost text is inserted with Tab: never offer one carrying a placeholder.
    if (unresolvedPiiTokens(out.completion ?? '', context).length) return reply.send({ ...out, completion: '' })
    return reply.send(out)
  })

  // POST /api/v1/agent/assist — inline AI text improvement for editor
  app.post('/assist', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const body = AssistSchema.parse(req.body)
    // X27 — as assist-stream: the selection goes out tokenized, the rewrite
    // comes back with the values.
    // The editor sends HTML: values are found in its text too (a label and
    // its value in separate tags), and it goes out with its spaces made plain.
    const scope = randomUUID()
    const html = plainSpacesHtml(body.selectedText)
    const forms = htmlTextForms(html)
    const selected = await redactJson(req.user.orgId, html, { surface: 'assist', roundTrip: scope, valuesFrom: forms })
    if (await getOrgPiiMode(req.user.orgId) !== 'off' && valueLeftInMarkup(selected)) {
      return reply.status(422).send({
        detail: 'The selection has a redacted value split by formatting (bold or a link inside it), so it can\'t go to the AI. Remove that formatting and try again.',
      })
    }

    const upstream = await modelFetch(`${AGENTS_URL}/assist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': INTERNAL_SECRET,
      },
      body: JSON.stringify({
        selected_text: selected,
        action: body.action,
        contract_type: body.contractType,
        governing_law: body.governingLaw,
        provider: body.provider,
        model_id: body.modelId,
        orgId: req.user.orgId,   // per-org BYOK key + Langfuse tracing
      }),
    }, { orgId: req.user.orgId, surface: 'assist' }).catch(() => null)

    if (!upstream?.ok) {
      return reply.status(502).send({ detail: 'Agent service unavailable' })
    }

    const out = restorePii(await upstream.json(), forms, scope)
    // "Rewrite document" replaces the whole editor content with this: a
    // placeholder the model mangled would replace a value in the next save.
    if (unresolvedPiiTokens(out, body.selectedText).length) {
      return reply.status(502).send({ detail: 'The suggestion lost a redacted value from your text. Try again.' })
    }
    return reply.send(out)
  })

  // POST /api/v1/agent/compare — compare clause text to playbook positions
  // X9 — the answer is the org's playbook positions (walkaway language
  // included); REST's twin /playbook/test needs view:playbook.
  app.post('/compare', { preHandler: requirePermission('view', 'playbook') }, async (req, reply) => {
    const { orgId } = req.user
    const { clauseText, clauseCategoryId, contractType } = req.body as {
      clauseText: string
      clauseCategoryId: string
      contractType?: string
    }

    if (!clauseText?.trim() || !clauseCategoryId) {
      return reply.status(400).send({ detail: 'clauseText and clauseCategoryId are required' })
    }

    // Fetch playbook positions from DB
    const positions = await prisma.playbookPosition.findMany({
      where: {
        orgId,
        clauseCategoryId,
        ...(contractType ? {
          OR: [
            { contractTypes: { isEmpty: true } },
            { contractTypes: { has: contractType } },
          ],
        } : {}),
      },
      orderBy: { sortOrder: 'asc' },
    })

    if (!positions.length) {
      return reply.status(404).send({ detail: 'No playbook positions found for this category' })
    }

    const scope = randomUUID()
    const upstream = await modelFetch(`${AGENTS_URL}/compare`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': INTERNAL_SECRET,
      },
      // X27 — the clause goes to the model under the org's PII policy.
      // Cut to the agents service's 2,000-character limit without splitting a token.
      body: JSON.stringify({ clauseText: sliceOutsideTokens(await redactJson(orgId, clauseText, { surface: 'compare', roundTrip: scope }), 0, 2000), positions }),
    }, { orgId, surface: 'compare' }).catch(() => null)

    if (!upstream?.ok) {
      return reply.status(502).send({ detail: 'Agent service unavailable' })
    }

    return reply.send(restorePii(await upstream.json(), clauseText, scope))
  })
}
