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
  /** X6 — the bot token proved this workspace via Slack's auth.test. */
  teamVerified?: boolean
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
export async function findOrgsBySlackTeam(teamId: string): Promise<Array<{ orgId: string; config: SlackOrgConfig }>> {
  // X6 — a team id names a workspace, not an org: two orgs can share one
  // (separate Slack apps, separate signing secrets), and any admin can type
  // any team id. Taking the first match let a second claimant break the
  // first org's Slack, so return every candidate; the caller authenticates
  // as the one whose signing secret signed the request.
  //
  // Any cap on candidates can be filled by squatters (and no cap multiplies
  // the HMAC work per request), so verified claims — whose bot token proved
  // the workspace through Slack's auth.test — are tried first. A squatter
  // can't verify a workspace it isn't in.
  const rows = await prisma.$queryRaw<Array<{ id: string; slack: unknown }>>`
    SELECT id, settings -> 'slack' AS slack
    FROM   organizations
    WHERE  settings -> 'slack' ->> 'teamId' = ${teamId}
    ORDER  BY (settings -> 'slack' ->> 'teamVerified') = 'true' DESC NULLS LAST, "createdAt" ASC
    LIMIT  20`
  return rows
    .map(row => ({ orgId: row.id, config: row.slack as SlackOrgConfig }))
    .filter(found => typeof found.config?.signingSecret === 'string' && found.config.signingSecret.length > 0)
}

/**
 * X6 — which Slack workspace a bot token belongs to (Slack's auth.test).
 * Null when Slack can't be reached, so the caller can tell "unknown" from "no".
 */
export async function slackTeamOfToken(botToken: string): Promise<{ ok: true; teamId: string } | { ok: false; error: string } | null> {
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(5_000),
    })
    const body = await res.json() as { ok?: boolean; team_id?: string; error?: string }
    return body.ok && body.team_id ? { ok: true, teamId: body.team_id } : { ok: false, error: body.error ?? `HTTP ${res.status}` }
  } catch {
    return null
  }
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
