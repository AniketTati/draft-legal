/**
 * ArtifactPane — the right-side panel of /agent that hosts assistant
 * outputs richer than a paragraph (U.5.2 / doc 32 §5b + §5c).
 *
 * Five renderer types, all driven off the same Artifact discriminated
 * union so the chat stream just emits one kind:
 *
 *   📄 Doc       — contract draft / summary / advice memo (TipTap-able)
 *   📊 Table     — queue / search results / export (sortable, drill)
 *   ⚖ Diff      — redline / version compare (uses existing DiffViewer)
 *   📝 Form      — pre-filled create-X form with a Save button
 *   🎯 Card      — decision strip with Approve/Reject/Sign + preview
 *
 * Action wiring: every artifact has an `actions` array. Clicking an
 * action posts to the corresponding tool (`save_draft`, `send_for_
 * review`, etc.) and surfaces a toast + closes the artifact when done.
 *
 * Keyboard:
 *   Esc       — closes the artifact pane (chat takes the full width)
 *   ⌘D       — toggles "details" panel inside the artifact (later)
 */
import { useState } from 'react'
import { sanitizeHtml } from '@/lib/sanitize'
import { X, Download, ChevronDown, FileText, Table as TableIcon,
         GitCompareArrows, ListChecks, FormInput, Loader2, Check, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// ─── Artifact types ──────────────────────────────────────────────────

export interface ArtifactAction {
  id: string
  label: string
  variant?: 'primary' | 'secondary' | 'danger'
  /** Tool name to invoke; the parent component does the actual call. */
  tool?: string
  /** When set, clicking opens this URL in the same tab (doesn't run a tool). */
  href?: string
  /**
   * L6 #6 — a purely client-side action, needing neither a URL nor a tool.
   * The three export actions were declared with neither, so every click threw
   * "This action has nothing to apply" and flashed an unlabeled red icon for
   * 2.5s — beside a Download icon that made them look wired. No backend is
   * needed: the rows and columns are already in the browser.
   */
  clientAction?: 'csv' | 'memo'
  /** Free-form payload passed to the tool handler. */
  args?: Record<string, unknown>
}

export interface DocArtifact {
  kind: 'doc'
  id: string
  /**
   * Stable content-based key. Two artifacts with the same dedupeKey
   * are the same logical artifact (just regenerated) and the pane
   * should replace, not append. P61 audit (2026-05-02): without this,
   * a tool that fires twice in a turn produced two near-identical
   * cards in the right pane.
   */
  dedupeKey?: string
  title: string
  subtitle?: string
  /** Sanitized HTML rendered with prose styles. */
  html: string
  actions?: ArtifactAction[]
  /** Optional source citations to pin under the doc body. */
  citations?: Array<{ label: string; href?: string }>
}

export interface TableArtifact<Row = Record<string, unknown>> {
  kind: 'table'
  id: string
  dedupeKey?: string
  title: string
  subtitle?: string
  columns: Array<{ key: string; label: string; align?: 'left' | 'right'; format?: 'text' | 'number' | 'currency' | 'date' | 'pill' }>
  rows: Row[]
  actions?: ArtifactAction[]
  /** When a row is clicked, navigate to this URL with `:id` substituted. */
  rowHref?: string
}

export interface DiffArtifact {
  kind: 'diff'
  id: string
  dedupeKey?: string
  title: string
  subtitle?: string
  /** v1 + v2 plain-text bodies; the renderer computes a unified diff. */
  before: string
  after: string
  actions?: ArtifactAction[]
}

export interface FormArtifact {
  kind: 'form'
  id: string
  dedupeKey?: string
  title: string
  subtitle?: string
  fields: Array<{ key: string; label: string; type: 'text' | 'email' | 'number' | 'select' | 'textarea'; defaultValue?: string; required?: boolean; options?: Array<{ label: string; value: string }> }>
  /** Tool name to call when the user submits; the form's values become args. */
  submitTool: string
  actions?: ArtifactAction[]
}

export interface CardArtifact {
  kind: 'card'
  id: string
  dedupeKey?: string
  title: string
  subtitle?: string
  /** Headline metric / recommendation. */
  headline: string
  /** Supporting bullets shown beneath the headline. */
  details?: string[]
  /** Big-button decision actions — Approve / Reject / Sign / etc. */
  actions: ArtifactAction[]
}

export type Artifact = DocArtifact | TableArtifact | DiffArtifact | FormArtifact | CardArtifact

// ─── Pane shell ──────────────────────────────────────────────────────

export function ArtifactPane({
  artifact,
  onClose,
  onAction,
}: {
  artifact: Artifact
  onClose: () => void
  /** Invoked when an action button is clicked. Parent runs the tool /
   *  navigation; we just show a pending state until done. */
  onAction: (action: ArtifactAction, artifact: Artifact) => Promise<void> | void
}) {
  return (
    <aside
      data-testid="artifact-pane"
      data-artifact-kind={artifact.kind}
      data-artifact-id={artifact.id}
      className="flex-1 flex flex-col min-w-0 bg-paper-50 border-l border-paper-200"
    >
      <ArtifactHeader artifact={artifact} onClose={onClose} />
      <div className="flex-1 overflow-y-auto p-6">
        {artifact.kind === 'doc'   && <DocBody   artifact={artifact} />}
        {artifact.kind === 'table' && <TableBody artifact={artifact} />}
        {artifact.kind === 'diff'  && <DiffBody  artifact={artifact} />}
        {artifact.kind === 'form'  && <FormBody  artifact={artifact} onAction={onAction} />}
        {artifact.kind === 'card'  && <CardBody  artifact={artifact} onAction={onAction} />}
      </div>
      {/* Action bar — bottom of pane. Form + Card render their own
          inline buttons; doc/table/diff use the shared bar. */}
      {(artifact.kind === 'doc' || artifact.kind === 'table' || artifact.kind === 'diff')
        && (artifact.actions ?? []).length > 0 && (
        <div className="bg-card border-t border-paper-200 px-5 py-3 flex items-center gap-2 flex-wrap">
          {(artifact.actions ?? []).map(a => (
            <ActionButton key={a.id} action={a} onAction={a => onAction(a, artifact)} />
          ))}
        </div>
      )}
    </aside>
  )
}

function ArtifactHeader({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const Icon =
    artifact.kind === 'doc'   ? FileText :
    artifact.kind === 'table' ? TableIcon :
    artifact.kind === 'diff'  ? GitCompareArrows :
    artifact.kind === 'form'  ? FormInput :
                                ListChecks
  return (
    <div className="h-14 flex items-center px-5 bg-card border-b border-paper-200 gap-3 shrink-0">
      {/* The one assist mark on this pane: it says the artifact was authored by
          the machine. The document inside it stays neutral. */}
      <div className="size-7 rounded-md bg-assist-50 border border-assist-200 flex items-center justify-center shrink-0">
        <Icon className="size-3.5 text-assist-600" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-ink-950 truncate" data-testid="artifact-title">
          {artifact.title}
        </div>
        {artifact.subtitle && (
          <div className="text-[11px] text-ink-500 truncate">{artifact.subtitle}</div>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        title="Close artifact (Esc)"
        data-testid="artifact-close"
        className="text-ink-400 hover:text-ink-700 p-1 rounded-md hover:bg-paper-100"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}

// ─── Renderers ───────────────────────────────────────────────────────

function DocBody({ artifact }: { artifact: DocArtifact }) {
  return (
    <div className="max-w-3xl mx-auto bg-card border border-paper-200 rounded-card shadow-e1">
      <div
        className="p-10 prose prose-sm max-w-none prose-headings:font-bold prose-headings:text-ink-950"
        // Doc HTML is already sanitized by the agent; we trust it like
        // the existing TipTap renderer does on contract pages.
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(artifact.html) }}
      />
      {artifact.citations && artifact.citations.length > 0 && (
        <div className="px-10 pb-6 pt-2 border-t border-paper-200 mt-4">
          <p className="text-[10px] uppercase tracking-wider text-ink-400 font-semibold mb-2">Sources</p>
          <ul className="space-y-1">
            {artifact.citations.map((c, i) => (
              // Citations point at the document, not at the model — neutral.
              <li key={i} className="text-[12px] text-ink-500">
                {c.href ? (
                  <a href={c.href} className="hover:underline text-ink-950 hover:text-brand-700">{c.label}</a>
                ) : c.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function formatCell(v: unknown, format?: string): string {
  if (v === null || v === undefined) return '—'
  if (format === 'currency' && typeof v === 'number') {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
    if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`
    return `$${v.toLocaleString()}`
  }
  if (format === 'date' && typeof v === 'string') {
    const d = new Date(v); return isNaN(d.getTime()) ? v : d.toLocaleDateString()
  }
  if (format === 'number' && typeof v === 'number') return v.toLocaleString()
  return String(v)
}

function TableBody({ artifact }: { artifact: TableArtifact }) {
  return (
    <div className="max-w-5xl mx-auto bg-card border border-paper-200 rounded-card shadow-e1 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="bg-paper-50 border-b border-paper-200">
            <tr>
              {artifact.columns.map(c => (
                <th
                  key={c.key}
                  className={cn(
                    'px-4 py-2.5 font-semibold text-ink-700 text-[11px] uppercase tracking-wider',
                    c.align === 'right' ? 'text-right' : 'text-left',
                  )}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-paper-100">
            {artifact.rows.length === 0 ? (
              <tr>
                <td colSpan={artifact.columns.length} className="px-4 py-12 text-center text-ink-400 text-[12px]">
                  No rows.
                </td>
              </tr>
            ) : (
              artifact.rows.map((row, i) => {
                const href = artifact.rowHref
                  ? artifact.rowHref.replace(':id', String((row as Record<string, unknown>).id ?? ''))
                  : undefined
                const Cell = href ? 'a' : 'div'
                return (
                  <tr key={i} className={href ? 'hover:bg-paper-50 cursor-pointer' : ''}>
                    {artifact.columns.map(c => (
                      <td
                        key={c.key}
                        className={cn(
                          'px-4 py-2.5 text-ink-700',
                          c.align === 'right' ? 'text-right tabular-nums' : '',
                        )}
                      >
                        <Cell {...(href ? { href } : {})}>
                          {formatCell((row as Record<string, unknown>)[c.key], c.format)}
                        </Cell>
                      </td>
                    ))}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 border-t border-paper-200 text-[11px] text-ink-500 flex items-center justify-between">
        <span className="tabular-nums">{artifact.rows.length} {artifact.rows.length === 1 ? 'row' : 'rows'}</span>
      </div>
    </div>
  )
}

function DiffBody({ artifact }: { artifact: DiffArtifact }) {
  // Simple line-by-line diff. For richer markup, swap in DiffViewer
  // (already in apps/web/src/components/contracts/DiffViewer.tsx).
  const beforeLines = artifact.before.split('\n')
  const afterLines = artifact.after.split('\n')
  const max = Math.max(beforeLines.length, afterLines.length)
  return (
    <div className="max-w-5xl mx-auto bg-card border border-paper-200 rounded-card shadow-e1 overflow-hidden">
      <div className="grid grid-cols-2 text-[12px] font-mono">
        <div className="border-r border-paper-200">
          <div className="px-3 py-1.5 bg-risk-50 text-risk-700 text-[10px] font-semibold uppercase tracking-wider border-b border-risk-200">Before</div>
          <pre className="p-3 whitespace-pre-wrap text-ink-700 leading-relaxed">
            {beforeLines.slice(0, max).map((l, i) => (
              <div key={i} className={l !== afterLines[i] ? 'bg-risk-50' : ''}>{l || ' '}</div>
            ))}
          </pre>
        </div>
        <div>
          <div className="px-3 py-1.5 bg-brand-50 text-brand-700 text-[10px] font-semibold uppercase tracking-wider border-b border-brand-200">After</div>
          <pre className="p-3 whitespace-pre-wrap text-ink-700 leading-relaxed">
            {afterLines.slice(0, max).map((l, i) => (
              <div key={i} className={l !== beforeLines[i] ? 'bg-brand-50' : ''}>{l || ' '}</div>
            ))}
          </pre>
        </div>
      </div>
    </div>
  )
}

/** Field treatment lifted from ui/input.tsx — same border, same emerald focus. */
const FIELD_CLS =
  'w-full text-[13px] text-ink-950 bg-card border border-input rounded-md px-3 transition-colors ' +
  'placeholder:text-ink-400 focus-visible:outline-none focus-visible:border-brand-700 ' +
  'focus-visible:ring-[3px] focus-visible:ring-brand-700/12'

function FormBody({ artifact, onAction }: { artifact: FormArtifact; onAction: (a: ArtifactAction, art: Artifact) => Promise<void> | void }) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const f of artifact.fields) init[f.key] = f.defaultValue ?? ''
    return init
  })
  const [submitting, setSubmitting] = useState(false)
  const submit = async () => {
    setSubmitting(true)
    try {
      await onAction({ id: 'submit', label: 'Submit', tool: artifact.submitTool, args: values, variant: 'primary' }, artifact)
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div className="max-w-2xl mx-auto bg-card border border-paper-200 rounded-card shadow-e1">
      <div className="p-6 space-y-4">
        {artifact.fields.map(f => (
          <div key={f.key}>
            <label className="block text-[11.5px] font-medium text-ink-700 mb-1">
              {f.label}{f.required && <span className="text-risk-600 ml-0.5">*</span>}
            </label>
            {f.type === 'textarea' ? (
              <textarea
                value={values[f.key]}
                onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                rows={4}
                className={FIELD_CLS + ' py-2'}
              />
            ) : f.type === 'select' ? (
              <select
                value={values[f.key]}
                onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                className={FIELD_CLS + ' h-9'}
              >
                {(f.options ?? []).map(o => (<option key={o.value} value={o.value}>{o.label}</option>))}
              </select>
            ) : (
              <input
                type={f.type}
                value={values[f.key]}
                onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                className={FIELD_CLS + ' h-9'}
              />
            )}
          </div>
        ))}
      </div>
      <div className="bg-paper-50 border-t border-paper-200 px-5 py-3 flex items-center justify-end gap-2">
        {/* Save is the user committing the form — ink, not the machine's indigo. */}
        <Button
          onClick={submit}
          disabled={submitting}
          data-testid="artifact-form-submit"
        >
          {submitting ? <Loader2 className="size-4 animate-spin mr-1" /> : null}
          Save
        </Button>
      </div>
    </div>
  )
}

function CardBody({ artifact, onAction }: { artifact: CardArtifact; onAction: (a: ArtifactAction, art: Artifact) => Promise<void> | void }) {
  return (
    <div className="max-w-2xl mx-auto bg-card border border-paper-200 rounded-card shadow-e1">
      <div className="p-6">
        <h2 className="text-title text-ink-950 mb-2">{artifact.headline}</h2>
        {artifact.details && artifact.details.length > 0 && (
          <ul className="mt-3 space-y-1.5 text-[13px] text-ink-700 list-disc pl-5">
            {artifact.details.map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        )}
      </div>
      <div className="bg-paper-50 border-t border-paper-200 px-5 py-3 flex items-center gap-2 flex-wrap">
        {artifact.actions.map(a => (
          <ActionButton key={a.id} action={a} onAction={a => onAction(a, artifact)} large />
        ))}
      </div>
    </div>
  )
}

// ─── Action button ───────────────────────────────────────────────────

function ActionButton({
  action, onAction, large,
}: {
  action: ArtifactAction
  onAction: (a: ArtifactAction) => Promise<void> | void
  large?: boolean
}) {
  const [state, setState] = useState<'idle' | 'pending' | 'ok' | 'error'>('idle')
  // L6 #6 — keep the thrown message. The catch used to discard it and flash an
  // unlabeled red icon for 2.5s, so a user who clicked a broken action learned
  // only that *something* went wrong, with no way to tell a permissions
  // problem from a stale artifact from an unwired button.
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const click = async () => {
    if (state === 'pending') return
    if (action.href) {
      window.location.href = action.href
      return
    }
    setState('pending')
    setErrorMessage(null)
    try {
      await onAction(action)
      setState('ok')
      setTimeout(() => setState('idle'), 1200)
    } catch (err) {
      setErrorMessage((err as Error)?.message ?? 'Something went wrong.')
      setState('error')
      // No auto-clear on the message: an error the user did not manage to read
      // is the same as no error at all. The icon still settles back to idle.
      setTimeout(() => setState('idle'), 2500)
    }
  }
  // primary → ink (the artifact's one committing action); danger → the system's
  // outlined-red Reject treatment; everything else is a quiet outline.
  const variant = action.variant === 'primary' ? 'default'
    : action.variant === 'danger' ? 'danger'
    : 'outline'
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        type="button"
        variant={variant}
        size={large ? 'md' : 'sm'}
        onClick={click}
        disabled={state === 'pending'}
        data-testid={`artifact-action-${action.id}`}
        data-state={state}
      >
        {state === 'pending' && <Loader2 className="animate-spin" />}
        {state === 'ok'      && <Check />}
        {state === 'error'   && <AlertCircle />}
        {state === 'idle' && action.id === 'export' && <Download />}
        <span>{action.label}</span>
        {action.id === 'send' && state === 'idle' && <ChevronDown />}
      </Button>
      {errorMessage && (
        <span
          role="alert"
          data-testid={`artifact-action-error-${action.id}`}
          className="text-[12px] text-risk-700 max-w-[22rem] break-words"
        >
          {errorMessage}
        </span>
      )}
    </span>
  )
}
