/**
 * slack-formatter.ts (Phase 10B)
 *
 * Renders our internal webhook events as Slack message blocks. Users
 * paste a Slack incoming-webhook URL ("https://hooks.slack.com/…") and
 * we format the payload so it shows up as a clean message instead of a
 * raw JSON dump.
 *
 * Slack's incoming webhook accepts:
 *   { text: string, blocks?: Block[] }
 * `text` is the fallback for notifications + screen readers; `blocks`
 * is the rich rendering. We always include both.
 */

interface SlackBlock {
  type: string
  text?: { type: string; text: string }
  fields?: Array<{ type: string; text: string }>
  elements?: Array<unknown>
}

interface SlackPayload {
  text: string
  blocks: SlackBlock[]
}

const APP_BASE = process.env.FRONTEND_URL ?? 'http://localhost:5173'

function fmtMoney(amount: unknown, currency: unknown = 'USD'): string {
  const n = typeof amount === 'number' ? amount : Number(amount)
  if (!Number.isFinite(n)) return ''
  const cur = String(currency ?? 'USD')
  if (n >= 1_000_000) return `${cur} ${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `${cur} ${(n / 1_000).toFixed(0)}K`
  return `${cur} ${n.toFixed(0)}`
}

function contractLink(contractId: unknown): string {
  if (!contractId || typeof contractId !== 'string') return ''
  return `${APP_BASE}/contracts/${contractId}`
}

export function formatForSlack(event: string, data: Record<string, unknown>): SlackPayload {
  const link = contractLink(data.contractId)

  switch (event) {
    case 'contract.executed': {
      const text = `✅ Contract executed${data.contractId ? ` (${data.contractId})` : ''}`
      return {
        text,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: '✅ Contract executed' } },
          { type: 'section', fields: [
            { type: 'mrkdwn', text: `*Contract*\n<${link}|${data.contractId}>` },
            { type: 'mrkdwn', text: `*Executed*\n${data.executedAt ?? 'just now'}` },
          ] },
        ],
      }
    }
    case 'signature.sent': {
      const sigCount = data.signerCount ?? '?'
      const signOrder = data.signOrder ?? 'ANY'
      return {
        text: `✍️ Sent for signature — ${sigCount} signer(s)`,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: '✍️ Sent for signature' } },
          { type: 'section', fields: [
            { type: 'mrkdwn', text: `*Contract*\n<${link}|${data.contractId}>` },
            { type: 'mrkdwn', text: `*Signers*\n${sigCount} (${signOrder})` },
          ] },
        ],
      }
    }
    case 'signature.completed': {
      return {
        text: `🖋️ All signers signed`,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: '🖋️ All signers signed' } },
          { type: 'section', text: { type: 'mrkdwn', text: `Contract <${link}|${data.contractId}> is now executed.` } },
        ],
      }
    }
    case 'contract.created':
    case 'contract.uploaded': {
      const action = event === 'contract.uploaded' ? 'uploaded' : 'created'
      const title = data.title ?? data.contractId
      return {
        text: `📄 Contract ${action}: ${title}`,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: `📄 Contract ${action}` } },
          { type: 'section', text: { type: 'mrkdwn', text: `*<${link}|${title}>*` } },
          { type: 'context', elements: [
            { type: 'mrkdwn',
              text: [
                data.type ? `Type: ${data.type}` : null,
                data.counterpartyName ? `· Counterparty: ${data.counterpartyName}` : null,
              ].filter(Boolean).join(' ') || ' ',
            } as never,
          ] },
        ],
      }
    }
    case 'obligation.completed': {
      return {
        text: `✓ Obligation completed`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn',
            text: `✓ *Obligation completed* on <${link}|${data.contractId}>${data.type ? ` — ${data.type}` : ''}${data.hasEvidence ? ' (with evidence)' : ''}`,
          } },
        ],
      }
    }
    case 'obligation.overdue': {
      return {
        text: `⚠️ Obligation overdue`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn',
            text: `⚠️ *Obligation overdue* by ${data.daysOverdue ?? '?'} day(s) on <${link}|${data.contractId}>`,
          } },
        ],
      }
    }
    case 'invoice.reconciled': {
      return {
        text: `💸 Invoice reconciled`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn',
            text: `💸 *Invoice reconciled* — payment obligation cleared on <${link}|${data.contractId}>`,
          } },
        ],
      }
    }
    case 'approval.submitted': {
      // Phase 10 — actionable approval card. The Approve/Reject buttons
      // post back to /api/v1/slack/interactions (configure Interactivity
      // on the Slack app); the URL button always works as a fallback.
      const title = typeof data.title === 'string' ? data.title : String(data.contractId ?? 'Contract')
      const value = data.value != null ? ` · ${fmtMoney(data.value, data.currency)}` : ''
      const ref = JSON.stringify({ instanceId: data.instanceId, stepId: data.stepId })
      return {
        text: `📝 Approval requested: ${title}`,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: '📝 Approval requested' } },
          { type: 'section', text: { type: 'mrkdwn',
            text: `*<${link}|${title}>*\n${data.type ?? 'Contract'}${value} · step: ${data.stepName ?? 'Approval'}`,
          } },
          { type: 'actions', elements: [
            { type: 'button', style: 'primary', action_id: 'approval_approve',
              text: { type: 'plain_text', text: '✅ Approve' }, value: ref },
            { type: 'button', style: 'danger', action_id: 'approval_reject',
              text: { type: 'plain_text', text: '❌ Reject' }, value: ref },
            { type: 'button', action_id: 'approval_open',
              text: { type: 'plain_text', text: 'Open in draftLegal' }, url: `${link}?tab=approval` },
          ] },
        ],
      }
    }
    case 'approval.decided': {
      const decision = String(data.decision ?? '').toUpperCase()
      const emoji = decision === 'APPROVED' ? '✅' : decision === 'REJECTED' ? '❌' : '🔄'
      return {
        text: `${emoji} Approval ${decision.toLowerCase()}`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn',
            text: `${emoji} *Approval ${decision.toLowerCase()}* on <${link}|${data.contractId}>`,
          } },
        ],
      }
    }
    case 'webhook.test': {
      return {
        text: '🔔 Test event from CLM',
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: '🔔 Test event from CLM' } },
          { type: 'section', text: { type: 'mrkdwn',
            text: 'Your webhook is wired correctly. You should see real events here as contracts move through their lifecycle.',
          } },
        ],
      }
    }
    default: {
      // Generic fallback — show event name + a JSON-ish summary.
      const summary = Object.entries(data)
        .filter(([k]) => !k.startsWith('_'))
        .slice(0, 6)
        .map(([k, v]) => `*${k}*: ${typeof v === 'string' ? v.slice(0, 80) : JSON.stringify(v).slice(0, 80)}`)
        .join('\n')
      return {
        text: `🔔 ${event}`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `🔔 *${event}*\n${summary}` } },
        ],
      }
    }
  }
}

export function isSlackUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.hostname === 'hooks.slack.com'
  } catch {
    return false
  }
}
