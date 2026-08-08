/**
 * NegotiationStatusStrip — State 1 bottom strip (docs/26 §5 State 1).
 *
 * Shows ONLY when the contract is in a "back-and-forth" phase:
 *   - UNDER_NEGOTIATION (counterparty is the other party)
 *   - PENDING_APPROVAL (waiting on an internal approver)
 *
 * And ONLY for the OWNER / SUBMITTER — not for the approver (they see
 * the DecisionStrip instead). The strip compresses "what's happening"
 * into one row:
 *
 *   ↪ You → Zynga · waiting 2d · Last: §8.1 comment · Next: review
 *
 * This is the answer to "why is my deal stuck?", visible without
 * opening the approval tab or reading comment threads.
 */
import { ArrowRight, Clock, MessageCircle, Hourglass, Send } from 'lucide-react'
import { cn } from '@/lib/utils'

export function NegotiationStatusStrip({
  contract,
  approvalInstance,
  lastComment,
  latestVersion,
  // P7.4.16 / F-31 — REAL signals so "Waiting on counterparty" only
  // shows when we ACTUALLY shared with them. Without these the banner
  // was lying.
  lastShareSentAt,
  counterpartyUploadedVersion,
  externalCommentAt,
  onNudge,
}: {
  contract: {
    status:           string
    counterpartyName: string | null
  }
  /** The approval instance if the contract is in approval flow. */
  approvalInstance?: {
    submittedAt?:     string | null
    submittedByName?: string | null
    /** The step that's currently blocking — from approvalData.stepName. */
    currentStepName?: string | null
    /** Who's waiting: the approver's name if we have it. */
    currentApproverName?: string | null
  } | null
  /** Last comment on the contract (for "Last: comment"). */
  lastComment?: {
    excerpt:   string
    createdAt: string
    authorName?: string | null
  } | null
  /** Latest version (for "Last: v5 uploaded"). */
  latestVersion?: {
    versionNumber: number
    createdAt:     string
    changeNote?:   string | null
    /** Was this version uploaded by counterparty (createdById = "portal:…")? */
    fromCounterparty?: boolean
  } | null
  /** When (if ever) we sent a share link to the counterparty. null = never shared. */
  lastShareSentAt?: string | null
  /** When the counterparty most recently uploaded a counter-version. */
  counterpartyUploadedVersion?: { versionNumber: number; createdAt: string } | null
  /** Most recent external (portal:…) comment timestamp. */
  externalCommentAt?: string | null
  /** Called when user clicks the Nudge / Send reply action. */
  onNudge?: () => void
}) {
  const status = contract.status

  // Decide who we're waiting on + how long.
  //
  // PENDING_APPROVAL → blocker is the internal approver.
  // UNDER_NEGOTIATION + we shared → blocker is the counterparty.
  // UNDER_NEGOTIATION + counterparty came back → blocker is US.
  // UNDER_NEGOTIATION + never shared → still internal.
  const [blockedBy, waitingSince, internalOnly] = (() => {
    if (status === 'PENDING_APPROVAL') {
      const since = approvalInstance?.submittedAt ?? null
      const who = approvalInstance?.currentApproverName
        ?? approvalInstance?.currentStepName
        ?? 'Approver'
      return [who, since, false] as const
    }
    if (status === 'UNDER_NEGOTIATION') {
      // Did the counterparty come back to us? They block us reviewing.
      const cpVersionAt = counterpartyUploadedVersion?.createdAt ?? null
      const cpCommentAt = externalCommentAt ?? null
      const cpRecent = (cpVersionAt && cpCommentAt)
        ? (cpVersionAt > cpCommentAt ? cpVersionAt : cpCommentAt)
        : (cpVersionAt ?? cpCommentAt)
      // Did we send AFTER their last touch?
      const weSentRecently = lastShareSentAt && (!cpRecent || lastShareSentAt > cpRecent)

      if (cpRecent && !weSentRecently) {
        // Their move — we owe a reply.
        return ['You (review counter)', cpRecent, false] as const
      }
      if (lastShareSentAt) {
        // Our last move was sending it; they owe us a reply.
        return [contract.counterpartyName ?? 'Counterparty', lastShareSentAt, false] as const
      }
      // Never shared with the counterparty — purely internal still.
      return ['Internal review', latestVersion?.createdAt ?? null, true] as const
    }
    return [null, null, false] as const
  })()

  const waitDays = waitingSince
    ? Math.max(0, Math.round((Date.now() - new Date(waitingSince).getTime()) / 86_400_000))
    : null

  // Last activity — pick whichever is more recent of comment vs. version.
  const last = (() => {
    const commentDate = lastComment ? new Date(lastComment.createdAt).getTime() : 0
    const versionDate = latestVersion ? new Date(latestVersion.createdAt).getTime() : 0
    if (commentDate > versionDate && lastComment) {
      const ex = (lastComment.excerpt ?? '').trim()
      return {
        icon:  <MessageCircle className="size-3" />,
        label: ex.length > 42 ? ex.slice(0, 42) + '…' : (ex || 'Comment'),
      }
    }
    if (latestVersion) {
      return {
        icon:  <Clock className="size-3" />,
        label: latestVersion.changeNote?.trim() || `v${latestVersion.versionNumber} uploaded`,
      }
    }
    return null
  })()

  // Next-action hint — tied to REAL signals (P7.4.16 / F-31). The
  // previous version always said "Waiting on counterparty revisions"
  // for any UNDER_NEGOTIATION contract — even when we'd never sent
  // anything to the counterparty.
  // Whether the ball is in OUR court. Drives the "your turn" color below:
  // amber here means the user is the blocker, not merely that the deal is old.
  const blockedOnUs = typeof blockedBy === 'string' && blockedBy.startsWith('You')

  const next = (() => {
    if (status === 'PENDING_APPROVAL') return 'Waiting on review'
    if (status !== 'UNDER_NEGOTIATION') return null
    if (internalOnly) return 'Internal draft — not yet sent to counterparty'
    if (typeof blockedBy === 'string' && blockedBy.startsWith('You')) {
      return counterpartyUploadedVersion
        ? `Counterparty uploaded v${counterpartyUploadedVersion.versionNumber} — review`
        : 'Counterparty replied — your move'
    }
    return `Waiting on ${contract.counterpartyName ?? 'counterparty'} reply`
  })()

  return (
    <div
      role="region"
      aria-label="Negotiation status"
      className="border-b border-paper-200 bg-paper-50"
    >
      <div className="px-6 py-2 flex items-center gap-3 text-dense text-ink-500 flex-wrap">
        <div className="flex items-center gap-1.5 shrink-0">
          <ArrowRight className="size-3 text-ink-400" />
          <span className="text-ink-400">You</span>
          <ArrowRight className="size-3 text-ink-400" />
          <span className={cn(
            'font-medium text-ink-950',
            status === 'UNDER_NEGOTIATION' && (blockedOnUs ? 'text-attention-700' : 'text-info-700'),
            status === 'PENDING_APPROVAL' && 'text-info-700',
          )}>
            {blockedBy ?? 'Awaiting action'}
          </span>
        </div>

        {waitDays != null && (
          <div className="flex items-center gap-1 text-ink-500 shrink-0" title={new Date(waitingSince!).toLocaleString()}>
            <Hourglass className="size-3" />
            Waiting {waitDays === 0 ? 'today' : `${waitDays}d`}
          </div>
        )}

        {last && (
          <div className="flex items-center gap-1 text-ink-500 truncate">
            <span className="text-ink-400 shrink-0">Last:</span>
            <span className="shrink-0">{last.icon}</span>
            <span className="truncate">{last.label}</span>
          </div>
        )}

        {next && (
          <div className="flex items-center gap-1 text-ink-500 shrink-0">
            <span className="text-ink-400">Next:</span>
            <span className="text-ink-700">{next}</span>
          </div>
        )}

        {onNudge && (
          <button
            onClick={onNudge}
            className="ml-auto inline-flex items-center gap-1 text-dense text-ink-700 hover:text-ink-950 font-medium shrink-0"
            title="Send a nudge"
          >
            <Send className="size-3" />
            Nudge
          </button>
        )}
      </div>
    </div>
  )
}
