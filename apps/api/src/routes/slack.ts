/**
 * Slack routes (Phase 10 — Slack bot).
 *
 *   POST /slack/commands      — `/contract search <query>` slash command
 *   POST /slack/interactions  — Approve / Reject button clicks on
 *                               approval.submitted messages
 *
 * Both endpoints are PUBLIC (Slack calls them) and authenticated by the
 * org's Slack signing secret (v0 HMAC over the raw body). The org is
 * resolved from Slack's team_id via organization.settings.slack.teamId,
 * so one deployment can serve many workspaces.
 *
 * Setup lives in Admin → Integrations → Slack: paste the signing
 * secret + team ID (+ optional bot token for button-click identity).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction } from '@clm/types'
import { advanceWorkflow } from '../lib/workflow-engine.js'
import { notificationQueue } from '../lib/queue.js'
import {
  verifySlackSignature, findOrgBySlackTeam, resolveSlackUser,
  searchResultBlocks, helpBlocks,
} from '../lib/slack.js'

const APP_BASE = process.env.FRONTEND_URL ?? 'http://localhost:5173'

/** Raw urlencoded body, preserved for signature verification. */
type SlackRequest = FastifyRequest & { rawBody?: string }

export async function slackRoutes(app: FastifyInstance) {
  // Slack sends application/x-www-form-urlencoded. Parse it ourselves
  // (no @fastify/formbody in the stack) and keep the raw string around —
  // the signature is computed over the exact bytes Slack sent.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    ;(req as SlackRequest).rawBody = body as string
    const parsed: Record<string, string> = {}
    for (const [k, v] of new URLSearchParams(body as string)) parsed[k] = v
    done(null, parsed)
  })

  /** Verify the v0 signature and resolve the org for a Slack request. */
  async function authenticate(req: SlackRequest, teamId: string | undefined) {
    if (!teamId) return null
    const found = await findOrgBySlackTeam(teamId)
    if (!found) return null
    const ok = verifySlackSignature(
      found.config.signingSecret,
      String(req.headers['x-slack-request-timestamp'] ?? ''),
      req.rawBody ?? '',
      String(req.headers['x-slack-signature'] ?? ''),
    )
    return ok ? found : null
  }

  // ── POST /commands — `/contract` slash command ────────────────────────
  app.post('/commands', async (req, reply) => {
    const body = req.body as Record<string, string>
    const auth = await authenticate(req as SlackRequest, body.team_id)
    if (!auth) return reply.status(401).send({ detail: 'invalid Slack signature or unconnected workspace' })

    // `/contract search acme` or `/contract acme` — both search.
    const text = (body.text ?? '').trim()
    const query = text.replace(/^search\s+/i, '').trim()
    if (!query) return reply.send(helpBlocks())

    const where = {
      orgId: auth.orgId,
      deletedAt: null,
      OR: [
        { title:            { contains: query, mode: 'insensitive' as const } },
        { counterpartyName: { contains: query, mode: 'insensitive' as const } },
        { contractNumber:   { contains: query, mode: 'insensitive' as const } },
      ],
    }
    const [contracts, totalMatching] = await Promise.all([
      prisma.contract.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: 5,
        select: {
          id: true, title: true, type: true, status: true,
          counterpartyName: true, value: true, currency: true,
        },
      }),
      prisma.contract.count({ where }),
    ])

    createAuditEvent({
      orgId: auth.orgId, userId: 'slack',
      action: AuditAction.AGENT_ACTION,
      resourceType: 'integration', resourceId: 'slack',
      metadata: { command: '/contract', query, results: totalMatching, slackUser: body.user_id },
    }).catch(() => {})

    return reply.send(searchResultBlocks(query, contracts, totalMatching))
  })

  // ── POST /interactions — block_actions (Approve / Reject buttons) ────
  app.post('/interactions', async (req, reply) => {
    const body = req.body as Record<string, string>
    let payload: {
      type?: string
      team?: { id?: string }
      user?: { id?: string; username?: string }
      actions?: Array<{ action_id?: string; value?: string }>
      response_url?: string
    }
    try { payload = JSON.parse(body.payload ?? '{}') }
    catch { return reply.status(400).send({ detail: 'invalid payload' }) }

    const auth = await authenticate(req as SlackRequest, payload.team?.id)
    if (!auth) return reply.status(401).send({ detail: 'invalid Slack signature or unconnected workspace' })

    if (payload.type !== 'block_actions' || !payload.actions?.length) {
      return reply.send({ ok: true }) // ignore other interaction types
    }

    const action = payload.actions[0]
    if (action.action_id !== 'approval_approve' && action.action_id !== 'approval_reject') {
      return reply.send({ ok: true })
    }
    const decision = action.action_id === 'approval_approve' ? 'APPROVED' as const : 'REJECTED' as const

    let ref: { instanceId?: string; stepId?: string }
    try { ref = JSON.parse(action.value ?? '{}') }
    catch { ref = {} }
    if (!ref.instanceId || !ref.stepId) {
      return reply.send(ephemeral('⚠️ This approval button is missing its reference — decide in draftLegal instead.'))
    }

    // Identify the clicker. Without a bot token we can't see their email,
    // so we fall back to a deep link rather than deciding as nobody.
    const user = await resolveSlackUser(auth.orgId, auth.config, payload.user?.id ?? '')
    if (!user) {
      const instance = await prisma.approvalInstance.findFirst({
        where: { id: ref.instanceId, orgId: auth.orgId }, select: { contractId: true },
      })
      const link = instance ? `${APP_BASE}/contracts/${instance.contractId}?tab=approval` : APP_BASE
      return reply.send(ephemeral(
        auth.config.botToken
          ? `⚠️ Couldn't match your Slack account to a draftLegal user. <${link}|Decide in draftLegal> instead.`
          : `🔐 Deciding from Slack needs the bot token connected (Admin → Integrations → Slack). <${link}|Decide in draftLegal> instead.`,
      ))
    }

    // Mirror of POST /approvals/:instanceId/decide — org-scoped, step must
    // be PENDING and assigned to this user.
    const step = await prisma.approvalStep.findFirst({
      where: { id: ref.stepId, approvalInstanceId: ref.instanceId, orgId: auth.orgId, approverId: user.id, status: 'PENDING' },
    })
    if (!step) {
      return reply.send(ephemeral('⚠️ This approval step is not assigned to you (or was already decided).'))
    }
    const instance = await prisma.approvalInstance.findFirst({
      where: { id: ref.instanceId, orgId: auth.orgId },
    })
    if (!instance || (instance.status !== 'PENDING' && instance.status !== 'ESCALATED')) {
      return reply.send(ephemeral('⚠️ This approval workflow is already closed.'))
    }

    try { await notificationQueue.remove(`escalate-${ref.stepId}`) } catch { /* no-op */ }

    // Compare-and-set on status — a double-click (or a concurrent decide
    // from the web UI) must not overwrite an already-recorded decision.
    // The findFirst above gives the friendly error message; this guard
    // closes the race window between the check and the write.
    const decided = await prisma.approvalStep.updateMany({
      where: { id: ref.stepId, approverId: user.id, status: 'PENDING' },
      data: {
        status: decision, decision,
        comment: decision === 'REJECTED' ? `Rejected via Slack by ${user.email}` : null,
        decidedAt: new Date(),
      },
    })
    if (decided.count === 0) {
      return reply.send(ephemeral('⚠️ This step was already decided (possibly a double-click).'))
    }
    createAuditEvent({
      orgId: auth.orgId, userId: user.id,
      action: AuditAction.APPROVAL_DECIDED,
      resourceType: 'approval_step', resourceId: ref.stepId,
      metadata: { decision, instanceId: ref.instanceId, via: 'slack' },
    }).catch(() => {})

    await advanceWorkflow(ref.instanceId, prisma)

    const emoji = decision === 'APPROVED' ? '✅' : '❌'
    // replace_original swaps the button message for the outcome so the
    // channel doesn't keep a stale actionable card around.
    return reply.send({
      response_type: 'in_channel',
      replace_original: true,
      text: `${emoji} ${decision === 'APPROVED' ? 'Approved' : 'Rejected'} by ${user.email} via Slack`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn',
          text: `${emoji} *${decision === 'APPROVED' ? 'Approved' : 'Rejected'}* by ${user.email} via Slack · <${APP_BASE}/contracts/${instance.contractId}?tab=approval|view in draftLegal>` } },
      ],
    })
  })
}

function ephemeral(text: string) {
  return { response_type: 'ephemeral', replace_original: false, text }
}
