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
import { decideStep } from '../lib/approval-flow.js'
import {
  verifySlackSignature, findOrgsBySlackTeam, resolveSlackUser,
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
    // Slack signs the raw urlencoded body; a request without one (sent as
    // another content type) has nothing to verify.
    if (typeof teamId !== 'string' || !teamId || req.rawBody === undefined) return null
    const timestamp = String(req.headers['x-slack-request-timestamp'] ?? '')
    const signature = String(req.headers['x-slack-signature'] ?? '')
    // X6 — the org is the one whose signing secret signed this request. One
    // bad candidate row must not fail the request for the others.
    for (const found of await findOrgsBySlackTeam(teamId)) {
      try {
        if (verifySlackSignature(found.config.signingSecret, timestamp, req.rawBody, signature)) return found
      } catch { /* not this org */ }
    }
    return null
  }

  // Slack payloads are small; the limit also bounds the HMAC work per request.
  const SLACK_BODY_LIMIT = 256 * 1024

  // ── POST /commands — `/contract` slash command ────────────────────────
  app.post('/commands', { bodyLimit: SLACK_BODY_LIMIT }, async (req, reply) => {
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
      diligenceRoomId: null, // C11 — a diligence room's documents aren't the org's contracts
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
  app.post('/interactions', { bodyLimit: SLACK_BODY_LIMIT }, async (req, reply) => {
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
    if (!payload || typeof payload !== 'object') return reply.status(400).send({ detail: 'invalid payload' })

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

    // docs/41 Part 4 — a return needs a reason, and the Slack app has no
    // dialog to ask for one (no views.open / view_submission handling). So
    // Reject from Slack doesn't decide: it links to the contract, where the
    // approver returns it (changes needed) or declines it, with a reason.
    // Approve decides here, as POST /approvals/:instanceId/decide does.
    const instance = await prisma.approvalInstance.findFirst({
      where: { id: ref.instanceId, orgId: auth.orgId }, select: { contractId: true, status: true },
    })
    if (!instance || (instance.status !== 'PENDING' && instance.status !== 'ESCALATED')) {
      return reply.send(ephemeral('⚠️ This approval workflow is already closed.'))
    }
    const link = `${APP_BASE}/contracts/${instance.contractId}?tab=approval`
    if (decision === 'REJECTED') {
      return reply.send(ephemeral(`✍️ Returning a contract needs a reason the owner can act on. <${link}|Return or decline it in draftLegal> — it takes a minute.`))
    }

    // The same decision as the web (lib/approval-flow.ts): org-scoped, the
    // step pending and theirs (or their role's), compare-and-set so a
    // double-click can't decide twice.
    const r = await decideStep({ orgId: auth.orgId, userId: user.id, stepId: ref.stepId, instanceId: ref.instanceId, decision: 'APPROVED', via: 'slack' })
    if (!r.ok) {
      return reply.send(ephemeral(r.status === 403
        ? '⚠️ This approval step is not assigned to you (or was already decided).'
        : r.status === 409 ? `⚠️ ${r.error}` : `⚠️ ${r.error}`))
    }

    // replace_original swaps the button message for the outcome so the
    // channel doesn't keep a stale actionable card around.
    return reply.send({
      response_type: 'in_channel',
      replace_original: true,
      text: `✅ Approved by ${user.email} via Slack`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn',
          text: `✅ *Approved* by ${user.email} via Slack · <${link}|view in draftLegal>` } },
      ],
    })
  })
}

function ephemeral(text: string) {
  return { response_type: 'ephemeral', replace_original: false, text }
}
