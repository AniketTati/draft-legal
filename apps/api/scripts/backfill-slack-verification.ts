/**
 * backfill-slack-verification.ts — one-shot after X6: verify the Slack
 * workspace of configs saved before verification existed.
 *
 * Inbound Slack requests try verified claims on a team id first (X6). A
 * config saved before that has no `teamVerified` flag and ranks as unverified.
 * If it holds a bot token, Slack's auth.test can confirm the workspace now,
 * which is what saving the config again would do.
 *
 * Idempotent: only configs without the flag are checked. A token Slack
 * rejects, or one for another workspace, records `teamVerified: false`.
 * Slack unreachable leaves the row alone.
 *
 * Usage:
 *   cd apps/api && npx tsx --env-file=../../.env scripts/backfill-slack-verification.ts          # report
 *   cd apps/api && npx tsx --env-file=../../.env scripts/backfill-slack-verification.ts --fix    # apply
 */
import { prisma } from '../src/lib/prisma.js'
import { slackTeamOfToken } from '../src/lib/slack.js'
import { mergeOrgSettings } from '../src/lib/org-settings.js'

const fix = process.argv.includes('--fix')

const rows = await prisma.$queryRaw<Array<{ id: string; slack: { teamId?: string; botToken?: string } }>>`
  SELECT id, settings -> 'slack' AS slack
  FROM   organizations
  WHERE  settings -> 'slack' ->> 'teamId' IS NOT NULL
    AND  NOT (settings -> 'slack' ? 'teamVerified')`

let verified = 0, rejected = 0, skipped = 0
for (const row of rows) {
  if (!row.slack.botToken || !row.slack.teamId) { skipped++; continue }
  const team = await slackTeamOfToken(row.slack.botToken)
  if (team === null) { console.warn(`org ${row.id}: Slack unreachable — left alone`); skipped++; continue }
  const ok = team.ok && team.teamId === row.slack.teamId
  console.info(`org ${row.id}: team ${row.slack.teamId} — ${ok ? 'verified' : `not verified (${team.ok ? `token is for ${team.teamId}` : team.error})`}`)
  ok ? verified++ : rejected++
  if (fix) await mergeOrgSettings(row.id, { slack: { ...row.slack, teamVerified: ok } })
}
console.info(`${rows.length} config(s) without a flag: ${verified} verified, ${rejected} not, ${skipped} skipped${fix ? '' : ' (report only — pass --fix to write)'}`)
await prisma.$disconnect()
