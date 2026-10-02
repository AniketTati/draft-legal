/**
 * docs/41 Part 16 (C1) — the dialogs around the editor's draft changes:
 *   - Save as version: a note, and optionally send it to the counterparty or
 *     ask every approver again;
 *   - leaving with draft changes: save them as a version, keep them, or
 *     throw them away;
 *   - someone else saved since this editor loaded: load theirs or overwrite.
 * Typing autosaves to the draft changes (lib/working-copy.ts); only these
 * make a version.
 */
import { useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { agoWords, type SaveVersionBody, type SendMethod, type WorkingCopyConflict } from '@/lib/working-copy'

/** The shortest note the server takes (lib/working-copy.ts MIN_NOTE_LENGTH). */
export const MIN_NOTE_LENGTH = 3

export const SEND_METHOD_LABELS: Record<SendMethod, string> = {
  share_link: 'Share link',
  email: 'Email',
  word: 'Word (tracked changes)',
  pdf: 'PDF',
}

export interface SaveVersionForm {
  note: string
  send: boolean
  method: SendMethod
  recipientEmail: string
  message: string
  resetApprovals: boolean
}

export const emptySaveVersionForm = (): SaveVersionForm => ({ note: '', send: false, method: 'share_link', recipientEmail: '', message: '', resetApprovals: false })

/** Why the form can't be saved yet, or null. */
export function saveVersionRefusal(f: SaveVersionForm): string | null {
  if (f.note.trim().length < MIN_NOTE_LENGTH) return 'Say what changed in this version.'
  if (f.send && f.method === 'email' && !/^\S+@\S+\.\S+$/.test(f.recipientEmail.trim())) return 'Enter the email address to send it to.'
  return null
}

/**
 * The request body. "Reset approvals" goes only from someone who may
 * configure workflows (the server ignores it from anyone else).
 */
export function saveVersionBody(f: SaveVersionForm, opts: { canResetApprovals: boolean }): SaveVersionBody {
  return {
    note: f.note.trim(),
    ...(f.send && {
      sendToCounterparty: {
        method: f.method,
        ...(f.method === 'email' && { recipientEmail: f.recipientEmail.trim(), ...(f.message.trim() && { message: f.message.trim() }) }),
      },
    }),
    ...(opts.canResetApprovals && { resetApprovals: f.resetApprovals }),
  }
}

/** A plain dialog frame, as the page's other dialogs draw it. */
function Frame({ label, testId, title, sub, onClose, children }: { label: string; testId: string; title: string; sub?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose} role="dialog" aria-label={label}>
      <div onClick={e => e.stopPropagation()} data-testid={testId} className="bg-card rounded-card shadow-e3 w-full max-w-md mx-4 flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-paper-200 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-section text-ink-950">{title}</h2>
            {sub && <p className="text-dense text-ink-500 mt-1">{sub}</p>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-paper-100 text-ink-500" aria-label="Close"><X className="size-4" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function SaveVersionDialog({ open, onClose, onSave, saving, error, canResetApprovals, canShare, initial }: {
  open: boolean
  onClose: () => void
  onSave: (body: SaveVersionBody) => void
  saving?: boolean
  error?: string | null
  /** configure:workflow — may ask every approver again. */
  canResetApprovals: boolean
  /** configure:contract — may make a share link or email one. */
  canShare: boolean
  initial?: Partial<SaveVersionForm>
}) {
  const [f, setF] = useState<SaveVersionForm>(() => ({ ...emptySaveVersionForm(), ...(!canShare && { method: 'word' as const }), ...initial }))
  if (!open) return null
  const set = (patch: Partial<SaveVersionForm>) => setF(prev => ({ ...prev, ...patch }))
  const refusal = saveVersionRefusal(f)
  const methods = (Object.keys(SEND_METHOD_LABELS) as SendMethod[]).filter(m => canShare || (m !== 'share_link' && m !== 'email'))
  return (
    <Frame label="Save as version" testId="save-version-dialog" title="Save as version" sub="Your draft changes become a new version, with a note saying what changed." onClose={onClose}>
      <div className="px-6 py-5 space-y-4 overflow-y-auto">
        <div>
          <label htmlFor="save-version-note" className="block text-dense font-semibold text-ink-700 mb-1.5">What changed</label>
          <textarea
            id="save-version-note"
            value={f.note}
            onChange={e => set({ note: e.target.value })}
            rows={3}
            placeholder="e.g. Extended the term to two years"
            data-testid="save-version-note"
            className="w-full text-[13px] border border-input rounded-md px-2.5 py-2 bg-card focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15"
          />
        </div>
        <label className="flex items-center gap-2 text-body text-ink-950">
          <input type="checkbox" checked={f.send} onChange={e => set({ send: e.target.checked })} data-testid="save-version-send" />
          Send to counterparty
        </label>
        {f.send && (
          <div className="space-y-3 pl-6" data-testid="save-version-send-options">
            <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="How to send it">
              {methods.map(m => (
                <label key={m} className="inline-flex items-center gap-1.5 text-dense text-ink-700">
                  <input type="radio" name="save-version-method" value={m} checked={f.method === m} onChange={() => set({ method: m })} data-testid={`save-version-method-${m}`} />
                  {SEND_METHOD_LABELS[m]}
                </label>
              ))}
            </div>
            {f.method === 'email' && (
              <>
                <Input type="email" value={f.recipientEmail} onChange={e => set({ recipientEmail: e.target.value })} placeholder="their@email.com" data-testid="save-version-email" />
                <Input value={f.message} onChange={e => set({ message: e.target.value })} placeholder="Message (optional)" />
              </>
            )}
            <p className="text-[11px] text-ink-500">{sendHint(f.method)}</p>
          </div>
        )}
        {canResetApprovals && (
          <label className="flex items-start gap-2 text-body text-ink-950" data-testid="save-version-reset-approvals">
            <input type="checkbox" className="mt-1" checked={f.resetApprovals} onChange={e => set({ resetApprovals: e.target.checked })} />
            <span>
              Reset approvals
              <span className="block text-[11px] text-ink-500">Every approver is asked again, whatever the workflow's rules say for this change.</span>
            </span>
          </label>
        )}
        {error && <p className="text-dense text-risk-700" role="alert">{error}</p>}
      </div>
      <div className="px-6 py-4 border-t border-paper-200 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" disabled={!!refusal || saving} title={refusal ?? undefined} onClick={() => onSave(saveVersionBody(f, { canResetApprovals }))} data-testid="save-version-submit">
          {saving && <Loader2 className="size-4 animate-spin" />}
          {f.send ? 'Save and send' : 'Save version'}
        </Button>
      </div>
    </Frame>
  )
}

function sendHint(m: SendMethod): string {
  switch (m) {
    case 'share_link': return 'A link they can open to read, comment on and upload their reply.'
    case 'email': return 'The link is emailed to them.'
    case 'word': return 'Downloads their Word file with your changes as tracked changes, for you to send.'
    case 'pdf': return 'Downloads the new version as a PDF, for you to send.'
  }
}

export type LeaveChoice = 'save' | 'keep' | 'discard'

/** Leaving the editor (Done, Esc, or a link) with draft changes not yet a version. */
export function LeaveDraftPrompt({ open, onChoose, onClose, busy }: {
  open: boolean
  onChoose: (choice: LeaveChoice) => void
  onClose: () => void
  busy?: LeaveChoice | null
}) {
  if (!open) return null
  return (
    <Frame label="Draft changes not saved as a version" testId="leave-draft-prompt" title="Your changes aren't a version yet" sub="They're saved as draft changes. Save them as a version now, keep them as draft changes to finish later, or discard them." onClose={onClose}>
      <div className="px-6 py-4 flex flex-wrap justify-end gap-2">
        <Button variant="danger" size="sm" disabled={!!busy} onClick={() => onChoose('discard')} data-testid="leave-draft-discard">
          {busy === 'discard' && <Loader2 className="size-4 animate-spin" />}Discard
        </Button>
        <Button variant="outline" size="sm" disabled={!!busy} onClick={() => onChoose('keep')} data-testid="leave-draft-keep">
          {busy === 'keep' && <Loader2 className="size-4 animate-spin" />}Keep as draft changes
        </Button>
        <Button size="sm" disabled={!!busy} onClick={() => onChoose('save')} data-testid="leave-draft-save">Save as version</Button>
      </div>
    </Frame>
  )
}

/** "Priya Shah saved changes 2 min ago": who overwrote this editor's revision, and when. */
export function conflictWords(c: WorkingCopyConflict, now = Date.now()): string {
  if (!c.current) return 'These draft changes were saved as a version or discarded since you loaded them.'
  return `${c.current.updatedBy.name ?? 'Someone'} saved changes ${agoWords(c.current.updatedAt, now)}.`
}

/** An autosave refused because someone else saved first. */
export function WorkingCopyConflictDialog({ conflict, onReload, onOverwrite, onClose, busy }: {
  conflict: WorkingCopyConflict | null
  onReload: () => void
  onOverwrite: () => void
  onClose: () => void
  busy?: boolean
}) {
  if (!conflict) return null
  return (
    <Frame label="Someone else saved changes" testId="working-copy-conflict" title={conflictWords(conflict)} sub="Your latest typing isn't saved. Load their changes (yours since are lost), or overwrite theirs with yours." onClose={onClose}>
      <div className="px-6 py-4 flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={onReload} data-testid="working-copy-reload">
          {conflict.current ? 'Reload their changes' : 'Reload'}
        </Button>
        <Button size="sm" disabled={busy} onClick={onOverwrite} data-testid="working-copy-overwrite">
          {busy && <Loader2 className="size-4 animate-spin" />}Overwrite
        </Button>
      </div>
    </Frame>
  )
}

/** The editor's save status: typing is kept, but it is not a version until someone saves one. */
export function draftStatusText(state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error'): string {
  switch (state) {
    case 'saving': return 'Saving…'
    case 'saved': return 'Draft changes saved · not a version yet'
    case 'dirty': return 'Unsaved'
    case 'error': return 'Save failed'
    default: return ''
  }
}
