/**
 * DiligenceRoomsPage — list view (Phase 09 Step 5).
 *
 * Lists every diligence room in the org. Each row shows progress
 * (done / processing / failed). New room creation kicks off via a
 * dialog; clicking a row opens the detail page.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  FolderOpen, Plus, Loader2, AlertCircle, ArrowRight, X,
  ChevronDown, ChevronRight, FileText,
} from 'lucide-react'

interface ApiRoom {
  id: string
  name: string
  description: string | null
  status: string
  documentCount: number
  progress: { done: number; failed: number; processing: number }
  createdAt: string
  updatedAt: string
}

export function DiligenceRoomsPage() {
  const [createOpen, setCreateOpen] = useState(false)
  const qc = useQueryClient()

  const { data, isLoading, isError } = useQuery<{ data: ApiRoom[] }>({
    queryKey: ['diligence-rooms'],
    queryFn:  () => api.get('/diligence').then(r => r.data),
    refetchInterval: 30_000,
  })

  return (
    <div className="px-6 py-6 max-w-7xl mx-auto" data-testid="diligence-rooms-page">
      <div className="flex items-center justify-between mb-1 gap-4">
        <div className="flex items-center gap-3">
          {/* Violet is reserved for machine-authored surfaces; a room is a
              folder, so its chrome recedes to ink. */}
          <FolderOpen className="size-4 text-ink-400" />
          <h1 className="text-title text-ink-950">Diligence Rooms</h1>
        </div>
        <Button
          onClick={() => setCreateOpen(true)}
          data-testid="create-room-btn"
          className="gap-1.5"
        >
          <Plus className="size-3.5" />
          New room
        </Button>
      </div>
      <p className="text-dense text-ink-500 mb-5">
        Bulk-upload contracts for cross-document analysis — M&amp;A due diligence, vendor consolidation, portfolio reviews.
      </p>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-5 animate-spin text-ink-400" />
        </div>
      ) : isError ? (
        <div className="flex items-start gap-2 p-4 rounded-md bg-risk-50 border border-risk-200 text-dense text-risk-700">
          <AlertCircle className="size-4 mt-0.5" />
          Failed to load diligence rooms.
        </div>
      ) : (data?.data?.length ?? 0) === 0 ? (
        <div className="text-center py-16 px-6 border border-dashed border-paper-300 rounded-card" data-testid="rooms-empty">
          <FolderOpen className="size-6 text-ink-400 mx-auto mb-2" />
          <p className="text-dense text-ink-500 mb-1">No diligence rooms yet.</p>
          <p className="text-[11.5px] text-ink-400 mb-3">
            Create a room to bulk-upload up to 50 contracts and run cross-document analysis.
          </p>
          <Button onClick={() => setCreateOpen(true)} variant="outline" size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" />
            Create first room
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3" data-testid="rooms-grid">
          {(data?.data ?? []).map(r => (
            <RoomCard key={r.id} r={r} />
          ))}
        </div>
      )}

      {createOpen && (
        <CreateRoomDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => qc.invalidateQueries({ queryKey: ['diligence-rooms'] })}
        />
      )}
    </div>
  )
}

// U8 audit (2026-04-29). Trust gap on the rooms list — each room card
// claimed "30 contracts inside" but offered no inline preview, so the
// user had to take the agent's word for it. The card now expands on
// click to show the first 5 contract titles + status, with a link to
// the full room. The card itself stays a primary navigation target via
// the chevron-collapsed state.
interface RoomDocument {
  id: string
  title: string | null
  type: string
  status: string
  counterpartyName: string | null
  analysisStatus: string
}

function RoomCard({ r }: { r: ApiRoom }) {
  const [expanded, setExpanded] = useState(false)
  const { data: docs, isLoading: docsLoading } = useQuery<{ data: RoomDocument[] }>({
    queryKey: ['diligence-room-docs', r.id],
    queryFn:  () => api.get(`/diligence/${r.id}/documents`).then(res => res.data),
    enabled:  expanded,
    staleTime: 30_000,
  })
  const previewDocs = (docs?.data ?? []).slice(0, 5)

  return (
    <div
      data-testid={`room-card-${r.id}`}
      data-expanded={expanded ? 'true' : 'false'}
      className="block bg-card border border-paper-200 rounded-card p-4 hover:border-paper-300 transition-colors"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <Link to={`/diligence/${r.id}`} className="flex-1 min-w-0 group">
          <h3 className="text-body font-medium text-ink-950 truncate group-hover:text-brand-700 transition-colors" title={r.name ?? undefined}>{r.name}</h3>
          {r.description && (
            <p className="text-[11.5px] text-ink-500 mt-0.5 line-clamp-2">{r.description}</p>
          )}
        </Link>
        <Link to={`/diligence/${r.id}`} className="text-paper-300 hover:text-ink-950 transition-colors flex-shrink-0 mt-1" title="Open room">
          <ArrowRight className="size-4" />
        </Link>
      </div>
      <div className="flex items-center gap-3 text-[11.5px] mt-3 pt-3 border-t border-paper-200">
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          data-testid={`room-card-toggle-${r.id}`}
          className="flex items-center gap-1 text-ink-700 font-medium hover:text-ink-950 transition-colors"
          aria-expanded={expanded}
          aria-controls={`room-card-docs-${r.id}`}
        >
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <span className="tabular-nums">{r.documentCount}</span> {r.documentCount === 1 ? 'doc' : 'docs'}
        </button>
        {/* Extraction finished / still running / failed — binding, in flight, risk. */}
        {r.progress.done > 0 && (
          <span className="text-brand-700 tabular-nums">
            <span className="inline-block size-1.5 rounded-full bg-brand-700 mr-1" />
            {r.progress.done} ready
          </span>
        )}
        {r.progress.processing > 0 && (
          <span className="text-info-700 tabular-nums">
            <Loader2 className="inline size-3 animate-spin mr-0.5" />
            {r.progress.processing} processing
          </span>
        )}
        {r.progress.failed > 0 && (
          <span className="text-risk-700 tabular-nums">
            <span className="inline-block size-1.5 rounded-full bg-risk-600 mr-1" />
            {r.progress.failed} failed
          </span>
        )}
      </div>
      <div className="text-[10.5px] text-ink-400 mt-2">
        Updated {new Date(r.updatedAt).toLocaleDateString()}
      </div>
      {expanded && (
        <div
          id={`room-card-docs-${r.id}`}
          data-testid={`room-card-docs-${r.id}`}
          className="mt-3 pt-3 border-t border-paper-200 space-y-1.5"
        >
          {docsLoading ? (
            <div className="flex items-center gap-1.5 text-[11px] text-ink-400">
              <Loader2 className="size-3 animate-spin" /> Loading contracts…
            </div>
          ) : previewDocs.length === 0 ? (
            <p className="text-[11px] text-ink-400">No contracts uploaded yet.</p>
          ) : (
            <>
              {previewDocs.map(d => (
                <Link
                  key={d.id}
                  to={`/contracts/${d.id}`}
                  className="flex items-start gap-2 text-[11px] hover:bg-paper-100 rounded-md px-1.5 py-1 -mx-1 transition-colors"
                  title={d.title ?? 'Untitled'}
                >
                  <FileText className="size-3 text-ink-400 flex-shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-ink-950 truncate">{d.title ?? 'Untitled'}</div>
                    <div className="text-[10px] text-ink-400 flex items-center gap-1.5 mt-0.5">
                      <span>{d.type}</span>
                      <span aria-hidden>·</span>
                      <span>{d.status.replace(/_/g, ' ').toLowerCase()}</span>
                      {d.analysisStatus && d.analysisStatus !== 'DONE' && (
                        <>
                          <span aria-hidden>·</span>
                          {/* Extraction still running — the system's turn. */}
                          <span className="text-info-700">{d.analysisStatus.replace(/_/g, ' ').toLowerCase()}</span>
                        </>
                      )}
                    </div>
                  </div>
                </Link>
              ))}
              {(docs?.data?.length ?? 0) > previewDocs.length && (
                <Link
                  to={`/diligence/${r.id}`}
                  className="block text-[11px] text-ink-950 hover:text-brand-700 font-medium pt-1"
                >
                  + {(docs?.data?.length ?? 0) - previewDocs.length} more — open room →
                </Link>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function CreateRoomDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: async () => {
      const r = await api.post('/diligence', {
        name: name.trim(),
        description: description.trim() || undefined,
      })
      return r.data
    },
    onSuccess: () => {
      onCreated()
      onClose()
      setName(''); setDescription(''); setError(null)
    },
    onError: (err: { response?: { data?: { detail?: string } } }) => {
      setError(err.response?.data?.detail ?? 'Failed to create room.')
    },
  })

  return (
    <div
      role="dialog"
      aria-label="Create diligence room"
      className="fixed inset-0 z-50 bg-ink-950/40 flex items-center justify-center p-4 overflow-auto"
      onClick={onClose}
      data-testid="create-room-dialog"
    >
      <div className="bg-card rounded-card max-w-md w-full shadow-e3 my-8" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-paper-200 flex items-start justify-between">
          <div>
            <h2 className="text-section text-ink-950 flex items-center gap-2">
              <FolderOpen className="size-4 text-ink-400" />
              New diligence room
            </h2>
            <p className="text-[11.5px] text-ink-500 mt-1">
              Group a batch of contracts for cross-document analysis.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded-md hover:bg-paper-100 text-ink-400">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-[11px] font-medium text-ink-700 mb-1">Name</label>
            <Input
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              placeholder="Acme M&A — Vendor Contracts"
              data-testid="room-name"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-ink-700 mb-1">
              Description <span className="text-ink-400 font-normal">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Q3 2026 vendor contract review for the Acme acquisition…"
              rows={3}
              data-testid="room-description"
              className="w-full text-[13px] text-ink-950 border border-input bg-card rounded-md px-3 py-2 placeholder:text-ink-400 focus:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/12 resize-y"
            />
          </div>
          {error && (
            <div className="text-dense text-risk-700 bg-risk-50 border border-risk-200 rounded-md px-3 py-2">{error}</div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-paper-200 flex justify-end gap-2 bg-paper-50 rounded-b-card">
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!name.trim() || create.isPending}
            data-testid="create-room-confirm"
          >
            {create.isPending ? (
              <><Loader2 className="size-3.5 animate-spin mr-1" /> Creating…</>
            ) : (
              <><FolderOpen className="size-3.5 mr-1" /> Create room</>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
