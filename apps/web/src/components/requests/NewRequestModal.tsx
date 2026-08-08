import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { X, Loader2, Paperclip, FileText, CheckCircle2 } from 'lucide-react'
import { CounterpartyPicker, type CounterpartySelection } from '@/components/common/CounterpartyPicker'

const CONTRACT_TYPES = [
  { value: 'NDA',              label: 'Non-Disclosure Agreement (NDA)' },
  { value: 'MSA',              label: 'Master Services Agreement (MSA)' },
  { value: 'SOW',              label: 'Statement of Work (SOW)' },
  { value: 'SLA',              label: 'Service Level Agreement (SLA)' },
  { value: 'VENDOR_AGREEMENT', label: 'Vendor / Supplier Agreement' },
  { value: 'EMPLOYMENT',       label: 'Employment Agreement' },
  { value: 'PARTNERSHIP',      label: 'Partnership Agreement' },
  { value: 'LICENSE',          label: 'License Agreement' },
  { value: 'DATA_PROCESSING',  label: 'Data Processing Addendum' },
  { value: 'ORDER_FORM',       label: 'Order Form / Purchase Order' },
  { value: 'OTHER',            label: 'Other / Not sure' },
]

const PRIORITIES = [
  { value: 'LOW',    label: 'Low — no deadline pressure' },
  { value: 'MEDIUM', label: 'Medium — standard request' },
  { value: 'HIGH',   label: 'High — time-sensitive (< 1 week)' },
  { value: 'URGENT', label: 'Urgent — blocking deal / regulatory' },
]

interface Props {
  onClose: () => void
}

export function NewRequestModal({ onClose }: Props) {
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [form, setForm] = useState({
    title:           '',
    type:            'OTHER',
    counterpartyName: '',
    description:     '',
    estimatedValue:  '',
    priority:        'MEDIUM',
  })
  // P7.4.14 / F-56 — typed counterparty selection. We send `counterpartyId`
  // when the user picks an existing row (proper FK link) and fall back to
  // the freetext `counterpartyName` when they're describing something new.
  const [counterparty, setCounterparty] = useState<CounterpartySelection>({ id: null, name: '' })
  const [attachedFile, setAttachedFile] = useState<File | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const create = useMutation({
    mutationFn: () => {
      // P7.4.14 — prefer the linked counterpartyId; fall back to free
      // text. Sends both so existing API code paths keep working
      // unchanged whichever it expects.
      const cpName = counterparty.name || form.counterpartyName || undefined
      const cpId   = counterparty.id || undefined
      if (attachedFile) {
        // Send as multipart so the backend can upload the file to S3
        const fd = new FormData()
        fd.append('body', JSON.stringify({
          title:           form.title,
          type:            form.type,
          counterpartyId:  cpId,
          counterpartyName: cpName,
          description:     form.description,
          estimatedValue:  form.estimatedValue ? Number(form.estimatedValue) : undefined,
          priority:        form.priority,
        }))
        fd.append('file', attachedFile)
        return api.post('/requests', fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
      }
      return api.post('/requests', {
        title:           form.title,
        type:            form.type,
        counterpartyId:  cpId,
        counterpartyName: cpName,
        description:     form.description,
        estimatedValue:  form.estimatedValue ? Number(form.estimatedValue) : undefined,
        priority:        form.priority,
      }).then(r => r.data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requests'] })
      setSubmitted(true)
      setTimeout(onClose, 1500)
    },
  })

  const set = (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [field]: e.target.value }))

  const valid = form.title.trim().length > 0 && form.description.trim().length > 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 backdrop-blur-sm"
      data-testid="new-request-modal"
    >
      <div className="bg-card rounded-card shadow-e3 w-full max-w-lg mx-4 flex flex-col max-h-[90vh]">
        {/* Acknowledgement, not a binding event: a submitted request is SUBMITTED
            in lib/status, which is "turn" — nothing has been approved, signed or
            executed, and the copy itself says the classifier is still running.
            Brand would read as "done", so this stays neutral like every other
            "we heard you" confirmation in the product. */}
        {submitted && (
          <div className="px-6 py-4 bg-paper-100 border-b border-paper-200 flex items-center gap-2 text-ink-950 text-body font-medium">
            <CheckCircle2 className="size-4 text-ink-500" />
            Request submitted! AI is classifying it now.
          </div>
        )}
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-paper-200">
          <div>
            <h2 className="text-section text-ink-950">New Contract Request</h2>
            <p className="text-dense text-ink-500 mt-0.5">AI will classify and extract key terms automatically</p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-paper-100 rounded-md transition-colors">
            <X className="size-4 text-ink-500" />
          </button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {/* Title */}
          <div>
            <label className="block text-dense font-medium text-ink-700 mb-1.5">
              Request title <span className="text-risk-600">*</span>
            </label>
            <Input
              value={form.title}
              onChange={set('title')}
              placeholder="e.g. NDA with Acme Corp for Q2 partnership"
              className="h-9 text-[13px]"
              data-testid="request-title"
            />
          </div>

          {/* Type + Priority row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-dense font-medium text-ink-700 mb-1.5">Contract type</label>
              <select
                value={form.type}
                onChange={set('type')}
                className="w-full h-9 text-[13px] text-ink-950 border border-input rounded-md px-2.5 bg-card focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/12"
              >
                {CONTRACT_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-dense font-medium text-ink-700 mb-1.5">Priority</label>
              <select
                value={form.priority}
                onChange={set('priority')}
                className="w-full h-9 text-[13px] text-ink-950 border border-input rounded-md px-2.5 bg-card focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/12"
              >
                {PRIORITIES.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Counterparty + Value row — P7.4.14 / F-56: typeahead picker
              prevents duplicate counterparty creation by surfacing
              existing rows as the user types. */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-dense font-medium text-ink-700 mb-1.5">Counterparty</label>
              <CounterpartyPicker
                value={counterparty}
                onChange={(sel) => {
                  setCounterparty(sel)
                  // Keep the freetext field in sync for the create payload
                  setForm(f => ({ ...f, counterpartyName: sel.name }))
                }}
                placeholder="Search or create…"
              />
            </div>
            <div>
              <label className="block text-dense font-medium text-ink-700 mb-1.5">Estimated value (USD)</label>
              <Input
                type="number"
                value={form.estimatedValue}
                onChange={set('estimatedValue')}
                placeholder="e.g. 50000"
                className="h-9 text-[13px] tabular-nums"
                min="0"
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-dense font-medium text-ink-700 mb-1.5">
              Description <span className="text-risk-600">*</span>
            </label>
            <textarea
              value={form.description}
              onChange={set('description')}
              placeholder="Describe the purpose, key terms, deadlines, or any special requirements…"
              rows={4}
              className="w-full text-[13px] text-ink-950 border border-input rounded-md px-3 py-2 bg-card resize-none placeholder:text-ink-400 focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/12"
              data-testid="request-description"
            />
          </div>

          {/* Optional document attachment */}
          <div>
            <label className="block text-dense font-medium text-ink-700 mb-1.5">
              Attach document <span className="text-ink-400 font-normal">(optional — PDF or DOCX)</span>
            </label>
            {attachedFile ? (
              // An attached file is a fact about the form, not a state — paper, not info.
              <div className="flex items-center gap-2 px-3 py-2 border border-paper-200 bg-paper-100 rounded-md text-[13px]">
                <FileText className="size-4 text-ink-500 flex-shrink-0" />
                <span className="flex-1 truncate text-ink-950 font-medium">{attachedFile.name}</span>
                <span className="text-[11px] tabular-nums text-ink-500 flex-shrink-0">
                  {(attachedFile.size / 1024 / 1024).toFixed(1)} MB
                </span>
                <button
                  onClick={() => setAttachedFile(null)}
                  className="text-ink-400 hover:text-ink-950 ml-1"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="w-full flex items-center gap-2 px-3 py-2 border border-dashed border-paper-300 rounded-md text-[13px] text-ink-500 hover:border-ink-400 hover:text-ink-950 transition-colors"
              >
                <Paperclip className="size-4" />
                Click to attach a draft contract for AI analysis
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) setAttachedFile(f)
                e.target.value = ''
              }}
            />
          </div>

          {create.isError && (
            <p className="text-dense text-risk-700">Failed to submit request. Please try again.</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-paper-200">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => create.mutate()}
            disabled={!valid || create.isPending}
            data-testid="request-submit"
          >
            {create.isPending ? (
              <><Loader2 className="animate-spin" /> Submitting…</>
            ) : (
              'Submit Request'
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
