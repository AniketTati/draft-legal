/**
 * After "Save and send": the download, link or email the person asked for.
 * The server saves the version and records the send; a Word or PDF file is
 * still fetched here, by the browser, so it lands in their downloads. Shared
 * by the contract page and the workspace so neither forgets a method, and a
 * send that failed always says so.
 */
import { api } from '@/lib/api'
import { serverMessage } from '@/lib/approval-keys'
import { toast } from '@/components/common/Toaster'
import type { SaveVersionResult } from '@/lib/working-copy'
import { downloadForCounterparty, type RedlineNotice } from './GoogleDocsEdit'

export interface FollowUpSendOptions {
  /** Where the Word download's notice goes; a toast when the page has no banner for it. */
  onRedline?: (notice: RedlineNotice) => void
}

/** The toast a Word download gets when the page has no banner for it. */
export function redlineToast(notice: RedlineNotice) {
  if (notice.error) {
    toast.error('The Word file could not be made', { description: notice.error, durationMs: 9000 })
    return
  }
  toast.success(`Downloaded ${notice.name}`, {
    description: notice.stats && !notice.stats.verified
      ? 'Check this file carefully in Word before sending it.'
      : 'Their Word file, with your changes as tracked changes. Open it in Word to check, then send it.',
    durationMs: 9000,
  })
}

export async function followUpSend(contractId: string, r: SaveVersionResult, opts: FollowUpSendOptions = {}): Promise<void> {
  const send = r.send
  if (!send) return
  if (!send.ok) {
    toast.error(`Saved as v${r.version.versionNumber}, but not sent`, { description: send.detail ?? 'Try sending it again.', durationMs: 9000 })
    return
  }
  if (send.method === 'word') {
    const notice = await downloadForCounterparty(contractId)
    ;(opts.onRedline ?? redlineToast)(notice)
  } else if (send.method === 'pdf') {
    try {
      const { url } = (await api.get(`/contracts/${contractId}/download`, { params: { versionId: r.version.id } })).data as { url: string }
      window.open(url, '_blank', 'noopener')
    } catch (err) {
      toast.error('The PDF could not be downloaded', { description: serverMessage(err, 'Try Download from the menu.'), durationMs: 9000 })
    }
  } else if (send.method === 'email') {
    toast.success(send.emailDelivered === false ? 'Link made, but the email was not sent' : `Emailed to ${send.emailedTo ?? 'the counterparty'}`, {
      description: send.emailDelivered === false ? `Email isn't set up. Copy the link and send it yourself: ${send.portalUrl ?? ''}` : undefined, durationMs: 9000,
    })
  } else if (send.portalUrl) {
    await navigator.clipboard?.writeText(send.portalUrl).catch(() => {})
    toast.success('Share link copied', { description: send.portalUrl, durationMs: 9000 })
  }
}
