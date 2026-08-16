/**
 * teams-formatter.ts (Phase 10 — Microsoft Teams notifications)
 *
 * Renders our internal webhook events as Microsoft Teams messages.
 * Targets Teams "Workflows" (Power Automate) webhooks — the successor
 * to the retired Office 365 connector webhooks — which accept:
 *
 *   { type: "message", attachments: [{
 *       contentType: "application/vnd.microsoft.card.adaptive",
 *       content: <Adaptive Card 1.4> }] }
 *
 * Buttons are Action.OpenUrl deep links into draftLegal. (Inline
 * approve/reject like the Slack bot needs an Azure bot registration —
 * out of scope for webhook-based notifications.)
 */

interface AdaptiveElement { type: string; [k: string]: unknown }

interface TeamsMessage {
  type: 'message'
  attachments: Array<{
    contentType: 'application/vnd.microsoft.card.adaptive'
    content: {
      $schema: string
      type: 'AdaptiveCard'
      version: '1.4'
      body: AdaptiveElement[]
      actions?: AdaptiveElement[]
    }
  }>
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
  if (!contractId || typeof contractId !== 'string') return APP_BASE
  return `${APP_BASE}/contracts/${contractId}`
}

function card(body: AdaptiveElement[], actions?: AdaptiveElement[]): TeamsMessage {
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body,
        ...(actions?.length ? { actions } : {}),
      },
    }],
  }
}

const title = (text: string): AdaptiveElement =>
  ({ type: 'TextBlock', size: 'Medium', weight: 'Bolder', text, wrap: true })
const line = (text: string): AdaptiveElement =>
  ({ type: 'TextBlock', text, wrap: true, spacing: 'Small' })
const facts = (pairs: Array<[string, unknown]>): AdaptiveElement =>
  ({ type: 'FactSet', facts: pairs.filter(([, v]) => v != null && v !== '').map(([t, v]) => ({ title: t, value: String(v) })) })
const open = (url: string, label = 'Open in draftLegal'): AdaptiveElement =>
  ({ type: 'Action.OpenUrl', title: label, url })

export function formatForTeams(event: string, data: Record<string, unknown>): TeamsMessage {
  const link = contractLink(data.contractId)

  switch (event) {
    case 'contract.executed':
      return card(
        [title('✅ Contract executed'), facts([['Contract', data.contractId], ['Executed', data.executedAt ?? 'just now']])],
        [open(link)],
      )
    case 'signature.sent':
      return card(
        [title('✍️ Signature request sent'), facts([['Contract', data.contractId], ['Signers', Array.isArray(data.signers) ? data.signers.length : data.signers]])],
        [open(link)],
      )
    case 'signature.completed':
      return card(
        [title('✍️ All signatures collected'), line('The contract is fully signed.')],
        [open(link)],
      )
    case 'signature.voided':
      return card(
        [title('🚫 Signature request voided'), facts([['Contract', data.contractId], ['Reason', data.reason]])],
        [open(link)],
      )
    case 'approval.submitted': {
      const t = typeof data.title === 'string' ? data.title : String(data.contractId ?? 'Contract')
      return card(
        [
          title('📝 Approval requested'),
          line(`**${t}**`),
          facts([
            ['Type', data.type],
            ['Value', data.value != null ? fmtMoney(data.value, data.currency) : null],
            ['Step', data.stepName],
          ]),
        ],
        [open(`${link}?tab=approval`, 'Review & decide')],
      )
    }
    case 'approval.decided': {
      const decision = String(data.decision ?? '').toUpperCase()
      const emoji = decision === 'APPROVED' ? '✅' : decision === 'REJECTED' ? '❌' : '🔄'
      return card(
        [title(`${emoji} Approval ${decision.toLowerCase()}`), facts([['Contract', data.contractId]])],
        [open(link)],
      )
    }
    case 'obligation.overdue':
      return card(
        [title('⏰ Obligation overdue'), line(String(data.description ?? '')), facts([['Contract', data.contractId], ['Due', data.dueDate]])],
        [open(link)],
      )
    case 'contract.expired':
      return card(
        [title('📅 Contract expired'), facts([['Contract', data.contractId], ['Expired', data.expiryDate]])],
        [open(link)],
      )
    case 'webhook.test':
      return card([
        title('🔔 Test event from draftLegal'),
        line('Your Teams webhook is wired correctly. You should see real events here as contracts move through their lifecycle.'),
      ])
    default: {
      const summary = Object.entries(data)
        .filter(([k]) => !k.startsWith('_'))
        .slice(0, 6)
        .map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 80) : JSON.stringify(v)?.slice(0, 80)] as [string, unknown])
      return card([title(`🔔 ${event}`), facts(summary)], data.contractId ? [open(link)] : undefined)
    }
  }
}

/** Teams Workflows (Power Automate) webhook URL heuristic for auto-detect. */
export function isTeamsUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.hostname.endsWith('.logic.azure.com')
      || u.hostname.endsWith('.webhook.office.com') // legacy O365 connectors still in the wild
      || u.hostname.endsWith('.powerplatform.com')
  } catch {
    return false
  }
}
