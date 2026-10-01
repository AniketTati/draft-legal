/**
 * ImportWizard (docs/39 A16) — contracts from a spreadsheet and their
 * documents, in one import.
 *
 *   1 Files    — a CSV or Excel sheet of the contracts, their documents, or both
 *   2 Columns  — where each column goes (any field), how many of its cells read
 *                as that field, and a type or status column's words as the
 *                app's own types and statuses
 *   3 Review   — which document goes with which row, what will be left out
 *   then the import — rows a chunk at a time, each document after its row —
 *   and what was left out, and why.
 *
 * Values from the sheet are saved as Imported: an analysis of the document
 * never replaces them; where the AI reads otherwise, its reading waits
 * beside the value in the Review Queue. Replaces BulkImportDialog (a CSV of
 * nine fixed columns, no documents, a type list of its own).
 */
import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, CheckCircle2, Download, FileSpreadsheet, FileText, Loader2, Upload, X,
} from 'lucide-react'
import {
  CONTRACT_TYPE_LABELS, ContractType, IMPORT_TARGET_LABELS, IMPORTABLE_STATUSES, readContractStatus,
  type CatalogField, type ImportTarget,
} from '@clm/types'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useFieldCatalog, catalogSections, typesOf } from '@/lib/field-catalog'
import { useOrgDateOrder } from '@/lib/org-date-order'
import { statusMeta } from '@/lib/status'
import { errorDetail } from './FieldsPanel'
import {
  SAMPLE_CSV, chunks, distinctValues, isDocumentFile, isSheetFile, matchDocuments, readColumn, statusValuesOf, typeValuesOf,
  type ImportRowResult, type SheetRead,
} from '@/lib/contract-import'

type Step = 'files' | 'columns' | 'review' | 'importing' | 'done'

/** Rows per request (the API takes up to 100); documents uploaded at once. */
const ROWS_PER_REQUEST = 50
const PARALLEL_UPLOADS = 2
/** The most rows one import makes (the sheet says how many more it has). */
const MAX_ROWS = 1000

const OWN_KINDS = ['title', 'type', 'status', 'file', 'owner'] as const
const targetKey = (t: ImportTarget | null) => (t ? (t.kind === 'field' ? `field:${t.key}` : t.kind) : '')
const targetOf = (key: string): ImportTarget | null =>
  !key ? null : key.startsWith('field:') ? { kind: 'field', key: key.slice(6) } : { kind: key as (typeof OWN_KINDS)[number] }
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`
const sizeOf = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

interface Progress {
  batch: string | null
  rowsDone: number
  rowsTotal: number
  docsDone: number
  docsTotal: number
  current?: string
  results: ImportRowResult[]
  docErrors: Array<{ file: string; error: string }>
}

export function ImportWizard({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const dateOrder = useOrgDateOrder()
  const { data: catalog = [] } = useFieldCatalog()
  const fileInput = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<Step>('files')
  const [dragActive, setDragActive] = useState(false)
  const [sheet, setSheet] = useState<SheetRead | null>(null)
  const [sheetFile, setSheetFile] = useState<string | null>(null)
  const [sheetError, setSheetError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [docs, setDocs] = useState<File[]>([])
  const [ignored, setIgnored] = useState<string[]>([])
  const [mapping, setMapping] = useState<Array<ImportTarget | null>>([])
  const [typeChoice, setTypeChoice] = useState<Record<string, string>>({})
  const [statusChoice, setStatusChoice] = useState<Record<string, string>>({})
  const [signed, setSigned] = useState(true)
  const [progress, setProgress] = useState<Progress | null>(null)

  const fieldOf = (key: string): CatalogField | undefined => catalog.find(f => f.key === key)
  const rows = useMemo(() => (sheet?.rows ?? []).slice(0, MAX_ROWS), [sheet])
  const col = (kind: string) => mapping.findIndex(t => t?.kind === kind)
  const typeCol = col('type')
  const statusCol = col('status')
  const titleCol = col('title')
  const docNames = useMemo(() => docs.map(d => d.name), [docs])
  const match = useMemo(() => matchDocuments(rows, mapping, docNames), [rows, mapping, docNames])
  const typeValues = useMemo(() => ({ ...(typeCol >= 0 ? typeValuesOf(rows, typeCol) : {}), ...typeChoice }), [rows, typeCol, typeChoice])
  const statusValues = useMemo(() => ({ ...(statusCol >= 0 ? statusValuesOf(rows, statusCol) : {}), ...statusChoice }), [rows, statusCol, statusChoice])
  /** Rows with neither a title nor a document to name them by: left out. */
  const untitled = useMemo(() => rows.map((r, i) => (!(titleCol >= 0 && r[titleCol]?.trim()) && !match.fileOf[i] ? i : -1)).filter(i => i >= 0), [rows, titleCol, match])
  const importable = rows.length - untitled.length
  const withDocs = match.fileOf.filter(Boolean).length
  const contractsToMake = importable + (sheet ? match.unmatched.length : docs.length)

  // ── Files ───────────────────────────────────────────────────────────────
  const readSheet = async (file: File) => {
    setReading(true)
    setSheetError(null)
    setSheetFile(file.name)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = (await api.post<SheetRead>('/contracts/import/read', fd, { headers: { 'Content-Type': 'multipart/form-data' } })).data
      setSheet(r)
      setMapping(r.suggestions)
      setTypeChoice({})
      setStatusChoice({})
    } catch (err) {
      setSheet(null)
      setSheetError(errorDetail(err))
    } finally {
      setReading(false)
    }
  }
  const addFiles = (list: FileList | File[] | null) => {
    const files = Array.from(list ?? [])
    const sheets = files.filter(f => isSheetFile(f.name))
    const documents = files.filter(f => isDocumentFile(f.name))
    setIgnored(files.filter(f => !isSheetFile(f.name) && !isDocumentFile(f.name)).map(f => f.name))
    if (documents.length) setDocs(d => [...d, ...documents.filter(f => !d.some(x => x.name === f.name))])
    if (sheets.length) void readSheet(sheets[0])
  }
  const downloadSample = () => {
    const url = URL.createObjectURL(new Blob([SAMPLE_CSV], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'contracts-import-sample.csv'
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  // ── Import ──────────────────────────────────────────────────────────────
  const runImport = async () => {
    setStep('importing')
    const byName = new Map(docs.map(d => [d.name, d]))
    const plan = {
      headers: sheet?.headers ?? [],
      mapping: sheet ? mapping : [],
      typeValues: sheet ? typeValues : undefined,
      statusValues: sheet ? statusValues : undefined,
      defaultStatus: signed ? 'EXECUTED' : 'DRAFT',
    }
    const entries = [
      ...rows.map((r, i) => ({ row: i + 2, cells: r, file: match.fileOf[i] })).filter((_, i) => !untitled.includes(i)),
      // Documents no row names: a contract each, named by its file.
      ...(sheet ? match.unmatched : docNames).map(file => ({ row: 0, cells: [] as string[], file })),
    ]
    const state: Progress = { batch: null, rowsDone: 0, rowsTotal: entries.length, docsDone: 0, docsTotal: 0, results: [], docErrors: [] }
    const show = () => setProgress({ ...state, results: [...state.results], docErrors: [...state.docErrors] })
    show()
    for (const part of chunks(entries, ROWS_PER_REQUEST)) {
      try {
        const r = (await api.post<{ batch: string; results: ImportRowResult[] }>('/contracts/import', { plan, rows: part, ...(state.batch && { batch: state.batch }) })).data
        state.batch = r.batch
        state.results.push(...r.results)
      } catch (err) {
        state.results.push(...part.map(p => ({ row: p.row, ok: false, title: p.file ?? undefined, issues: [], error: errorDetail(err) })))
      }
      state.rowsDone += part.length
      show()
    }
    // Each document after its row: then read by the AI like any upload.
    const uploads = state.results.filter(r => r.ok && r.contractId && r.file && byName.has(r.file))
    state.docsTotal = uploads.length
    show()
    let next = 0
    const worker = async () => {
      for (let i = next++; i < uploads.length; i = next++) {
        const u = uploads[i]
        state.current = u.file!
        show()
        try {
          const fd = new FormData()
          fd.append('file', byName.get(u.file!)!)
          await api.post(`/contracts/${u.contractId}/import-document`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
        } catch (err) {
          state.docErrors.push({ file: u.file!, error: errorDetail(err) })
        }
        state.docsDone++
        show()
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL_UPLOADS, uploads.length) }, worker))
    state.current = undefined
    show()
    qc.invalidateQueries({ queryKey: ['contracts'] })
    onImported()
    setStep('done')
  }

  // ── Screens ─────────────────────────────────────────────────────────────
  const busy = step === 'importing'
  const canNext = step === 'files'
    ? !reading && (!!sheet || docs.length > 0)
    : step === 'columns'
      ? titleCol >= 0 || col('file') >= 0
      : contractsToMake > 0

  return (
    <div role="dialog" aria-label="Import contracts" aria-modal="true"
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 overflow-auto"
      onClick={() => { if (!busy) onClose() }} data-testid="import-wizard">
      {/* Its own body scrolls: the dialog (with the overlay's padding) never outgrows the window, so the header and buttons stay put. */}
      <div className="bg-card rounded-card max-w-3xl w-full shadow-e3 my-4 flex flex-col max-h-[calc(100vh-4rem)]" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-paper-200 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-section text-ink-950 flex items-center gap-2"><Upload className="size-4 text-ink-500" /> Import contracts</h2>
            <p className="text-dense text-ink-500 mt-1">
              {step === 'files' && 'A spreadsheet of your contracts — one row each — and their documents. Either on its own works too.'}
              {step === 'columns' && 'Where each column goes. Every cell is saved as the contract’s value, marked Imported.'}
              {step === 'review' && 'What the import will make. Nothing is saved until you import.'}
              {step === 'importing' && 'Keep this open until the import finishes.'}
              {step === 'done' && 'The import is done.'}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {sheet && step !== 'done' && step !== 'importing' && (
              <ol className="hidden sm:flex items-center gap-1.5 text-[11px] text-ink-400" aria-label="Steps">
                {(['files', 'columns', 'review'] as const).map((s, i) => (
                  <li key={s} className={cn('px-1.5 py-0.5 rounded-chip', step === s && 'bg-ink-950 text-white')}>{i + 1} {s === 'files' ? 'Files' : s === 'columns' ? 'Columns' : 'Review'}</li>
                ))}
              </ol>
            )}
            <button type="button" onClick={onClose} disabled={busy} className="p-1 rounded-chip hover:bg-paper-100 text-ink-400 disabled:opacity-40" aria-label="Close">
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="px-6 py-5 overflow-y-auto flex-1 min-h-0">
          {step === 'files' && (
            <div className="space-y-4">
              <div
                onDragOver={e => { e.preventDefault(); setDragActive(true) }}
                onDragLeave={e => { e.preventDefault(); setDragActive(false) }}
                onDrop={e => { e.preventDefault(); setDragActive(false); addFiles(e.dataTransfer.files) }}
                className={cn('rounded-card border-2 border-dashed p-6 text-center transition-colors', dragActive ? 'border-ink-950 bg-paper-100' : 'border-paper-300 hover:border-ink-400 hover:bg-paper-50')}
                data-testid="import-drop-zone"
              >
                <Upload className="size-6 text-ink-400 mx-auto mb-2" />
                <p className="text-body font-semibold text-ink-950 mb-1">Drop the spreadsheet and the documents here</p>
                <p className="text-dense text-ink-500 mb-3">Spreadsheet: CSV or Excel (.xlsx) · Documents: PDF, Word, or scans (PNG, JPG, TIFF)</p>
                <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()} className="gap-1.5" data-testid="import-browse">
                  <Upload className="size-4" /> Choose files
                </Button>
                <input ref={fileInput} type="file" multiple hidden accept=".csv,.tsv,.xlsx,.pdf,.docx,.doc,.txt,.png,.jpg,.jpeg,.tif,.tiff"
                  onChange={e => { addFiles(e.target.files); e.target.value = '' }} data-testid="import-file-input" />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-card border border-paper-200 p-3" data-testid="import-sheet-card">
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-400 mb-1.5">Spreadsheet</p>
                  {reading ? (
                    <p className="text-dense text-ink-700 flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" /> Reading {sheetFile}…</p>
                  ) : sheet ? (
                    <div className="flex items-start gap-2">
                      <FileSpreadsheet className="size-4 text-ink-500 mt-0.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-dense font-medium text-ink-950 truncate" title={sheet.filename}>{sheet.filename}</p>
                        <p className="text-[11.5px] text-ink-500">
                          {plural(sheet.total, 'row')} · {plural(sheet.headers.length, 'column')}{sheet.sheetName ? ` · sheet “${sheet.sheetName}”` : ''}
                        </p>
                        {sheet.total > MAX_ROWS && <p className="text-[11.5px] text-attention-700 mt-0.5">The first {MAX_ROWS.toLocaleString()} rows are imported: split the rest into another sheet.</p>}
                      </div>
                      <button type="button" className="text-[11.5px] text-ink-500 hover:text-risk-700" onClick={() => { setSheet(null); setSheetFile(null); setMapping([]) }}>Remove</button>
                    </div>
                  ) : sheetError ? (
                    <p className="text-dense text-risk-700 flex items-start gap-1.5" data-testid="import-sheet-error"><AlertTriangle className="size-3.5 mt-0.5 shrink-0" /> {sheetFile}: {sheetError}</p>
                  ) : (
                    <p className="text-dense text-ink-500">None — each document becomes a contract on its own, read by the AI.</p>
                  )}
                  {!sheet && !reading && (
                    <Button variant="link" size="xs" onClick={downloadSample} className="mt-1 h-auto gap-1 px-0"><Download className="size-3" /> A sample spreadsheet</Button>
                  )}
                </div>
                <div className="rounded-card border border-paper-200 p-3" data-testid="import-docs-card">
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-400 mb-1.5">Documents</p>
                  {docs.length ? (
                    <>
                      <p className="text-dense font-medium text-ink-950 flex items-center gap-1.5">
                        <FileText className="size-4 text-ink-500" /> {plural(docs.length, 'document')}
                        <span className="text-[11.5px] font-normal text-ink-500">· {sizeOf(docs.reduce((n, d) => n + d.size, 0))}</span>
                      </p>
                      <ul className="mt-1.5 max-h-28 overflow-y-auto text-[11.5px] text-ink-700 space-y-0.5">
                        {docs.map(d => (
                          <li key={d.name} className="flex items-center gap-2">
                            <span className="truncate flex-1" title={d.name}>{d.name}</span>
                            <button type="button" className="text-ink-400 hover:text-risk-700" aria-label={`Remove ${d.name}`} onClick={() => setDocs(ds => ds.filter(x => x !== d))}><X className="size-3" /></button>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="text-dense text-ink-500">None — the rows are imported as records, without a document.</p>
                  )}
                </div>
              </div>
              {ignored.length > 0 && (
                <p className="text-[11.5px] text-attention-700">Left out, not a spreadsheet or a document: {ignored.join(', ')}</p>
              )}
            </div>
          )}

          {step === 'columns' && sheet && (
            <ColumnsStep
              sheet={sheet} rows={rows} mapping={mapping} setMapping={setMapping} catalog={catalog} fieldOf={fieldOf} dateOrder={dateOrder}
              typeCol={typeCol} statusCol={statusCol} typeValues={typeValues} statusValues={statusValues}
              setType={(v, t) => setTypeChoice(c => ({ ...c, [v]: t }))} setStatus={(v, s) => setStatusChoice(c => ({ ...c, [v]: s }))}
              signed={signed} setSigned={setSigned} hasDocs={docs.length > 0}
            />
          )}

          {step === 'review' && (
            <div className="space-y-4" data-testid="import-review">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Figure label="Contracts to make" value={contractsToMake} />
                {sheet && <Figure label="Rows with their document" value={withDocs} />}
                {sheet && <Figure label="Rows without one" value={importable - withDocs} />}
                {docs.length > 0 && <Figure label={sheet ? 'Documents on their own' : 'Documents'} value={sheet ? match.unmatched.length : docs.length} />}
              </div>
              {docs.length > 0 && (
                <p className="text-dense text-ink-700">
                  Each document is read by the AI once its contract is made.{sheet && ' A value your sheet gives stays the contract’s; where the AI reads the document differently, its reading waits beside it in the Review Queue.'}
                </p>
              )}
              {!sheet && <p className="text-dense text-ink-700">Contracts are {signed ? 'marked signed' : 'drafts'} (<button type="button" className="underline underline-offset-2" onClick={() => setSigned(s => !s)}>make them {signed ? 'drafts' : 'signed'}</button>), named by their file.</p>}
              {untitled.length > 0 && (
                <Note tone="risk">{plural(untitled.length, 'row')} {untitled.length === 1 ? 'has' : 'have'} no title and no document to name {untitled.length === 1 ? 'it' : 'them'} by — left out: row {untitled.slice(0, 8).map(i => i + 2).join(', ')}{untitled.length > 8 ? '…' : ''}.</Note>
              )}
              {match.missing.length > 0 && (
                <Note tone="attention">{plural(match.missing.length, 'row')} {match.missing.length === 1 ? 'names a document' : 'name documents'} that {match.missing.length === 1 ? 'isn’t' : 'aren’t'} among the files — imported without: row {match.missing.slice(0, 8).map(i => i + 2).join(', ')}{match.missing.length > 8 ? '…' : ''}.</Note>
              )}
              {sheet && <UnreadableSummary rows={rows} mapping={mapping} fieldOf={fieldOf} dateOrder={dateOrder} />}
              {sheet && match.unmatched.length > 0 && (
                <details className="text-dense">
                  <summary className="cursor-pointer text-ink-700">{plural(match.unmatched.length, 'document')} no row names — each imported on its own</summary>
                  <ul className="mt-1.5 ml-4 list-disc text-[11.5px] text-ink-500">{match.unmatched.map(f => <li key={f}>{f}</li>)}</ul>
                </details>
              )}
              {sheet && withDocs > 0 && (
                <details className="text-dense">
                  <summary className="cursor-pointer text-ink-700">Which document goes with which row</summary>
                  <table className="mt-2 w-full text-[11.5px]">
                    <tbody className="divide-y divide-paper-100">
                      {rows.map((r, i) => match.fileOf[i] && (
                        <tr key={i}><td className="py-1 pr-3 text-ink-400 tabular-nums">{i + 2}</td><td className="py-1 pr-3 text-ink-950">{titleCol >= 0 ? r[titleCol] : ''}</td><td className="py-1 text-ink-500">{match.fileOf[i]}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </div>
          )}

          {step === 'importing' && progress && (
            <div className="space-y-4 py-4" data-testid="import-progress">
              <Bar label="Making contracts" done={progress.rowsDone} total={progress.rowsTotal} />
              {progress.docsTotal > 0 && <Bar label={`Uploading documents${progress.current ? ` — ${progress.current}` : ''}`} done={progress.docsDone} total={progress.docsTotal} />}
            </div>
          )}

          {step === 'done' && progress && <DoneStep progress={progress} />}
        </div>

        <div className="px-6 py-4 border-t border-paper-200 flex items-center justify-end gap-2 bg-paper-50 rounded-b-card">
          {step === 'files' && <>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button disabled={!canNext} onClick={() => setStep(sheet ? 'columns' : 'review')} data-testid="import-next">Next</Button>
          </>}
          {step === 'columns' && <>
            {!canNext && <span className="mr-auto text-[11.5px] text-risk-700">Pick the column with each contract’s title{docs.length ? ', or the one naming its document' : ''}.</span>}
            <Button variant="outline" onClick={() => setStep('files')}>Back</Button>
            <Button disabled={!canNext} onClick={() => setStep('review')} data-testid="import-next">Next</Button>
          </>}
          {step === 'review' && <>
            <Button variant="outline" onClick={() => setStep(sheet ? 'columns' : 'files')}>Back</Button>
            <Button disabled={!canNext} onClick={() => void runImport()} data-testid="import-run">
              <Upload className="size-4 mr-1" /> Import {plural(contractsToMake, 'contract')}
            </Button>
          </>}
          {step === 'done' && <>
            {progress?.batch && (
              <Button variant="outline" onClick={() => { navigate(`/contracts?import=${progress.batch}`); onClose() }} data-testid="import-open">Open the imported contracts</Button>
            )}
            <Button onClick={onClose}>Done</Button>
          </>}
        </div>
      </div>
    </div>
  )
}

// ─── Columns ─────────────────────────────────────────────────────────────────

function ColumnsStep({
  sheet, rows, mapping, setMapping, catalog, fieldOf, dateOrder, typeCol, statusCol, typeValues, statusValues, setType, setStatus, signed, setSigned, hasDocs,
}: {
  sheet: SheetRead
  rows: string[][]
  mapping: Array<ImportTarget | null>
  setMapping: (m: Array<ImportTarget | null>) => void
  catalog: CatalogField[]
  fieldOf: (key: string) => CatalogField | undefined
  dateOrder: 'MDY' | 'DMY'
  typeCol: number
  statusCol: number
  typeValues: Record<string, string>
  statusValues: Record<string, string>
  setType: (value: string, type: string) => void
  setStatus: (value: string, status: string) => void
  signed: boolean
  setSigned: (v: boolean) => void
  hasDocs: boolean
}) {
  const sections = useMemo(() => catalogSections(catalog), [catalog])
  const taken = new Set(mapping.map(targetKey).filter(Boolean))
  const choose = (i: number, key: string) => setMapping(mapping.map((t, j) => (j === i ? targetOf(key) : targetKey(t) === key && key ? null : t)))
  const samples = (i: number) => rows.map(r => r[i]).filter(Boolean).slice(0, 3)

  return (
    <div className="space-y-5" data-testid="import-columns">
      <table className="w-full text-dense">
        <thead className="text-[10px] uppercase tracking-[0.09em] text-ink-400 border-b border-paper-200">
          <tr><th className="text-left py-2 pr-3 font-semibold">Column</th><th className="text-left py-2 pr-3 font-semibold">First values</th><th className="text-left py-2 font-semibold w-[46%]">Import as</th></tr>
        </thead>
        <tbody className="divide-y divide-paper-100">
          {sheet.headers.map((h, i) => {
            const t = mapping[i] ?? null
            const field = t?.kind === 'field' ? fieldOf(t.key) : undefined
            const reading = t && t.kind !== 'title' && t.kind !== 'file' ? readColumn(rows, i, t, field, dateOrder) : null
            return (
              <tr key={i} data-testid={`import-column-${i}`}>
                <td className="py-2 pr-3 align-top font-medium text-ink-950 max-w-[160px] truncate" title={h}>{h}</td>
                <td className="py-2 pr-3 align-top text-[11.5px] text-ink-500 max-w-[200px]"><span className="line-clamp-2">{samples(i).join(' · ') || '—'}</span></td>
                <td className="py-2 align-top">
                  <select value={targetKey(t)} onChange={e => choose(i, e.target.value)} aria-label={`Import “${h}” as`}
                    className={cn('h-8 w-full rounded-md border border-input bg-card px-2 text-[12.5px]', !t && 'text-ink-400')} data-testid={`import-target-${i}`}>
                    <option value="">Don’t import</option>
                    <optgroup label="The contract">
                      {OWN_KINDS.map(k => <option key={k} value={k}>{IMPORT_TARGET_LABELS[k]}{taken.has(k) && targetKey(t) !== k ? ' (moves here)' : ''}</option>)}
                    </optgroup>
                    {sections.map(s => (
                      <optgroup key={s.title} label={s.title}>
                        {s.fields.map(f => (
                          <option key={f.key} value={`field:${f.key}`}>{f.label}{typesOf(f) ? ` — ${typesOf(f)}` : ''}{taken.has(`field:${f.key}`) && targetKey(t) !== `field:${f.key}` ? ' (moves here)' : ''}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {reading && reading.filled > 0 && (
                    <p className={cn('mt-1 text-[11px]', reading.read === reading.filled ? 'text-ink-500' : 'text-attention-700')} data-testid={`import-reading-${i}`}>
                      {reading.read === reading.filled
                        ? `All ${plural(reading.filled, 'value')} read`
                        : `${reading.read} of ${reading.filled} read · ${t?.kind === 'type' || t?.kind === 'status' ? 'set the others below' : `can’t read ${reading.unreadable.map(u => `“${u}”`).join(', ')}${reading.filled - reading.read > reading.unreadable.length ? '…' : ''} — left empty`}`}
                    </p>
                  )}
                  {field?.contractTypes && <p className="mt-1 text-[11px] text-ink-500">Kept for {typesOf(field)} contracts only.</p>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {typeCol >= 0 && (
        <ValueMap
          title="The sheet’s contract types" rows={rows} col={typeCol} values={typeValues} onChange={setType}
          options={Object.values(ContractType).map(t => ({ value: t, label: CONTRACT_TYPE_LABELS[t] }))}
          testid="import-type-values"
        />
      )}
      {statusCol >= 0 && (
        <ValueMap
          title="The sheet’s statuses" rows={rows} col={statusCol} values={statusValues} onChange={setStatus}
          options={IMPORTABLE_STATUSES.map(s => ({ value: s, label: statusMeta(s).label }))}
          note={v => (readContractStatus(v)?.workflow ? 'Only an approval sets this: pick what these contracts are.' : null)}
          testid="import-status-values"
        />
      )}
      <div className="flex items-center gap-3 text-dense text-ink-700" data-testid="import-default-status">
        <span>{statusCol >= 0 ? 'Rows without a status are' : 'The contracts are'}</span>
        <div className="inline-flex rounded-md border border-input overflow-hidden" role="radiogroup" aria-label="Status of contracts without one">
          {([[true, 'Signed'], [false, 'Drafts']] as const).map(([v, label]) => (
            <button key={label} type="button" role="radio" aria-checked={signed === v} onClick={() => setSigned(v)}
              className={cn('px-2.5 h-7 text-[12px] border-r border-input last:border-r-0', signed === v ? 'bg-ink-950 text-white' : 'bg-card text-ink-700 hover:bg-paper-100')}>
              {label}
            </button>
          ))}
        </div>
        {!hasDocs && mapping.every(t => t?.kind !== 'file') && <span className="text-[11.5px] text-ink-500">No documents: the rows are records the AI has nothing to read in.</span>}
      </div>
    </div>
  )
}

function ValueMap({ title, rows, col, values, onChange, options, note, testid }: {
  title: string
  rows: string[][]
  col: number
  values: Record<string, string>
  onChange: (value: string, to: string) => void
  options: Array<{ value: string; label: string }>
  note?: (value: string) => string | null
  testid: string
}) {
  const distinct = distinctValues(rows, col)
  return (
    <div data-testid={testid}>
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-400 mb-1.5">{title}</p>
      <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {distinct.map(({ value, count }) => (
          <label key={value} className="flex items-center gap-2 text-dense">
            <span className="min-w-0 flex-1 truncate text-ink-950" title={value}>{value} <span className="text-[11px] text-ink-400">×{count}</span></span>
            <span className="text-ink-400">→</span>
            <select value={values[value] ?? ''} onChange={e => onChange(value, e.target.value)} aria-label={`${value} is`}
              className="h-7 rounded-md border border-input bg-card px-1.5 text-[12px] w-40">
              {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {note?.(value) && <span className="sr-only">{note(value)}</span>}
          </label>
        ))}
      </div>
      {distinct.some(d => note?.(d.value)) && (
        <p className="mt-1.5 text-[11px] text-attention-700">{distinct.filter(d => note?.(d.value)).map(d => `“${d.value}”`).join(', ')}: only an approval sets {distinct.filter(d => note?.(d.value)).length === 1 ? 'it' : 'these'} — pick what these contracts are.</p>
      )}
    </div>
  )
}

// ─── Review and done ─────────────────────────────────────────────────────────

function UnreadableSummary({ rows, mapping, fieldOf, dateOrder }: {
  rows: string[][]; mapping: Array<ImportTarget | null>; fieldOf: (k: string) => CatalogField | undefined; dateOrder: 'MDY' | 'DMY'
}) {
  const lines = mapping.flatMap((t, i) => {
    if (t?.kind !== 'field' && t?.kind !== 'owner') return []
    const field = t.kind === 'field' ? fieldOf(t.key) : undefined
    const r = readColumn(rows, i, t, field, dateOrder)
    const bad = r.filled - r.read
    if (!bad) return []
    const name = t.kind === 'owner' ? 'Owner' : field?.label ?? t.key
    return [`${name}: ${plural(bad, 'value')} can’t be read (${r.unreadable.map(u => `“${u}”`).join(', ')}${bad > r.unreadable.length ? '…' : ''})${t.kind === 'owner' ? ' — you own those' : ' — left empty'}.`]
  })
  if (!lines.length) return null
  return <Note tone="attention">{lines.map(l => <span key={l} className="block">{l}</span>)}</Note>
}

function DoneStep({ progress }: { progress: Progress }) {
  const made = progress.results.filter(r => r.ok)
  const failed = progress.results.filter(r => !r.ok)
  const withIssues = made.filter(r => r.issues.length)
  const uploaded = progress.docsTotal - progress.docErrors.length
  return (
    <div className="space-y-4" data-testid="import-done">
      <div className="flex items-center gap-3">
        <div className="size-10 rounded-card bg-brand-50 flex items-center justify-center"><CheckCircle2 className="size-5 text-brand-700" /></div>
        <div>
          <p className="text-section text-ink-950 tabular-nums">Imported {plural(made.length, 'contract')}</p>
          {failed.length > 0 && <p className="text-dense text-risk-700 tabular-nums">{plural(failed.length, 'row')} couldn’t be — see below</p>}
        </div>
      </div>
      {uploaded > 0 && (
        <p className="text-dense text-ink-700">
          {plural(uploaded, 'document')} {uploaded === 1 ? 'is' : 'are'} being read by the AI. Where it reads a value differently from your sheet, the sheet’s value stays and the AI’s waits beside it in the Review Queue.
        </p>
      )}
      {progress.docErrors.length > 0 && (
        <Note tone="risk">
          {plural(progress.docErrors.length, 'document')} couldn’t be uploaded — {progress.docErrors.length === 1 ? 'its contract is' : 'their contracts are'} imported without {progress.docErrors.length === 1 ? 'it' : 'them'}:
          {progress.docErrors.map(d => <span key={d.file} className="block">{d.file}: {d.error}</span>)}
        </Note>
      )}
      {(failed.length > 0 || withIssues.length > 0) && (
        <div className="border border-paper-200 rounded-card overflow-hidden max-h-72 overflow-y-auto">
          <table className="w-full text-dense" data-testid="import-results">
            <thead className="bg-paper-50 text-ink-400 sticky top-0">
              <tr>
                <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.09em] w-14">Row</th>
                <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.09em]">Contract</th>
                <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.09em]">What happened</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-100">
              {[...failed, ...withIssues].map(r => (
                <tr key={`${r.row}-${r.file ?? r.title ?? ''}`}>
                  <td className="px-3 py-2 align-top text-ink-500 tabular-nums">{r.row || '—'}</td>
                  <td className="px-3 py-2 align-top text-ink-950">{r.title ?? r.file ?? '—'}</td>
                  <td className={cn('px-3 py-2 align-top text-[11.5px]', r.ok ? 'text-attention-800' : 'text-risk-700')}>
                    {r.ok ? r.issues.map(x => <span key={x} className="block">{x}</span>) : r.error}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card border border-paper-200 px-3 py-2">
      <p className="text-[11px] text-ink-500">{label}</p>
      <p className="text-[20px] font-semibold tracking-[-0.02em] tabular-nums text-ink-950">{value.toLocaleString()}</p>
    </div>
  )
}

function Note({ tone, children }: { tone: 'risk' | 'attention'; children: React.ReactNode }) {
  return (
    <div className={cn('flex gap-2 rounded-md border px-3 py-2 text-dense', tone === 'risk' ? 'bg-risk-50 border-risk-200 text-risk-800' : 'bg-attention-50 border-attention-200 text-attention-800')}>
      <AlertTriangle className="size-4 shrink-0 mt-0.5" />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function Bar({ label, done, total }: { label: string; done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <div>
      <div className="flex items-center justify-between text-dense mb-1.5">
        <span className="text-ink-700 truncate">{label}</span>
        <span className="text-ink-500 tabular-nums shrink-0 ml-3">{done.toLocaleString()} of {total.toLocaleString()}</span>
      </div>
      <div className="h-2 rounded-full bg-paper-100 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full bg-ink-950 transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
