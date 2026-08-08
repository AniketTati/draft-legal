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

function riskBadge(score: number | null) {
  if (score == null) return { text: '—', tone: 'text-gray-400' }
  const pct = Math.round(score * 100)
  if (score >= 0.8)  return { text: `${pct}`, tone: 'text-red-700 bg-red-50 border-red-200' }
  if (score >= 0.6)  return { text: `${pct}`, tone: 'text-orange-700 bg-orange-50 border-orange-200' }
  if (score >= 0.3)  return { text: `${pct}`, tone: 'text-amber-700 bg-amber-50 border-amber-200' }
  return { text: `${pct}`, tone: 'text-emerald-700 bg-emerald-50 border-emerald-200' }
}

function statusBadge(s: string) {
  const tones: Record<string, string> = {
    DONE:        'bg-emerald-50 border-emerald-200 text-emerald-700',
    FAILED:      'bg-red-50 border-red-200 text-red-700',
    PENDING:     'bg-gray-100 border-gray-200 text-gray-600',
    ANALYZING:   'bg-blue-50 border-blue-200 text-blue-700',
    PARSING:     'bg-blue-50 border-blue-200 text-blue-700',
    EXTRACTING:  'bg-blue-50 border-blue-200 text-blue-700',
    INDEXING:    'bg-blue-50 border-blue-200 text-blue-700',
    CLASSIFYING: 'bg-blue-50 border-blue-200 text-blue-700',
    SPLITTING:   'bg-blue-50 border-blue-200 text-blue-700',
  }
  return tones[s] ?? tones.PENDING
}

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
    return <div className="flex items-center justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-gray-300" /></div>
  }
  if (!room) {
    return (
      <div className="px-6 py-6 max-w-7xl mx-auto">
        <div className="flex items-start gap-2 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 mt-0.5" />
          Room not found.
        </div>
        <Link to="/diligence" className="text-sm text-violet-600 mt-4 inline-flex items-center gap-1">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to all rooms
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
          <Link to="/diligence" className="text-xs text-gray-500 hover:text-violet-600 inline-flex items-center gap-1 mb-2">
            <ArrowLeft className="h-3.5 w-3.5" /> All rooms
          </Link>
          <div className="flex items-center gap-3">
            <FolderOpen className="h-5 w-5 text-violet-600" />
            <h1 className="text-2xl font-semibold text-gray-900">{room.name}</h1>
          </div>
          {room.description && <p className="text-sm text-gray-500 mt-1">{room.description}</p>}
        </div>
        <Button
          onClick={handleExport}
          variant="outline"
          size="sm"
          disabled={!hasAnyDone}
          data-testid="export-csv-btn"
          className="gap-1.5"
        >
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {exportError && (
        <p className="text-[11px] text-red-600" data-testid="export-error">{exportError}</p>
      )}

      {/* Progress strip */}
      <div className="grid grid-cols-3 gap-3 mt-5 mb-5">
        <ProgressCard label="Documents"  value={room.documentCount}                tone="violet"  icon={FileText}        />
        <ProgressCard label="Processed"  value={room.progress.done}                tone="emerald" icon={CheckCircle2}    />
        <ProgressCard label="Processing" value={room.progress.processing}          tone="blue"    icon={RefreshCw} animate={room.progress.processing > 0} />
      </div>
      {room.progress.failed > 0 && (
        <div className="mb-4 p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-800 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
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
        className={`mb-6 rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          dragActive
            ? 'border-violet-400 bg-violet-50'
            : 'border-gray-300 bg-white hover:border-violet-300 hover:bg-violet-50/30'
        }`}
      >
        <Upload className={`h-8 w-8 mx-auto mb-2 ${dragActive ? 'text-violet-500' : 'text-gray-400'}`} />
        <div className="text-sm font-medium text-gray-900 mb-1">
          {upload.isPending ? 'Uploading…' : 'Drop contracts here or click to browse'}
        </div>
        <div className="text-xs text-gray-500 mb-3">PDF or DOCX · up to 50 files per upload</div>
        <Button
          onClick={() => fileInputRef.current?.click()}
          disabled={upload.isPending}
          variant="outline"
          size="sm"
          className="gap-1.5"
          data-testid="upload-btn"
        >
          {upload.isPending ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Uploading {(upload.variables as File[])?.length ?? 0}…</>
          ) : (
            <><Upload className="h-4 w-4" /> Browse files</>
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
          <div className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2 inline-block">
            {uploadError}
          </div>
        )}
      </div>

      {/* Results table */}
      {items.length === 0 ? (
        <div className="text-center py-12 px-6 border border-dashed border-gray-200 rounded-xl">
          <FileText className="h-7 w-7 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500">No documents in this room yet. Upload some to start.</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <header className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-900">Cross-document extraction</h3>
            <span className="text-xs text-gray-500">{items.length} {items.length === 1 ? 'doc' : 'docs'}</span>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="results-table">
              <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium">Title</th>
                  <th className="text-left px-4 py-2.5 font-medium">Counterparty</th>
                  <th className="text-left px-4 py-2.5 font-medium">Value</th>
                  <th className="text-left px-4 py-2.5 font-medium">Effective</th>
                  <th className="text-left px-4 py-2.5 font-medium">Expiry</th>
                  <th className="text-left px-4 py-2.5 font-medium">Risk</th>
                  <th className="text-left px-4 py-2.5 font-medium">Status</th>
                  <th className="text-right px-4 py-2.5 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map(d => {
                  const risk = riskBadge(d.riskScore)
                  return (
                    <tr key={d.id} className="hover:bg-gray-50" data-testid={`result-row-${d.id}`}>
                      <td className="px-4 py-2.5 max-w-[260px]">
                        <div className="font-medium text-gray-900 truncate" title={d.title}>{d.title}</div>
                        {d.type && d.type !== 'OTHER' && (
                          <div className="text-[10px] uppercase tracking-wider font-mono text-gray-400 mt-0.5">
                            {d.type}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        {d.counterpartyName ?? <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-xs whitespace-nowrap font-medium text-gray-800 tabular-nums">
                        {formatMoney(d.value, d.currency ?? 'USD')}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-700 whitespace-nowrap">
                        {d.effectiveDate ?? <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-700 whitespace-nowrap">
                        {d.expiryDate ?? <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        {d.riskScore != null ? (
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-xs font-medium border ${risk.tone}`}>
                            {risk.text}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border ${statusBadge(d.analysisStatus)}`}>
                          {d.analysisStatus === 'DONE' && <CheckCircle2 className="h-3 w-3" />}
                          {['ANALYZING', 'PARSING', 'EXTRACTING', 'INDEXING', 'CLASSIFYING', 'SPLITTING'].includes(d.analysisStatus) && (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          )}
                          {d.analysisStatus === 'FAILED' && <AlertTriangle className="h-3 w-3" />}
                          {d.analysisStatus.charAt(0) + d.analysisStatus.slice(1).toLowerCase()}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Link
                          to={`/contracts/${d.id}`}
                          className="inline-flex items-center gap-0.5 text-xs text-violet-600 hover:text-violet-700 font-medium"
                        >
                          Open <ArrowRight className="h-3 w-3" />
                        </Link>
                      </td>
                    </tr>
                  )
                })}
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
  tone: 'violet' | 'emerald' | 'blue'
  icon: React.ComponentType<{ className?: string }>
  animate?: boolean
}) {
  const toneClass = {
    violet:  'text-violet-700 bg-violet-50',
    emerald: 'text-emerald-700 bg-emerald-50',
    blue:    'text-blue-700 bg-blue-50',
  }[tone]
  return (
    <div className="border border-gray-200 rounded-xl p-3 bg-white flex items-center gap-3">
      <div className={`h-9 w-9 rounded-lg flex items-center justify-center ${toneClass}`}>
        <Icon className={`h-4 w-4 ${animate ? 'animate-spin' : ''}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-gray-500">{label}</div>
        <div className="text-2xl font-semibold tabular-nums text-gray-900">{value}</div>
      </div>
    </div>
  )
}
