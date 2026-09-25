/**
 * BB4 — their Word file, round-tripped (the API side: routes/external-edit.ts).
 *
 * "Edit in Google Docs" hands out a working copy (their paper with our
 * changes as tracked changes, which Google Docs shows as suggestions) and
 * makes this contract read-only until the edited copy is published back as
 * the next version, or discarded. "Download for counterparty" is their paper
 * with our changes tracked under the sender's name.
 */
import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ExternalLink, FileDown, Loader2, UploadCloud, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toaster'

export interface ExternalEditLock {
  provider:          'google-docs'
  startedById:       string
  startedByName:     string
  startedAt:         string
  baseVersionId:     string
  baseVersionNumber: number
  workingCopyName:   string
}

export interface RedlineStats {
  modified:         number
  inserted:         number
  deleted:          number
  skipped:          Array<{ text: string; reason: string }>
  verified:         boolean
  acceptedExisting: number
}

interface ApiError { detail: string; code?: string; data?: Record<string, unknown> }

/** The API's message for a failed request, including one that asked for a file. */
async function apiError(err: unknown, fallback: string): Promise<ApiError> {
  const data = (err as { response?: { data?: unknown } })?.response?.data
  let body = data as Record<string, unknown> | undefined
  if (data instanceof Blob) {
    try { body = JSON.parse(await data.text()) } catch { body = undefined }
  }
  return { detail: (body?.detail as string) ?? fallback, code: body?.code as string | undefined, data: body }
}

/** Save a .docx the API sends (it needs the auth header, so not a plain link). */
async function saveDocx(url: string): Promise<{ name: string; stats: RedlineStats | null }> {
  const res = await api.get(url, { responseType: 'blob' })
  const name = /filename="([^"]+)"/.exec(String(res.headers['content-disposition'] ?? ''))?.[1] ?? 'contract.docx'
  const raw = res.headers['x-redline-stats']
  const stats = raw ? JSON.parse(decodeURIComponent(String(raw))) as RedlineStats : null
  const href = URL.createObjectURL(res.data as Blob)
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 2000)
  return { name, stats }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function changeCount(s: RedlineStats): string {
  const n = s.modified + s.inserted + s.deleted
  return n ? `${plural(n, 'paragraph')} changed` : 'no changes'
}

// ─── Download for counterparty ──────────────────────────────────────────────

export interface RedlineNotice { name: string; stats: RedlineStats | null; error?: string }

export async function downloadForCounterparty(contractId: string): Promise<RedlineNotice> {
  try {
    return await saveDocx(`/contracts/${contractId}/redline/counterparty`)
  } catch (err) {
    const e = await apiError(err, 'The redline could not be made.')
    return { name: '', stats: null, error: e.detail }
  }
}

/** What the download for the counterparty holds, and anything left out of it. */
export function RedlineNoticeBanner({ notice, onDismiss }: { notice: RedlineNotice; onDismiss: () => void }) {
  const { stats } = notice
  const tone = notice.error || (stats && !stats.verified) ? 'border-risk-200 bg-risk-50 text-risk-900' : 'border-paper-200 bg-paper-50 text-ink-950'
  return (
    <div role="status" data-testid="counterparty-redline-notice" className={`mt-2 flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-dense ${tone}`}>
      <div className="min-w-0 space-y-1">
        {notice.error ? <p>{notice.error}</p> : (
          <>
            <p>
              <span className="font-medium">Downloaded {notice.name}.</span>{' '}
              {stats && <>Their Word file, with {changeCount(stats)} as tracked changes under your name. Open it in Word to check, then send it.</>}
            </p>
            {!!stats?.acceptedExisting && (
              <p>Their file had {plural(stats.acceptedExisting, 'tracked change')} of their own; your changes are marked against it as it reads with those accepted.</p>
            )}
            {!!stats?.skipped.length && (
              <div>
                <p>Left as they were, so change these by hand in Word:</p>
                <ul className="list-disc pl-5">
                  {stats.skipped.map((s, i) => <li key={i}>&ldquo;{s.text}&rdquo; ({s.reason})</li>)}
                </ul>
              </div>
            )}
            {stats && !stats.verified && (
              <p className="font-medium">Check this file carefully before sending it: it didn&rsquo;t pass its own check that accepting every change gives this version.</p>
            )}
          </>
        )}
      </div>
      <button type="button" onClick={onDismiss} className="shrink-0 font-semibold hover:underline">Dismiss</button>
    </div>
  )
}

// ─── Edit in Google Docs: starting ──────────────────────────────────────────

export function GoogleDocsStartDialog({ contractId, open, onClose }: { contractId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [started, setStarted] = useState<{ name: string; stats: RedlineStats | null; theirVersion: number | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const start = useMutation({
    mutationFn: async () => {
      const res = await api.post(`/contracts/${contractId}/external-edit/start`)
      const { name } = await saveDocx(`/contracts/${contractId}/external-edit/working-copy`)
      return { name, stats: res.data.stats as RedlineStats | null, theirVersion: res.data.theirVersionNumber as number | null }
    },
    onSuccess: s => { setStarted(s); setError(null); qc.invalidateQueries({ queryKey: ['contract', contractId] }) },
    onError: async err => setError((await apiError(err, 'Could not start editing in Google Docs.')).detail),
  })

  if (!open) return null
  const close = () => { setStarted(null); setError(null); onClose() }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={close} role="dialog" aria-label="Edit in Google Docs">
      <div onClick={e => e.stopPropagation()} data-testid="google-docs-dialog" className="bg-card rounded-card shadow-e3 w-full max-w-lg mx-4 flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-paper-200 flex items-center justify-between">
          <div>
            <h2 className="text-section text-ink-950">Edit in Google Docs</h2>
            <p className="text-dense text-ink-500 mt-1">
              Work on this contract with your team in Google Docs, then publish it back here as the next version.
            </p>
          </div>
          <button onClick={close} className="p-1.5 rounded-md hover:bg-paper-100 text-ink-500" aria-label="Close"><X className="size-4" /></button>
        </div>

        <div className="px-6 py-5 space-y-4 overflow-y-auto text-body text-ink-800">
          {!started ? (
            <>
              <p>
                You&rsquo;ll get a Word copy of this contract. If it came as their Word file, it&rsquo;s their file, with the changes
                made here as tracked changes, which Google Docs shows as suggestions.
              </p>
              <p className="text-dense text-ink-600">
                While the copy is out, this contract is read-only here, so the two can&rsquo;t drift apart. Publish the copy back,
                or discard it, to edit here again.
              </p>
              {error && <p className="text-dense text-risk-700" role="alert">{error}</p>}
            </>
          ) : (
            <ol className="space-y-3 list-decimal pl-5" data-testid="google-docs-steps">
              <li>
                <span className="font-medium">Downloaded {started.name}.</span>
                {started.stats && (
                  <span className="text-ink-600"> Their Version {started.theirVersion}, with {changeCount(started.stats)} as suggestions.</span>
                )}
              </li>
              <li>
                In Google Drive, choose <span className="font-medium">New › File upload</span> and pick that file, then open it
                with <span className="font-medium">Google Docs</span>.{' '}
                <a href="https://drive.google.com/drive/my-drive" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
                  Open Google Drive <ExternalLink className="size-3.5" />
                </a>
              </li>
              <li>Share it with your team. Accept or reject suggestions, suggest changes, and comment.</li>
              <li>
                When you&rsquo;re done: <span className="font-medium">File › Download › Microsoft Word (.docx)</span>, then
                choose <span className="font-medium">Publish from Google Docs</span> on this contract. Comments come in as
                internal comments; nothing is shared with the counterparty.
              </li>
            </ol>
          )}
        </div>

        <div className="px-6 py-4 border-t border-paper-200 flex justify-end gap-2">
          {!started ? (
            <>
              <Button variant="outline" size="sm" onClick={close}>Cancel</Button>
              <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending} data-testid="google-docs-start">
                {start.isPending ? <Loader2 className="animate-spin" /> : <FileDown />} Download working copy
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={close}>Done</Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Edit in Google Docs: while the copy is out ─────────────────────────────

export function ExternalEditBanner({ contractId, lock, canPublish }: { contractId: string; lock: ExternalEditLock; canPublish: boolean }) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [problem, setProblem] = useState<ApiError & { file?: File } | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['contract', contractId] })
    qc.invalidateQueries({ queryKey: ['contract-versions', contractId] })
    qc.invalidateQueries({ queryKey: ['contract-comments', contractId] })
  }

  const publish = useMutation({
    mutationFn: async ({ file, force }: { file: File; force?: boolean }) => {
      const form = new FormData()
      if (force) form.append('force', 'true')
      form.append('file', file)
      // The client's default type is JSON; a file goes as multipart.
      return (await api.post(`/contracts/${contractId}/external-edit/publish`, form, { headers: { 'Content-Type': 'multipart/form-data' } })).data as {
        version: { versionNumber: number }
        imported: { comments: number; openSuggestions: number }
      }
    },
    onSuccess: r => {
      setProblem(null)
      refresh()
      const bits = [
        r.imported.comments ? `${plural(r.imported.comments, 'comment')} added as internal comments` : null,
        r.imported.openSuggestions ? `${plural(r.imported.openSuggestions, 'open suggestion')} included as written` : null,
      ].filter(Boolean)
      toast.success(`Published as Version ${r.version.versionNumber}`, { description: bits.join('; ') || undefined, durationMs: 7000 })
    },
    onError: async (err, vars) => setProblem({ ...(await apiError(err, 'Could not publish that file.')), file: vars.file }),
  })

  const discard = useMutation({
    mutationFn: () => api.post(`/contracts/${contractId}/external-edit/discard`),
    onSuccess: () => { setConfirmDiscard(false); refresh(); toast.info('Google Docs copy discarded', { description: 'The contract can be edited here again.' }) },
  })

  const copy = useMutation({ mutationFn: () => saveDocx(`/contracts/${contractId}/external-edit/working-copy`) })

  const since = new Date(lock.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const canForce = problem?.code === 'STALE_BASE' || problem?.code === 'DIFFERENT_DOCUMENT'

  return (
    <div role="status" data-testid="external-edit-banner" className="mt-2 rounded-md border border-info-200 bg-info-50 px-3 py-2.5 text-dense text-ink-950">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0">
          <span className="font-medium">Editing in Google Docs.</span>{' '}
          {lock.startedByName} took a working copy of Version {lock.baseVersionNumber} on {since}. This contract is read-only here
          until it&rsquo;s published back or discarded.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => copy.mutate()} disabled={copy.isPending}>
            {copy.isPending ? <Loader2 className="animate-spin" /> : <FileDown />} Working copy
          </Button>
          {canPublish && (
            <>
              <input
                ref={fileRef} type="file" className="hidden" data-testid="external-edit-file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) publish.mutate({ file: f }) }}
              />
              <Button size="sm" onClick={() => fileRef.current?.click()} disabled={publish.isPending} data-testid="external-edit-publish">
                {publish.isPending ? <Loader2 className="animate-spin" /> : <UploadCloud />} Publish from Google Docs
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConfirmDiscard(true)} disabled={discard.isPending}>Discard copy</Button>
            </>
          )}
        </div>
      </div>

      {problem && (
        <div role="alert" className="mt-2 flex items-start gap-2 text-risk-700">
          <AlertTriangle className="size-4 mt-0.5 shrink-0" />
          <div className="min-w-0 space-y-1.5">
            <p>{problem.detail}</p>
            <div className="flex gap-2">
              {canForce && problem.file && (
                <Button size="sm" variant="outline" onClick={() => publish.mutate({ file: problem.file!, force: true })} disabled={publish.isPending}>
                  Publish anyway
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setProblem(null)}>Dismiss</Button>
            </div>
          </div>
        </div>
      )}

      {confirmDiscard && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p>Discard the Google Docs copy? Nothing from it comes back here, and the copy in Google Drive stays where it is.</p>
          <Button size="sm" variant="outline" onClick={() => discard.mutate()} disabled={discard.isPending}>
            {discard.isPending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} Discard
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>Keep editing in Google Docs</Button>
        </div>
      )}
    </div>
  )
}
