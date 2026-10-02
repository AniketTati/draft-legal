/**
 * docs/41 Part 16 (C1) — the editor's working copy: typing autosaves here
 * (PUT /contracts/:id/working-copy), and a version is made only with a note
 * (POST /contracts/:id/versions/from-working-copy). See the API's
 * lib/working-copy.ts.
 */
import { api } from '@/lib/api'

export interface WorkingCopy {
  contractId: string
  baseVersionId: string | null
  baseVersionNumber: number | null
  html: string
  revision: number
  updatedAt: string
  updatedBy: { id: string; name: string | null }
  /** A version was made since these changes were started. */
  stale: boolean
}

export interface WorkingCopyConflict {
  code: 'WORKING_COPY_CONFLICT'
  detail: string
  current: { revision: number; updatedAt: string; updatedBy: { id: string; name: string | null }; baseVersionId: string | null } | null
}

export type SendMethod = 'share_link' | 'email' | 'word' | 'pdf'

export interface SaveVersionBody {
  note: string
  sendToCounterparty?: { method: SendMethod; recipientEmail?: string; message?: string; permissions?: string[] } | null
  resetApprovals?: boolean
  overwriteNewer?: boolean
}

export interface SaveVersionResult {
  version: { id: string; versionNumber: number }
  created: boolean
  approvals: 'rules' | 'reset_all' | 'keep'
  send?: { method: SendMethod; ok: boolean; detail?: string; code?: string; portalUrl?: string; emailedTo?: string | null; emailDelivered?: boolean | null; download?: string }
  contract: { stage: string; stageState: string; turn: string } | null
}

export const workingCopyKey = (contractId: string) => ['working-copy', contractId] as const

export const fetchWorkingCopy = (contractId: string) =>
  api.get(`/contracts/${contractId}/working-copy`).then(r => (r.data as { workingCopy: WorkingCopy | null }).workingCopy)

export const putWorkingCopy = (contractId: string, body: { html: string; revision: number; baseVersionId?: string | null }) =>
  api.put(`/contracts/${contractId}/working-copy`, body).then(r => (r.data as { workingCopy: WorkingCopy }).workingCopy)

export const discardWorkingCopy = (contractId: string) => api.delete(`/contracts/${contractId}/working-copy`)

export const saveVersionFromWorkingCopy = (contractId: string, body: SaveVersionBody) =>
  api.post(`/contracts/${contractId}/versions/from-working-copy`, body).then(r => r.data as SaveVersionResult)

/** "just now", "2 min ago", "3 h ago", "12 Oct": how long since a save. */
export function agoWords(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** The 409 body of a stale autosave, when that is what an error is. */
export function conflictOf(err: unknown): WorkingCopyConflict | null {
  const data = (err as { response?: { status?: number; data?: { code?: string } } })?.response
  return data?.status === 409 && data.data?.code === 'WORKING_COPY_CONFLICT' ? data.data as WorkingCopyConflict : null
}
