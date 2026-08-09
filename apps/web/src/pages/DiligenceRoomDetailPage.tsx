/**
 * DiligenceRoomDetailPage — single room view (Phase 09 Step 5).
 *
 * Shows progress + a results table comparing extracted fields across
 * every document in the room. Drag-and-drop bulk upload zone for
 * adding more contracts. CSV export button on the header.
 */
import { useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { AssistMark } from '@/components/ui/assist'
import { RiskMeter } from '@/components/ui/primitives'
import { StatusPill } from '@/components/ui/status-pill'
import { statusMeta, type Meaning } from '@/lib/status'
import {
  FolderOpen, Upload, Loader2, AlertCircle, ArrowLeft, ArrowRight,
  Download, CheckCircle2, AlertTriangle, FileText, RefreshCw,
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

interface ApiResultRow {
  id:               string
  title:            string
  type:             string
  status:           string
  counterpartyName: string | null
  value:            number | null
  currency:         string | null
  effectiveDate:    string | null
  expiryDate:       string | null
  jurisdiction:     string | null
  riskScore:        number | null
  riskFactors:      string[] | null
  overallConfidence: number | null
  summary:          string | null
  analysisStatus:   string
  autoRenew:        unknown
  terminationNotice: unknown
  governingLaw:     unknown
  paymentTerms:     unknown
}

function formatMoney(n: number | null, currency = 'USD'): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${currency} ${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `${currency} ${(n / 1_000).toFixed(0)}K`
  return `${currency} ${n.toFixed(0)}`
}

/*
 * Both local color maps are gone. Risk now renders as the system's RiskMeter,
 * which shares its thresholds with lib/status, and the analysis state renders
 * as a StatusPill — every one of these keys already lives in the status map.
 */
const IN_PROGRESS = ['ANALYZING', 'PARSING', 'EXTRACTING', 'INDEXING', 'CLASSIFYING', 'SPLITTING']

export function DiligenceRoomDetailPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { data: room, isLoading: roomLoading } = useQuery<ApiRoom>({
    queryKey: ['diligence-room', id],
    queryFn:  () => api.get(`/diligence/${id}`).then(r => r.data),
    enabled:  !!id,
    refetchInterval: 5_000,    // tight refresh while docs are processing
  })

  const { data: results } = useQuery<{ data: ApiResultRow[]; total: number }>({
    queryKey: ['diligence-results', id],
    queryFn:  () => api.get(`/diligence/${id}/results`).then(r => r.data),
    enabled:  !!id,
    refetchInterval: 5_000,
  })

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const fd = new FormData()
      for (const f of files) fd.append('file', f)
      const r = await api.post(`/diligence/${id}/upload`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return r.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['diligence-room', id] })
      qc.invalidateQueries({ queryKey: ['diligence-results', id] })
      setUploadError(null)
    },
    onError: (err: { response?: { data?: { detail?: string } } }) => {
      setUploadError(err.response?.data?.detail ?? 'Upload failed.')
    },
  })

  const handleFiles = (files: FileList | File[] | null) => {
    if (!files) return
    const arr = Array.from(files)
    if (arr.length === 0) return
    if (arr.length > 50) {
      setUploadError('Cap is 50 files per upload — please split into multiple batches.')
      return
    }
    upload.mutate(arr)
  }

  const [exportError, setExportError] = useState<string | null>(null)

  const handleExport = async () => {
    // window.open cannot carry the Bearer token -- middleware/auth.ts accepts
    // only `Authorization: Bearer` and only the axios client attaches it -- so
    // this opened a new tab containing 401 JSON. Same pattern as
    // ObligationsPage.tsx, two files over.
    try {
      const r = await api.get(`/diligence/${id}/export?format=csv`, { responseType: 'blob' })
      const url = URL.createObjectURL(new Blob([r.data], { type: 'text/csv' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `diligence-${room?.name?.replace(/[^\w.-]+/g, '_') ?? id}.csv`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      // A download that silently does nothing is indistinguishable from a
      // broken app; say so.
      setExportError('Could not export this room — try again.')
      setTimeout(() => setExportError(null), 5000)
    }
  }

  if (roomLoading) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="size-5 animate-spin text-ink-400" /></div>
  }
  if (!room) {
    return (
      <div className="px-6 py-6 max-w-7xl mx-auto">
        <div className="flex items-start gap-2 p-4 rounded-md bg-risk-50 border border-risk-200 text-dense text-risk-700">
          <AlertCircle className="size-4 mt-0.5" />
          Room not found.
        </div>
        <Link to="/diligence" className="text-dense text-ink-950 hover:text-brand-700 mt-4 inline-flex items-center gap-1">
          <ArrowLeft className="size-3.5" /> Back to all rooms
        </Link>
      </div>
    )
  }

  const items = results?.data ?? []
  const hasAnyDone = (room.progress?.done ?? 0) > 0

  return (
    <div className="px-6 py-6 max-w-7xl mx-auto" data-testid="diligence-detail-page">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-2">
        <div className="flex-1 min-w-0">
          <Link to="/diligence" className="text-[11.5px] text-ink-500 hover:text-ink-950 inline-flex items-center gap-1 mb-2">
            <ArrowLeft className="size-3.5" /> All rooms
          </Link>
          <div className="flex items-center gap-3">
            <FolderOpen className="size-4 text-ink-400" />
            <h1 className="text-title text-ink-950">{room.name}</h1>
          </div>
          {room.description && <p className="text-dense text-ink-500 mt-1">{room.description}</p>}
        </div>
        <Button
          onClick={handleExport}
          variant="outline"
          size="sm"
          disabled={!hasAnyDone}
          data-testid="export-csv-btn"
          className="gap-1.5"
        >
          <Download className="size-3.5" />
          Export CSV
        </Button>
      </div>

      {exportError && (
        <p className="text-[11px] text-risk-700" data-testid="export-error">{exportError}</p>
      )}

      {/* Progress strip */}
      <div className="grid grid-cols-3 gap-3 mt-5 mb-5">
        <ProgressCard label="Documents"  value={room.documentCount}                tone="neutral"  icon={FileText}        />
        <ProgressCard label="Processed"  value={room.progress.done}                tone="binding"  icon={CheckCircle2}    />
        <ProgressCard label="Processing" value={room.progress.processing}          tone="inflight" icon={RefreshCw} animate={room.progress.processing > 0} />
      </div>
      {room.progress.failed > 0 && (
        <div className="mb-4 p-3 rounded-md bg-risk-50 border border-risk-200 text-dense text-risk-900 flex items-center gap-2">
          <AlertTriangle className="size-4 flex-shrink-0" />
          {room.progress.failed} {room.progress.failed === 1 ? 'document' : 'documents'} failed to extract — open them to inspect.
        </div>
      )}

      {/* Upload zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
        onDragLeave={(e) => { e.preventDefault(); setDragActive(false) }}
        onDrop={(e) => {
          e.preventDefault()
          setDragActive(false)
          handleFiles(e.dataTransfer.files)
        }}
        data-testid="upload-zone"
        className={`mb-6 rounded-card border-2 border-dashed p-8 text-center transition-colors ${
          dragActive
            // The drop target is an action surface, so the "armed" state is ink.
            ? 'border-ink-950 bg-paper-100'
            : 'border-paper-300 bg-card hover:border-ink-400 hover:bg-paper-50'
        }`}
      >
        <Upload className={`size-6 mx-auto mb-2 ${dragActive ? 'text-ink-950' : 'text-ink-400'}`} />
        <div className="text-body font-medium text-ink-950 mb-1">
          {upload.isPending ? 'Uploading…' : 'Drop contracts here or click to browse'}
        </div>
        <div className="text-[11.5px] text-ink-500 mb-3">PDF or DOCX · up to 50 files per upload</div>
        <Button
          onClick={() => fileInputRef.current?.click()}
          disabled={upload.isPending}
          variant="outline"
          size="sm"
          className="gap-1.5"
          data-testid="upload-btn"
        >
          {upload.isPending ? (
            <><Loader2 className="animate-spin" /> Uploading {(upload.variables as File[])?.length ?? 0}…</>
          ) : (
            <><Upload /> Browse files</>
          )}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.doc"
          hidden
          onChange={e => handleFiles(e.target.files)}
        />
        {uploadError && (
          <div className="mt-3 text-[11.5px] text-risk-700 bg-risk-50 border border-risk-200 rounded-md px-3 py-2 inline-block">
            {uploadError}
          </div>
        )}
      </div>

      {/* Results table */}
      {items.length === 0 ? (
        <div className="text-center py-12 px-6 border border-dashed border-paper-300 rounded-card">
          <FileText className="size-6 text-ink-400 mx-auto mb-2" />
          <p className="text-dense text-ink-500">No documents in this room yet. Upload some to start.</p>
        </div>
      ) : (
        <div className="bg-card border border-paper-200 rounded-card overflow-hidden">
          <header className="flex items-center justify-between px-5 py-3 bg-paper-50 border-b border-paper-200">
            {/* Every value in this table was read out of a PDF by the model, so
                the table carries the machine mark. */}
            <h3 className="text-section text-ink-950 flex items-center gap-2">
              <AssistMark />
              Cross-document extraction
            </h3>
            <span className="text-[11.5px] tabular-nums text-ink-500">{items.length} {items.length === 1 ? 'doc' : 'docs'}</span>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-dense" data-testid="results-table">
              <thead className="bg-paper-50 text-[10px] uppercase tracking-[0.09em] text-ink-400 border-b border-paper-200">
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Title</th>
                  <th className="text-left px-4 py-2 font-semibold">Counterparty</th>
                  <th className="text-left px-4 py-2 font-semibold">Value</th>
                  <th className="text-left px-4 py-2 font-semibold">Effective</th>
                  <th className="text-left px-4 py-2 font-semibold">Expiry</th>
                  <th className="text-left px-4 py-2 font-semibold">Risk</th>
                  <th className="text-left px-4 py-2 font-semibold">Status</th>
                  <th className="text-right px-4 py-2 font-semibold"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-paper-100">
                {items.map(d => (
                  <tr key={d.id} className="hover:bg-paper-50" data-testid={`result-row-${d.id}`}>
                    <td className="px-4 py-2 max-w-[260px]">
                      <div className="text-[13px] font-medium text-ink-950 truncate" title={d.title}>{d.title}</div>
                      {d.type && d.type !== 'OTHER' && (
                        <div className="text-[10px] uppercase tracking-[0.09em] font-mono text-ink-400 mt-0.5">
                          {d.type}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-ink-700">
                      {d.counterpartyName ?? <span className="text-ink-400">—</span>}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap font-medium text-ink-950 tabular-nums">
                      {formatMoney(d.value, d.currency ?? 'USD')}
                    </td>
                    <td className="px-4 py-2 text-ink-700 whitespace-nowrap tabular-nums">
                      {d.effectiveDate ?? <span className="text-ink-400">—</span>}
                    </td>
                    <td className="px-4 py-2 text-ink-700 whitespace-nowrap tabular-nums">
                      {d.expiryDate ?? <span className="text-ink-400">—</span>}
                    </td>
                    <td className="px-4 py-2">
                      {d.riskScore != null ? (
                        <RiskMeter score={d.riskScore} className="w-[92px]" />
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <StatusPill status={d.analysisStatus}>
                        {IN_PROGRESS.includes(d.analysisStatus) && (
                          <Loader2 className="size-3 animate-spin" />
                        )}
                        {statusMeta(d.analysisStatus).label}
                      </StatusPill>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        to={`/contracts/${d.id}`}
                        className="inline-flex items-center gap-0.5 text-[11.5px] text-ink-950 hover:text-brand-700 font-medium"
                      >
                        Open <ArrowRight className="size-3" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function ProgressCard({ label, value, tone, icon: Icon, animate }: {
  label: string
  value: number
  tone: Extract<Meaning, 'neutral' | 'binding' | 'inflight'>
  icon: React.ComponentType<{ className?: string }>
  animate?: boolean
}) {
  const toneClass = {
    neutral:  'text-ink-700 bg-paper-100',
    binding:  'text-brand-700 bg-brand-100',
    inflight: 'text-info-700 bg-info-100',
  }[tone]
  return (
    <div className="border border-paper-200 rounded-card p-4 bg-card flex items-center gap-3">
      <div className={`size-9 rounded-card flex items-center justify-center ${toneClass}`}>
        <Icon className={`size-4 ${animate ? 'animate-spin' : ''}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-ink-500">{label}</div>
        <div className="text-[24px] font-semibold tracking-[-0.02em] tabular-nums text-ink-950">{value}</div>
      </div>
    </div>
  )
}
