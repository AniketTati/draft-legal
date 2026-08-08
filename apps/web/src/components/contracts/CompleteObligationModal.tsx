/**
 * CompleteObligationModal (Phase 08 Step 4)
 *
 * Marks an obligation done with optional completion note + evidence file
 * (e.g. paid invoice, audit cert PDF). Posts multipart/form-data when a
 * file is attached, falls back to JSON otherwise.
 */
import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { CheckCircle2, Paperclip, X, Loader2 } from 'lucide-react'

interface Props {
  obligationId: string
  description:  string
  open:         boolean
  onClose:      () => void
  onCompleted?: () => void
}

const MAX_BYTES = 25 * 1024 * 1024

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function CompleteObligationModal({ obligationId, description, open, onClose, onCompleted }: Props) {
  const [note, setNote]   = useState('')
  const [file, setFile]   = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const complete = useMutation({
    mutationFn: async () => {
      if (file) {
        const fd = new FormData()
        if (note.trim()) fd.append('note', note.trim())
        fd.append('file', file)
        const r = await api.post(`/obligations/${obligationId}/complete`, fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
        return r.data
      }
      const r = await api.post(`/obligations/${obligationId}/complete`, { note: note.trim() || undefined })
      return r.data
    },
    onSuccess: () => {
      onCompleted?.()
      onClose()
      setNote(''); setFile(null); setError(null)
    },
    onError: (err: { response?: { data?: { detail?: string } } }) => {
      setError(err.response?.data?.detail ?? 'Failed to complete obligation.')
    },
  })

  const onPickFile = (f: File | null) => {
    setError(null)
    if (!f) { setFile(null); return }
    if (f.size > MAX_BYTES) {
      setError(`File too large — 25MB max (this is ${formatBytes(f.size)}).`)
      return
    }
    setFile(f)
  }

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-label="Complete obligation"
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 overflow-auto"
      onClick={onClose}
      data-testid="complete-obligation-modal"
    >
      <div
        className="bg-card rounded-card max-w-md w-full shadow-e3 my-8"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-paper-200 flex items-start justify-between">
          <div>
            <h2 className="text-section text-ink-950 flex items-center gap-2">
              {/* The emerald is spent on the decision button below, so the
                  header glyph stays neutral — one colored element. */}
              <CheckCircle2 className="size-4 text-ink-500" />
              Mark obligation complete
            </h2>
            <p className="text-dense text-ink-500 mt-1 leading-relaxed line-clamp-2">{description}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-chip hover:bg-paper-100 text-ink-400"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* Note */}
          <div>
            <label className="block text-body font-medium text-ink-700 mb-1">
              Completion note <span className="text-ink-400 font-normal">(optional)</span>
            </label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="What was done? Reference numbers, payment date, etc."
              rows={3}
              data-testid="obligation-note"
              className="w-full text-[13px] text-ink-950 bg-card border border-input rounded-md px-[11px] py-2 placeholder:text-ink-400 focus:border-brand-700 focus:outline-none focus:ring-[3px] focus:ring-brand-700/12 resize-y"
            />
          </div>

          {/* Evidence */}
          <div>
            <label className="block text-body font-medium text-ink-700 mb-1">
              Evidence file <span className="text-ink-400 font-normal">(optional, 25MB max)</span>
            </label>
            {!file ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                data-testid="obligation-pick-file"
                className="w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed border-paper-300 rounded-md hover:border-ink-400 hover:bg-paper-50 transition-colors text-body text-ink-700"
              >
                <Paperclip className="size-4" />
                Attach evidence (PDF, image, CSV…)
              </button>
            ) : (
              <div className="flex items-center gap-2 px-3 py-2 bg-paper-50 border border-paper-200 rounded-md text-body" data-testid="obligation-attached-file">
                <Paperclip className="size-4 text-ink-500 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-ink-950 truncate">{file.name}</div>
                  <div className="text-[11px] text-ink-500 tabular-nums">{formatBytes(file.size)}</div>
                </div>
                <button
                  type="button"
                  onClick={() => onPickFile(null)}
                  data-testid="obligation-remove-file"
                  className="text-ink-400 hover:text-risk-600"
                  aria-label="Remove file"
                >
                  <X className="size-4" />
                </button>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              hidden
              onChange={e => onPickFile(e.target.files?.[0] ?? null)}
            />
          </div>

          {error && (
            <div className="text-body text-risk-700 bg-risk-50 border border-risk-200 rounded-md px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-paper-200 flex justify-end gap-2 bg-paper-50 rounded-b-card">
          <Button variant="outline" onClick={onClose} disabled={complete.isPending}>
            Cancel
          </Button>
          {/* Marking an obligation done is a binding act, which is what the
              brand variant exists for. */}
          <Button
            variant="brand"
            onClick={() => complete.mutate()}
            disabled={complete.isPending}
            data-testid="obligation-complete-confirm"
          >
            {complete.isPending ? (
              <><Loader2 className="size-4 animate-spin mr-1" /> Saving…</>
            ) : (
              <><CheckCircle2 className="size-4 mr-1" /> Mark complete</>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
