/**
 * BulkImportDialog (P10D) — drop-zone for CSV import of contracts.
 *
 * Posts the file to /contracts/bulk-import and renders the per-row
 * result summary (total / created / failed) so the user can see
 * exactly which rows took.
 */
import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Upload, X, Loader2, CheckCircle2, AlertCircle, FileText, Download,
} from 'lucide-react'

interface RowResult {
  row:    number
  ok:     boolean
  id?:    string
  title?: string
  error?: string
}

interface ImportResponse {
  total:   number
  created: number
  failed:  number
  results: RowResult[]
}

const SAMPLE_CSV = `title,type,counterpartyName,value,currency,effectiveDate,expiryDate,jurisdiction
Acme Master Services Agreement,MSA,Acme Corp,250000,USD,2026-05-01,2027-04-30,Delaware
SaaSCo Annual License,LICENSE,SaaSCo Ltd,48000,USD,2026-05-15,2027-05-14,California
Brex Mutual NDA,NDA,Brex,,USD,,,
"Project Falcon, SOW #1",SOW,Falcon LLC,80000,USD,2026-06-01,2026-12-31,New York`

export function BulkImportDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [result, setResult] = useState<ImportResponse | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('no file')
      const fd = new FormData()
      fd.append('file', file)
      const r = await api.post('/contracts/bulk-import', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return r.data as ImportResponse
    },
    onSuccess: (data) => {
      setResult(data)
      if (data.failed === 0) onSuccess()
    },
  })

  const downloadSample = () => {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'contracts-import-sample.csv'
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div
      role="dialog"
      aria-label="Bulk import contracts"
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 overflow-auto"
      onClick={onClose}
      data-testid="bulk-import-dialog"
    >
      <div className="bg-card rounded-card max-w-2xl w-full shadow-e3 my-8" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-paper-200 flex items-start justify-between">
          <div>
            <h2 className="text-section text-ink-950 flex items-center gap-2">
              <Upload className="size-4 text-ink-500" />
              Bulk import contracts
            </h2>
            <p className="text-dense text-ink-500 mt-1">
              Upload a CSV with one row per contract. Up to 1,000 rows per file.
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded-chip hover:bg-paper-100 text-ink-400">
            <X className="size-4" />
          </button>
        </div>

        {!result ? (
          <div className="px-6 py-5 space-y-4">
            {/* Drag-active is an interaction state, so it borrows the emerald
                hairline the system already uses for focus — not a "binding" claim. */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
              onDragLeave={(e) => { e.preventDefault(); setDragActive(false) }}
              onDrop={(e) => {
                e.preventDefault(); setDragActive(false)
                const f = e.dataTransfer.files?.[0]
                if (f) setFile(f)
              }}
              data-testid="csv-drop-zone"
              className={`rounded-card border-2 border-dashed p-8 text-center transition-colors ${
                dragActive
                  ? 'border-brand-700 bg-brand-50'
                  : 'border-paper-300 hover:border-ink-400 hover:bg-paper-50'
              }`}
            >
              {file ? (
                <div className="flex items-center justify-center gap-2">
                  <FileText className="size-4 text-ink-500" />
                  <span className="font-medium text-ink-950">{file.name}</span>
                  <span className="text-dense text-ink-500 tabular-nums">({Math.round(file.size / 1024)} KB)</span>
                  <button onClick={() => setFile(null)} className="ml-2 text-dense text-risk-700">remove</button>
                </div>
              ) : (
                <>
                  <Upload className="size-6 text-ink-400 mx-auto mb-2" />
                  <p className="text-body font-semibold text-ink-950 mb-1">Drop a CSV here or click to browse</p>
                  <p className="text-dense text-ink-500 mb-3">
                    Required column: <code className="bg-paper-100 px-1 rounded-chip font-mono">title</code>
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    className="gap-1.5"
                  >
                    <Upload className="size-4" /> Browse
                  </Button>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                hidden
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>

            <div className="text-dense text-ink-500">
              <p className="mb-1">Supported columns:</p>
              <code className="block bg-paper-50 border border-paper-200 rounded-chip px-2 py-1.5 font-mono text-[10.5px] leading-relaxed">
                title (required) · type · status · counterpartyName · value · currency · effectiveDate · expiryDate · jurisdiction
              </code>
              <Button
                variant="link"
                size="xs"
                onClick={downloadSample}
                className="mt-2 h-auto gap-1 px-0"
              >
                <Download className="size-3" /> Download sample CSV
              </Button>
            </div>

            {upload.error && (
              <div className="text-body text-risk-700 bg-risk-50 border border-risk-200 rounded-md px-3 py-2">
                {(upload.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Upload failed.'}
              </div>
            )}
          </div>
        ) : (
          <div className="px-6 py-5">
            <div className="flex items-center gap-3 mb-4">
              {/* An imported row is a contract that now exists — binding, so
                  this is one of the few places emerald is earned. */}
              <div className="size-10 rounded-card bg-brand-50 flex items-center justify-center">
                <CheckCircle2 className="size-5 text-brand-700" />
              </div>
              <div>
                <div className="text-section text-ink-950 tabular-nums">
                  Imported {result.created} of {result.total} contracts
                </div>
                {result.failed > 0 && (
                  <div className="text-dense text-risk-700 tabular-nums">{result.failed} row(s) failed — see below</div>
                )}
              </div>
            </div>

            <div className="bg-card border border-paper-200 rounded-card overflow-hidden max-h-72 overflow-y-auto">
              <table className="w-full text-dense" data-testid="bulk-import-results">
                <thead className="bg-paper-50 text-ink-400 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.09em] w-12">Row</th>
                    <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.09em]">Title / Error</th>
                    <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.09em] w-20">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-paper-100">
                  {result.results.map(r => (
                    <tr key={r.row}>
                      <td className="px-3 py-2 text-ink-500 tabular-nums">{r.row}</td>
                      <td className="px-3 py-2">
                        {r.ok ? (
                          <span className="text-ink-950">{r.title}</span>
                        ) : (
                          <span className="text-risk-700">{r.title ?? '—'} — {r.error}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {r.ok ? (
                          <span className="inline-flex items-center gap-1 text-brand-700">
                            <CheckCircle2 className="size-3" /> created
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-risk-700">
                            <AlertCircle className="size-3" /> failed
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="px-6 py-4 border-t border-paper-200 flex justify-end gap-2 bg-paper-50 rounded-b-card">
          {!result ? (
            <>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button
                onClick={() => upload.mutate()}
                disabled={!file || upload.isPending}
                data-testid="bulk-import-confirm"
              >
                {upload.isPending ? (
                  <><Loader2 className="size-4 animate-spin mr-1" /> Importing…</>
                ) : (
                  <><Upload className="size-4 mr-1" /> Import CSV</>
                )}
              </Button>
            </>
          ) : (
            <Button onClick={() => { onClose(); setResult(null); setFile(null) }}>Done</Button>
          )}
        </div>
      </div>
    </div>
  )
}
