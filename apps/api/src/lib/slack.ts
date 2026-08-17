/**
 * slack.ts (Phase 10 — Slack bot)
 *
 * Helpers for the interactive Slack integration:
 *   • request signature verification (Slack signing secret, v0 scheme)
 *   • org ↔ Slack workspace mapping (organization.settings.slack)
 *   • Slack user → CLM user resolution (users.info via bot token)
 *   • block builders for slash-command search results
 *
 * Outbound notifications still go through the existing webhook system
 * (type='slack' + slack-formatter.ts); this module powers the INBOUND
 * half: `/contract` slash command + Approve/Reject button clicks.
 */
import crypto from 'node:crypto'
import { prisma } from './prisma.js'

export interface SlackOrgConfig {
  teamId:        string
  signingSecret: string
  /** xoxb- bot token; optional — needed only to resolve button-clickers to CLM users. */
  botToken?:     string
  configuredAt?: string
}

const APP_BASE = process.env.FRONTEND_URL ?? 'http://localhost:5173'

/**
 * Verify Slack's v0 request signature. Returns false on stale
 * timestamps (>5 min) to block replay attacks.
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false
  const base = `v0:${timestamp}:${rawBody}`
  const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(base).digest('hex')}`
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}

/** Read the org's Slack config from organization.settings.slack. */
export async function getSlackConfig(orgId: string): Promise<SlackOrgConfig | null> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { settings: true },
  })
  const slack = (org?.settings as Record<string, unknown> | null)?.slack as SlackOrgConfig | undefined
  return slack?.teamId && slack?.signingSecret ? slack : null
}

/** Find the org connected to a Slack workspace (team_id). */
export async function findOrgBySlackTeam(teamId: string): Promise<{ orgId: string; config: SlackOrgConfig } | null> {
  const org = await prisma.organization.findFirst({
    where: { settings: { path: ['slack', 'teamId'], equals: teamId } },
    select: { id: true, settings: true },
  })
  if (!org) return null
  const config = (org.settings as Record<string, unknown>).slack as SlackOrgConfig
  return config?.signingSecret ? { orgId: org.id, config } : null
}

/**
 * Resolve a Slack user id to a CLM user via the Slack users.info API
 * (needs the bot token + users:read.email scope). Returns null when no
 * token is configured, the API call fails, or no CLM user matches.
 */
export async function resolveSlackUser(
  orgId: string,
  config: SlackOrgConfig,
  slackUserId: string,
): Promise<{ id: string; email: string } | null> {
  if (!config.botToken) return null
  try {
    const res = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`, {
      headers: { authorization: `Bearer ${config.botToken}` },
    })
    const data = await res.json() as { ok: boolean; user?: { profile?: { email?: string } } }
    const email = data.ok ? data.user?.profile?.email : undefined
    if (!email) return null
    const user = await prisma.user.findFirst({
      where: { orgId, email: email.toLowerCase(), status: 'ACTIVE', deletedAt: null },
      select: { id: true, email: true },
    })
    return user
  } catch {
    return null
  }
}

// ─── Block builders ────────────────────────────────────────────────────

interface ContractRow {
  id: string
  title: string
  type: string
  status: string
  counterpartyName: string | null
  value: unknown
  currency: string | null
}

/** Ephemeral response for `/contract <query>`. */
export function searchResultBlocks(query: string, contracts: ContractRow[], totalMatching: number): Record<string, unknown> {
  if (contracts.length === 0) {
    return {
      response_type: 'ephemeral',
      text: `No contracts matching “${query}”.`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `🔍 No contracts matching *${query}*. Try a counterparty name or contract title.` } },
      ],
    }
  }
  const lines = contracts.map(c => {
    const value = c.value != null && Number.isFinite(Number(c.value))
      ? ` · ${c.currency ?? 'USD'} ${Number(c.value).toLocaleString()}`
      : ''
    return `• <${APP_BASE}/contracts/${c.id}|${c.title}> — ${c.type} · ${c.status}${c.counterpartyName ? ` · ${c.counterpartyName}` : ''}${value}`
  })
  const more = totalMatching > contracts.length
    ? `\n_…and ${totalMatching - contracts.length} more — <${APP_BASE}/contracts|open the full list>_`
    : ''
  return {
    response_type: 'ephemeral',
    text: `${totalMatching} contract(s) matching “${query}”`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `🔍 *${totalMatching} contract${totalMatching === 1 ? '' : 's'}* matching *${query}*\n${lines.join('\n')}${more}` } },
    ],
  }
}

/** Help text for `/contract` with no arguments. */
export function helpBlocks(): Record<string, unknown> {
  return {
    response_type: 'ephemeral',
    text: 'Usage: /contract search <query>',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn',
        text: '*draftLegal commands*\n• `/contract search <query>` — find contracts by title or counterparty\n• `/contract <query>` — shorthand for search' } },
    ],
  }
}
