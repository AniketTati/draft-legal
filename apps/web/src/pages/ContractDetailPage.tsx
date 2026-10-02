import { useClauseTypes } from '@/lib/clause-types'
import { useState, useRef, useEffect, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
// B.5.2 — PDF viewer re-enabled as the "Original" view via the
// [Styled | Original] toggle. Styled (TipTap / DocumentCanvas) remains the
// default; Legal users typically flip to Original for pixel fidelity.
import { Worker, Viewer, type RenderPageProps, type DocumentLoadEvent } from '@react-pdf-viewer/core'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { defaultLayoutPlugin } from '@react-pdf-viewer/default-layout'
import { api } from '@/lib/api'
import { parseCitationTarget, highlightRect } from '@/lib/citation-target'
import { cn } from '@/lib/utils'
import { MEANING_CLASS, RISK_BAND_CLASS, normalizeRisk, riskBand } from '@/lib/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ArrowLeft, Copy, Download, FileText, Tag,
  AlertCircle, Sparkles, Loader2,
  CheckCircle2, AlertTriangle, XCircle, Shield, TrendingUp,
  ChevronDown, ChevronUp, ChevronRight, CheckSquare,
  Link, Link2, Paperclip, Trash2, ExternalLink, Scissors, RefreshCw,
  FileEdit, Share2, ArrowLeftRight, X, PenLine, GitBranch,
  PanelRightClose, PanelRightOpen, FileDown, LocateFixed, FileDiff, Maximize2,
} from 'lucide-react'
import { expiryLabel, relativeTime } from '@/components/contracts/dates'
import { toast } from '@/components/common/Toaster'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { UploadModal } from '@/components/contracts/UploadModal'
import { CommentsReadList } from '@/components/contracts/workspace/CommentsView'
import { useSelectionActions } from '@/components/contracts/workspace/useSelectionActions'
import { ShareLinkDialog } from '@/components/contracts/ShareLinkDialog'
import { ContractMatterPicker } from '@/components/contracts/ContractMatterPicker'
import { ObligationsRailSection } from '@/components/contracts/ObligationsRailSection'
import { ComplianceRailSection } from '@/components/contracts/ComplianceRailSection'
import { ReviewPanel } from '@/components/contracts/review/ReviewPanel'
import { MatterRailSection } from '@/components/contracts/MatterRailSection'
import { RenewalAdviceRailSection, type RenewalAdvice } from '@/components/contracts/RenewalAdviceRailSection'
import { BubbleAiPopover } from '@/components/contracts/BubbleAiPopover'
import { DefinedTermsGlossary, useDefinedTerms } from '@/components/contracts/DefinedTermsGlossary'
import { VariablesRailSection } from '@/components/contracts/VariablesRailSection'
import { OriginRailSection } from '@/components/contracts/OriginRailSection'
import { SalesforceConflictsSection } from '@/components/contracts/SalesforceConflictsSection'
import { ClauseDeviationPopover } from '@/components/contracts/ClauseDeviationPopover'
import { StatusPill } from '@/components/contracts/StatusPill'
import { RailSection } from '@/components/contracts/RailSection'
import { DocumentCanvas, type CanvasState } from '@/components/contracts/DocumentCanvas'
import {
  FocusedReviewDrawer,
  type FocusedClause,
} from '@/components/contracts/FocusedReviewDrawer'
import {
  reviewQueue, nextPending, isReviewState, isDecided, DECISION_LABEL, type ReviewState,
} from '@/lib/review-queue'
import { classifyRisk } from '@/components/contracts/RiskDecorations'
// U.4.1 — AiCommandPalette deleted. ⌘K now focuses the rail composer.
import { DecisionStrip } from '@/components/contracts/DecisionStrip'
import { StatusBanner } from '@/components/contracts/StatusBanner'
import { HistoryDrawer } from '@/components/contracts/HistoryDrawer'
import { SendForReviewDialog } from '@/components/contracts/SendForReviewDialog'
import { SendForSignatureDialog } from '@/components/contracts/SendForSignatureDialog'
import { CreateAmendmentDialog } from '@/components/contracts/CreateAmendmentDialog'
import { SignatureStatusRailSection } from '@/components/contracts/SignatureStatusRailSection'
import { CoachMarks } from '@/components/contracts/CoachMarks'
import { useMediaQuery, BREAKPOINTS } from '@/hooks/useMediaQuery'
import { track } from '@/lib/telemetry'
import { useCanRequest, usePermission } from '@/lib/permissions'
import { FieldsPanel, type ContractField } from '@/components/contracts/FieldsPanel'
import { revealInCanvas, pdfSearchPattern, viewOf } from '@/components/contracts/SourceHighlight'
import { SelectionMenu, PdfSelectionMenu, type TextSelection } from '@/components/contracts/SelectionMenu'
import { pageTextOf } from '@/components/contracts/pdf-selection'
import { FieldPicker } from '@/components/contracts/FieldPicker'
import { NewFieldPopover } from '@/components/contracts/NewFieldPopover'
import { useFieldCatalog } from '@/lib/field-catalog'
import { ClauseTagPicker } from '@/components/contracts/ClauseTagPicker'
import { SaveToLibraryPopover } from '@/components/contracts/SaveToLibraryPopover'
import { AgreementPanel } from '@/components/contracts/AgreementPanel'
import { FamilyPanel } from '@/components/contracts/FamilyPanel'
import { AssistMark } from '@/components/ui/assist'
import { Can } from '@/components/auth/Can'
import {
  ExternalEditBanner, GoogleDocsStartDialog, RedlineNoticeBanner, downloadForCounterparty,
  type ExternalEditLock, type RedlineNotice,
} from '@/components/contracts/GoogleDocsEdit'

import { currentVersionOf } from '@/lib/current-version'
import { analysisLine } from '@/lib/analysis-state'
import { familyLine } from '@/lib/family-banner'
import { approvalKeys, invalidateApproval, serverMessage } from '@/lib/approval-keys'
import { useWorkingCopy } from '@/hooks/useWorkingCopy'
import { workspacePath } from '@/lib/workspace'
import { type SaveVersionBody, type SaveVersionResult } from '@/lib/working-copy'
import { LeaveDraftPrompt, SaveVersionDialog, WorkingCopyConflictDialog, draftStatusText, type LeaveChoice } from '@/components/contracts/WorkingCopyDialogs'

import '@react-pdf-viewer/core/lib/styles/index.css'
import '@react-pdf-viewer/default-layout/lib/styles/index.css'

// ─── Constants ────────────────────────────────────────────────────────────────

// A contract's type is a fact, not a state, so it earns no meaning color — the
// nine-hue rainbow this used to be competed with the status pill sitting right
// next to it. The map is kept (call sites index into it by type) but every type
// now resolves to the same neutral chip.
const TYPE_CHIP = 'bg-paper-100 text-ink-700 border-paper-200'
const TYPE_COLORS: Record<string, string> = {
  NDA:              TYPE_CHIP,
  MSA:              TYPE_CHIP,
  SOW:              TYPE_CHIP,
  SLA:              TYPE_CHIP,
  VENDOR_AGREEMENT: TYPE_CHIP,
  EMPLOYMENT:       TYPE_CHIP,
  PARTNERSHIP:      TYPE_CHIP,
  LICENSE:          TYPE_CHIP,
  OTHER:            TYPE_CHIP,
}

const CONTRACT_TYPES = [
  'NDA', 'MSA', 'SOW', 'SLA', 'VENDOR_AGREEMENT',
  'EMPLOYMENT', 'PARTNERSHIP', 'LICENSE', 'DATA_PROCESSING', 'ORDER_FORM', 'OTHER',
]

/** GET /contracts/:id/approval (docs/41 P0.6). */
interface ApprovalView {
  id: string
  status: string
  outcome: 'pending' | 'approved' | 'auto_approved' | 'returned' | 'cancelled'
  workflowName: string | null
  submittedAt: string
  decidedAt: string | null
  submittedBy: { id: string; name: string }
  currentStepOrder: number
  currentStepName: string | null
  waitingOn: Array<{ id: string; name: string }>
  returnedBy: { id: string; name: string } | null
  reason: string | null
  approvalRecommendation: string | null
  recommendationReasons: string[]
  steps: Array<{ id: string; stepOrder: number; stepName: string; approverId: string; approverName: string; status: string; decision: string | null; comment: string | null; decidedAt: string | null }>
}
interface ContractApproval {
  current: ApprovalView | null
  history: ApprovalView[]
  awaitingMe: any
}

const IN_PROGRESS_STATUSES = ['PENDING', 'PARSING', 'SPLITTING', 'CLASSIFYING', 'EXTRACTING', 'INDEXING', 'ANALYZING', 'DRAFTING']

// Statuses that can get "stuck" — includes queued states with a longer threshold
const STUCK_DETECTABLE = ['PENDING', 'DRAFTING', 'PARSING', 'SPLITTING', 'CLASSIFYING', 'EXTRACTING', 'INDEXING', 'ANALYZING']

const STATUS_BANNER: Record<string, { message: string; sub: string }> = {
  PENDING:     { message: 'Processing starting…',                     sub: '' },
  PARSING:     { message: 'Extracting document text…',                sub: '' },
  SPLITTING:   { message: 'Splitting the scanned file into separate contracts…', sub: '' },
  CLASSIFYING: { message: 'Identifying contract type…',               sub: '' },
  EXTRACTING:  { message: 'Routing to AI agent…',                     sub: '' },
  ANALYZING:   { message: 'AI extracting clauses, key terms & risk…', sub: '(~30–60 seconds)' },
  INDEXING:    { message: 'Building search index…',                   sub: '' },
}

// docs/39 A1 — the extraction's own steps, inside EXTRACTING (metadata._extraction).
const EXTRACTION_STEP_BANNER: Record<string, { message: string; sub: string }> = {
  reading:    { message: 'Reading the document…',            sub: '' },
  extracting: { message: 'AI reading fields and clauses…',   sub: '(~30–60 seconds)' },
  saving:     { message: 'Saving what was read…',            sub: '' },
}

interface ExtractionMark { step: string; attempt: number; of: number; error?: string; at?: string }

// Ordered pipeline steps — used for the step indicator in the progress banner
const PIPELINE_STEPS = [
  { statuses: ['PENDING'],                  label: 'Queue'    },
  { statuses: ['PARSING'],                  label: 'Parse'    },
  { statuses: ['SPLITTING', 'CLASSIFYING'], label: 'Classify' },
  { statuses: ['EXTRACTING'],               label: 'Extract'  },
  { statuses: ['ANALYZING'],                label: 'Analyze'  },
  { statuses: ['INDEXING'],                 label: 'Index'    },
]

// B.1.5a — STATUS_COLORS (the old pill-tint map) is gone. Status color is
// resolved once, in @/lib/status, and rendered by StatusPill; the commented
// palette that used to sit here would only tempt someone into a second source
// of truth.

const CLAUSE_FLAG_LABELS: Record<string, string> = {
  forceMajeure:          'Force Majeure',
  mfn:                   'MFN',
  changeOfControl:       'Change of Control',
  auditRights:           'Audit Rights',
  assignmentRestriction: 'Assignment Restriction',
  limitationOfLiability: 'Liability Cap',
  indemnification:       'Indemnification',
  warrantyDisclaimer:    'Warranty Disclaimer',
}

// U.4.4 — 'ask' removed; the rail handles per-contract Q&A.
// docs/41 Part 12 — Versions, Activity and Approval are in the History drawer now.
type Tab = 'overview' | 'document' | 'clauses' | 'comments'

// ─── Moves by hand ─────────────────────────────────────────────────────────────
// docs/41 Part 18 — the moves a person makes by hand (start negotiating,
// archive, mark signed outside the app, cancel) are offered by the status
// banner (components/contracts/StatusBanner.tsx), from GET /contracts/:id/stage.

// ─── Clause type → human-readable label ───────────────────────────────────────

// Clause ratings ride the same five meanings as every other state: unfavorable
// is exposure, unusual is "a human has to look at this", and favorable is the
// low end of the same scale the risk meter calls "low".
/** Risk band → the meaning whose wash the header chip borrows. */
const RISK_TO_MEANING = { low: 'binding', medium: 'turn', high: 'risk' } as const

const RISK_RATING_BADGE: Record<string, { label: string; cls: string }> = {
  unfavorable: { label: 'Unfavorable', cls: 'bg-risk-100 text-risk-700 border border-risk-200' },
  favorable:   { label: 'Favorable',   cls: 'bg-brand-100 text-brand-700 border border-brand-200' },
  unusual:     { label: 'Unusual',     cls: 'bg-attention-100 text-attention-700 border border-attention-200' },
  neutral:     { label: 'Neutral',     cls: 'bg-paper-100 text-ink-500 border border-paper-200' },
}

interface AiFinding {
  key: string; label: string; value: unknown; confidence: number; quote?: string
}

/** A finding's value as words, for the new field made from it (C4). */
function findingText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(String).join(', ')
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/** The org already tracks it as a field: same name, or same key (C4). */
const sameFieldName = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, '') === b.toLowerCase().replace(/[^a-z0-9]+/g, '')

// ─── Sub-components ───────────────────────────────────────────────────────────

// Extraction confidence isn't authorship, so it doesn't take the assist accent:
// it answers "must I check this myself?". High confidence next to an otherwise
// neutral fact stays neutral; medium is the user's turn; low is a value that
// may be wrong, which is risk.
function ConfidenceIcon({ confidence }: { confidence: number }) {
  if (confidence >= 0.9) return <CheckCircle2 className="size-3.5 text-ink-400 flex-shrink-0" />
  if (confidence >= 0.7) return <AlertTriangle className="size-3.5 text-attention-600 flex-shrink-0" />
  return <XCircle className="size-3.5 text-risk-600 flex-shrink-0" />
}

function RiskMeter({ score }: { score: number }) {
  // normalizeRisk absorbs the 0-1 vs 0-100 mismatch between the schema and the
  // stored data; without it every contract here read "Risk 7000% / High Risk".
  const pct = normalizeRisk(score) ?? 0
  const band = riskBand(pct)
  // Bar and label read their color from the shared risk bands, so this meter
  // can never disagree with a pill sitting next to it.
  const meaning = { dot: RISK_BAND_CLASS[band], fg: MEANING_CLASS[RISK_TO_MEANING[band]].fg }
  const label = band === 'high' ? 'High Risk' : band === 'medium' ? 'Medium Risk' : 'Low Risk'
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className={cn('text-body font-semibold', meaning.fg)}>{label}</span>
        <span className="text-body font-semibold text-ink-950 tabular-nums">{pct}%</span>
      </div>
      <div className="h-2 rounded-full bg-paper-100 overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', meaning.dot)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function formatTermValue(_key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (Array.isArray(v)) {
    if (v.length === 0) return '—'
    if (typeof v[0] === 'object' && v[0] !== null) {
      return (v as any[]).map(p => p.name ? `${p.name}${p.role ? ` (${p.role})` : ''}` : JSON.stringify(p)).join(' · ')
    }
    return (v as unknown[]).map(String).join(', ')
  }
  if (typeof v === 'object') return JSON.stringify(v)
  const s = String(v)
  // Format ISO dates nicely
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    try { return new Date(s).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) }
    catch { return s }
  }
  return s
}

function ClauseCard({
  typeLabel, sectionRef, badge, interpretation, content, onReview, onShowInDocument,
  clauseType, source, onRetype, onDismiss, busy,
}: {
  typeLabel: string
  sectionRef?: string | null
  badge: { label: string; cls: string } | null
  interpretation?: string | null
  content: string
  /** Opens the clause in the review drawer: playbook, alternative language, comments. */
  onReview?: () => void
  /** docs/39 B2 — highlights the clause in the document. */
  onShowInDocument?: () => void
  /** docs/39 E1 — who made it (a person's clauses survive re-analysis), and correcting it. */
  clauseType?: string
  source?: string
  onRetype?: (clauseType: string) => void
  onDismiss?: () => void
  busy?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [confirmDismiss, setConfirmDismiss] = useState(false)
  // docs/39 E3 — the organization's own clause types too.
  const { types: clauseTypes } = useClauseTypes()
  return (
    <div className="bg-card border border-paper-200 rounded-card p-4 shadow-e1 hover:border-paper-300 transition-colors">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          {badge && (
            <span className={`text-[11.5px] font-semibold px-2 py-0.5 rounded-full ${badge.cls}`}>
              {badge.label}
            </span>
          )}
          <span className="text-body font-semibold text-ink-950">{typeLabel}</span>
          {source === 'user' && (
            <span className="text-[10.5px] font-medium text-ink-500 border border-paper-200 rounded-chip px-1.5 py-px" title="Tagged or corrected by a person: a re-analysis keeps it">
              Tagged
            </span>
          )}
        </div>
        {sectionRef && (
          <span className="text-dense font-mono text-ink-400 flex-shrink-0 mt-0.5">{sectionRef}</span>
        )}
      </div>
      {interpretation ? (
        <p className="text-body text-ink-700 mb-2">{interpretation}</p>
      ) : (
        <p className="text-body text-ink-400 italic mb-2">No interpretation available.</p>
      )}
      <div className="flex items-center gap-4">
        <button
          onClick={() => setExpanded(e => !e)}
          className="flex items-center gap-1 text-dense text-ink-700 hover:text-ink-950 font-medium"
        >
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {expanded ? 'Hide' : 'View'} verbatim text
        </button>
        {onShowInDocument && (
          <button onClick={onShowInDocument} className="flex items-center gap-1 text-dense text-ink-700 hover:text-ink-950 font-medium" data-testid="clause-card-show">
            <LocateFixed className="size-3.5" /> Show in document
          </button>
        )}
        {onReview && (
          <button onClick={onReview} className="text-dense text-ink-700 hover:text-ink-950 font-medium underline underline-offset-2" data-testid="clause-card-review">
            Review and suggest changes
          </button>
        )}
        {(onRetype || onDismiss) && (
          <div className="ml-auto flex items-center gap-2">
            {onRetype && clauseType && (
              <select
                value={clauseType}
                disabled={busy}
                onChange={e => onRetype(e.target.value)}
                aria-label="Clause type"
                title="Wrong type? Pick the right one"
                className="h-7 max-w-[11rem] rounded-md border border-input bg-card px-1.5 text-[11.5px] text-ink-700"
                data-testid="clause-card-type"
              >
                {clauseTypes.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            )}
            {onDismiss && (confirmDismiss ? (
              <span className="flex items-center gap-1.5 text-dense text-ink-700">
                Not a clause?
                <button className="font-medium text-risk-700 hover:underline" disabled={busy} onClick={() => { setConfirmDismiss(false); onDismiss() }} data-testid="clause-card-dismiss-confirm">Remove</button>
                <button className="text-ink-500 hover:underline" onClick={() => setConfirmDismiss(false)}>Keep</button>
              </span>
            ) : (
              <button onClick={() => setConfirmDismiss(true)} disabled={busy} className="text-dense text-ink-500 hover:text-risk-700" data-testid="clause-card-dismiss">
                Not a clause
              </button>
            ))}
          </div>
        )}
      </div>
      {expanded && (
        <div className="mt-2 p-3 bg-paper-50 rounded-md border border-paper-200">
          <p className="text-micro text-ink-700 font-mono whitespace-pre-wrap">{content}</p>
        </div>
      )}
    </div>
  )
}

// B.1 — `hideIfEmpty` suppresses the row entirely when the value is an
// empty/placeholder string. Previously the Contract Details panel showed
// 6+ rows of `—` on contracts that had no extraction yet.
function DetailRow({ label, value, hideIfEmpty = true, evidence }: {
  label: string
  value: string
  hideIfEmpty?: boolean
  /** X2 — an extracted value's confidence and source quote (custom fields). */
  evidence?: { confidence?: number; quote?: string | null }
}) {
  if (hideIfEmpty && (!value || value === '—' || value === '-')) return null
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 border-b border-paper-100 last:border-0">
      <span className="text-dense text-ink-500 whitespace-nowrap pt-0.5">{label}</span>
      <span
        className="text-dense text-ink-950 font-medium text-right inline-flex items-center gap-1.5"
        title={evidence?.quote ? `Source: “${evidence.quote}”` : undefined}
      >
        {value}
        {evidence?.confidence != null && <ConfidenceIcon confidence={evidence.confidence} />}
      </span>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

/** docs/39 A13 — a contract type as a sentence says it. */
const TYPE_AS: Record<string, string> = {
  NDA: 'an NDA', MSA: 'an MSA', SOW: 'a statement of work', SLA: 'a service level agreement',
  VENDOR_AGREEMENT: 'a vendor agreement', EMPLOYMENT: 'an employment agreement', PARTNERSHIP: 'a partnership agreement',
  LICENSE: 'a license', DATA_PROCESSING: 'a data processing agreement', ORDER_FORM: 'an order form', OTHER: 'another kind of contract',
}
const typeAs = (t: string) => TYPE_AS[t] ?? t.replace(/_/g, ' ').toLowerCase()
/** docs/39 A12 — attachments read as part of the contract (API lib/exhibits.ts EXHIBIT_READABLE). */
const EXHIBIT_READABLE = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', 'text/plain', 'text/csv', 'image/png', 'image/jpeg', 'image/tiff'])
/** How long an attachment not read yet counts as being read (then: not read, with a way to read it). */
const READING_WINDOW_MS = 10 * 60_000
/** docs/39 A12 — uploads read as the PDF they're made into (API lib/document.ts TO_PDF). */
const CONVERTED_TO_PDF = new Set(['application/msword', 'image/png', 'image/jpeg', 'image/tiff'])
/** docs/39 A7 — below this the OCR engine was unsure of a page (API lib/scan-quality.ts POOR_SCAN). */
const POOR_SCAN = 0.6
/** The most pages of a scan that are read (API lib/ocr-batches.ts OCR_MAX_PAGES). */
const OCR_MAX_PAGES = 1000
/** Pages as people write them: "3, 7–9 and 12". */
function pageList(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  const runs: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    runs.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]))
    i = j
  }
  return runs.length > 1 ? `${runs.slice(0, -1).join(', ')} and ${runs[runs.length - 1]}` : runs[0] ?? ''
}
const typeNoun = (t: string) => typeAs(t).replace(/^an? /, '')

export function ContractDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  // P3.1 — when a citation pill links here with ?section=9.2, we scroll
  // the TipTap view to that heading + flash the matching TOC entry.
  const [searchParams] = useSearchParams()
  const highlightSection = searchParams.get('section') ?? null
  // X1 — ?page=&bbox= from a citation pill: open the original PDF there.
  const citeTarget = useMemo(() => parseCitationTarget(searchParams), [searchParams])
  // B.1 — default to 'document' so the contract itself is the first thing
  // a user sees, instead of a wall of AI-generated analysis panels.
  const [tab, setTab] = useState<Tab>('document')
  // B.5.4 — showEditor + its modal were deleted; edit mode now lives on
  // this same canvas via isEditing (see B.5.3).
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [pdfError, setPdfError] = useState<string | null>(null)
  // L6 #7 — Download had no error state at all; a 404 closed the menu silently.
  const [downloadError, setDownloadError] = useState<string | null>(null)
  // BB4 — Edit in Google Docs, and the counterparty's redline.
  const [googleDocsOpen, setGoogleDocsOpen] = useState(false)
  const [redlineNotice, setRedlineNotice] = useState<RedlineNotice | null>(null)
  const [redlinePending, setRedlinePending] = useState(false)
  const [showAllFlags, setShowAllFlags] = useState(false)
  const [editingType, setEditingType] = useState(false)
  const [showFindings, setShowFindings] = useState(false)
  const [showReanalyzeMenu, setShowReanalyzeMenu] = useState(false)
  const [clauseRatingFilter, setClauseRatingFilter] = useState<string>('all')
  const [clauseSearch, setClauseSearch] = useState('')
  const typeSelectRef = useRef<HTMLSelectElement>(null)

  // Close type select on Escape
  useEffect(() => {
    if (!editingType) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditingType(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [editingType])

  // Close re-analyze dropdown on outside click
  useEffect(() => {
    if (!showReanalyzeMenu) return
    const handler = () => setShowReanalyzeMenu(false)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showReanalyzeMenu])

  // Q&A surface removed by U.4.4 — rail handles per-contract chat now.

  const qc = useQueryClient()
  const layoutPlugin = defaultLayoutPlugin()
  // The viewer's search state lives in each render's plugin instance: a
  // deferred call ("show in document", B2) must reach the newest one.
  const layoutPluginRef = useRef(layoutPlugin)
  layoutPluginRef.current = layoutPlugin

  // B.5.2 — Styled | Original document view.
  const [docView, setDocView] = useState<'styled' | 'original'>(() => {
    if (typeof window === 'undefined') return 'styled'
    const saved = window.localStorage.getItem('clm.doc-view')
    return saved === 'original' ? 'original' : 'styled'
  })
  // X1 — a citation opening the original PDF is not a change of preference.
  const citationSwitchedView = useRef(false)
  useEffect(() => {
    if (citationSwitchedView.current) { citationSwitchedView.current = false; return }
    window.localStorage.setItem('clm.doc-view', docView)
  }, [docView])

  // B.5.5 — Risk visibility: off | summary | full.
  const [riskView, setRiskView] = useState<'off' | 'summary' | 'full'>(() => {
    if (typeof window === 'undefined') return 'full'
    const saved = window.localStorage.getItem('clm.risk-view')
    if (saved === 'off' || saved === 'summary' || saved === 'full') return saved
    return 'full'
  })
  useEffect(() => {
    window.localStorage.setItem('clm.risk-view', riskView)
  }, [riskView])

  // B.5.6 — Focused Review drawer state.
  // B.5.7 — reviewStates seeded from clausesData.reviewState and persisted
  // back via PATCH /contracts/clauses/:id/review-state (optimistic update).
  // Seed effect + mutation live lower in the file, after clausesData is
  // declared (the query for contract-clauses uses `id` from useParams).
  const [focusedClauseId, setFocusedClauseId] = useState<string | null>(null)
  // Scroll a clause's marker into view (the risk-markers extension labels
  // spans with data-clause-id); fall back to the focused-review drawer.
  // Shared by the approver DecisionStrip and the playbook review rail.
  const jumpToClause = (clauseId: string) => {
    const el = document.querySelector(`[data-clause-id="${clauseId}"]`) as HTMLElement | null
    // docs/39 B2 — a clause the risk layer doesn't mark is found by its words.
    const content = (clausesData?.data ?? []).find((c: { id: string }) => c.id === clauseId)?.content as string | undefined
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('ring-2', 'ring-attention-600')
      setTimeout(() => el.classList.remove('ring-2', 'ring-attention-600'), 1500)
    } else if (!(content && revealInCanvas(canvasEditorRef.current, content))) {
      setFocusedClauseId(clauseId)
    }
  }
  // P7.4.4 — Expand the REVIEW PROGRESS row into a checklist so users
  // can mark items reviewed without hunting for each red underline.
  const [reviewExpanded, setReviewExpanded] = useState(false)
  const [reviewStates, setReviewStates] = useState<Record<string, ReviewState>>({})

  // B.5.3 — Edit mode on the unified canvas.
  // Replaces the old "Open in Editor" full-screen modal flow. Edit mode
  // flips the TipTap editor to editable=true and debounces saves to the
  // existing /html-version endpoint. Exits on click, Esc, or Save.
  const [isEditing, setIsEditing] = useState(false)
  // X75, Y3 — each action is offered only to a user who may make the request
  // it sends, by the permission the server's route for it needs: a viewer was
  // let into Edit mode, and every save failed (403) behind "Save failed".
  // docs/41 Part 16 — typing saves to the draft changes, so that is the request edit mode needs.
  const mayEdit = useCanRequest('PUT /contracts/:id/working-copy')
  // Save as version's "Send to counterparty" by link or email, and its "Reset approvals".
  const canShare = useCanRequest('POST /contracts/:id/share')
  const canResetApprovals = usePermission('configure', 'workflow')
  const canChangeStatus = useCanRequest('PATCH /contracts/:id')
  const canEditFields = useCanRequest('PUT /contracts/:id/fields/:key')
  // docs/39 C3 — add a field from a highlight, or suggest one to whoever can.
  const canCreateFields = useCanRequest('POST /field-definitions')
  const canSuggestFields = useCanRequest('POST /field-suggestions')
  // docs/39 E1 — tag, retype or dismiss clauses.
  const canTagClauses = useCanRequest('POST /contracts/:id/clauses/tag')
  // docs/39 E3 — clause types' names, the organization's own included.
  const { labelOf: clauseLabelOf } = useClauseTypes()
  // docs/39 E4 — wording saved to the clause library from here.
  const canSaveWording = useCanRequest('POST /clauses/from-contract')
  const retypeClause = useMutation({
    mutationFn: (a: { clauseId: string; clauseType: string }) => api.patch(`/contracts/clauses/${a.clauseId}/type`, { clauseType: a.clauseType }).then(r => r.data),
    onSuccess: (_d, a) => {
      toast.success(`Now a ${clauseLabelOf(a.clauseType).toLowerCase()} clause`, { description: 'A re-analysis keeps it.' })
      qc.invalidateQueries({ queryKey: ['contract-clauses', id] })
    },
    onError: (err: { response?: { data?: { detail?: string } } }) => toast.error("Couldn't change the type", { description: err.response?.data?.detail ?? 'Try again.' }),
  })
  const dismissClause = useMutation({
    mutationFn: (a: { clauseId: string }) => api.post(`/contracts/clauses/${a.clauseId}/dismiss`).then(r => r.data),
    onSuccess: () => {
      toast.success('Removed', { description: 'It won\u2019t come back when the contract is analysed again.' })
      qc.invalidateQueries({ queryKey: ['contract-clauses', id] })
    },
    onError: (err: { response?: { data?: { detail?: string } } }) => toast.error("Couldn't remove it", { description: err.response?.data?.detail ?? 'Try again.' }),
  })
  const canSign = useCanRequest('POST /contracts/:id/send-for-signature')
  const canUpload = useCanRequest('POST /contracts/upload')

  // B.5.9 — ⌘K command palette.
  // Single entry point for every AI interaction. Opens from anywhere on the
  // detail page via ⌘K / Ctrl+K (see effect below) and also from the bubble
  // menu's ✨ button (which pre-fills the input with the selected text).
  // Replaces the former cluster of colored AI pill-buttons (deleted as part
  // of this commit) per docs/26 §6.5.
  // U.4.1 — palette deleted; state removed.
  // U.6.1 — Send-for-Review dialog state. Replaces the silent state flip
  // the old button did (audit P1 #5).
  const [sendForReviewOpen, setSendForReviewOpen] = useState(false)
  // Phase 07 — Send-for-Signature dialog state. Drives the
  // POST /contracts/:id/send-for-signature flow that was previously
  // reachable only via API.
  const [sendForSignatureOpen, setSendForSignatureOpen] = useState(false)
  // docs/41 Part 12 — the History drawer (versions, approvals, signatures, moves).
  const [historyOpen, setHistoryOpen] = useState(false)
  const [createAmendmentOpen, setCreateAmendmentOpen]   = useState(false)
  // P6.3 — streaming bubble AI popover
  const [aiPopoverOpen, setAiPopoverOpen] = useState(false)
  const [aiPopoverText, setAiPopoverText] = useState('')
  const [aiPopoverRange, setAiPopoverRange] = useState<{ from: number; to: number } | null>(null)

  // B.5.13 — Compare Versions mode (full-screen overlay).
  // Elevated from a buried tab to a first-class mode per docs/26 State 9.
  // docs/41 Part 15 (C2) — Compare, Review their changes and the history's
  // compare open the workspace's Changes mode (it replaced the Compare
  // overlay, the Negotiate tab and the redline panel).
  const openChanges = () => navigate(workspacePath(id!, { changes: true }))

  // B.5.16 — Responsive rail behaviour.
  //   xl+   (≥1280)  → static two-column layout (rail visible).
  //   md-lg (768–1279) → rail becomes a slide-in right drawer.
  //   < md   (mobile)  → rail becomes a bottom sheet with 64px peek.
  // The floating trigger button is hidden at xl+.
  const isXl = useMediaQuery(BREAKPOINTS.xl)
  const isMd = useMediaQuery(BREAKPOINTS.md)
  const [railOpen, setRailOpen] = useState(false)
  // Fix-up 15 — bumped by the family banner's "View family": the rail's family section opens and scrolls into view.
  const [familyReveal, setFamilyReveal] = useState(0)

  // Esc closes the mobile/tablet rail.
  useEffect(() => {
    if (isXl || !railOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setRailOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isXl, railOpen])

  // When we cross the xl threshold (e.g. user rotates / resizes), reset
  // the drawer state so we don't get stuck with a mobile drawer visible
  // at desktop width.
  useEffect(() => { if (isXl) setRailOpen(false) }, [isXl])

  /*
   * Reading room (design system rule 3 — "the document is the hero").
   *
   * At 1440px the document column measured 460px wide. DocumentCanvas gives
   * the page a real 2.5cm print margin on each side, so counsel was reading a
   * 40-page MSA through a ~223px slot — roughly 30 characters a line, about a
   * third of the measure the typographic literature calls comfortable. The
   * chrome (320px rail + the assistant panel) outweighed the paper.
   *
   * The rail earns its space during review and costs during reading, so this
   * makes it foldable rather than permanent, and remembers the choice. Folded,
   * the same viewport gives the document ~780px — a full 65-character measure.
   */
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('contract:rail-collapsed') === '1' } catch { return false }
  })
  const toggleRail = () => {
    setRailCollapsed(v => {
      const next = !v
      try { localStorage.setItem('contract:rail-collapsed', next ? '1' : '0') } catch { /* private mode */ }
      track('contract_rail_toggled', { collapsed: next })
      return next
    })
  }
  // ⌥\ folds the rail — same modifier the sidebar uses for its own collapse.
  useEffect(() => {
    if (!isXl) return
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === '\\' || e.code === 'Backslash')) {
        e.preventDefault()
        toggleRail()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isXl])

  // P3.1 — when arriving from a citation pill (?section=9.2), find the
  // matching <h*> in the TipTap view + scroll to it + pulse the
  // matching TOC entry. Runs whenever `highlightSection` changes so
  // clicking a second citation from the same page re-scrolls.
  useEffect(() => {
    if (!highlightSection) return
    // Defer until the document + TOC have mounted.
    const t = setTimeout(() => {
      const hostSel = '[data-testid="contract-document-host"], .contract-paper'
      const scope: Document | Element = document.querySelector(hostSel) ?? document
      const heads = Array.from(scope.querySelectorAll('h1, h2, h3, h4, h5, h6')) as HTMLElement[]
      const needle = highlightSection.toLowerCase()
      const match = heads.find(h => h.innerText?.toLowerCase().includes(needle))
      if (match) {
        match.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      // Flash the matching TOC row regardless of whether we found a
      // heading (the TOC might be the only visible anchor). Attribute
      // values inside quotes don't need escaping; the dot in "9.2"
      // works as-is.
      const tocItem = document.querySelector(
        `[data-testid^="toc-item-"][data-ref="${highlightSection.replace(/"/g, '\\"')}"]`,
      ) as HTMLElement | null
      if (tocItem) {
        // "You landed here" is a selection, not a state, so the flash is ink.
        // The literals stay spelled out so Tailwind's scanner still emits them.
        tocItem.classList.add('bg-paper-100', 'ring-2', 'ring-ink-950')
        tocItem.scrollIntoView({ behavior: 'smooth', block: 'center' })
        // 5s flash — long enough for users to visually register and
        // for verification scripts to catch it deterministically.
        setTimeout(() => tocItem.classList.remove('bg-paper-100', 'ring-2', 'ring-ink-950'), 5000)
      }
    }, 350)
    return () => clearTimeout(t)
  }, [highlightSection])
  const canvasEditorRef = useRef<import('@tiptap/react').Editor | null>(null)
  // Mirror the ref into state so rail sections that need the editor
  // (the defined-terms glossary, P6.3 BubbleAiPopover) re-render
  // when the editor remounts on Edit-mode toggle.
  const [canvasEditor, setCanvasEditor] = useState<import('@tiptap/react').Editor | null>(null)
  // docs/41 Part 16 (C1) — typing autosaves to the draft changes (the
  // working copy), not to a version: a version is made only with a note
  // (Save as version), on submit or send, or after a long pause (the server's).
  const draft = useWorkingCopy(id, {
    onSaveError: (err) => {
      // BB4 — someone took a Google Docs copy while this was open for editing.
      const data = (err as { response?: { data?: { code?: string; detail?: string } } })?.response?.data
      if (data?.code === 'EDITING_IN_GOOGLE_DOCS') {
        toast.error('Not saved: this contract is being edited in Google Docs', { description: data.detail, durationMs: 9000 })
        qc.invalidateQueries({ queryKey: ['contract', id] })
      }
    },
  })
  const saveState = draft.saveState
  const [saveVersionOpen, setSaveVersionOpen] = useState(false)
  const [savingVersion, setSavingVersion] = useState(false)
  const [saveVersionError, setSaveVersionError] = useState<string | null>(null)
  // Leaving the editor with draft changes: where to go once the person chooses.
  const [leaving, setLeaving] = useState<null | { then: () => void }>(null)
  const [leaveBusy, setLeaveBusy] = useState<LeaveChoice | null>(null)
  const afterSaveVersion = useRef<(() => void) | null>(null)

  /**
   * docs/39 H2 — what a command just changed in the document (a variable
   * changed everywhere it appears), or typing before the server changes the
   * draft itself, becomes a version now with its own note. Through the
   * draft changes, like every other version made in the editor.
   */
  const saveDocumentNow = async (note?: string): Promise<boolean> => {
    if (!await draft.flush()) throw new Error('Your latest changes could not be saved.')
    if (!draft.hasDraft()) return false
    try {
      await draft.saveVersion({ note: note ?? 'Draft changes saved before a change to the draft' })
      return true
    } catch (err) {
      if ((err as { response?: { data?: { code?: string } } })?.response?.data?.code === 'NO_WORKING_COPY') return false
      throw err
    }
  }

  const saveAsVersion = async (body: SaveVersionBody) => {
    if (!id) return
    setSavingVersion(true)
    setSaveVersionError(null)
    try {
      const r = await draft.saveVersion(body)
      setSaveVersionOpen(false)
      invalidateApproval(qc, id)
      toast.success(r.created ? `Saved as v${r.version.versionNumber}` : 'No changes to save', { description: body.note })
      if (r.send) await followUpSend(id, r)
      const then = afterSaveVersion.current
      afterSaveVersion.current = null
      then?.()
    } catch (err) {
      setSaveVersionError(serverMessage(err, (err as Error).message || 'Not saved. Try again.'))
    } finally {
      setSavingVersion(false)
    }
  }

  /** After Save as version sent it: the download, link or email the person asked for. */
  const followUpSend = async (contractId: string, r: SaveVersionResult) => {
    const send = r.send!
    if (!send.ok) {
      toast.error(`Saved as v${r.version.versionNumber}, but not sent`, { description: send.detail ?? 'Try sending it again.', durationMs: 9000 })
      return
    }
    if (send.method === 'word') {
      setRedlineNotice(await downloadForCounterparty(contractId))
    } else if (send.method === 'pdf') {
      try {
        const { url } = (await api.get(`/contracts/${contractId}/download`, { params: { versionId: r.version.id } })).data as { url: string }
        window.open(url, '_blank', 'noopener')
      } catch (err) {
        toast.error('The PDF could not be downloaded', { description: serverMessage(err, 'Try Download from the menu.') })
      }
    } else if (send.method === 'email') {
      toast.success(send.emailDelivered === false ? 'Link made, but the email was not sent' : `Emailed to ${send.emailedTo ?? 'the counterparty'}`, {
        description: send.emailDelivered === false ? `Email isn't set up. Copy the link and send it yourself: ${send.portalUrl ?? ''}` : undefined, durationMs: 9000,
      })
    } else if (send.portalUrl) {
      await navigator.clipboard?.writeText(send.portalUrl).catch(() => {})
      toast.success('Share link copied', { description: send.portalUrl, durationMs: 9000 })
    }
  }

  /** Done, Esc or a link while editing: ask first when there are draft changes. */
  const leaveEdit = (then: () => void = () => {}) => {
    if (!draft.hasDraft()) { setIsEditing(false); then(); return }
    setLeaving({ then })
  }
  const chooseLeave = async (choice: LeaveChoice) => {
    const then = leaving?.then ?? (() => {})
    if (choice === 'save') {
      setLeaving(null)
      afterSaveVersion.current = () => { setIsEditing(false); then() }
      setSaveVersionOpen(true)
      return
    }
    setLeaveBusy(choice)
    try {
      if (choice === 'keep') await draft.flush()
      else {
        await draft.discard()
        qc.invalidateQueries({ queryKey: ['contract', id] })
      }
      setLeaving(null)
      setIsEditing(false)
      track('edit_exited', { leave: choice })
      then()
    } catch (err) {
      toast.error(choice === 'discard' ? 'Not discarded' : 'Not saved', { description: serverMessage(err, 'Try again.') })
    } finally {
      setLeaveBusy(null)
    }
  }
  // docs/39 H2 — a variable clicked in the document, for the Variables panel to show.
  const [focusVariable, setFocusVariable] = useState<string | null>(null)

  // The draft changes the editor opens on, when there are any (else the version).
  const [draftHtml, setDraftHtml] = useState<string | null>(null)
  const enterEdit = async () => {
    if (!canEdit) return   // the button, ⌘E and a clause's "Edit manually"
    // Edit requires Styled view (can't edit a PDF).
    if (docView !== 'styled') setDocView('styled')
    let html: string | null = null
    try {
      const copy = await draft.load(contract?.currentVersionId ?? null)
      html = copy?.html ?? null
      if (copy?.stale) {
        toast.info('These draft changes were started on an older version', {
          description: `They were made on v${copy.baseVersionNumber ?? '?'}; a newer version was saved since. Check them before saving them as a version.`, durationMs: 9000,
        })
      }
    } catch { /* opens on the version; the next save says what's wrong */ }
    setDraftHtml(html)
    setIsEditing(true)
    track('edit_entered', { from: docView, draft: !!html })
  }
  const exitEdit = () => leaveEdit()

  // A link clicked, or the tab closed, with draft changes not yet a version.
  useEffect(() => {
    if (!isEditing) return
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !draft.hasDraft()) return
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || a.target === '_blank' || a.hasAttribute('download') || a.origin !== window.location.origin) return
      const to = a.pathname + a.search + a.hash
      if (to === window.location.pathname + window.location.search + window.location.hash) return
      e.preventDefault()
      e.stopPropagation()
      leaveEdit(() => navigate(to))
    }
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!draft.hasPendingTyping()) return
      void draft.flush()
      e.preventDefault()
    }
    document.addEventListener('click', onClick, true)
    window.addEventListener('beforeunload', onUnload)
    return () => { document.removeEventListener('click', onClick, true); window.removeEventListener('beforeunload', onUnload) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing])

  // Esc exits edit mode. Cmd+S forces a flush.
  useEffect(() => {
    if (!isEditing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); exitEdit() }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void draft.flush() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing])

  // B.5.9 — Global ⌘K / Ctrl+K opens the AI command palette from anywhere
  // on the detail page. Fires on the detail page only — `id` in deps means
  // the listener detaches on unmount. We skip when the palette is already
  // U.4.1 — Cmd-K palette deleted. ⌘K is now handled globally inside
  // SideAgentRail (focuses the rail composer). The palette state below
  // stays declared (paletteOpen) only so legacy click paths in the
  // toolbar / Actions menu don't blow up; those paths are deleted in
  // U.4.4. This effect is intentionally empty — kept as a no-op so the
  // keyboard contract stays clean.

  // B.5.17 — telemetry: record detail page opens so we can see the split
  // between roles (Legal / Approver / Sales) in usage.
  useEffect(() => {
    if (!id) return
    track('contract_detail_opened', { id, status: contract?.status ?? 'unknown' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const { data: contract, isLoading } = useQuery({
    queryKey: ['contract', id],
    queryFn: () => api.get(`/contracts/${id}`).then(r => r.data),
    enabled: !!id,
    // Poll every 4s while any pipeline step is in progress or redline is analyzing
    refetchInterval: (q) => {
      const s = q.state.data?.analysisStatus
      const meta = q.state.data?.metadata as Record<string, unknown> | undefined
      const rm = meta?._redlineStatus
      // Every long-running job that reports through contract.metadata has to be
      // listed here, or the page fetches once and then stops: the rail sits on
      // "working…" forever and only a manual refresh reveals the result. The
      // playbook redline takes minutes, so it is exactly the case that suffers.
      const pr = meta?._playbookRedlineStatus
      // docs/39 A12 — an attachment just attached is being read with the contract.
      const read = new Set(((q.state.data as any)?.exhibits ?? []).map((e: { s3Key: string }) => e.s3Key))
      const reading = (((q.state.data as any)?.attachments ?? []) as Array<{ s3Key: string; mimeType: string; attachedAt?: string }>)
        .some(a => !read.has(a.s3Key) && EXHIBIT_READABLE.has(a.mimeType) && !!a.attachedAt && Date.now() - new Date(a.attachedAt).getTime() < READING_WINDOW_MS)
      const inFlight =
        (s && IN_PROGRESS_STATUSES.includes(s)) ||
        rm === 'ANALYZING' ||
        pr === 'QUEUED' || pr === 'RUNNING' || reading
      // BB4 — a Google Docs copy is out: notice when it comes back.
      return inFlight ? 4000 : q.state.data?.externalEdit ? 15000 : false
    },
  })
  // BB4 — while a Google Docs copy is out, the document here is read-only.
  const externalEdit = (contract?.externalEdit ?? null) as ExternalEditLock | null
  const canEdit = mayEdit && !externalEdit
  useEffect(() => {
    if (externalEdit && isEditing) setIsEditing(false)
  }, [externalEdit, isEditing])

  const { data: versionsData } = useQuery({
    queryKey: ['contract-versions', id],
    queryFn: () => api.get(`/contracts/${id}/versions`).then(r => r.data),
    enabled: !!id,
  })

  const { data: clausesData } = useQuery({
    queryKey: ['contract-clauses', id],
    queryFn: () => api.get(`/contracts/${id}/clauses`).then(r => r.data),
    // B.1.5f — rail's Clauses section shows counts + first-6 preview; fetch
    // as soon as clauses could be extracted.
    enabled: !!id && ['INDEXING', 'DONE'].includes(contract?.analysisStatus ?? ''),
    staleTime: 30_000,
  })

  // B.5.7 — seed review states from server + mutation to persist changes.
  // Declared here (not near other B.5.6 state) because it depends on the
  // clausesData query above.
  useEffect(() => {
    const data = clausesData?.data as Array<{ id: string; reviewState?: string }> | undefined
    if (!data) return
    setReviewStates((prev) => {
      const next = { ...prev }
      for (const c of data) {
        const s = c.reviewState
        if (isReviewState(s)) next[c.id] = s
      }
      return next
    })
  }, [clausesData])

  const updateReviewState = useMutation({
    mutationFn: ({ clauseId, state }: { clauseId: string; state: ReviewState }) =>
      api.patch(`/contracts/clauses/${clauseId}/review-state`, { state }).then(r => r.data as { requestedId?: string }),
    onSuccess: (data) => {
      // DD2 — the clause was an older version's (the drawer marks the one it
      // has just rewritten): the server marked the same clause in the version
      // the contract stands on, which the page shows.
      if (data?.requestedId) qc.invalidateQueries({ queryKey: ['contract-clauses', id] })
    },
    onError: () => {
      qc.invalidateQueries({ queryKey: ['contract-clauses', id] })
    },
  })

  // DD2 — the focused clause by its place, so the review drawer follows it
  // into a new version (an applied rewrite, an edit) instead of closing: the
  // page's clauses are then the new version's, with new ids.
  const focusedPlaceRef = useRef<{ sortOrder: number; clauseType: string } | null>(null)
  useEffect(() => {
    if (!focusedClauseId) { focusedPlaceRef.current = null; return }
    const list = (clausesData?.data ?? []) as Array<{ id: string; sortOrder: number; clauseType: string }>
    const here = list.find(c => c.id === focusedClauseId)
    if (here) { focusedPlaceRef.current = { sortOrder: here.sortOrder, clauseType: here.clauseType }; return }
    const place = focusedPlaceRef.current
    const moved = place && list.find(c => c.sortOrder === place.sortOrder && c.clauseType === place.clauseType)
    if (moved) setFocusedClauseId(moved.id)
  }, [focusedClauseId, clausesData])

  // docs/41 Part 10 — the canvas shows a defined term's definition on hover,
  // whether or not the Review panel's glossary is open.
  useDefinedTerms(id, contract?.currentVersionId, canvasEditor)

  // Phase 06 — this contract's approval. docs/41 P0.6 — one read, from the
  // contract (GET /contracts/:id/approval): the latest request with its steps,
  // approver names, outcome and the reason it was returned, the earlier
  // requests, and the step waiting on the current user (the DecisionStrip's).
  // It used to filter the user's own queue, and the full instance came from
  // GET /approvals?contractId=, which doesn't exist: the timeline, the rail
  // section and the "waiting on" strip were always empty.
  const { data: contractApproval, refetch: refetchApproval } = useQuery({
    queryKey: approvalKeys.contract(id ?? ''),
    queryFn: () => api.get(`/contracts/${id}/approval`).then(r => r.data as ContractApproval),
    enabled: !!id,
    staleTime: 15_000,
  })
  const approvalData = contractApproval?.awaitingMe ?? null

  // B.5.10 — Approver Mode flag. True when the current user has a PENDING
  // approval step assigned to them on this contract. Drives:
  //   - DecisionStrip rendering above the document,
  //   - amber risk markers instead of red (tone shift),
  //   - Precedents rail section appears (B.5.11).
  const isApproverMode = !!approvalData

  // B.5.11 — Precedents: top-3 signed similar contracts + risk delta.
  // Only fetched in approver mode so we don't pay the vector-search cost
  // for Legal / Sales viewers who don't use this signal. When the backend
  // has no similar peers yet (brand-new org), the endpoint returns an
  // empty data array and the rail section shows a soft empty state.
  const { data: precedentsData } = useQuery({
    queryKey: ['contract-precedents', id],
    queryFn: () => api.get(`/contracts/${id}/precedents`).then(r => r.data),
    enabled: !!id && isApproverMode,
    staleTime: 60_000,
  })

  // docs/39 G1 — a re-analysis refreshes the values the AI owns; values a
  // person set or checked stay, and what the AI now reads shows beside them
  // in the Fields panel. `fill_blanks` only fills empty fields.
  const analyze = useMutation({
    mutationFn: (fields: 'replace_ai' | 'fill_blanks' | void) => api.post(`/contracts/${id}/analyze`, fields ? { fields } : {}),
    onSuccess: (_r, fields) => {
      qc.invalidateQueries({ queryKey: ['contract', id] })
      toast.info(fields === 'fill_blanks' ? 'Re-analysing — only empty fields will be filled' : 'Re-analysing — values you set or checked are kept')
    },
  })

  const reprocess = useMutation({
    mutationFn: () => api.post(`/contracts/${id}/analyze?full=true`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contract', id] }),
  })

  const cancelAnalysis = useMutation({
    mutationFn: () => api.post(`/contracts/${id}/cancel-analysis`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', id] })
    },
  })

  const retype = useMutation({
    mutationFn: (contractType: string) => api.post(`/contracts/${id}/retype`, { contractType }),
    onSuccess: () => {
      setEditingType(false)
      qc.invalidateQueries({ queryKey: ['contract', id] })
    },
  })
  const canRetype = useCanRequest('POST /contracts/:id/retype')
  // docs/39 A12 — each attachment as it was read with the contract.
  const exhibitReading = (att: { s3Key: string; mimeType: string; attachedAt?: string }): { state: 'read' | 'reading' | 'failed' | 'unread' | 'not-read'; pages?: number | null; ocr?: boolean; error?: string | null } => {
    const e = ((contract as any)?.exhibits ?? []).find((x: { s3Key: string }) => x.s3Key === att.s3Key)
    if (e) return e.error ? { state: 'failed', error: e.error } : { state: 'read', pages: e.pageCount, ocr: e.ocrApplied }
    if (!EXHIBIT_READABLE.has(att.mimeType)) return { state: 'not-read' }
    return att.attachedAt && Date.now() - new Date(att.attachedAt).getTime() < READING_WINDOW_MS ? { state: 'reading' } : { state: 'unread' }
  }
  const readAttachment = useMutation({
    mutationFn: (idx: number) => api.post(`/contracts/${id}/attachments/${idx}/read`),
    onSuccess: () => { toast.success('Reading it with the contract'); qc.invalidateQueries({ queryKey: ['contract', id] }) },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? 'Couldn’t start reading it'),
  })
  // docs/39 A7 — read the file again from the start, for pages of a scan that couldn't be read.
  const rereadScan = useMutation({
    mutationFn: () => api.post(`/contracts/${id}/analyze?full=true`),
    onSuccess: () => { toast.success('Reading the scan again'); qc.invalidateQueries({ queryKey: ['contract', id] }) },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? 'Couldn’t start reading the scan again'),
  })
  const reread = useMutation({
    mutationFn: () => api.post(`/contracts/${id}/retype`, { contractType: contract?.type, reread: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contract', id] }),
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? 'Couldn’t start the read'),
  })
  // docs/39 A13 — the fields list is its own query: read it again when the
  // type changes (a retype lists the new type's fields, then reads them) or an
  // analysis finishes, or it shows the old values until the page is reloaded —
  // and what that analysis changed (G1), with its undo.
  const fieldsStamp = contract ? `${contract.type}|${contract.analysisStatus}` : null
  const lastFieldsStamp = useRef(fieldsStamp)
  useEffect(() => {
    if (lastFieldsStamp.current && fieldsStamp && lastFieldsStamp.current !== fieldsStamp) {
      qc.invalidateQueries({ queryKey: ['contract-fields', id] })
      qc.invalidateQueries({ queryKey: ['field-run-latest', id] })
    }
    lastFieldsStamp.current = fieldsStamp
  }, [fieldsStamp, id, qc])

  // docs/41 P0.3 — the deterministic checks describe the version the contract
  // stands on: read again when it moves or its analysis finishes.
  const { data: checksData } = useQuery({
    queryKey: ['contract-checks', id],
    queryFn: () => api.get(`/contracts/${id}/checks`).then(r => r.data as { openChoices?: Array<{ key: string; label: string }> }),
    enabled: !!id,
    staleTime: 15_000,
  })
  // docs/41 P0.4 — terms the draft left to choose (a governing law nobody
  // named). It can't go out until they are chosen.
  const openChoices = checksData?.openChoices ?? []
  // docs/41 P0.8 — sent for signature once approved, unless the org allows otherwise.
  const { data: orgData } = useQuery<{ settings?: { allowSignWithoutApproval?: boolean } }>({
    queryKey: ['organization'],
    queryFn: () => api.get('/organization').then(r => r.data),
    staleTime: 60_000,
  })
  const signGateReason = contract && !['APPROVED', 'PENDING_SIGNATURE'].includes(contract.status) && orgData && !orgData.settings?.allowSignWithoutApproval
    ? (contract.status === 'PENDING_APPROVAL'
        ? 'Waiting for approval — it can be sent for signature once approved.'
        : 'Needs approval first — send it for approval, then for signature.')
    : null
  const openChoicesReason = openChoices.length
    ? `${openChoices.length === 1 ? '1 choice' : `${openChoices.length} choices`} still open in the draft (${openChoices.map(c => c.label).join(', ')}). Choose ${openChoices.length === 1 ? 'it' : 'them'} before sending.`
    : null
  const checksStamp = contract ? `${contract.analysisStatus}|${contract.currentVersionId}` : null
  useEffect(() => {
    if (checksStamp) {
      qc.invalidateQueries({ queryKey: ['contract-checks', id] })
      qc.invalidateQueries({ queryKey: ['contract-review', id] })
    }
  }, [checksStamp, id, qc])

  // Binder split
  const [showSplitModal, setShowSplitModal] = useState(false)
  const [splitSpecs, setSplitSpecs] = useState<Array<{ pageStart: number; pageEnd: number; title: string; type: string }>>([])
  const suggestedSplits: any[] = (contract as any)?.metadata?._suggestedSplits ?? []
  const binderDetected = !!(contract as any)?.metadata?._binderDetected
  const splitInto: string[] = (contract as any)?.metadata?._splitInto ?? []
  // C10 — set when a binder can't be split (not a PDF) or a re-split was refused.
  const binderSplitUnsupported: string | null = (contract as any)?.metadata?._binderSplitUnsupported ?? null
  const splitError: string | null = (contract as any)?.metadata?._splitError ?? null
  const autoSplitDone = splitInto.length > 0

  // docs/39 A1 — the extraction job's step and attempt, while it runs.
  const extractionMark = (contract as any)?.metadata?._extraction as ExtractionMark | undefined
  const extracting = contract?.analysisStatus === 'EXTRACTING' && extractionMark ? extractionMark : null
  // docs/39 A13 — a retype reads only the new type's own fields: the bar says
  // that (not a whole analysis), and a read that failed says so below.
  const typeRead = (contract as any)?.metadata?._typeFieldsRead as { type: string; error?: string } | undefined
  const readingType = contract?.analysisStatus === 'ANALYZING' && typeRead && !typeRead.error ? typeRead.type : null
  // docs/39 A7 — a scan is read a few pages at a time: how far it has got.
  const ocrMark = (contract as any)?.metadata?._ocr as { done: number; of: number } | undefined
  const readingScan = ocrMark && (contract?.analysisStatus === 'PENDING' || contract?.analysisStatus === 'PARSING') ? ocrMark : null
  // docs/39 A12 — read again with an exhibit just attached (until its read starts).
  const exhibitAt = (contract as any)?.metadata?._exhibitReread as string | undefined
  const exhibitReread = contract?.analysisStatus === 'EXTRACTING' && !!exhibitAt && Date.now() - Date.parse(exhibitAt) < READING_WINDOW_MS
  const banner = readingType
    ? { message: `Reading the ${typeNoun(readingType)} fields…`, sub: '' }
    : readingScan ? { message: 'Reading the scanned pages…', sub: `${readingScan.done} of ${readingScan.of} pages` }
    : exhibitReread && !extracting ? { message: 'Reading the contract again with its exhibits…', sub: '' }
    : extracting ? EXTRACTION_STEP_BANNER[extracting.step] ?? STATUS_BANNER.EXTRACTING : STATUS_BANNER[contract?.analysisStatus ?? '']

  // Stuck detection: in-progress but updatedAt hasn't changed in 3 minutes
  // PENDING is excluded — it's just queued, not stuck. An extraction job
  // marks each step and attempt, and a long contract's run (or a retry's
  // back-off) takes longer than a step elsewhere: 8 minutes from its last mark.
  const STUCK_THRESHOLD_MS = (extracting ? 8 : 3) * 60 * 1000
  const lastActivity = Math.max(
    contract?.updatedAt ? new Date(contract.updatedAt).getTime() : 0,
    extracting?.at ? new Date(extracting.at).getTime() : 0,
  )
  const isStuck = !!(
    contract?.analysisStatus &&
    STUCK_DETECTABLE.includes(contract.analysisStatus) &&
    lastActivity &&
    Date.now() - lastActivity > STUCK_THRESHOLD_MS
  )

  // Current step index in the pipeline (for the step indicator)
  const currentStepIdx = PIPELINE_STEPS.findIndex(s => s.statuses.includes(contract?.analysisStatus ?? ''))

  const splitMutation = useMutation({
    mutationFn: (specs: typeof splitSpecs) => api.post(`/contracts/${id}/split`, { splits: specs }).then(r => r.data),
    onSuccess: () => {
      setShowSplitModal(false)
      qc.invalidateQueries({ queryKey: ['contracts'] })
      qc.invalidateQueries({ queryKey: ['contract', id] })
      qc.invalidateQueries({ queryKey: ['contract-family', id] })
      navigate('/contracts')
    },
    // The route refuses a non-PDF binder (422) or a re-split that would
    // replace contracts that have moved on (409) — say which, and why.
    onError: (err: { response?: { data?: { detail?: string } } }) =>
      toast.error('Could not split this document', { description: err.response?.data?.detail ?? 'Try again.' }),
  })

  // Contract Family
  const [showAddRelated, setShowAddRelated] = useState(false)
  const { data: familyData } = useQuery({
    queryKey: ['contract-family', id],
    queryFn: () => api.get(`/contracts/${id}/family`).then(r => r.data),
    enabled: !!id,
  })

  // Negotiation (Phase 05)
  const [showShareDialog, setShowShareDialog] = useState(false)

  // Attachments
  const attachFileRef = useRef<HTMLInputElement>(null)
  const attachMutation = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData()
      form.append('file', file)
      form.append('label', file.name.replace(/\.[^.]+$/, ''))
      return api.post(`/contracts/${id}/attach`, form, { headers: { 'Content-Type': 'multipart/form-data' } })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contract', id] }),
    onError: (err: { response?: { data?: { detail?: string } } }) =>
      toast.error('Attachment not added', { description: err.response?.data?.detail ?? 'Upload failed. Try again.' }),
  })
  const deleteAttachment = useMutation({
    mutationFn: (idx: number) => api.delete(`/contracts/${id}/attachments/${idx}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contract', id] }),
  })
  const downloadAttachment = async (idx: number, filename: string) => {
    const res = await api.get(`/contracts/${id}/attachments/${idx}/download`)
    const a = document.createElement('a')
    a.href = res.data.url
    a.download = filename
    a.target = '_blank'
    a.click()
  }

  // Note: askMutation + handleAsk used to drive an in-page Ask tab.
  // U.4.4 moved that flow to the rail composer; both are now dead.
  // Refer to git history for the original implementation.

  // L6 #7 — this had no try/catch and no error state, while the sibling
  // handleViewPdf immediately below has both. On an agent-drafted or
  // pasted-HTML contract there is no original file, contracts.ts 404s, and the
  // dropdown just closed — the user saw a menu item that did nothing.
  const handleDownload = async (versionId?: string) => {
    setDownloadError(null)
    try {
      const res = await api.get(`/contracts/${id}/download`, {
        params: versionId ? { versionId } : undefined,
      })
      window.open(res.data.url, '_blank')
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status
      setDownloadError(
        status === 404
          ? 'This contract has no original file to download. It was drafted or pasted in, rather than uploaded.'
          : (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
            ?? 'Could not download this contract.',
      )
    }
  }

  const handleViewPdf = async () => {
    try {
      setPdfError(null)
      const res = await api.get(`/contracts/${id}/download`)
      setPdfUrl(res.data.url)
      setTab('document')
    } catch {
      setPdfError('Could not load document. No file attached or storage unavailable.')
      setTab('document')
    }
  }

  // ── Hooks that must run before early returns (Rules of Hooks) ─────────────
  const versions = versionsData?.data ?? contract?.versions ?? []
  // DD4 — the version the contract stands on, which an undo moves back; not
  // the newest.
  const standing = currentVersionOf(versions as Array<{ id: string; s3Key?: string | null; mimeType?: string | null; renderedPdfKey?: string | null }>, contract?.currentVersionId)
  // docs/41 P0.1 — Not analysed · Analysing · Analysed · vN · Failed at a step · stale.
  const analysis = analysisLine(
    { analysisStatus: contract?.analysisStatus ?? '', analysisError: contract?.analysisError, currentVersionId: contract?.currentVersionId ?? null, metadata: contract?.metadata },
    { currentVersionNumber: (standing as { versionNumber?: number } | undefined)?.versionNumber ?? null, checkpointSoon: true },
  )

  // U.1.2 — does the current version have an actual PDF/source file? When
  // null it's a text-only / template-generated contract — the Original
  // toggle would crash with "Invalid PDF structure". We disable it instead.
  // X49 — only a PDF: now that the version list carries the key, a DOCX or
  // TXT latest version would otherwise open the viewer on a file it can't read.
  // docs/39 A12 — a .doc or a scan kept as an image is shown as the PDF it was read from.
  const hasOriginal = !!(standing?.s3Key && (standing?.mimeType === 'application/pdf'
    || (standing?.renderedPdfKey && CONVERTED_TO_PDF.has(standing?.mimeType ?? ''))))
  // …but a Word or text upload still has an original: say that, not "created
  // from text or a template".
  const originalNotPdf = !!standing?.s3Key && !hasOriginal

  // X1 — a citation that knows its page opens the original PDF at it (the
  // passage is outlined there); without a source file, ?section= still
  // scrolls the styled view.
  useEffect(() => {
    if (!citeTarget.page || !hasOriginal) return
    setTab('document')
    if (docView !== 'original') {
      citationSwitchedView.current = true
      setDocView('original')
    }
  }, [citeTarget.page, hasOriginal])

  // docs/39 B2 — "Show in document": a field's source or a clause,
  // highlighted in the view the reader has open (the styled document or the
  // original PDF), switching to the document first. The request waits for
  // the view to be ready: from the Overview the canvas mounts first.
  const [pendingReveal, setPendingReveal] = useState<{ text: string; occurrence: number; tries: number } | null>(null)
  const showInDocument = (text: string, occurrence = 0) => {
    if (!text.trim()) return
    setTab('document')
    setPendingReveal({ text, occurrence, tries: 0 })
  }
  // docs/39 C1/C2 — a passage selected in the document, being set as a field's value.
  const [fieldPick, setFieldPick] = useState<TextSelection | null>(null)
  // docs/39 C1 — the original PDF's box (its selection menu listens there) and
  // each page's text, read once the file loads, to tell which of the passages
  // worded alike was picked.
  const [pdfBox, setPdfBox] = useState<HTMLDivElement | null>(null)
  const pdfPageTexts = useRef<string[] | null>(null)
  const readPdfPages = async ({ doc }: DocumentLoadEvent) => {
    pdfPageTexts.current = null
    const texts: string[] = []
    try {
      for (let i = 1; i <= Math.min(doc.numPages, 1000); i++) {
        const page = await doc.getPage(i)
        texts.push(pageTextOf((await page.getTextContent()).items as Array<{ str?: string }>))
      }
      pdfPageTexts.current = texts
    } catch { /* the count then starts at the selection's own page */ }
  }
  // docs/39 C3 — a passage a new field is being made from.
  const [newFieldFrom, setNewFieldFrom] = useState<TextSelection | null>(null)
  // docs/39 C4 — an AI finding being made a field.
  const [trackFinding, setTrackFinding] = useState<{ finding: AiFinding; rect: DOMRect } | null>(null)
  const { data: fieldCatalog = [] } = useFieldCatalog()
  // docs/39 E1 — a passage being tagged as a clause.
  const [clauseFrom, setClauseFrom] = useState<TextSelection | null>(null)
  const [libraryFrom, setLibraryFrom] = useState<TextSelection | null>(null)
  const showFieldSource = (f: ContractField) => {
    const text = f.anchor?.text ?? f.quote
    if (text) showInDocument(text, f.anchor?.occurrence ?? 0)
  }
  // docs/39 D6 — arriving from a diligence room's cell ("Show in the
  // contract"): the words its answer came from, highlighted. Carried in the
  // navigation's state, not the URL, so contract text stays out of history
  // and logs; cleared once used, so a reload doesn't jump there again.
  const location = useLocation()
  useEffect(() => {
    const reveal = (location.state as { reveal?: { text?: string; occurrence?: number } } | null)?.reveal
    if (!reveal?.text) return
    showInDocument(reveal.text, reveal.occurrence ?? 0)
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null })
  }, [location.key])
  useEffect(() => {
    if (!pendingReveal || tab !== 'document') return
    const notFound = () => toast.info("Couldn't find that passage in this view", {
      description: 'The document may word it slightly differently from the quote.',
    })
    const pdf = docView === 'original' && hasOriginal
    // Not mounted yet: canvasEditor changes when it is.
    if (!pdf && !viewOf(canvasEditorRef.current)) return
    const t = setTimeout(async () => {
      if (!pdf) {
        if (!revealInCanvas(canvasEditorRef.current, pendingReveal.text, pendingReveal.occurrence)) notFound()
        setPendingReveal(null)
        return
      }
      const search = () => layoutPluginRef.current.toolbarPluginInstance.searchPluginInstance
      const pattern = pdfSearchPattern(pendingReveal.text)
      const matches = pattern ? await search().highlight(pattern) : []
      // The PDF may still be loading: try for a few seconds before giving up.
      if (!matches.length && pendingReveal.tries < 6) { setPendingReveal({ ...pendingReveal, tries: pendingReveal.tries + 1 }); return }
      // The search opens on its first match; a later one once its matches are in state.
      const { occurrence } = pendingReveal
      if (!matches.length) notFound()
      else if (occurrence > 0) setTimeout(() => search().jumpToMatch(Math.min(occurrence, matches.length - 1) + 1), 150)
      setPendingReveal(null)
    }, pdf ? (pendingReveal.tries ? 500 : 50) : 50)
    return () => clearTimeout(t)
  }, [pendingReveal, tab, docView, hasOriginal, canvasEditor])

  const { data: commentsData } = useQuery({
    queryKey: ['comments', id],
    queryFn: () => api.get(`/contracts/${id}/comments`, { params: { limit: 1 } }).then(r => r.data),
    enabled: !!id,
    staleTime: 30_000,
  })

  // The threads on the contract, counted by the server: the rail said "9+"
  // whenever there were two or more (it fetched one and saw a next page).
  const commentCount: number | undefined = typeof commentsData?.total === 'number' ? commentsData.total : undefined

  const visibleTabs = useMemo(() => {
    const tabs: Tab[] = ['overview', 'clauses', 'document']
    tabs.push('comments')
    return tabs
  }, [versions.length])

  useEffect(() => {
    if (!visibleTabs.includes(tab)) setTab('document')
  }, [visibleTabs, tab])

  // docs/41 Part 16 — Comment and Request exception on selected words, in the
  // document and over the original PDF (rewriting is the workspace's job).
  const selectionExtras = useSelectionActions({
    contractId: id ?? '', editor: canvasEditor, versionId: contract?.currentVersionId ?? null, canEdit,
    clauses: ((clausesData?.data ?? []) as Array<{ id: string; content: string }>),
  })

  // B.1 — auto-load the PDF when Document is active and we haven't yet.
  // Kills the "click Load Document to see your own contract" dance.
  useEffect(() => {
    if (tab === 'document' && !pdfUrl && !pdfError && id) {
      handleViewPdf()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, id])


  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="size-6 animate-spin text-ink-400" />
      </div>
    )
  }

  if (!contract) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <AlertCircle className="size-10 text-ink-400" />
        <p className="text-body text-ink-500 font-medium">Contract not found</p>
        <Button variant="outline" onClick={() => navigate('/contracts')}>Back to Contracts</Button>
      </div>
    )
  }

  const keyTerms = contract.keyTerms ?? {}
  const riskFactors: string[] = contract.riskFactors ?? []
  const clauseFlags: Record<string, boolean> = currentVersionOf(contract.versions as Array<{ id: string; clauseFlags?: Record<string, boolean> }>, contract.currentVersionId)?.clauseFlags ?? {}
  // P2.1 — trust-signal: was this version's text produced by OCR? If
  // yes, the badge in the header lets Legal eyeball "this is scan-
  // derived text; extraction confidence is lower than a digital PDF".
  // P3.1 note — the editor autosave creates new versions without
  // structure metadata. Walk versions[] and pick the most recent one
  // that actually carries structure (or extraction), falling back to
  // versions[0] so existing code paths don't regress.
  const latestVersionMeta = (() => {
    const all = (contract.versions ?? []) as Array<{ id: string; metadata?: Record<string, unknown> }>
    // DD4 — the standing version first, then the most recent before it.
    const current = currentVersionOf(all, contract.currentVersionId)
    const versions = current ? [current, ...all.filter(v => v !== current)] : all
    const withStructure = versions.find(v => {
      const md = v.metadata ?? {}
      return md.structure || md.extraction
    })
    return ((withStructure ?? versions[0])?.metadata ?? {}) as Record<string, unknown>
  })()
  const extractionMeta = (latestVersionMeta.extraction ?? {}) as {
    ocrApplied?: boolean
    ocrBackend?: string
    pageCount?:  number
    ocrPages?:   number
    // docs/39 A7 — how sure the OCR engine was of each page, and what it couldn't read.
    ocrQuality?:   Array<{ page: number; confidence: number | null; failed?: boolean }>
    unreadPages?:  number[]
    ocrTruncated?: boolean
  }
  const ocrApplied = extractionMeta.ocrApplied === true
  const unclearPages = (extractionMeta.ocrQuality ?? [])
    .filter(q => !q.failed && q.confidence != null && q.confidence < POOR_SCAN).map(q => q.page)
  const unreadPages = extractionMeta.unreadPages ?? []
  // Pages past the limit — or past page 40, for a scan read before A7.
  const pagesNotRead = extractionMeta.ocrTruncated || (!extractionMeta.ocrQuality && (extractionMeta.ocrPages ?? 0) < (extractionMeta.pageCount ?? 0))
    ? Math.max(0, (extractionMeta.pageCount ?? 0) - (extractionMeta.ocrPages ?? 0)) : 0
  const presentFlags = Object.entries(CLAUSE_FLAG_LABELS).filter(([k]) => clauseFlags[k] === true)
  const keyTermEntries = Object.entries(keyTerms).filter(([, v]) => v != null && v !== '' && v !== false)
  const hasAnalysis = !!(contract.summary || keyTermEntries.length > 0)

  // Custom fields + AI findings from contract.metadata
  const customMeta = (contract.metadata ?? {}) as Record<string, unknown>
  // C4 — a finding the org has since made a field is that field now: shown in Fields, not here.
  const aiFindings: AiFinding[] = ((customMeta._aiFindings as AiFinding[]) ?? [])
    .filter(f => !fieldCatalog.some(c => sameFieldName(c.label, f.label) || sameFieldName(c.key, f.key)))
  const trackFindingButton = (f: AiFinding) => (canCreateFields || canSuggestFields) && (
    <button
      type="button"
      onClick={e => setTrackFinding({ finding: f, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
      className="shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-ink-700 hover:bg-paper-100 hover:text-ink-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={canCreateFields ? 'Add it as a field, with this value on this contract' : 'Suggest it as a field to your admins'}
      data-testid={`track-finding-${f.key}`}
    >
      {canCreateFields ? 'Track as field' : 'Suggest as field'}
    </button>
  )

  // Suggested questions used to live here for the in-page Ask tab
  // (U.4.4 deleted). When we add per-contract suggested prompts on
  // the rail, the canonical seed list is in git history.

  return (
    <div className="h-full flex flex-col bg-paper-50">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      {/*
        U.8 (header v2) — restructured into two explicit rows so metadata
        no longer wraps under the title block at MBA-class viewports.
        Row 1: back arrow + title (line-clamp-2) + action buttons.
        Row 2: a single full-width metadata strip (status / matter / type
        / jurisdiction / risk / owner / edited / value / expiry) that
        wraps gracefully only at very narrow widths. Title now has the
        whole row's width up to the buttons; metadata has the whole row
        below. Same JTBDs, no 4-row stack.
      */}
      <div className="bg-card border-b border-paper-200 px-6 py-4 space-y-2.5">
        {/* Row 1 — title + action buttons.

            `flex-wrap` + a floor on the title block is load-bearing, not
            cosmetic: the action cluster is `flex-shrink-0`, so on a 1440px
            laptop with the assistant panel open the buttons ate the entire
            row and the contract TITLE collapsed to zero width — the page
            rendered a toolbar with no name on it. The buttons now drop to
            their own line instead of erasing the record's identity. */}
        <div className="flex items-start justify-between gap-x-4 gap-y-2 flex-wrap">
          <div className="flex items-start gap-3 flex-1 min-w-[18rem]">
            <button
              onClick={() => navigate('/contracts')}
              className="mt-0.5 p-1.5 rounded-md text-ink-400 hover:text-ink-950 hover:bg-paper-100 transition-colors flex-shrink-0"
            >
              <ArrowLeft className="size-4" />
            </button>
            <h1
              className="text-title text-ink-950 line-clamp-2 break-words flex-1 min-w-0"
              title={contract.title}
            >
              {contract.title}
            </h1>
            <button
              type="button"
              onClick={() => {
                if (!id) return
                navigator.clipboard.writeText(id)
                  .then(() => toast.success('Copied', { description: 'Contract ID copied to clipboard' }))
                  .catch(() => toast.error('Copy failed', { description: "Couldn't access the clipboard" }))
              }}
              title="Copy contract ID"
              aria-label="Copy contract ID"
              className="mt-0.5 p-1.5 rounded-md text-ink-400 hover:text-ink-950 hover:bg-paper-100 transition-colors flex-shrink-0"
            >
              <Copy className="size-4" />
            </button>
          </div>
          {/* Row 1 right — action buttons.

              Hierarchy, not a queue. This row used to run nine controls at
              five weights, so nothing read as the next step. It is now two
              tiers separated by a hairline:

                view chrome  — Styled/Original, Risk markers, Compare, and the
                               rail fold. These change what you are LOOKING at.
                               Quiet: no button chrome, ink-500 until hovered.
                decisions    — Edit, the single workflow CTA, Actions. These
                               change the CONTRACT. Full weight.

              Same controls, same testids, same breakpoints — the difference is
              that the eye now lands on the decision. */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {/*
              B.5.2 — Styled / Original document-view toggle.
              - "Styled" (default): TipTap + contract-paper CSS. Editable when
                user flips Edit mode (B.5.3).
              - "Original": the source PDF via @react-pdf-viewer. Read-only,
                pixel-exact. The escape hatch that wins Legal's trust.
              Persisted per user (localStorage).
            */}
            {/*
              B.6.12 — hide on <1280px. The toggle moves into the
              Actions menu below xl so the primary CTA stays visible.
            */}
            {/* ── Tier 1: view chrome. Recessive by construction. ── */}
            <div className="hidden xl:flex items-center gap-0.5 mr-1.5 pr-2 border-r border-paper-200">
            <div className="inline-flex items-center rounded-md border border-paper-200 bg-paper-50 p-0.5">
              <button
                onClick={() => setDocView('styled')}
                aria-pressed={docView === 'styled'}
                disabled={isEditing}
                title={isEditing ? 'Exit Edit mode to switch to Original PDF' : undefined}
                className={cn(
                  'px-2.5 py-1 text-[11.5px] font-semibold rounded-chip transition-colors',
                  docView === 'styled'
                    ? 'bg-card text-ink-950 shadow-e1'
                    : 'text-ink-400 hover:text-ink-950',
                  isEditing && 'opacity-60 cursor-not-allowed',
                )}
              >
                Styled
              </button>
              <button
                onClick={() => hasOriginal && setDocView('original')}
                aria-pressed={docView === 'original'}
                disabled={isEditing || !hasOriginal}
                title={
                  isEditing
                    ? 'Exit Edit mode to switch to Original PDF'
                    : originalNotPdf
                      ? 'The original file isn\u2019t a PDF, so it can\u2019t be shown here. Download it from Actions.'
                      : !hasOriginal
                        ? 'No original file — this contract was created from text or a template.'
                        : 'View the original PDF — pixel-exact, read-only.'
                }
                data-testid="doc-view-original"
                className={cn(
                  'px-2.5 py-1 text-[11.5px] font-semibold rounded-chip transition-colors',
                  docView === 'original'
                    ? 'bg-card text-ink-950 shadow-e1'
                    : 'text-ink-400 hover:text-ink-950',
                  (isEditing || !hasOriginal) && 'opacity-60 cursor-not-allowed',
                )}
              >
                Original
              </button>
            </div>

            {/*
              B.5.5 — Risk visibility control. Only shown in Styled view
              (PDF viewer can't decorate). Three levels per the design:
              Off / Summary (margin dots) / Full (underlines + dots).
              B.6.12 — hidden below xl (collapsed into Actions menu).
            */}
            {docView === 'styled' && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="hidden 2xl:inline-flex gap-1 text-ink-500 hover:text-ink-950">
                    Risks: <span className="font-semibold capitalize">{riskView}</span>
                    <ChevronDown className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={() => setRiskView('full')}>
                    <span className="size-1.5 rounded-full bg-risk-600" />
                    Full — underlines + margin dots
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setRiskView('summary')}>
                    <span className="size-1.5 rounded-full bg-ink-400" />
                    Summary — margin dots only
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setRiskView('off')}>
                    <span className="size-1.5 rounded-full bg-transparent border border-paper-300" />
                    Off — no markers
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/*
              U.4.4 — toolbar agent-button deleted. The right rail is
              the single AI entry point on contract pages. ⌘K focuses
              it; the rail's Context header shows the current contract;
              the rail's /-slash menu carries the curated quick-actions
              this button used to host.
            */}

            {/*
              B.5.13 — Compare Versions entry. P7.4.15 / F-33 — we now
              always render the button so the feature is discoverable;
              when only 1 version exists it's disabled with a tooltip
              explaining why. (Hiding it entirely meant first-time
              users never learned the feature existed.)
              P28 audit (2026-04-30): the breakpoint was `2xl` (1536px),
              meaning standard 13" laptop users (1440x900) never saw
              this button — they could only reach Compare via the
              Actions kebab. Lowered to `xl` (1280px) so it's a primary
              action everywhere a real user works. The Actions kebab
              still has compare-menu-item as a backup for narrower
              widths.
            */}
            {/* docs/41 Part 16 (C2) — the full-screen workspace (lib/workspace.ts says which contracts open there first). */}
            <Button variant="outline" size="sm" onClick={() => navigate(workspacePath(id!))} className="gap-1.5" data-testid="open-workspace-btn" title="Work on this contract full screen: the document, its review and its changes">
              <Maximize2 className="size-4" />
              Open workspace
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={versions.length < 2}
              onClick={() => {
                openChanges()
                track('compare_opened', { versionCount: versions.length })
              }}
              className="gap-1.5 text-ink-500 hover:text-ink-950"
              title={versions.length < 2
                ? 'Upload a second version to compare. Until then there is nothing to diff.'
                : 'Compare two versions with redline attribution'}
              data-testid="compare-btn"
            >
              <ArrowLeftRight className="size-4" />
              Compare
            </Button>

            {/*
              Rail fold. The single biggest lever on "the document is the
              hero" — see the railCollapsed note above. Icon-only because it
              is chrome about chrome.
            */}
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleRail}
              aria-pressed={railCollapsed}
              data-testid="rail-toggle-btn"
              title={railCollapsed
                ? 'Show the details rail (⌥\\)'
                : 'Hide the details rail and widen the document (⌥\\)'}
              aria-label={railCollapsed ? 'Show details rail' : 'Hide details rail'}
              className="text-ink-500 hover:text-ink-950"
            >
              {railCollapsed ? <PanelRightOpen className="size-4" /> : <PanelRightClose className="size-4" />}
            </Button>
            </div>

            {/*
              B.5.3 — Edit toggle. In view mode it reads "✏ Edit"; in edit
              mode it becomes "● Editing" and the primary return action.
              Edit requires Styled view (can't type into a PDF).
            */}
            {isEditing ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => canvasEditorRef.current?.chain().focus().undo().run()}
                  disabled={!canvasEditorRef.current?.can().undo()}
                  className="gap-1.5"
                  aria-label="Undo"
                  title="Undo (⌘Z)"
                >
                  <RefreshCw className="size-4 -scale-x-100" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => canvasEditorRef.current?.chain().focus().redo().run()}
                  disabled={!canvasEditorRef.current?.can().redo()}
                  className="gap-1.5"
                  aria-label="Redo"
                  title="Redo (⌘⇧Z)"
                >
                  <RefreshCw className="size-4" />
                </Button>
                <span
                  className={cn('text-dense text-ink-400 min-w-[4rem] text-center', saveState === 'error' && 'text-risk-700')}
                  data-testid="draft-save-state"
                >
                  {draftStatusText(saveState)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setSaveVersionError(null); setSaveVersionOpen(true) }}
                  disabled={!draft.hasDraft()}
                  title={draft.hasDraft() ? 'Make a version of your draft changes, with a note' : 'Nothing changed since the last version'}
                  data-testid="save-as-version"
                >
                  Save as version
                </Button>
                {/* Outlined: the ink fill in this header belongs to the one
                    workflow CTA, and leaving edit mode is chrome. */}
                <Button variant="outline" size="sm" onClick={exitEdit} className="gap-1.5">
                  <CheckCircle2 className="size-4" /> Done
                </Button>
              </>
            ) : canEdit ? (
              <Button
                variant="outline"
                size="sm"
                onClick={enterEdit}
                className="gap-1.5"
                title="Edit this document (⌘E)"
                data-testid="enter-edit-btn"
              >
                <FileEdit className="size-4" /> Edit
              </Button>
            ) : mayEdit && externalEdit ? (
              <Button
                variant="outline"
                size="sm"
                disabled
                className="gap-1.5"
                title={`${externalEdit.startedByName} is editing this contract in Google Docs`}
                data-testid="edit-locked-btn"
              >
                <FileEdit className="size-4" /> In Google Docs
              </Button>
            ) : null}

            {/* Phase 07 — Send-for-Signature primary CTA.
                Visible on every non-terminal status; the dialog itself
                handles version/perm/already-executed gating. Send-for-Review
                still owns the slot in DRAFT/PENDING_REVIEW/UNDER_NEGOTIATION
                (it remains the recommended workflow path), and Send-for-Signature
                is shown alongside it for orgs that approve outside the system
                or want to skip approvals on low-risk contracts.

                It is NOT a brand-fill button. Emerald means the state "binding"
                — approved, executed, signed — and sending something out for
                signature is the act that starts that, not the state itself.
                (The design system's own send-for-signature dialog confirms with
                an ink button.) So this takes the ink primary only when
                Send-for-Review is absent; while both are on screen, review owns
                the single primary slot and this one steps back to outline. */}
            {canSign && !['EXECUTED', 'EXPIRED', 'TERMINATED', 'ARCHIVED'].includes(contract?.status ?? '') && (
              <Button
                // The status banner owns the one primary action (docs/41 Part 18).
                variant="outline"
                size="sm"
                onClick={() => setSendForSignatureOpen(true)}
                // docs/41 P0.4/P0.8 — not with a term still to choose, nor before approval.
                disabled={!!openChoicesReason || !!signGateReason}
                title={signGateReason ?? openChoicesReason ?? undefined}
                className="gap-1.5"
                data-testid="send-for-signature-btn"
              >
                <PenLine className="size-4" />
                {contract?.status === 'PENDING_SIGNATURE' ? 'Resend for Signature' : 'Send for Signature'}
              </Button>
            )}
            {/*
              B.1 — five secondary actions collapsed into one kebab menu.
              The primary CTA (Send for Review / Mark Executed / Archive —
              whichever applies to the current state) remains visible; the
              rest go under `⋯` so the top row stays readable.
            */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                {/*
                  B.5.4 — kebab renamed to [Actions ▾]. Holds parallel
                  actions that stay useful regardless of whether a user
                  is reviewing, editing, or approving. "Open in Editor"
                  removed — editing now happens on this same canvas via
                  the Edit toggle (B.5.3).
                */}
                <Button variant="outline" size="sm" className="gap-1.5" aria-label="More actions">
                  Actions <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {/*
                  Below xl (1280): inline Styled toggle hides → mirror it
                  here. Below 2xl (1536): inline Risks + Compare hide →
                  mirror them here. Each item appears only when its inline
                  twin is hidden, so we never have duplicate triggers.
                */}
                <div className="xl:hidden">
                  <DropdownMenuItem
                    onSelect={() => setDocView(docView === 'styled' ? 'original' : 'styled')}
                    disabled={isEditing}
                  >
                    <FileText className="size-4" />
                    {docView === 'styled' ? 'View original PDF' : 'Back to styled view'}
                  </DropdownMenuItem>
                </div>
                <div className="2xl:hidden">
                  {docView === 'styled' && (
                    <DropdownMenuItem
                      onSelect={() =>
                        setRiskView(
                          riskView === 'full' ? 'summary' : riskView === 'summary' ? 'off' : 'full',
                        )
                      }
                    >
                      <AlertTriangle className="size-4" />
                      Risk markers: <span className="ml-1 capitalize font-medium">{riskView}</span>
                    </DropdownMenuItem>
                  )}
                </div>
                {/* Compare is inline from xl up, so the mirror stops at xl —
                    it used to stop at 2xl, which double-listed it between
                    1280 and 1536 (two triggers, one action). */}
                <div className="xl:hidden">
                  <DropdownMenuItem
                    disabled={versions.length < 2}
                    onSelect={() => {
                      if (versions.length < 2) return
                      openChanges()
                      track('compare_opened', { versionCount: versions.length, source: 'actions_menu' })
                    }}
                    data-testid="compare-menu-item"
                  >
                    <ArrowLeftRight className="size-4" />
                    Compare versions
                    {versions.length < 2 && (
                      <span className="ml-auto text-[10px] text-muted-foreground">need 2+</span>
                    )}
                  </DropdownMenuItem>
                </div>
                <div className="2xl:hidden">
                  <DropdownMenuSeparator />
                </div>
                {/* Y3 — offered only to those who may: sharing needs
                    configure:contract, an amendment create:contract. */}
                <Can request="POST /contracts/:id/share">
                  <DropdownMenuItem
                    onSelect={() => setShowShareDialog(true)}
                    // docs/41 P0.4 — the counterparty never gets a draft with a term still to choose.
                    disabled={!!openChoicesReason}
                    title={openChoicesReason ?? undefined}
                    data-testid="share-menu-item"
                  >
                    <Share2 className="size-4" /> Share
                    {openChoicesReason && <span className="ml-auto text-[10px] text-muted-foreground">choose terms first</span>}
                  </DropdownMenuItem>
                </Can>
                {/* P8 Step 8 — spawn an amendment / SOW / order-form / renewal
                    that links back to this contract via parentContractId. */}
                <Can request="POST /contracts/:id/amendments">
                  <DropdownMenuItem onSelect={() => setCreateAmendmentOpen(true)} data-testid="create-amendment-menu-item">
                    <GitBranch className="size-4" /> Create amendment
                  </DropdownMenuItem>
                </Can>
                {/* BB4 — their Word file, round-tripped. */}
                <Can request="POST /contracts/:id/external-edit/start">
                  <DropdownMenuItem
                    onSelect={() => setGoogleDocsOpen(true)}
                    disabled={!!externalEdit}
                    data-testid="edit-in-google-docs-menu-item"
                  >
                    <FileEdit className="size-4" /> Edit in Google Docs
                  </DropdownMenuItem>
                </Can>
                <Can request="GET /contracts/:id/redline/counterparty">
                  <DropdownMenuItem
                    disabled={redlinePending}
                    onSelect={async () => {
                      if (!id) return
                      setRedlinePending(true)
                      setRedlineNotice(null)
                      setRedlineNotice(await downloadForCounterparty(id))
                      setRedlinePending(false)
                    }}
                    data-testid="download-for-counterparty-menu-item"
                  >
                    {redlinePending ? <Loader2 className="size-4 animate-spin" /> : <FileDown className="size-4" />}
                    Download for counterparty (Word)
                  </DropdownMenuItem>
                </Can>
                {/* P9 Step 6 — bundle audit trail + signers + signed PDF into
                    a single auditor-ready compliance package. */}
                {contract?.status === 'EXECUTED' && id && (
                  <DropdownMenuItem
                    onSelect={async () => {
                      try {
                        const r = await api.get(`/contracts/${id}/compliance-export`, { responseType: 'blob' })
                        const blob = new Blob([r.data], { type: 'application/pdf' })
                        const url = URL.createObjectURL(blob)
                        const a = document.createElement('a')
                        a.href = url
                        a.download = `compliance-${contract.title?.replace(/[^\w.\-]+/g, '_').slice(0, 60) ?? 'contract'}-${new Date().toISOString().slice(0, 10)}.pdf`
                        document.body.appendChild(a); a.click(); a.remove()
                        URL.revokeObjectURL(url)
                      } catch (err) {
                        console.error('compliance export failed', err)
                      }
                    }}
                    data-testid="compliance-export-menu-item"
                  >
                    <FileText className="size-4" /> Compliance package (PDF)
                  </DropdownMenuItem>
                )}
                {/* U.4.4 — Actions menu agent-item deleted. Use ⌘K or
                    the right rail. The 'ask' tab is also gone. */}
                <DropdownMenuSeparator />
                {/* U.1.2 — only offer "View PDF" when there's actually one */}
                {hasOriginal && (
                  <DropdownMenuItem onSelect={handleViewPdf}>
                    <FileText className="size-4" /> View PDF in new tab
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => handleDownload()}>
                  <Download className="size-4" /> Download
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {externalEdit && id && (
          <ExternalEditBanner contractId={id} lock={externalEdit} canPublish={mayEdit} />
        )}
        {redlineNotice && <RedlineNoticeBanner notice={redlineNotice} onDismiss={() => setRedlineNotice(null)} />}
        {downloadError && (
          <div
            role="alert"
            data-testid="contract-download-error"
            className="mt-2 flex items-start justify-between gap-3 rounded-md border border-risk-200 bg-risk-50 px-3 py-2 text-dense text-risk-900"
          >
            <span className="min-w-0 break-words">{downloadError}</span>
            <button
              type="button"
              onClick={() => setDownloadError(null)}
              className="shrink-0 font-semibold text-risk-700 hover:text-risk-900"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Row 2 — the record strip. Indented `pl-11` so it lines up with
            the title text (back-button + gap).

            This was nine affordances at five weights with no order: a status
            pill, a dashed action button, a sync badge, a type chip, a text
            link, a jurisdiction, an amber risk wash, an avatar, and four grey
            facts — all competing, and the one time-critical number ("Expires
            in 29d") rendered in the quietest grey on the row while a static
            risk SCORE got the loudest wash. Colour was inverted against
            urgency.

            It is now three groups, hairline-separated, read left to right:

              STATE     what is true right now, and what is running out.
                        The only place in this row allowed a colour.
              RECORD    what this document is — type, law, money, matter.
              PROVENANCE who owns it, when it moved, how the text was got.
                        Dimmest; it is context, never the answer.
        */}
        <div
          className="flex items-center flex-wrap gap-x-2.5 gap-y-1.5 pl-11 text-[11.5px]"
          data-testid="contract-meta-row"
        >
          {/* ── STATE ─────────────────────────────────────────────────── */}
          <StatusPill status={contract.status} />
          {openChoices.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setFocusVariable(openChoices[0].key)
                if (isXl) setRailCollapsed(false)
                else setRailOpen(true)
              }}
              className="inline-flex items-center gap-1 rounded-chip border border-attention-200 bg-attention-50 px-1.5 py-0.5 text-[11px] font-medium text-attention-700 hover:bg-attention-100"
              title={openChoicesReason ?? undefined}
              data-testid="open-choices-chip"
            >
              {openChoices.length === 1 ? '1 choice needed' : `${openChoices.length} choices needed`}
            </button>
          )}

          {/*
            Expiry. Calendar days, not elapsed milliseconds — the header said
            "29d" while the Renewal rail said "30d" for the same date on the
            same screen, because only one of them normalised to midnight.
            See components/contracts/dates.ts.

            It takes the wash when it is genuinely news (lapsed, or inside the
            30-day notice window). That wash is the row's one exception, which
            is why the risk score below gives its own up.
          */}
          {(() => {
            const exp = expiryLabel(contract.expiryDate)
            if (!exp) return null
            const meaning = exp.tone === 'risk' ? 'risk' : exp.tone === 'turn' ? 'turn' : null
            return (
              <span
                title={`Expires ${new Date(contract.expiryDate).toLocaleDateString()}`}
                data-testid="contract-expiry-chip"
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-medium tabular-nums',
                  meaning === 'risk'
                    ? [MEANING_CLASS.risk.wash, MEANING_CLASS.risk.washFg, 'border', MEANING_CLASS.risk.washBorder]
                    : meaning === 'turn'
                      ? ['border border-paper-200 bg-paper-100 text-ink-700']
                      : 'text-ink-500',
                )}
              >
                {meaning === 'turn' && (
                  <span className={cn('size-1.5 shrink-0 rounded-full', MEANING_CLASS.turn.dot)} aria-hidden />
                )}
                {exp.label}
              </span>
            )
          })()}

          {/*
            Risk score. Demoted from a full amber/red wash to the system's
            default treatment — neutral chip, coloured meaning dot. A risk
            score is a standing reading, not an event; washing it amber on
            every medium-risk contract (34–66, i.e. most of the portfolio)
            made amber the modal colour of the page and left nothing louder
            for the deadline that actually moves.
          */}
          {contract.riskScore != null && (() => {
            const band = riskBand(normalizeRisk(contract.riskScore)!)
            return (
              <span
                title={`Risk score ${normalizeRisk(contract.riskScore)} of 100 — ${band} band`}
                data-testid="contract-risk-chip"
                className="inline-flex items-center gap-1.5 rounded-full border border-paper-200 bg-paper-100 px-2.5 py-0.5 font-medium tabular-nums text-ink-700"
              >
                <span className={cn('size-1.5 shrink-0 rounded-full', RISK_BAND_CLASS[band])} aria-hidden />
                Risk {normalizeRisk(contract.riskScore)}
              </span>
            )
          })()}

          <span className="h-3.5 w-px bg-paper-200" aria-hidden />

          {/* ── RECORD ────────────────────────────────────────────────── */}
          {editingType ? (
            <select
              ref={typeSelectRef}
              autoFocus
              defaultValue={contract.type}
              disabled={retype.isPending}
              onBlur={() => setEditingType(false)}
              onChange={(e) => {
                if (e.target.value !== contract.type) retype.mutate(e.target.value)
                else setEditingType(false)
              }}
              aria-label="Contract type"
              className="text-[11.5px] font-semibold border border-paper-300 rounded-full px-2.5 py-0.5 bg-card text-ink-950 cursor-pointer focus:outline-none focus:border-brand-700 focus:ring-[3px] focus:ring-brand-700/15"
            >
              {CONTRACT_TYPES.map(t => (
                <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
              ))}
            </select>
          ) : (
            /*
              Type is one control, not two. It was a static chip plus a
              separate "Correct type" text link — a second affordance, at a
              third weight, whose only job was to make the first one editable.
              The chip itself is now the button.
            */
            <button
              type="button"
              onClick={() => setEditingType(true)}
              title="Click to correct the contract type"
              data-testid="contract-type-chip"
              className={cn(
                'px-2.5 py-0.5 rounded-full text-[11.5px] font-semibold border transition-colors',
                'hover:border-paper-300 hover:bg-paper-100',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                TYPE_COLORS[contract.type] ?? TYPE_COLORS.OTHER,
              )}
            >
              {contract.type.replace(/_/g, ' ')}
            </button>
          )}
          {contract.jurisdiction && (
            <span className="text-ink-500" title="Governing law">⚖ {contract.jurisdiction}</span>
          )}
          {/* docs/39 A11 — a contract not in English says so: its quotes are in its own language. */}
          {(contract as any).metadata?._language?.code && (contract as any).metadata._language.code !== 'en' && (
            <span className="text-ink-500" title="The language the contract is written in, as read from its text" data-testid="contract-language">
              {(contract as any).metadata._language.name}
            </span>
          )}
          {contract.value != null && (
            <span
              title="Contract value"
              data-testid="contract-value-chip"
              className="font-medium text-ink-950 tabular-nums"
            >
              {(contract.currency ?? 'USD')} {Number(contract.value).toLocaleString()}
            </span>
          )}
          {id && (
            <ContractMatterPicker contractId={id} currentMatterId={(contract as unknown as { matterId?: string | null }).matterId ?? null} />
          )}

          <span className="h-3.5 w-px bg-paper-200" aria-hidden />

          {/* ── PROVENANCE ────────────────────────────────────────────── */}
          {contract.owner?.name && (
            <span
              className="inline-flex items-center gap-1.5 text-ink-500"
              title={`Owner: ${contract.owner.name}`}
              data-testid="contract-owner-chip"
            >
              {/* The owner is a person, not the machine — the indigo avatar this
                  used to be is now the system's neutral initials chip. */}
              <span
                aria-hidden
                className="size-5 rounded-full bg-paper-100 text-ink-700 flex items-center justify-center text-[9.5px] font-semibold ring-1 ring-paper-200"
              >
                {contract.owner.name.split(/\s+/).filter(Boolean).slice(0, 2).map((p: string) => p[0]?.toUpperCase()).join('') || '?'}
              </span>
              <span className="text-ink-500">{contract.owner.name}</span>
            </span>
          )}
          {contract.updatedAt && (
            <span
              className="text-ink-500"
              title={new Date(contract.updatedAt).toLocaleString()}
              data-testid="contract-edited-chip"
            >
              Edited {relativeTime(contract.updatedAt)}
            </span>
          )}
          {ocrApplied && (
            <span
              data-testid="contract-ocr-badge"
              title={`Text was OCR'd from scan (${extractionMeta.ocrBackend ?? 'unknown'}, ${extractionMeta.ocrPages ?? 0}/${extractionMeta.pageCount ?? 0} pages). Treat extracted fields with higher review bar.`
                + (unclearPages.length ? ` Hard to read: ${unclearPages.length === 1 ? 'page' : 'pages'} ${pageList(unclearPages)}. Values from ${unclearPages.length === 1 ? 'it' : 'them'} are marked Check.` : '')}
              // Provenance, not "your turn": this badge is a permanent fact
              // about how the text was obtained and rides along on executed and
              // archived contracts too. Nothing is blocked on the user, so it
              // stays neutral rather than competing with the status pill beside
              // it for the one attention colour on the row.
              className="inline-flex items-center gap-1 rounded-full border border-paper-200 bg-paper-100 px-2 py-0.5 text-[10.5px] font-medium text-ink-700"
            >
              <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 8h10M7 12h10M7 16h6" /></svg>
              OCR'd
              {unclearPages.length > 0 && <span className="text-attention-700" data-testid="contract-ocr-unclear">· {unclearPages.length} page{unclearPages.length === 1 ? '' : 's'} unclear</span>}
            </span>
          )}
        </div>
      </div>

      {/*
        B.1.5b — two-column body shell.
        Left column (flex-1): tabs + current tab content. Survives until
        B.1.5f migrates the last tab into the rail and the tabs row is
        deleted.
        Right column (w-80): rail with collapsible sections. Empty
        placeholder this commit; populated in B.1.5c-f.
      */}
      <div className="flex-1 flex overflow-hidden min-h-0">
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">

      {/*
        B.1.5f — tabs row deleted. Document is permanently the main-area
        content; everything else (Overview, Key Terms, Risks, Clauses,
        History, Comments, Activity) lives in the right rail. The handful
        of screens that still use tab-like states (`ask`, `negotiate`) are
        reached via the kebab menu or rail actions and render as overlays.
      */}

      {/*
        docs/41 Parts 12, 18 — the status banner: stage progress, state and
        whose turn in words, the one next action, approvals x/y, signatures
        x/y, why it came back. It replaces the negotiation strip (which
        guessed the turn in the browser), the "returned" banner, the
        signature revert banner and the header's status buttons; everyone
        sees it, the approver too (their decision strip follows).
      */}
      {id && (
        <StatusBanner
          contractId={id}
          onSubmit={() => setSendForReviewOpen(true)}
          onSendForSignature={() => setSendForSignatureOpen(true)}
          onReviewChanges={openChanges}
          onOpenHistory={() => setHistoryOpen(true)}
        />
      )}

      {/*
        B.5.10 — Approver Mode: Decision Strip. Only renders when the current
        user has a PENDING approval step on this contract (see docs/26
        State 4). Compresses the review signal — AI confidence, risk,
        recommendation, top blocker — into one row with Approve / Reject /
        Delegate CTAs, so the approver can decide without tab-hunting.
      */}
      {isApproverMode && approvalData && (
        <DecisionStrip
          awaitingMe={approvalData}
          riskScore={contract?.riskScore ?? null}
          onJumpToClause={jumpToClause}
          onDecided={() => { refetchApproval() }}
        />
      )}

      {/* ── AI Drafting Banner ──────────────────────────────────────────────
          The model is writing the document — one of the few surfaces on this
          page that genuinely earns the assist accent. */}
      {contract?.analysisStatus === 'DRAFTING' && (
        // Tint, not a saturated band. Assist still owns the colour — this is
        // genuinely machine-authored work — but a background job is chrome,
        // and chrome recedes. See the note on the pipeline banner below.
        <div className="bg-assist-50 border-b border-assist-200 text-assist-700 px-6 py-2.5 flex items-center gap-3 text-body">
          <Loader2 className="size-4 animate-spin flex-shrink-0" />
          <div className="flex-1">
            <span className="font-medium">AI is generating a first draft from your request…</span>
            <span className="text-ink-500 text-dense ml-2">(~30–60 seconds)</span>
          </div>
          {isStuck && (
            <div className="flex items-center gap-3 flex-shrink-0 border-l border-assist-200 pl-3 ml-1">
              <span className="text-ink-500 text-dense">Taking too long?</span>
              <button
                onClick={() => cancelAnalysis.mutate()}
                disabled={cancelAnalysis.isPending}
                className="text-dense font-medium text-assist-700 hover:text-assist-900 underline underline-offset-2"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Analysis Progress Banner ───────────────────────────────────────
          Pipeline states resolve to "inflight" in lib/status, so the banner
          takes info rather than the ink an action would get.

          It used to be a full-bleed `bg-info-600` band in white type — the
          single loudest element on a page whose declared hero is the paper,
          and louder than the FAILED banner directly below it, which is a
          quiet risk tint. So an ordinary background job shouted and an actual
          extraction failure whispered. Both are now tints of their meaning,
          which puts them in the right order: failure reads louder because red
          on the page is rarer than blue. */}
      {contract?.analysisStatus && contract.analysisStatus !== 'DRAFTING' && banner && (
        <div className="bg-info-50 border-b border-info-200 text-info-700 px-6 py-2.5 flex items-center gap-3 text-body" data-testid="analysis-progress">
          <Loader2 className="size-4 animate-spin flex-shrink-0" />
          <span className="font-medium">{banner.message}</span>
          {banner.sub && (
            <span className="text-ink-500 text-dense">{banner.sub}</span>
          )}
          {/* A1 — a retry says so, and why the last attempt failed. */}
          {extracting && extracting.attempt > 1 && (
            <span className="text-attention-700 text-dense" title={extracting.error ? `The last attempt failed: ${extracting.error}` : undefined} data-testid="analysis-retrying">
              Retrying ({extracting.attempt}/{extracting.of})
            </span>
          )}
          {/* Step indicator — not for a retype's read, which is one step */}
          <div className={cn('ml-auto flex items-center gap-2.5 flex-shrink-0', readingType && 'hidden')}>
            {PIPELINE_STEPS.map((step, i) => {
              const isActive = i === currentStepIdx
              const isPast = i < currentStepIdx
              return (
                <div
                  key={i}
                  className={`flex items-center gap-1 text-[10px] font-medium transition-colors ${
                    isActive ? 'text-info-700' : isPast ? 'text-info-600' : 'text-ink-400'
                  }`}
                >
                  <div className={`size-1.5 rounded-full flex-shrink-0 transition-colors ${
                    isActive ? 'bg-info-600' : isPast ? 'bg-info-200' : 'bg-paper-300'
                  }`} />
                  {step.label}
                </div>
              )
            })}
          </div>
          {isStuck && (
            <div className="flex items-center gap-3 flex-shrink-0 border-l border-info-200 pl-3 ml-1">
              <span className="text-ink-500 text-dense">Taking too long?</span>
              <button
                onClick={() => cancelAnalysis.mutate()}
                disabled={cancelAnalysis.isPending}
                className="text-dense font-medium text-info-700 hover:text-ink-950 underline underline-offset-2"
              >
                Cancel
              </button>
              <button
                onClick={() => analyze.mutate()}
                disabled={analyze.isPending}
                className="text-dense font-medium border border-info-200 bg-card text-info-700 hover:bg-info-100 px-2.5 py-1 rounded-chip"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}
      {contract?.analysisStatus === 'FAILED' && (
        <div className="bg-risk-50 border-b border-risk-200 text-risk-700 px-6 py-2.5 flex items-center gap-3 text-body">
          <AlertCircle className="size-4 flex-shrink-0" />
          <span className="font-medium whitespace-nowrap flex-shrink-0">
            {versions.length === 0 ? 'Draft generation failed' : analysis.text}
          </span>
          {/* A1 — the extraction job names its step: "Analysis failed while saving what was read (attempt 3 of 3): …" */}
          {contract.analysisError && (
            <span className="text-risk-900 min-w-0" data-testid="analysis-error">
              {/^Failed while /.test(contract.analysisError) ? contract.analysisError.replace(/^Failed /, '') : `— ${contract.analysisError}`}
            </span>
          )}
          <div className="ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={() => analyze.mutate()}
              disabled={analyze.isPending}
              className="gap-1.5 text-risk-700 border-risk-200 hover:bg-risk-100 hover:text-risk-900"
            >
              {analyze.isPending && <Loader2 className="size-3.5 animate-spin" />}
              {versions.length === 0 ? 'Retry Draft' : 'Re-analyze'}
            </Button>
          </div>
        </div>
      )}
      {/* docs/41 P0.1 — a contract nothing has read, or whose document changed
          after it was read, says so: it used to say DONE, and every check
          that loops over its clauses found nothing to flag. */}
      {contract && versions.length > 0 && (analysis.state === 'not_analysed' || analysis.state === 'stale') && (
        <div className="bg-attention-50 border-b border-attention-200 text-ink-950 px-6 py-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-dense" data-testid="analysis-state-banner" data-state={analysis.state}>
          <AlertTriangle className="size-4 flex-shrink-0 text-attention-700" />
          <span className="font-medium">{analysis.text}</span>
          {analysis.detail && <span className="text-ink-700 min-w-0 flex-1">{analysis.detail}</span>}
          {canChangeStatus && (
            <Button
              variant="outline" size="xs" className="ml-auto flex-shrink-0 gap-1.5"
              onClick={() => analyze.mutate()} disabled={analyze.isPending}
              data-testid="analysis-state-analyse"
            >
              {analyze.isPending && <Loader2 className="size-3.5 animate-spin" />}
              {analysis.state === 'stale' ? 'Analyse now' : 'Analyse'}
            </Button>
          )}
        </div>
      )}
      {/* docs/39 A7 — pages of the scan nothing could read, or past the limit
          (a scan read before A7 stopped at page 40): what's on them isn't in
          the text, so it isn't in the fields. */}
      {ocrApplied && (unreadPages.length > 0 || pagesNotRead > 0) && !IN_PROGRESS_STATUSES.includes(contract.analysisStatus) && (
        <div className="bg-attention-50 border-b border-attention-200 px-6 py-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-dense text-ink-950" data-testid="scan-unread-banner">
          <AlertTriangle className="size-4 flex-shrink-0 text-attention-700" />
          <span className="min-w-0 flex-1">
            {unreadPages.length > 0 && <>Pages {pageList(unreadPages)} of the scan couldn’t be read. </>}
            {unreadPages.length === 0 && pagesNotRead > 0 && <>Only the first {(extractionMeta.ocrPages ?? 0).toLocaleString()} of its {(extractionMeta.pageCount ?? 0).toLocaleString()} pages were read. </>}
            <span className="text-ink-700">Anything on the missing pages isn’t in the fields.</span>
          </span>
          {(unreadPages.length > 0 || (extractionMeta.pageCount ?? 0) <= OCR_MAX_PAGES) && canChangeStatus && (
            <Button size="xs" variant="outline" disabled={rereadScan.isPending} onClick={() => rereadScan.mutate()} data-testid="scan-read-again">
              {rereadScan.isPending && <Loader2 className="size-3 animate-spin" />}
              Read the scan again
            </Button>
          )}
        </div>
      )}
      {/* docs/39 A9 — the other side's Word file, its tracked changes not
          accepted: the document shows them made, and the fields keep what's
          agreed with each change's proposal beside it. */}
      {(() => {
        const all = ((contract as any)?.versions ?? []) as Array<{ id: string; metadata?: any }>
        const standing = all.find(v => v.id === contract.currentVersionId) ?? all[0]
        const t = standing?.metadata?.trackedChanges as { insertions: number; deletions: number; byAuthor?: Record<string, number>; comments?: number } | undefined
        const n = t ? (t.insertions ?? 0) + (t.deletions ?? 0) : 0
        if (!n) return null
        const who = Object.keys(t?.byAuthor ?? {})
        const by = who.length === 0 ? '' : who.length === 1 ? ` by ${who[0]}` : ` by ${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}`
        return (
          <div className="bg-attention-50 border-b border-attention-200 px-6 py-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-dense text-ink-950" data-testid="tracked-changes-banner">
            <FileDiff className="size-4 flex-shrink-0 text-attention-700" />
            <span className="min-w-0 flex-1">
              This Word file has {n} tracked change{n === 1 ? '' : 's'}{by} that nobody has accepted.
              <span className="text-ink-700"> The document shows them made. The fields keep what's agreed, with each proposed change beside its value.</span>
            </span>
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              {versions.length > 1 && (
                <Button size="xs" variant="ghost" onClick={() => openChanges()} data-testid="tracked-changes-compare">
                  <ArrowLeftRight className="size-3.5" /> Compare versions
                </Button>
              )}
              <Button size="xs" variant="outline" onClick={() => navigate(`/review-queue?contractId=${id}&reason=proposed`)} data-testid="tracked-changes-review">
                Go through the proposals
              </Button>
            </div>
          </div>
        )
      })()}
      {typeRead?.error && typeRead.type === contract.type && contract.analysisStatus === 'DONE' && canRetype && (
        <div className="bg-attention-50 border-b border-attention-200 px-6 py-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-dense text-ink-950" data-testid="type-fields-failed">
          <AlertCircle className="size-4 flex-shrink-0 text-attention-700" />
          <span className="min-w-0 flex-1">
            Couldn’t read the {typeNoun(contract.type)} fields <span className="text-ink-500">— {typeRead.error}</span>
          </span>
          <Button size="xs" variant="outline" disabled={reread.isPending} onClick={() => reread.mutate()} data-testid="type-fields-retry">
            {reread.isPending && <Loader2 className="size-3 animate-spin" />}
            Try again
          </Button>
        </div>
      )}
      {/* docs/39 A13 — read in full, the AI takes it for another type than the
          one it was filed as: a person settles it. Making it that type reads
          only that type's own fields. */}
      {(() => {
        const opinion = (contract as any)?.metadata?._typeOpinion?.type as string | undefined
        if (!opinion || opinion === contract.type || !canRetype) return null
        const as = typeAs
        return (
          <div className="bg-assist-50 border-b border-assist-200 px-6 py-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-dense text-ink-950" data-testid="type-opinion-banner">
            <AssistMark />
            <span className="min-w-0 flex-1">
              {contract.type === 'OTHER'
                ? <>Read in full, this looks like {as(opinion)}.</>
                : <>Read in full, this looks more like {as(opinion)} than {as(contract.type)}.</>}
            </span>
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              <Button
                size="xs" variant="ghost" disabled={retype.isPending} data-testid="type-opinion-keep"
                onClick={() => retype.mutate(contract.type, { onSuccess: () => toast.success(`Kept as ${as(contract.type)}`) })}
              >
                Keep as is
              </Button>
              <Button
                size="xs" variant="assistOutline" disabled={retype.isPending} data-testid="type-opinion-use"
                title={`Reads ${as(opinion)}’s own fields. Values a person set stay.`}
                onClick={() => retype.mutate(opinion, { onSuccess: () => toast.success(`Now ${as(opinion)} — reading its fields`) })}
              >
                Make it {as(opinion)}
              </Button>
            </div>
          </div>
        )
      })()}
      {/* P2.3 — the line a child contract shows about its parent, on every
          tab. docs/41 P0.9 — "Split from scanned file" only for a contract the
          binder split carved out of a bundle; an amendment says what it
          amends, anything else that it is linked (lib/family-banner.ts). */}
      {(() => {
        const line = familyLine(familyData)
        if (!line || !familyData?.parent) return null
        return (
          <div
            data-testid="family-banner"
            data-kind={line.kind}
            className="bg-paper-100 border-b border-paper-200 text-ink-700 px-6 py-2 flex items-center gap-2 text-dense"
          >
            {line.kind === 'split' ? <Scissors className="size-3.5 flex-shrink-0 text-ink-400" /> : <Link2 className="size-3.5 flex-shrink-0 text-ink-400" />}
            <span className="text-dense">{line.lead}</span>
            <button
              onClick={() => navigate(`/contracts/${familyData.parent.id}`)}
              data-testid="family-parent-link"
              className="text-dense font-medium underline underline-offset-2 decoration-paper-300 text-ink-950 hover:decoration-ink-950 truncate"
              title={`Open ${familyData.parent.title}`}
            >
              {familyData.parent.title}
            </button>
            {line.note && <span className="ml-auto text-[10.5px] text-ink-500">{line.note}</span>}
            {/* Fix-up 15 — the whole family, in the rail's Contract family section. */}
            <button
              type="button"
              onClick={() => { if (isXl) setRailCollapsed(false); else setRailOpen(true); setFamilyReveal(n => n + 1) }}
              data-testid="family-view-link"
              className={cn('text-dense font-medium text-ink-950 hover:underline underline-offset-2 flex-shrink-0', !line.note && 'ml-auto')}
            >
              View family
            </button>
          </div>
        )
      })()}
      {autoSplitDone && (
        <div className="bg-info-50 border-b border-info-200 text-info-700 px-6 py-2.5 flex items-center gap-3 text-body">
          <Scissors className="size-4 flex-shrink-0 text-info-600" />
          <span className="font-medium">Auto-split into {splitInto.length} contracts</span>
          <span>— the AI split this scanned file into its agreements. Each one is read on its own.</span>
          {/* Outlined, not ink: the header already owns the one filled primary. */}
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              setSplitSpecs(suggestedSplits.map((s: any, i: number) => ({
                pageStart: s.pageStart ?? 1,
                pageEnd:   s.pageEnd ?? 99,
                title:     s.title ?? `Agreement ${i + 1}`,
                type:      s.type ?? 'OTHER',
              })))
              setShowSplitModal(true)
            }}
            className="ml-auto flex-shrink-0"
          >
            Adjust splits →
          </Button>
        </div>
      )}
      {/* Nothing moves until the user splits this binder, so this band is
          attention (your turn) rather than info. */}
      {binderDetected && !autoSplitDone && (
        <div className="bg-attention-50 border-b border-attention-200 text-attention-700 px-6 py-2.5 flex items-center gap-3 text-body">
          <FileText className="size-4 flex-shrink-0 text-attention-600" />
          <span className="font-medium">Multiple agreements detected</span>
          <span>
            — We found {suggestedSplits.length > 0 ? suggestedSplits.length : 'multiple'} separate agreements in this document.
            {binderSplitUnsupported && <> {binderSplitUnsupported}</>}
          </span>
          {!binderSplitUnsupported && <Button
            variant="outline"
            size="xs"
            onClick={() => {
              setSplitSpecs(suggestedSplits.map((s: any, i: number) => ({
                pageStart: s.pageStart ?? 1,
                pageEnd:   s.pageEnd ?? 99,
                title:     s.title ?? `Agreement ${i + 1}`,
                type:      s.type ?? 'OTHER',
              })))
              setShowSplitModal(true)
            }}
            className="ml-auto flex-shrink-0"
          >
            Review &amp; Split →
          </Button>}
        </div>
      )}
      {splitError && (
        <div className="bg-attention-50 border-b border-attention-200 text-attention-700 px-6 py-2.5 text-body" data-testid="split-error">
          {splitError}
        </div>
      )}

      {/* ── Tab nav (P-feedback 2026-05-02) ──────────────────────────────────
          User feedback: "when I open clauses in contracts I cannot go back
          to the contract." `setTab` was reachable via "View all" links but
          had no visible tab bar to switch back. This renders one. */}
      {tab !== 'document' && (
        <div className="flex items-center gap-1 px-6 py-2 border-b border-paper-200 bg-card sticky top-0 z-10">
          <button
            type="button"
            onClick={() => setTab('document')}
            data-testid="tab-back-to-document"
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-dense font-medium text-ink-700 hover:text-ink-950 hover:bg-paper-100 mr-2"
            title="Back to document view"
          >
            <ArrowLeft className="size-3.5" />
            Document
          </button>
          <span className="text-paper-300" aria-hidden>·</span>
          {visibleTabs.filter(t => t !== 'document').map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              data-testid={`tab-${t}`}
              className={cn(
                'px-2.5 py-1 rounded-md text-dense font-medium capitalize transition-colors',
                // Selected is an action state, so it inverts to ink.
                tab === t
                  ? 'bg-ink-950 text-white'
                  : 'text-ink-500 hover:text-ink-950 hover:bg-paper-100',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {/* The attach input, for every Attach button (the rail's and the Overview card's). */}
      <input
        ref={attachFileRef}
        type="file"
        accept=".pdf,.docx,.doc,.txt,.xlsx,.csv,.png,.jpg,.jpeg,.tif,.tiff"
        className="hidden"
        data-testid="attach-file-input"
        onChange={e => {
          const file = e.target.files?.[0]
          if (file) {
            attachMutation.mutate(file)
            e.target.value = ''
          }
        }}
      />

      {/* ── Content ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">

        {/* ─── Overview ──────────────────────────────────────────────────── */}
        {tab === 'overview' && (
          <div className="p-6 max-w-6xl mx-auto">
            <div className="grid grid-cols-5 gap-6">

              {/* Left column (3/5) */}
              <div className="col-span-3 space-y-4">

                {/* AI Summary */}
                <div className="bg-card rounded-card border border-paper-200 shadow-e1 overflow-hidden">
                  {/* Machine-authored panel — the one place on this tab that
                      keeps the assist wash. */}
                  <div className="px-5 py-4 border-b border-paper-200 bg-assist-50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Sparkles className="size-4 text-assist-600" />
                      <span className="text-section text-assist-700">AI Analysis</span>
                    </div>
                    {/* Split button: primary = smart resume, dropdown = full reprocess */}
                    {(() => {
                      const isAnalyzing = analyze.isPending || reprocess.isPending || IN_PROGRESS_STATUSES.includes(contract.analysisStatus)
                      return (
                        <div className="relative flex-shrink-0" onClick={e => e.stopPropagation()}>
                          <div className="flex h-7 rounded-md overflow-hidden border border-assist-200">
                            <button
                              onClick={() => { analyze.mutate(); setShowReanalyzeMenu(false) }}
                              disabled={isAnalyzing}
                              className="flex items-center gap-1 px-3 text-[11.5px] font-semibold text-assist-700 bg-card hover:bg-assist-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              {isAnalyzing
                                ? <><Loader2 className="size-3 animate-spin" /> Analyzing…</>
                                : <><Sparkles className="size-3" /> {hasAnalysis ? 'Re-analyze' : 'Run Analysis'}</>
                              }
                            </button>
                            {hasAnalysis && !isAnalyzing && (
                              <button
                                onClick={e => { e.stopPropagation(); setShowReanalyzeMenu(m => !m) }}
                                className="px-1.5 border-l border-assist-200 text-assist-600 hover:bg-assist-50 hover:text-assist-700 transition-colors"
                              >
                                <ChevronDown className="size-3" />
                              </button>
                            )}
                          </div>
                          {showReanalyzeMenu && (
                            <div className="absolute right-0 top-full mt-1 z-50 bg-card border border-paper-200 rounded-md shadow-e2 py-1 w-64" onMouseDown={e => e.stopPropagation()}>
                              {/* docs/39 G1 — neither choice touches a value a person set or checked. */}
                              <button
                                onClick={() => { analyze.mutate('fill_blanks'); setShowReanalyzeMenu(false) }}
                                className="w-full px-3 py-2 text-left text-dense text-ink-700 hover:bg-paper-100 flex items-center gap-2"
                                data-testid="reanalyze-fill-blanks"
                              >
                                <Sparkles className="size-3.5 text-ink-400 flex-shrink-0" />
                                <div>
                                  <div className="font-medium">Only fill empty fields</div>
                                  <div className="text-ink-400 mt-0.5">Leave every value there is; new readings show as suggestions</div>
                                </div>
                              </button>
                              <button
                                onClick={() => { reprocess.mutate(); setShowReanalyzeMenu(false) }}
                                className="w-full px-3 py-2 text-left text-dense text-ink-700 hover:bg-paper-100 flex items-center gap-2"
                              >
                                <RefreshCw className="size-3.5 text-ink-400 flex-shrink-0" />
                                <div>
                                  <div className="font-medium">Full re-process from file</div>
                                  <div className="text-ink-400 mt-0.5">Re-parse PDF, re-classify, re-extract</div>
                                </div>
                              </button>
                              <p className="px-3 pt-1.5 pb-1 text-[10.5px] text-ink-400 border-t border-paper-100 mt-1">
                                Values you set or checked are never overwritten.
                              </p>
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                  <div className="p-5">
                    {contract.summary ? (
                      <p className="text-body text-ink-700">{contract.summary}</p>
                    ) : (
                      <div className="flex flex-col items-center py-6 gap-3">
                        <div className="size-10 rounded-full bg-paper-100 flex items-center justify-center">
                          <Sparkles className="size-5 text-ink-400" />
                        </div>
                        <div className="text-center">
                          <p className="text-body font-medium text-ink-950">No analysis yet</p>
                          <p className="text-dense text-ink-500 mt-0.5">Click "Run Analysis" to extract key terms, risk score, and summary</p>
                        </div>
                        <Button variant="assistOutline" size="sm" onClick={() => analyze.mutate()} disabled={analyze.isPending || IN_PROGRESS_STATUSES.includes(contract.analysisStatus)} className="gap-1.5">
                          <Sparkles className="size-3.5" /> Run Analysis
                        </Button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Clause Flags */}
                {presentFlags.length > 0 && (
                  <div className="bg-card rounded-card border border-paper-200 shadow-e1 p-5">
                    {/* Attention, not risk: a flagged clause isn't exposure by
                        itself, it's the list a reviewer is expected to read. */}
                    <div className="flex items-center gap-2 mb-3">
                      <Shield className="size-4 text-attention-600" />
                      <h3 className="text-section text-ink-950">Clause Flags</h3>
                      <span className="ml-auto text-dense text-ink-400 tabular-nums">{presentFlags.length} detected</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(showAllFlags ? presentFlags : presentFlags.slice(0, 6)).map(([k, label]) => (
                        <span key={k} className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11.5px] font-medium bg-attention-50 text-attention-700 border border-attention-200">
                          <span className="size-1.5 rounded-full bg-attention-600" />
                          {label}
                        </span>
                      ))}
                      {presentFlags.length > 6 && (
                        <button
                          onClick={() => setShowAllFlags(!showAllFlags)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-dense text-ink-500 hover:text-ink-950"
                        >
                          {showAllFlags ? <><ChevronUp className="size-3" /> Less</> : <><ChevronDown className="size-3" /> +{presentFlags.length - 6} more</>}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* docs/39 B1 — every field, who set it, and the fix in place: replaces
                    the read-only Key Terms, contract-type terms and custom field cards. */}
                <FieldsPanel contractId={id!} canEdit={canEditFields} onShowSource={showFieldSource} />

                {/* AI Findings — extra terms the LLM found beyond defined fields */}
                {aiFindings.length > 0 && (
                  <div className="bg-card rounded-card border border-paper-200 shadow-e1 p-5">
                    <button
                      onClick={() => setShowFindings(v => !v)}
                      className="flex items-center justify-between w-full mb-1"
                    >
                      <div className="flex items-center gap-2">
                        <Sparkles className="size-4 text-assist-600" />
                        <h3 className="text-section text-ink-950">AI Findings</h3>
                        <span className="px-1.5 py-0.5 rounded-full border border-assist-200 bg-assist-50 text-assist-700 text-[10.5px] font-semibold tabular-nums">
                          {aiFindings.length}
                        </span>
                      </div>
                      {showFindings
                        ? <ChevronUp className="size-4 text-ink-400" />
                        : <ChevronDown className="size-4 text-ink-400" />
                      }
                    </button>
                    {showFindings && (
                      <div className="mt-3 divide-y divide-paper-100">
                        {aiFindings.map((f) => (
                          <div key={f.key} className="group py-2.5 flex items-start justify-between gap-3">
                            <span className="text-dense text-ink-500 w-1/3 flex-shrink-0">{f.label}</span>
                            <div className="flex items-center gap-2 flex-1 justify-end">
                              <span className="text-dense text-ink-950 text-right">
                                {formatTermValue(f.key, f.value)}
                              </span>
                              <ConfidenceIcon confidence={f.confidence} />
                              {/* docs/39 C4 — worth tracking on every contract: one click to a field. */}
                              {trackFindingButton(f)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Tags */}
                {contract.tags?.length > 0 && (
                  <div className="bg-card rounded-card border border-paper-200 shadow-e1 p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <Tag className="size-4 text-ink-400" />
                      <h3 className="text-section text-ink-950">Tags</h3>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {contract.tags.map((tag: string) => (
                        <span key={tag} className="px-3 py-1 bg-paper-100 border border-paper-200 rounded-full text-[11.5px] text-ink-950">{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Right column (2/5) */}
              <div className="col-span-2 space-y-4">

                {/* Contract Details */}
                <div className="bg-card rounded-card border border-paper-200 shadow-e1 p-5">
                  <h3 className="text-section text-ink-950 mb-3">Contract Details</h3>
                  <div>
                    <DetailRow label="Owner" value={contract.owner?.name ?? '—'} />
                    <DetailRow label="Counterparty" value={contract.counterpartyName ?? contract.counterparty?.name ?? formatTermValue('parties', keyTerms.parties) !== '—' ? formatTermValue('parties', keyTerms.parties) : '—'} />
                    <DetailRow label="Effective" value={
                      contract.effectiveDate ? new Date(contract.effectiveDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                      : keyTerms.effectiveDate ? formatTermValue('effectiveDate', keyTerms.effectiveDate) : '—'
                    } />
                    <DetailRow label="Expires" value={
                      contract.expiryDate ? new Date(contract.expiryDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                      : keyTerms.expiryDate ? formatTermValue('expiryDate', keyTerms.expiryDate) : '—'
                    } />
                    <DetailRow label="Value" value={
                      contract.value ? `${contract.currency ?? keyTerms.currency ?? 'USD'} ${Number(contract.value).toLocaleString()}`
                      : keyTerms.value ? `${keyTerms.currency ?? 'USD'} ${Number(keyTerms.value).toLocaleString()}` : '—'
                    } />
                    <DetailRow label="Jurisdiction" value={contract.jurisdiction ?? keyTerms.governingLaw ?? '—'} />
                    <DetailRow label="Contract No." value={contract.contractNumber ?? '—'} />
                  </div>
                </div>

                {/* Risk Assessment */}
                {contract.riskScore != null && (
                  <div className="bg-card rounded-card border border-paper-200 shadow-e1 p-5">
                    <div className="flex items-center gap-2 mb-4">
                      <TrendingUp className="size-4 text-ink-400" />
                      <h3 className="text-section text-ink-950">Risk Assessment</h3>
                    </div>
                    <RiskMeter score={contract.riskScore} />
                    {riskFactors.length > 0 && (
                      <div className="mt-4">
                        <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-700 mb-2">Risk Factors</p>
                        <ul className="space-y-1.5">
                          {riskFactors.map((f, i) => (
                            <li key={i} className="flex items-start gap-2 text-dense text-ink-700">
                              <span className="size-1.5 rounded-full bg-risk-600 mt-1.5 flex-shrink-0" />
                              {f}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {contract.overallConfidence != null && (
                      <div className="mt-4 pt-4 border-t border-paper-200">
                        <p className="text-dense text-ink-500">
                          Extraction confidence: <span className="font-semibold text-ink-950 tabular-nums">{Math.round((contract.overallConfidence ?? 0) * 100)}%</span>
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Contract Family */}
                <div className="bg-card rounded-card border border-paper-200 shadow-e1 p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Link className="size-4 text-ink-400" />
                      <h3 className="text-section text-ink-950">Contract Family</h3>
                    </div>
                    {/* X75 review — it opens the upload dialog, which creates a contract. */}
                    {canUpload && (
                      <button
                        onClick={() => setShowAddRelated(true)}
                        className="text-dense text-ink-700 hover:text-ink-950 hover:underline underline-offset-2"
                      >
                        + Add related
                      </button>
                    )}
                  </div>

                  {/* Parent */}
                  {familyData?.parent && (
                    <div className="mb-3">
                      <p className="text-[10.5px] font-semibold text-ink-700 uppercase tracking-[0.08em] mb-1.5">Parent</p>
                      <button
                        onClick={() => navigate(`/contracts/${familyData.parent.id}`)}
                        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md border border-paper-200 bg-paper-50 hover:bg-paper-100 transition-colors text-left"
                      >
                        <ExternalLink className="size-3 text-ink-400 flex-shrink-0" />
                        <span className="text-dense font-medium text-ink-950 truncate">{familyData.parent.title}</span>
                        <span className="ml-auto text-[10px] text-ink-400 flex-shrink-0">{familyData.parent.type}</span>
                      </button>
                    </div>
                  )}

                  {/* Children grouped by relationshipType */}
                  {familyData?.children && familyData.children.length > 0 ? (
                    <div className="space-y-1">
                      {(familyData.children as any[]).map((child: any) => (
                        <button
                          key={child.id}
                          onClick={() => navigate(`/contracts/${child.id}`)}
                          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-paper-100 transition-colors text-left"
                        >
                          <FileText className="size-3 text-ink-400 flex-shrink-0" />
                          <span className="text-dense text-ink-700 truncate">{child.title}</span>
                          {child.relationshipType && (
                            <span className="ml-auto text-[10px] text-ink-400 flex-shrink-0 capitalize">
                              {child.relationshipType.replace(/_/g, ' ')}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  ) : !familyData?.parent ? (
                    <p className="text-dense text-ink-400">No related documents yet.</p>
                  ) : null}
                </div>

                {/* Attachments */}
                <div className="bg-card rounded-card border border-paper-200 shadow-e1 p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Paperclip className="size-4 text-ink-400" />
                      <h3 className="text-section text-ink-950">Attachments</h3>
                      <span className="text-dense text-ink-400">(exhibits, schedules)</span>
                    </div>
                    <button
                      onClick={() => attachFileRef.current?.click()}
                      disabled={attachMutation.isPending}
                      className="text-dense text-ink-700 hover:text-ink-950 hover:underline underline-offset-2 disabled:opacity-50"
                    >
                      {attachMutation.isPending ? 'Uploading…' : '+ Attach'}
                    </button>
                  </div>
                  {(contract.attachments as any[] ?? []).length === 0 ? (
                    <p className="text-dense text-ink-400">No attachments. Click "+ Attach" to add exhibits, schedules, or reference documents.</p>
                  ) : (
                    <div className="space-y-1">
                      {(contract.attachments as any[]).map((att: any, idx: number) => (
                        <div key={idx} className="flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-paper-100 group">
                          <Paperclip className="size-3 text-ink-400 flex-shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-dense text-ink-700 truncate">{att.label || att.filename}</span>
                            {/* docs/39 A12 — read as part of the contract */}
                            {(() => {
                              const r = exhibitReading(att)
                              if (r.state === 'read') return <span className="block text-[11px] text-ink-500" data-testid={`attachment-read-${idx}`}>Read with the contract{r.pages ? ` · ${r.pages} page${r.pages === 1 ? '' : 's'}` : ''}{r.ocr ? ' · OCR’d' : ''}</span>
                              if (r.state === 'reading') return <span className="block text-[11px] text-ink-500 inline-flex items-center gap-1" data-testid={`attachment-read-${idx}`}><Loader2 className="size-3 animate-spin" /> Reading it…</span>
                              if (r.state === 'failed') return <span className="block text-[11px] text-attention-700" title={r.error ?? undefined} data-testid={`attachment-read-${idx}`}>Couldn’t read it</span>
                              if (r.state === 'unread' && canChangeStatus) return (
                                <button type="button" onClick={() => readAttachment.mutate(idx)} disabled={readAttachment.isPending} className="text-[11px] text-ink-500 hover:text-ink-950 underline underline-offset-2" data-testid={`attachment-read-${idx}`}>
                                  Not read yet — read it with the contract
                                </button>
                              )
                              return null
                            })()}
                          </span>
                          <span className="text-[10px] text-ink-400 tabular-nums">{(att.size / 1024).toFixed(0)} KB</span>
                          <button
                            onClick={() => downloadAttachment(idx, att.filename)}
                            className="p-1 rounded-chip opacity-0 group-hover:opacity-100 hover:bg-paper-200 text-ink-500 transition-all"
                            title="Download"
                          >
                            <Download className="size-3" />
                          </button>
                          <button
                            onClick={() => deleteAttachment.mutate(idx)}
                            className="p-1 rounded-chip opacity-0 group-hover:opacity-100 hover:bg-risk-50 text-risk-600 transition-all"
                            title="Remove"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ─── Clauses ───────────────────────────────────────────────────── */}
        {tab === 'clauses' && (() => {
          const allClauses: Array<{
            id: string; clauseType: string; content: string
            interpretation?: string; riskRating?: string; sectionRef?: string; sortOrder: number
          }> = clausesData?.data ?? []

          const filtered = allClauses.filter(c => {
            const matchesRating = clauseRatingFilter === 'all' || c.riskRating === clauseRatingFilter
            const matchesSearch = !clauseSearch ||
              c.content.toLowerCase().includes(clauseSearch.toLowerCase()) ||
              c.interpretation?.toLowerCase().includes(clauseSearch.toLowerCase()) ||
              clauseLabelOf(c.clauseType).toLowerCase().includes(clauseSearch.toLowerCase())
            return matchesRating && matchesSearch
          })

          const unfavorableCount = allClauses.filter(c => c.riskRating === 'unfavorable').length
          const unusualCount     = allClauses.filter(c => c.riskRating === 'unusual').length

          return (
            <div className="p-6 max-w-4xl mx-auto">
              {!['INDEXING', 'DONE'].includes(contract?.analysisStatus ?? '') ? (
                <div className="text-center py-16 text-ink-400">
                  <Sparkles className="size-8 mx-auto mb-3 opacity-40" />
                  <p className="text-body">Clause extraction will appear here once analysis is complete.</p>
                </div>
              ) : allClauses.length === 0 ? (
                <div className="text-center py-16 text-ink-400">
                  <FileText className="size-8 mx-auto mb-3 opacity-40" />
                  <p className="text-body">No clauses extracted yet. Try re-analyzing this contract.</p>
                </div>
              ) : (
                <>
                  {/* Filter bar */}
                  <div className="flex items-center gap-3 mb-6 flex-wrap">
                    <div className="flex-1 min-w-48">
                      <Input
                        type="text"
                        placeholder="Search clauses…"
                        value={clauseSearch}
                        onChange={e => setClauseSearch(e.target.value)}
                      />
                    </div>
                    <div className="flex gap-1.5">
                      {[
                        { key: 'all',         label: `All (${allClauses.length})` },
                        { key: 'unfavorable', label: `Unfavorable (${unfavorableCount})` },
                        { key: 'unusual',     label: `Unusual (${unusualCount})` },
                        { key: 'favorable',   label: 'Favorable' },
                        { key: 'neutral',     label: 'Neutral' },
                      ].map(f => (
                        <button
                          key={f.key}
                          onClick={() => setClauseRatingFilter(f.key)}
                          className={`px-2.5 py-1 text-[11.5px] rounded-full font-medium border transition-colors ${
                            clauseRatingFilter === f.key
                              ? 'bg-ink-950 text-white border-ink-950'
                              : 'bg-card text-ink-950 border-paper-200 hover:border-paper-300'
                          }`}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Clause list */}
                  {filtered.length === 0 ? (
                    <p className="text-body text-ink-400 text-center py-8">No clauses match this filter.</p>
                  ) : (
                    <div className="space-y-3">
                      {filtered.map(clause => {
                        const badge = clause.riskRating ? RISK_RATING_BADGE[clause.riskRating] : null
                        const typeLabel = clauseLabelOf(clause.clauseType)
                        return (
                          <ClauseCard
                            key={clause.id}
                            typeLabel={typeLabel}
                            sectionRef={clause.sectionRef}
                            badge={badge}
                            interpretation={clause.interpretation}
                            content={clause.content}
                            onReview={() => setFocusedClauseId(clause.id)}
                            onShowInDocument={() => showInDocument(clause.content)}
                            clauseType={clause.clauseType}
                            source={(clause as { source?: string }).source}
                            onRetype={canTagClauses ? type => retypeClause.mutate({ clauseId: clause.id, clauseType: type }) : undefined}
                            onDismiss={canTagClauses ? () => dismissClause.mutate({ clauseId: clause.id }) : undefined}
                            busy={retypeClause.isPending || dismissClause.isPending}
                          />
                        )
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })()}

        {/* ─── Document (B.5.1 + B.5.2 — DocumentCanvas or Original PDF) ─── */}
        {tab === 'document' && (() => {
          // B.5.2 — Original PDF branch. Auto-fetches presigned URL via the
          // existing handleViewPdf on tab enter (already wired in B.1).
          if (docView === 'original') {
            // U.1.2 — graceful empty state when this contract has no PDF
            // backing (text-only / template-generated). Used to crash with
            // a red "Invalid PDF structure" error.
            if (!hasOriginal) {
              return (
                <div className="flex flex-col items-center justify-center h-64 bg-card rounded-card border border-paper-200 shadow-e1 m-4" data-testid="no-original-pdf">
                  <FileText className="size-8 text-ink-400 mb-3" />
                  <p className="text-body font-medium text-ink-950">{originalNotPdf ? 'The original isn\u2019t a PDF' : 'No original file'}</p>
                  <p className="text-dense text-ink-500 mt-1 text-center max-w-sm">
                    {originalNotPdf
                      ? 'Only PDFs open in this view. Download the original from Actions, or read it in the Styled view.'
                      : 'This contract was created from text or a template — there\'s no source PDF to display.'}
                  </p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => setDocView('styled')}>
                    Switch to Styled view
                  </Button>
                </div>
              )
            }
            if (pdfError) {
              return (
                <div className="flex flex-col items-center justify-center h-64 bg-card rounded-card border border-paper-200 shadow-e1 m-4">
                  <AlertCircle className="size-8 text-risk-600 mb-3" />
                  <p className="text-body font-medium text-ink-950">Failed to load original PDF</p>
                  <p className="text-dense text-ink-500 mt-1 text-center max-w-sm">{pdfError}</p>
                  <Button variant="outline" className="mt-3" onClick={handleViewPdf}>Retry</Button>
                  <Button variant="ghost" size="xs" className="mt-2" onClick={() => setDocView('styled')}>
                    Switch to Styled view
                  </Button>
                </div>
              )
            }
            if (!pdfUrl) {
              return (
                <div className="flex flex-col items-center justify-center h-64 bg-paper-50">
                  <Loader2 className="size-6 text-ink-400 mb-3 animate-spin" />
                  <p className="text-body text-ink-500">Loading original PDF…</p>
                </div>
              )
            }
            return (
              // The document canvas: paper on warm ground, and the only surface
              // in the system allowed a drop shadow.
              <div className="h-full overflow-hidden bg-paper-50 p-4">
                <div ref={setPdfBox} className="bg-card rounded-paper shadow-page h-full">
                  <Worker workerUrl={pdfWorkerUrl}>
                    <Viewer
                      // X1 — remounted per citation: initialPage applies on load.
                      key={citeTarget.page ?? 0}
                      fileUrl={pdfUrl}
                      plugins={[layoutPlugin]}
                      onDocumentLoad={e => { void readPdfPages(e) }}
                      initialPage={citeTarget.page ? citeTarget.page - 1 : 0}
                      renderPage={citeTarget.bbox ? (props: RenderPageProps) => (
                        <>
                          {props.canvasLayer.children}
                          {props.textLayer.children}
                          {props.annotationLayer.children}
                          {props.pageIndex === citeTarget.page! - 1 && props.rotation === 0 && (
                            // "You landed here" is a selection, not a state: ink,
                            // as the TOC flash for ?section= is.
                            <div
                              data-testid="citation-highlight"
                              aria-hidden
                              className="absolute pointer-events-none rounded-sm ring-2 ring-ink-950"
                              style={highlightRect(citeTarget.bbox!, props.scale)}
                            />
                          )}
                        </>
                      ) : undefined}
                    />
                  </Worker>
                </div>
              </div>
            )
          }

          // B.5.1 — Styled branch. TipTap + contract-paper CSS. Default.
          // DD4 — the version the contract stands on (an undo moves it back), not the newest.
          const latest = currentVersionOf(contract.versions as any[], contract.currentVersionId)
          // docs/41 Part 16 — while editing, the draft changes when there are any.
          const rawHtml = isEditing && draftHtml
            ? draftHtml
            : latest?.htmlContent?.trim()
              ? latest.htmlContent
              : latest?.plainText?.trim() || ''
          // A freshly-seeded amendment/draft carries markup-only content like
          // '<p></p>' — truthy, but with no real text. Strip tags before deciding
          // emptiness; otherwise the Styled view mounts a blank editor and paints
          // an empty white page instead of the empty-state card.
          const hasText = rawHtml.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length > 0
          const analyzing = [
            'PENDING', 'PARSING', 'CLASSIFYING', 'EXTRACTING',
            'INDEXING', 'ANALYZING', 'DRAFTING',
          ].includes(contract.analysisStatus ?? '')

          let canvasState: CanvasState
          // A failed analysis doesn't hide a document that was read: the
          // banner above says what failed and offers the retry (docs/39 A1).
          if (contract.analysisStatus === 'FAILED' && !hasText) {
            canvasState = {
              kind: 'analysis_failed',
              reason: contract.analysisError ?? undefined,
              onReanalyze: () => reprocess.mutate(),
            }
          } else if (analyzing && !hasText) {
            canvasState = { kind: 'loading' }
          } else if (!hasText && !isEditing) {
            // Effectively-empty in view mode → graceful empty state. In edit mode
            // we fall through to 'ready' so the editable canvas still mounts and
            // the user can start typing the amendment.
            canvasState = { kind: 'empty' }
          } else {
            canvasState = { kind: 'ready', html: rawHtml }
          }

          return (
            <DocumentCanvas
              state={canvasState}
              editable={isEditing}
              onReady={(editor) => { canvasEditorRef.current = editor; setCanvasEditor(editor) }}
              onChange={(html) => {
                // X75 review — nothing a viewer changes is saved (the server
                // refuses it): a view-mode command still changes the canvas.
                if (canvasState.kind !== 'ready' || !canEdit) return
                draft.change(html)
              }}
              // B.5.5 — feed extracted clauses into the decoration layer
              riskClauses={(clausesData?.data ?? []).map((c: any) => ({
                id: c.id,
                content: c.content,
                riskRating: c.riskRating,
              }))}
              riskView={riskView}
              // B.5.10 — amber tone when the current user is the pending
              // approver. Softer than Legal's red; still drives attention.
              riskTone={isApproverMode ? 'amber' : undefined}
              onRiskClick={(clauseId) => {
                // B.5.6 — open the focused-review drawer on this clause.
                setFocusedClauseId(clauseId)
              }}
              onSetField={canEditFields ? setFieldPick : undefined}
              onVariableClick={(key) => {
                setFocusVariable(key)
                if (isXl) setRailCollapsed(false)
                else setRailOpen(true)
              }}
              onAiAction={(selected) => {
                // P6.3 — bubble menu's ✨ opens the streaming BubbleAiPopover
                // anchored to the selection (four quick-action chips, then
                // inline NDJSON stream). ⌘K still opens the free-form palette.
                const trimmed = (selected ?? '').trim()
                if (trimmed.length > 0 && canvasEditorRef.current) {
                  const { from, to } = canvasEditorRef.current.state.selection
                  setAiPopoverText(trimmed)
                  setAiPopoverRange({ from, to })
                  setAiPopoverOpen(true)
                } else {
                  // U.4.1 — no selection → focus the rail composer instead
                  // of opening the deleted Cmd-K palette modal.
                  window.dispatchEvent(new CustomEvent('rail-focus-composer'))
                }
              }}
            />
          )
        })()}

        {/* ─── Comments ───────────────────────────────────────────────────── */}
        {tab === 'comments' && (
          <div className="p-6 max-w-3xl mx-auto">
            {/* docs/41 Part 16 — threads are written in the workspace, beside their words. */}
            <CommentsReadList contractId={id!} onOpenWorkspace={() => navigate(workspacePath(id!))} />
          </div>
        )}

        {/* U.4.4 — "Ask" tab deleted. The rail handles per-contract Q&A
            with the Context header + per-resource thread history. ⌘K
            from anywhere focuses the rail composer. */}
      </div>

      {/* end of left column (document zone) */}
      </div>

      {/*
        Right rail — placeholder for B.1.5c–f. Hidden below xl; will become
        a slide-in drawer on tablet/mobile in a later pass.
      */}
      {/*
        B.5.6 — when a risk is focused, the normal rail is replaced by
        the Focused Review drawer. Same 320px slot, different content.
      */}
      {(() => {
        const allClauses: FocusedClause[] = (clausesData?.data ?? []).map((c: any) => ({
          id: c.id,
          content: c.content,
          riskRating: c.riskRating,
          clauseType: c.clauseType,
          interpretation: c.interpretation,
          sectionRef: c.sectionRef,
        }))
        // Prev / Next step through the risk and deviation clauses. Any clause
        // can be opened, though (from the Clauses tab or a playbook finding):
        // a contract with nothing flagged had no way to reach Suggest.
        const flagged = allClauses.filter((c) => classifyRisk(c.riskRating) !== null || c.id === focusedClauseId)
        const savedState = new Map(((clausesData?.data ?? []) as Array<{ id: string; reviewState?: string }>)
          .map((c) => [c.id, isReviewState(c.reviewState) ? c.reviewState : undefined]))
        const stateOf = (cid: string) => reviewStates[cid] ?? savedState.get(cid)
        // EE1 — the drawer steps through the clauses still waiting on a
        // decision. Each decision takes its clause out and moves on to the
        // next one still pending, so the count goes down; with none left,
        // the drawer closes.
        const queue = reviewQueue(flagged, stateOf, focusedClauseId)
        const focusedIdx = focusedClauseId
          ? queue.findIndex((c) => c.id === focusedClauseId)
          : -1
        const decide = (cid: string, state: ReviewState) => {
          setReviewStates((s) => ({ ...s, [cid]: state }))
          updateReviewState.mutate({ clauseId: cid, state })
          setFocusedClauseId(nextPending(flagged, (c) => (c === cid ? state : stateOf(c)), cid))
        }

        if (focusedClauseId && focusedIdx >= 0) {
          return (
            <FocusedReviewDrawer
              contractId={id!}
              clauses={queue}
              currentIndex={focusedIdx}
              reviewStates={reviewStates}
              onPrev={() => {
                if (focusedIdx > 0) setFocusedClauseId(queue[focusedIdx - 1].id)
              }}
              onNext={() => {
                if (focusedIdx < queue.length - 1) setFocusedClauseId(queue[focusedIdx + 1].id)
              }}
              onAccept={(cid) => decide(cid, 'resolved')}
              onReject={(cid) => decide(cid, 'rejected')}
              onMarkReviewed={(cid) => decide(cid, 'reviewed')}
              onApplied={(cid) => decide(cid, 'resolved')}
              onReopen={(cid) => {
                setReviewStates((s) => ({ ...s, [cid]: 'unreviewed' }))
                updateReviewState.mutate({ clauseId: cid, state: 'unreviewed' })
              }}
              onEditManually={canEdit ? () => {
                // Exit drawer, enter edit mode. A future commit will also
                // scroll to and focus the specific clause in the editor.
                setFocusedClauseId(null)
                enterEdit()
              } : undefined}
              onClose={() => setFocusedClauseId(null)}
              canEdit={canEdit}
            />
          )
        }
        return null
      })()}

      {/*
        B.5.16 — Responsive rail.
        • xl+ (≥1280): static right column, always visible (default).
        • md–lg (768–1279): slide-in drawer from the right. Opened via
          the floating "Details" pill (rendered below this aside); closed
          by backdrop click, × button, or Esc.
        • <md (mobile): bottom sheet — 64px peek visible even when
          "closed", click/drag up to expand to near-full height.
        When the focused-review drawer is showing, the normal rail is
        hidden regardless of breakpoint (FocusedReviewDrawer takes over).
      */}
      {!isXl && (
        <>
          {/* Backdrop for tablet/mobile when rail is open */}
          {railOpen && (
            <div
              className="fixed inset-0 z-30 bg-black/20 xl:hidden"
              onClick={() => setRailOpen(false)}
              aria-hidden
            />
          )}
          {/*
            Floating trigger pill — tablet only (md–lg). On mobile the
            bottom-sheet's peek header is already always visible and
            acts as its own trigger, so a second pill would just overlap
            and steal clicks.
          */}
          {isMd && !railOpen && (
            <button
              onClick={() => { setRailOpen(true); track('rail_drawer_opened', { viewport: 'tablet' }) }}
              aria-label="Open details rail"
              className={cn(
                'fixed right-4 bottom-4 z-30 xl:hidden',
                'inline-flex items-center gap-1.5 px-4 py-2 rounded-full',
                'bg-ink-950 text-white shadow-e2 hover:bg-ink-700',
                'text-dense font-semibold',
              )}
            >
              <ChevronUp className="size-3.5" />
              Details
            </button>
          )}
        </>
      )}
      <aside
        role="complementary"
        aria-label="Contract rail"
        // Folded on xl+ the rail leaves the layout entirely — its 320px is
        // exactly what the document gets back.
        className={cn(
          // B.5.16 — responsive positioning.
          isXl
            ? cn(
                'w-rail border-l border-paper-200 bg-card overflow-y-auto flex-col',
                railCollapsed ? 'hidden' : 'hidden xl:flex',
              )
            : isMd
              ? cn(
                  'fixed inset-y-0 right-0 z-40 w-[min(420px,100vw)] bg-card shadow-e3 border-l border-paper-200 overflow-y-auto flex flex-col transition-transform',
                  railOpen ? 'translate-x-0' : 'translate-x-full',
                )
              : cn(
                  // Mobile bottom sheet: always anchored to bottom, 64px peek when closed, near-full when open.
                  'fixed inset-x-0 bottom-0 z-40 bg-card shadow-e3 border-t border-paper-200 rounded-t-card overflow-y-auto flex flex-col transition-[max-height]',
                  railOpen ? 'max-h-[85vh]' : 'max-h-16',
                ),
          // When the focused-review drawer is showing, hide the normal rail.
          focusedClauseId != null &&
            (clausesData?.data ?? []).some((c: any) => c.id === focusedClauseId) &&
            'hidden xl:hidden',
        )}
      >
        {/*
          B.5.16 — Drawer/sheet header (tablet + mobile only). Provides a
          grab handle + close button so users can dismiss the drawer
          without hunting for the backdrop. Hidden at xl+ where the rail
          is static and never needs closing.
        */}
        {!isXl && (
          <div
            onClick={() => {
              // On mobile the whole header acts as a toggle for the peek.
              if (!isMd) setRailOpen(o => !o)
            }}
            className={cn(
              'flex items-center justify-between px-4 py-2 border-b border-paper-200 bg-paper-50',
              !isMd && 'cursor-pointer',
            )}
          >
            <div className="flex items-center gap-2">
              {!isMd && (
                <span
                  aria-hidden
                  className="inline-block h-1 w-10 rounded-full bg-paper-300"
                />
              )}
              <span className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-700">
                Details
              </span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); setRailOpen(false) }}
              className="p-1 rounded-chip text-ink-400 hover:text-ink-950 hover:bg-paper-100"
              aria-label="Close details"
            >
              <X className="size-4" />
            </button>
          </div>
        )}

        {/*
          B.5.7 — Review Progress row at the top of the rail.
          P7.4.4 — Expandable. Click the row → see a checklist of every
          risky clause with severity dot + section ref + "Mark reviewed".
          Bulk "Mark all reviewed" link at the bottom for the "I read
          everything in one pass" workflow.
        */}
        {(() => {
          const risky = (clausesData?.data ?? []).filter((c: any) => classifyRisk(c.riskRating) !== null)
          if (risky.length === 0) return null
          const reviewedCount = risky.filter(
            (c: any) => (reviewStates[c.id] ?? c.reviewState ?? 'unreviewed') !== 'unreviewed',
          ).length
          const pct = Math.round((reviewedCount / risky.length) * 100)
          const complete = reviewedCount === risky.length

          // Severity dot colour per risk rating — the same five meanings the
          // rest of the product uses, so a dot here reads like a dot anywhere.
          const riskDot = (rating: string | null | undefined): string => {
            if (rating === 'unfavorable') return MEANING_CLASS.risk.dot
            if (rating === 'unusual') return MEANING_CLASS.turn.dot
            return MEANING_CLASS.inflight.dot // deviation / neutral
          }

          return (
            <div className="px-5 pt-4 pb-3 border-b border-paper-200" data-testid="review-progress">
              {/* Click the row header to expand/collapse the checklist */}
              <button
                type="button"
                onClick={() => setReviewExpanded(v => !v)}
                aria-expanded={reviewExpanded}
                data-testid="review-progress-toggle"
                className="w-full flex items-center justify-between mb-1.5 group"
              >
                <span className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-700 inline-flex items-center gap-1">
                  Review progress
                  <ChevronRight
                    className={cn(
                      'size-3 text-ink-400 transition-transform',
                      reviewExpanded && 'rotate-90',
                    )}
                  />
                </span>
                <span className={cn(
                  'text-[10.5px] tabular-nums font-medium',
                  complete ? 'text-brand-700' : 'text-ink-500',
                )}>
                  {reviewedCount} / {risky.length}{complete && ' ✓'}
                </span>
              </button>
              {/* Progress itself carries no meaning until it lands: ink while
                  you work, brand once the review is actually complete. */}
              <div className="h-1 w-full rounded-full bg-paper-100 overflow-hidden">
                <div
                  className={cn(
                    'h-full transition-all',
                    complete ? 'bg-brand-700' : 'bg-ink-950',
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>

              {/* Expanded checklist */}
              {reviewExpanded && (
                <div className="mt-3 space-y-1" data-testid="review-progress-list">
                  {risky.map((c: any) => {
                    const decision: ReviewState = reviewStates[c.id] ?? (isReviewState(c.reviewState) ? c.reviewState : 'unreviewed')
                    const isReviewed = isDecided(decision)
                    const cleanType = (c.clauseType ?? 'clause').replace(/_/g, ' ')
                    return (
                      <div
                        key={c.id}
                        data-testid={`review-row-${c.id}`}
                        className={cn(
                          'group flex items-center gap-2 text-[11.5px] rounded-chip px-1.5 py-1 transition-colors',
                          isReviewed ? 'opacity-60 hover:bg-paper-100' : 'hover:bg-paper-100',
                        )}
                      >
                        <span
                          className={cn(
                            'size-1.5 rounded-full shrink-0',
                            !isReviewed ? riskDot(c.riskRating)
                              : decision === 'rejected' ? MEANING_CLASS.risk.dot : MEANING_CLASS.binding.dot,
                          )}
                        />
                        <button
                          type="button"
                          onClick={() => setFocusedClauseId(c.id)}
                          className="flex-1 min-w-0 text-left truncate text-ink-950 hover:underline"
                          title={`${cleanType}${c.sectionRef ? ' · §' + c.sectionRef : ''}`}
                        >
                          {cleanType}
                          {c.sectionRef && <span className="text-ink-400 ml-1 font-mono">§{c.sectionRef}</span>}
                        </button>
                        {!isReviewed && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setReviewStates((s) => ({ ...s, [c.id]: 'reviewed' }))
                              updateReviewState.mutate({ clauseId: c.id, state: 'reviewed' })
                            }}
                            data-testid={`review-mark-${c.id}`}
                            className="text-[10.5px] font-semibold text-ink-950 hover:underline opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                          >
                            Mark reviewed
                          </button>
                        )}
                        {isReviewed && (
                          <span
                            data-testid={`review-decision-${c.id}`}
                            className={cn(
                              'text-[10.5px] shrink-0 inline-flex items-center gap-0.5',
                              decision === 'rejected' ? 'text-risk-700' : 'text-brand-700',
                            )}
                          >
                            <CheckSquare className="size-3" />
                            {DECISION_LABEL[decision].toLowerCase()}
                          </span>
                        )}
                      </div>
                    )
                  })}
                  {/* Bulk action — only when there's still something unreviewed */}
                  {!complete && (
                    <button
                      type="button"
                      onClick={() => {
                        const newStates = { ...reviewStates }
                        risky.forEach((c: any) => {
                          if ((newStates[c.id] ?? c.reviewState ?? 'unreviewed') === 'unreviewed') {
                            newStates[c.id] = 'reviewed'
                            updateReviewState.mutate({ clauseId: c.id, state: 'reviewed' })
                          }
                        })
                        setReviewStates(newStates)
                      }}
                      data-testid="review-mark-all"
                      className="mt-1.5 text-[11px] text-ink-950 hover:underline font-semibold"
                    >
                      ✓ Mark all {risky.length - reviewedCount} as reviewed
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })()}

        {/*
          B.5.11 — PRECEDENTS. Approver-only section showing top-3 signed
          similar contracts + a "how does our risk compare?" signal.
          Per docs/26 §6.6 + ChatGPT round-3: approvers trust past
          decisions more than AI recommendations. This surfaces the
          comparables right next to the decision CTA.
        */}
        {isApproverMode && (
          <RailSection
            title="Precedents"
            defaultOpen
            count={precedentsData?.data?.length ?? null}
          >
            {precedentsData?.riskDeltaLabel && (
              <div
                className={cn(
                  'mb-2 inline-flex items-center gap-1.5 text-[11.5px] px-2 py-1 rounded-full border',
                  /higher/.test(precedentsData.riskDeltaLabel)
                    ? 'bg-risk-50 text-risk-700 border-risk-200'
                    : /lower/.test(precedentsData.riskDeltaLabel)
                    ? 'bg-brand-50 text-brand-700 border-brand-200'
                    : 'bg-paper-50 text-ink-700 border-paper-200',
                )}
                title="Compared to signed peers of the same contract type"
              >
                <TrendingUp className="size-3" />
                {precedentsData.riskDeltaLabel}
              </div>
            )}

            {(!precedentsData?.data || precedentsData.data.length === 0) ? (
              <p className="text-dense text-ink-400 italic">
                No signed precedents of this type yet in your workspace.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {precedentsData.data.map((p: any) => (
                  <li key={p.contractId} className="flex items-start gap-2.5">
                    {/* Vector similarity is a machine-computed score, so the
                        assist accent is earned here. */}
                    <div className="h-6 px-1.5 rounded-chip border border-assist-200 bg-assist-50 text-assist-700 text-[10px] font-semibold tabular-nums flex items-center justify-center flex-shrink-0">
                      {Math.round((p.similarity ?? 0) * 100)}%
                    </div>
                    <div className="min-w-0 flex-1">
                      <button
                        onClick={() => navigate(`/contracts/${p.contractId}`)}
                        className="text-body text-ink-950 hover:underline truncate text-left w-full"
                        title={p.title}
                      >
                        {p.title}
                      </button>
                      <div className="text-[11px] text-ink-400 flex items-center gap-1.5 flex-wrap">
                        {p.counterparty && <span>{p.counterparty}</span>}
                        {p.signedAt && (
                          <>
                            <span>·</span>
                            <span>
                              {new Date(p.signedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                            </span>
                          </>
                        )}
                        {p.riskScore != null && (
                          <>
                            <span>·</span>
                            <span
                              className={cn(
                                'tabular-nums',
                                MEANING_CLASS[RISK_TO_MEANING[riskBand(normalizeRisk(p.riskScore)!)]].fg,
                              )}
                            >
                              Risk {normalizeRisk(p.riskScore)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </RailSection>
        )}

        <RailSection title="Overview" defaultOpen>
          {/* docs/41 P0.1 — which version the analysis describes. */}
          {versions.length > 0 && analysis.state === 'done' && (
            <p className="text-[11px] text-ink-500 mb-1.5" data-testid="analysis-done-for">{analysis.text}</p>
          )}
          {contract.summary ? (
            <p className="text-body text-ink-700">{contract.summary}</p>
          ) : (
            <p className="text-body text-ink-400 italic">
              {analysis.state === 'not_analysed'
                ? 'Not analysed yet — no summary.'
                : contract.analysisStatus === 'DONE'
                ? 'No AI summary available.'
                : contract.analysisStatus === 'FAILED'
                  ? 'Analysis failed — re-run to generate a summary.'
                  : 'Generating summary…'}
            </p>
          )}
        </RailSection>

        {/* docs/39 H2 — a draft's variables: each term changed once, everywhere
            it appears and in the field it fills. Only a draft made from a
            template has any. */}
        {id && (
          <VariablesRailSection
            contractId={id}
            editor={canvasEditor}
            canEdit={canEdit}
            canEditFields={canEditFields}
            title={contract.title}
            canRetitle={canChangeStatus}
            focusKey={focusVariable}
            onFocused={() => setFocusVariable(null)}
            beforeChange={() => saveDocumentNow()}
            saveDocument={note => saveDocumentNow(note)}
          />
        )}
        {/* docs/41 Part 1 — the template and clause choices the draft was made with. */}
        {id && <OriginRailSection contractId={id} canEdit={canEdit} beforeChange={() => saveDocumentNow()} />}
        {/* docs/41 fix-up 4 — deal changes from Salesforce held back on this contract. */}
        {id && <SalesforceConflictsSection contractId={id} canEdit={mayEdit} />}

        {/* P5.1 — Obligations rail section. When metadata.obligations
            exists, show the list with a due-date indicator + an
            "Extract obligations" button for un-extracted contracts. */}
        {/* P7.4.2 — Matter rail section. Surfaces the parent matter
            (sibling contracts, owner, tags) above OBLIGATIONS so the
            user immediately sees the wider context. Empty when the
            contract isn't in a matter; the header pill handles "add". */}
        <MatterRailSection
          matterId={(contract as unknown as { matterId?: string | null }).matterId ?? null}
        />

        {/* Phase 07 — Signature status. Shown when at least one
            SignatureRequest exists on this contract. The component
            self-hides when there are no requests (empty array). */}
        {id && <SignatureStatusRailSection contractId={id} onChanged={() => qc.invalidateQueries({ queryKey: ['contract', id] })} />}

        <ObligationsRailSection
          contractId={id ?? ''}
          contractStatus={contract.status}
          contractType={contract.type}
          onAfterExtract={() => {
            qc.invalidateQueries({ queryKey: ['contract', id] })
          }}
        />

        {/* docs/41 P1 (Part 8) — the one Review panel: the recommendation,
            the findings with their evidence, and the fixes, from GET
            /contracts/:id/review. It replaces the separate playbook review
            and playbook redline sections, which used two engines that could
            disagree. "Fix all fixable" stages its rewrites in
            contract.metadata, which the 4s poll above watches. docs/41
            Parts 9, 10 — compliance gaps and drafting problems are groups
            of it too, with the defined-terms glossary under Drafting (it
            replaces the separate Drafting section). */}
        {id && (
          <ReviewPanel
            contractId={id}
            contractMetadata={contract?.metadata as Record<string, unknown> | undefined}
            canEdit={canEdit}
            onJumpToClause={jumpToClause}
            onAnalyse={canChangeStatus && analysis.canAnalyse ? () => analyze.mutate() : undefined}
            analysing={analyze.isPending}
            onShowText={text => { revealInCanvas(canvasEditorRef.current, text) }}
            definedTerms={<DefinedTermsGlossary contractId={id} versionId={contract.currentVersionId} editor={canvasEditor} canEdit={canEdit} />}
          />
        )}

        {/* Phase 10 — Compliance Agent; docs/41 Part 9 — which frameworks
            apply and why (facts with quotes, the one question), and each
            framework's checks. The gaps are also findings in the Review
            panel's Compliance group, where the recommendation weighs them. */}
        {id && (
          <ComplianceRailSection
            contractId={id}
            canEdit={canEdit}
            onAfterCheck={() => {
              qc.invalidateQueries({ queryKey: ['contract', id] })
              // Its gaps are review findings too.
              qc.invalidateQueries({ queryKey: ['contract-review', id] })
            }}
          />
        )}

        {/* P5.3 — Renewal advisor. Shows inside the 180-day expiry
            window; offers an LLM-backed recommendation + decision
            logging so the RENEWAL_DUE reminder stops firing. */}
        <RenewalAdviceRailSection
          contractId={id ?? ''}
          expiryDate={contract.expiryDate ?? null}
          advice={(contract.metadata?.renewalAdvice as RenewalAdvice | undefined) ?? null}
          onAfterAdvice={() => qc.invalidateQueries({ queryKey: ['contract', id] })}
          onAfterDecision={() => qc.invalidateQueries({ queryKey: ['contract', id] })}
        />

        {/* P2.2 + P2.4 — Table of Contents with page anchors.
            Built from version.metadata.structure.nav (extract.py's
            _build_section_tree). Each entry carries its PDF page +
            bbox. Click scrolls the TipTap rendering to the heading; a
            "p.N" chip shows which page of the original PDF it lives
            on. Foundation for D.5.8 citations + in-PDF highlight. */}
        {(() => {
          const nav = (latestVersionMeta.structure as { nav?: Array<{
            id: string; ref: string; title: string; level: number
            depth: number; paragraphCount: number
            page?: number | null; bbox?: number[] | null
          }> } | undefined)?.nav ?? []
          if (nav.length === 0) return null
          return (
            <RailSection title="Table of Contents" defaultOpen count={nav.length}>
              <ul data-testid="contract-toc" className="space-y-0.5 text-[12px]">
                {nav.map(n => (
                  <li
                    key={n.id}
                    data-testid={`toc-item-${n.id}`}
                    data-depth={n.depth}
                    data-ref={n.ref || undefined}
                    data-page={n.page ?? undefined}
                    style={{ paddingLeft: `${n.depth * 10}px` }}
                    className="group"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        // Best-effort scroll: search for an <h{level}>
                        // whose text contains the ref + title. Works
                        // with the TipTap-rendered document view.
                        const hostSel = '[data-testid="contract-document-host"], .contract-paper'
                        const scope = document.querySelector(hostSel) ?? document
                        const needle = ((n.ref ? `${n.ref}` : '') + (n.title ? ` ${n.title}` : '')).trim().toLowerCase()
                        const heads = Array.from(scope.querySelectorAll('h1, h2, h3, h4, h5, h6')) as HTMLElement[]
                        const match = heads.find(h => h.innerText?.toLowerCase().includes(needle))
                        if (match) match.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }}
                      title={`${n.title}${n.page ? ` — page ${n.page}` : ''}`}
                      className="text-left w-full truncate py-0.5 px-1 rounded-chip text-ink-700 hover:bg-paper-100 hover:text-ink-950 transition-colors flex items-baseline gap-1.5"
                    >
                      {n.ref && (
                        <span className="font-mono text-[10.5px] text-ink-500 flex-shrink-0">
                          {n.ref}
                        </span>
                      )}
                      <span className="truncate flex-1">{n.title}</span>
                      {n.page && (
                        <span
                          data-testid={`toc-page-${n.id}`}
                          className="font-mono text-[9.5px] text-ink-400 flex-shrink-0 tabular-nums"
                        >
                          p.{n.page}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </RailSection>
          )
        })()}

        {/* docs/39 B1 — the contract's fields beside its text: every value,
            who set it, and the fix in place (was a read-only list of six). */}
        {/* docs/39 G3 — the agreement this one amends: its changes, set there; or the agreement it may belong to. */}
        {/* docs/41 Part 13 — the family, the agreement as amended, an amendment's redline. */}
        {id && <FamilyPanel contractId={id} reveal={familyReveal} />}
        {id && <AgreementPanel contractId={id} canEdit={canEditFields} />}

        <RailSection title="Fields" defaultOpen>
          <dl className="flex flex-wrap gap-x-4 gap-y-0.5 pb-2 text-[11px] text-ink-500">
            <div><dt className="inline">Owner </dt><dd className="inline text-ink-700">{contract.owner?.name ?? '—'}</dd></div>
            {contract.contractNumber && <div><dt className="inline">No. </dt><dd className="inline font-mono text-ink-700">{contract.contractNumber}</dd></div>}
          </dl>
          <FieldsPanel contractId={id!} canEdit={canEditFields} variant="rail" onShowSource={showFieldSource} />
        </RailSection>

        {/* docs/39 C4 — what the AI noticed beyond the fields, beside them (it
            was only on the Overview tab, read-only), each one a click from
            being tracked on every contract. */}
        {aiFindings.length > 0 && (
          <RailSection title="AI findings" count={aiFindings.length}>
            <p className="pb-1.5 text-[11px] text-ink-500">Terms the AI noticed beyond your fields. Track one to follow it on every contract.</p>
            <ul className="space-y-1.5" data-testid="ai-findings-rail">
              {aiFindings.map(f => (
                <li key={f.key} className="rounded-md border border-paper-200 bg-card px-2 py-1.5 text-[11.5px]">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-ink-500">{f.label}</p>
                      <p className="text-ink-950 break-words" title={f.quote ? `“${f.quote}”` : undefined}>{formatTermValue(f.key, f.value)}</p>
                    </div>
                    {trackFindingButton(f)}
                  </div>
                </li>
              ))}
            </ul>
          </RailSection>
        )}

        {/* B.1.5d — Risks (collapsed by default, count in header) */}
        <RailSection
          title="Risks"
          count={
            contract.riskScore != null
              ? `${normalizeRisk(contract.riskScore)}`
              : riskFactors.length || null
          }
        >
          {contract.riskScore != null && (
            <div className="mb-3">
              <div className="flex items-center justify-between text-dense mb-1.5">
                <span className={cn(
                  'font-medium',
                  MEANING_CLASS[RISK_TO_MEANING[riskBand(normalizeRisk(contract.riskScore)!)]].fg,
                )}>
                  {(() => { const b = riskBand(normalizeRisk(contract.riskScore)!)
                    return b === 'high' ? 'High Risk' : b === 'medium' ? 'Medium Risk' : 'Low Risk' })()}
                </span>
                <span className="text-ink-500 tabular-nums">{normalizeRisk(contract.riskScore)}</span>
              </div>
              <div className="h-1 w-full rounded-full bg-paper-100 overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    MEANING_CLASS[RISK_TO_MEANING[riskBand(normalizeRisk(contract.riskScore)!)]].dot,
                  )}
                  style={{ width: `${normalizeRisk(contract.riskScore)}%` }}
                />
              </div>
            </div>
          )}
          {riskFactors.length > 0 ? (
            <ul className="space-y-1.5">
              {riskFactors.map((rf, i) => (
                <li key={i} className="flex items-start gap-2 text-dense text-ink-700">
                  <span className="mt-1.5 size-1 rounded-full bg-risk-600 flex-shrink-0" />
                  <span>{rf}</span>
                </li>
              ))}
            </ul>
          ) : contract.riskScore == null ? (
            <p className="text-body text-ink-400 italic">No risk analysis yet.</p>
          ) : null}
        </RailSection>

        {/* B.1.5d — Clause flags (collapsed; count = present flags) */}
        {presentFlags.length > 0 && (
          <RailSection title="Clause Flags" count={presentFlags.length}>
            <div className="flex flex-wrap gap-1.5">
              {presentFlags.map(([k, label]) => (
                <span
                  key={k}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-attention-50 text-attention-700 text-[11.5px] font-medium border border-attention-200"
                >
                  <AlertTriangle className="size-3" /> {label}
                </span>
              ))}
            </div>
          </RailSection>
        )}

        {/* B.1.5d — Clauses (count from versioned extraction) */}
        <RailSection
          title="Clauses"
          count={clausesData?.data?.length || null}
          action={
            clausesData?.data?.length ? (
              <button
                onClick={() => setTab('clauses')}
                className="text-[11px] font-semibold text-ink-950 hover:underline"
              >
                View all
              </button>
            ) : null
          }
        >
          {clausesData?.data?.length ? (
            <ul className="space-y-2">
              {clausesData.data.slice(0, 6).map((c: any) => (
                <li key={c.id} className="text-dense">
                  <div className="font-medium text-ink-950 truncate">
                    {clauseLabelOf(c.clauseType)}
                  </div>
                  {c.riskRating && (
                    <div className={cn(
                      'text-[11px] mt-0.5',
                      c.riskRating === 'HIGH' ? MEANING_CLASS.risk.fg :
                      c.riskRating === 'MEDIUM' ? MEANING_CLASS.turn.fg : MEANING_CLASS.binding.fg,
                    )}>
                      {c.riskRating.toLowerCase()} risk
                    </div>
                  )}
                </li>
              ))}
              {clausesData.data.length > 6 && (
                <li className="text-dense text-ink-400">+ {clausesData.data.length - 6} more</li>
              )}
            </ul>
          ) : (
            <p className="text-body text-ink-400 italic">No clauses extracted yet.</p>
          )}
        </RailSection>

        {/*
          B.1.5e — unified History: versions + attachments + parent/child all
          live in one timeline. Per plan this is also B.2. Merging because
          they share the rail and are conceptually "documents related to
          this contract" — users shouldn't have to tell us whether a
          counter-redline is a version, attachment, or child.
        */}
        {/* docs/41 Part 12 — versions are in the History drawer (with the
            rest of what happened); this section keeps the documents that go
            with the contract: attachments, its parent and its children. */}
        <RailSection
          title="Related documents"
          count={
            ((contract.attachments as any[] ?? []).length || 0) +
            (familyData?.children?.length ?? 0) +
            (familyData?.parent ? 1 : 0) || null
          }
          action={
            <span className="inline-flex items-center gap-3">
              {/* docs/39 A12 — attach an exhibit where the attachments are listed:
                  the Overview tab that had the only Attach button can't be
                  reached from the document for a contract without clauses. */}
              {mayEdit && (
                <button
                  onClick={() => attachFileRef.current?.click()}
                  disabled={attachMutation.isPending}
                  data-testid="rail-history-attach"
                  className="text-[11px] font-semibold text-ink-950 hover:underline disabled:opacity-50"
                  title="Attach an exhibit or schedule — it's read as part of the contract"
                >
                  {attachMutation.isPending ? 'Attaching…' : 'Attach'}
                </button>
              )}
              {/* docs/41 Part 15 — what changed between versions is the workspace's Changes mode. */}
              {versions.length >= 2 && (
                <button
                  onClick={openChanges}
                  data-testid="rail-history-changes"
                  className="text-[11px] font-semibold text-ink-950 hover:underline"
                >
                  Changes
                </button>
              )}
            </span>
          }
        >
          <ol className="space-y-2.5">
            {/* Parent contract — hierarchical link */}
            {familyData?.parent && (
              <li className="flex items-start gap-2.5">
                <Link className="size-3.5 text-ink-400 mt-0.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-500 font-semibold">Parent</div>
                  <button
                    onClick={() => navigate(`/contracts/${familyData.parent.id}`)}
                    className="text-dense text-ink-950 hover:underline truncate text-left w-full"
                  >
                    {familyData.parent.title}
                  </button>
                </div>
              </li>
            )}


            {/* Attachments */}
            {((contract.attachments as any[] ?? []) as any[]).map((att: any, i: number) => (
              <li key={`att-${i}`} className="flex items-start gap-2.5">
                <Paperclip className="size-3.5 text-ink-400 mt-1 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => downloadAttachment(i, att.filename)} className="block max-w-full text-dense text-ink-700 hover:text-ink-950 hover:underline truncate text-left" title="Download">
                    {att.label || att.filename}
                  </button>
                  {(() => {
                    const r = exhibitReading(att)
                    if (r.state === 'reading') return <div className="text-[11px] text-ink-500 inline-flex items-center gap-1" data-testid={`rail-attachment-read-${i}`}><Loader2 className="size-3 animate-spin" /> Reading it with the contract…</div>
                    if (r.state === 'failed') return <div className="text-[11px] text-attention-700" title={r.error ?? undefined} data-testid={`rail-attachment-read-${i}`}>Attachment · couldn’t read it</div>
                    if (r.state === 'unread' && mayEdit) return (
                      <div className="text-[11px] text-ink-400" data-testid={`rail-attachment-read-${i}`}>
                        Attachment · not read yet —{' '}
                        <button type="button" onClick={() => readAttachment.mutate(i)} disabled={readAttachment.isPending} className="underline underline-offset-2 hover:text-ink-950">read it with the contract</button>
                      </div>
                    )
                    return <div className="text-[11px] text-ink-400" data-testid={`rail-attachment-read-${i}`}>{r.state === 'read' ? `Attachment · read with the contract${r.pages ? ` · ${r.pages} page${r.pages === 1 ? '' : 's'}` : ''}` : 'Attachment'}</div>
                  })()}
                </div>
              </li>
            ))}

            {/* Children (amendments, SOWs, etc.) */}
            {familyData?.children && (familyData.children as any[]).map((child: any) => (
              <li key={`child-${child.id}`} className="flex items-start gap-2.5">
                {/* A child agreement is a relationship, not a binding state —
                    emerald here was decoration, so it's gone. */}
                <Link className="size-3.5 text-ink-400 mt-0.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-500 font-semibold">
                    {child.relationshipType ?? 'Related'}
                  </div>
                  <button
                    onClick={() => navigate(`/contracts/${child.id}`)}
                    className="text-dense text-ink-950 hover:underline truncate text-left w-full"
                  >
                    {child.title}
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </RailSection>

        {/* B.1.5f — Comments */}
        <RailSection
          title="Comments"
          count={commentCount || null}
        >
          {commentCount ? (
            <p className="text-body text-ink-700">
              {commentCount} comment{commentCount === 1 ? '' : 's'}.{' '}
              <button
                onClick={() => setTab('comments')}
                className="text-ink-700 hover:text-ink-950 underline underline-offset-2"
                data-testid="rail-open-comments"
              >
                Open the thread
              </button>
            </p>
          ) : (
            <p className="text-body text-ink-400 italic">No comments yet.</p>
          )}
        </RailSection>

      </aside>

      {/* end of two-column body */}
      </div>

      {id && <GoogleDocsStartDialog contractId={id} open={googleDocsOpen} onClose={() => setGoogleDocsOpen(false)} />}

      {id && (
        <HistoryDrawer
          contractId={id}
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          onCompare={() => openChanges()}
          onDownload={(versionId) => handleDownload(versionId)}
        />
      )}

      {/* Share dialog */}
      {showShareDialog && id && (
        <ShareLinkDialog contractId={id} onClose={() => setShowShareDialog(false)} />
      )}

      {/* Binder split modal */}
      {showSplitModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-card rounded-card shadow-e3 w-full max-w-lg">
            <div className="flex items-center justify-between p-5 border-b border-paper-200">
              <div>
                <h2 className="text-section text-ink-950">Split into separate contracts</h2>
                <p className="text-dense text-ink-500 mt-0.5">Set the page range, title, and type for each agreement</p>
              </div>
              <button onClick={() => setShowSplitModal(false)} className="text-ink-400 hover:text-ink-950">
                <XCircle className="size-5" />
              </button>
            </div>
            <div className="p-5 space-y-4 max-h-96 overflow-y-auto">
              {splitSpecs.map((spec, i) => (
                <div key={i} className="border border-paper-200 rounded-md p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-700">Agreement {i + 1}</span>
                    {splitSpecs.length > 2 && (
                      <button
                        onClick={() => setSplitSpecs(prev => prev.filter((_, j) => j !== i))}
                        className="text-dense text-risk-700 hover:text-risk-900 hover:underline"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <Input
                    value={spec.title}
                    onChange={e => setSplitSpecs(prev => prev.map((s, j) => j === i ? { ...s, title: e.target.value } : s))}
                    placeholder="Agreement title"
                  />
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="text-dense text-ink-500 mb-1 block">Page start</label>
                      <Input
                        type="number" min={1}
                        value={spec.pageStart}
                        onChange={e => setSplitSpecs(prev => prev.map((s, j) => j === i ? { ...s, pageStart: parseInt(e.target.value) || 1 } : s))}
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-dense text-ink-500 mb-1 block">Page end</label>
                      <Input
                        type="number" min={1}
                        value={spec.pageEnd}
                        onChange={e => setSplitSpecs(prev => prev.map((s, j) => j === i ? { ...s, pageEnd: parseInt(e.target.value) || 1 } : s))}
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-dense text-ink-500 mb-1 block">Type</label>
                      <select
                        value={spec.type}
                        onChange={e => setSplitSpecs(prev => prev.map((s, j) => j === i ? { ...s, type: e.target.value } : s))}
                        className="h-8 w-full rounded-md border border-input bg-card px-2 text-[13px] text-ink-950 focus:outline-none focus:border-brand-700 focus:ring-[3px] focus:ring-brand-700/15"
                      >
                        {CONTRACT_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                      </select>
                    </div>
                  </div>
                </div>
              ))}
              <button
                onClick={() => setSplitSpecs(prev => [...prev, { pageStart: 1, pageEnd: 10, title: `Agreement ${prev.length + 1}`, type: 'OTHER' }])}
                className="text-dense text-ink-950 hover:underline underline-offset-2 font-medium"
              >
                + Add another split
              </button>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-paper-200 bg-paper-50 rounded-b-card">
              <Button variant="outline" onClick={() => setShowSplitModal(false)}>Cancel</Button>
              <Button
                onClick={() => splitMutation.mutate(splitSpecs)}
                disabled={splitMutation.isPending || splitSpecs.length < 2}
              >
                {splitMutation.isPending
                  ? <><Loader2 className="size-4 animate-spin mr-1.5" /> Splitting…</>
                  : `Create ${splitSpecs.length} contracts`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Add related document modal */}
      {showAddRelated && (
        <UploadModal
          defaultParentContractId={id}
          onClose={() => setShowAddRelated(false)}
          onSuccess={() => {
            setShowAddRelated(false)
            qc.invalidateQueries({ queryKey: ['contract-family', id] })
            qc.invalidateQueries({ queryKey: ['contracts'] })
          }}
        />
      )}

      {/*
        B.5.4 — the full-screen "Open in Editor" modal was removed here.
        Editing now happens on the detail page itself via the Edit toggle
        (B.5.3) with DocumentCanvas.editable=true. Same rendering, no
        screen hop, no duplicated chrome. The ContractEditor component
        still exists in the codebase and may get reused for template
        editing (TemplatesPage) but is no longer a flow on this page.
      */}

      {/*
        B.5.9 — ⌘K AI command palette. Rendered at the page root so it
        overlays every tab / drawer / mode. The palette owns its own
        modal chrome (backdrop + input + suggestions); we only feed it
        the current contract id and the initial query (pre-filled from
        the bubble menu's ✨ AI button when relevant).
      */}
      {/* U.4.1 — Cmd-K palette deleted. ⌘K now focuses the rail composer
          via the global keyboard listener inside SideAgentRail. */}

      {/*
        P6.3 — Streaming bubble AI popover. Anchored to the current
        selection; renders 4 quick-action chips, then streams tokens
        via NDJSON. [Replace] / [Insert below] / [Copy] / retry.
      */}
      <BubbleAiPopover
        editor={canvasEditor}
        open={aiPopoverOpen}
        onClose={() => setAiPopoverOpen(false)}
        selectedText={aiPopoverText}
        selectionRange={aiPopoverRange}
      />

      {/* docs/39 C1 — the selection menu while reading (the bubble menu has it
          while editing), and C2's field picker it opens. */}
      <SelectionMenu
        editor={canvasEditor}
        enabled={tab === 'document' && docView === 'styled' && !isEditing}
        onSetField={canEditFields ? setFieldPick : undefined}
        onNewField={canCreateFields || canSuggestFields ? setNewFieldFrom : undefined}
        onTagClause={canTagClauses ? setClauseFrom : undefined}
        onSaveToLibrary={canSaveWording ? setLibraryFrom : undefined}
        {...selectionExtras.pdfActions}
      />
      {/* …and over the original PDF, with the same actions. */}
      <PdfSelectionMenu
        container={pdfBox}
        pageTexts={pdfPageTexts}
        enabled={tab === 'document' && docView === 'original' && hasOriginal}
        onSetField={canEditFields ? setFieldPick : undefined}
        onNewField={canCreateFields || canSuggestFields ? setNewFieldFrom : undefined}
        onTagClause={canTagClauses ? setClauseFrom : undefined}
        onSaveToLibrary={canSaveWording ? setLibraryFrom : undefined}
        {...selectionExtras.pdfActions}
      />
      {selectionExtras.ui}
      {libraryFrom && id && (
        <SaveToLibraryPopover contractId={id} selection={libraryFrom} onClose={() => setLibraryFrom(null)} />
      )}
      {clauseFrom && id && (
        <ClauseTagPicker
          contractId={id}
          selection={clauseFrom}
          onClose={() => setClauseFrom(null)}
          // The tagged passage, highlighted in whichever view is open (the document or the original PDF).
          onTagged={() => showInDocument(clauseFrom.text, clauseFrom.occurrence)}
        />
      )}
      {newFieldFrom && id && (
        <NewFieldPopover
          contractId={id}
          contractType={contract?.type ?? null}
          selection={newFieldFrom}
          canCreate={canCreateFields}
          onClose={() => setNewFieldFrom(null)}
        />
      )}
      {/* docs/39 C4 — something the AI found, tracked as a field from here on. */}
      {trackFinding && id && (
        <NewFieldPopover
          contractId={id}
          contractType={contract?.type ?? null}
          selection={{ text: findingText(trackFinding.finding.value), occurrence: 0, rect: trackFinding.rect, before: '', after: '' }}
          seed={{ label: trackFinding.finding.label, quote: trackFinding.finding.quote ?? null }}
          canCreate={canCreateFields}
          onClose={() => setTrackFinding(null)}
        />
      )}
      {fieldPick && id && (
        <FieldPicker
          contractId={id}
          selection={fieldPick}
          onClose={() => setFieldPick(null)}
          onSaved={() => showInDocument(fieldPick.text, fieldPick.occurrence)}
        />
      )}

      {/* docs/41 Part 16 — the editor's draft changes: save as a version, leave, or a save that met someone else's. */}
      <SaveVersionDialog
        key={saveVersionOpen ? 'open' : 'closed'}
        open={saveVersionOpen}
        onClose={() => { setSaveVersionOpen(false); afterSaveVersion.current = null }}
        onSave={saveAsVersion}
        saving={savingVersion}
        error={saveVersionError}
        canResetApprovals={canResetApprovals}
        canShare={canShare}
      />
      <LeaveDraftPrompt open={!!leaving} busy={leaveBusy} onChoose={chooseLeave} onClose={() => setLeaving(null)} />
      <WorkingCopyConflictDialog
        conflict={draft.conflict}
        onClose={draft.dismissConflict}
        onReload={async () => {
          const html = await draft.reloadTheirs()
          if (html != null) {
            setDraftHtml(html)
            canvasEditorRef.current?.commands.setContent(html, { emitUpdate: false })
          }
        }}
        onOverwrite={() => { void draft.overwrite() }}
      />

      {/* U.6.1 — Send-for-Review dialog. Picks workflow + adds optional
          message. Replaces the silent state flip the toolbar button did. */}
      {id && (
        <SendForReviewDialog
          contractId={id}
          contractType={contract?.type}
          contractValue={contract?.value}
          contractCurrency={contract?.currency}
          open={sendForReviewOpen}
          onClose={() => setSendForReviewOpen(false)}
          onSent={() => invalidateApproval(qc, id)}
        />
      )}

      {/* Phase 07 — Send-for-Signature dialog. Drives the eSignature backend
          (signature_requests + signers + tokens). Surfaces previously-API-only
          functionality so internal users can actually trigger the flow. */}
      {id && contract && (
        <SendForSignatureDialog
          contractId={id}
          contractTitle={contract.title}
          contractStatus={contract.status}
          hasVersion={!!contract.currentVersionId}
          open={sendForSignatureOpen}
          onClose={() => setSendForSignatureOpen(false)}
          onSent={() => {
            qc.invalidateQueries({ queryKey: ['contract', id] })
            qc.invalidateQueries({ queryKey: ['signature-requests', id] })
          }}
        />
      )}

      {/* P8 Step 8 — Create-amendment dialog. */}
      {id && contract && (
        <CreateAmendmentDialog
          parentContractId={id}
          parentTitle={contract.title}
          open={createAmendmentOpen}
          onClose={() => setCreateAmendmentOpen(false)}
          onCreated={() => {
            qc.invalidateQueries({ queryKey: ['contract-family', id] })
          }}
        />
      )}

      {/*
        P6.5 — Inline deviation popover. Opens when the user clicks
        a P6.2 margin badge (market/aggressive/weak/off). Shows the
        classifier's full rationale + 3 actions. "Rewrite to market"
        hands off to the P6.3 BubbleAiPopover on the same paragraph.
      */}
      <ClauseDeviationPopover
        onAskRewrite={(paragraphText) => {
          // Find + select the paragraph inside the editor, then open
          // the streaming AI popover with the text pre-captured.
          const editor = canvasEditor
          if (!editor) return
          const needle = paragraphText.slice(0, 80).trim()
          if (!needle) return
          let hitFrom = -1, hitTo = -1
          editor.state.doc.descendants((node, pos) => {
            if (hitFrom >= 0) return false
            if (node.type.name !== 'paragraph') return true
            const txt = node.textContent
            const idx = txt.indexOf(needle)
            if (idx >= 0) {
              hitFrom = pos + 1 + idx
              hitTo   = hitFrom + paragraphText.length
            }
            return false
          })
          if (hitFrom < 0) return
          editor.chain().setTextSelection({ from: hitFrom, to: hitTo }).run()
          setAiPopoverText(paragraphText)
          setAiPopoverRange({ from: hitFrom, to: hitTo })
          setAiPopoverOpen(true)
        }}
      />


      {/*
        B.5.17 — First-visit guide. Dismissible three-step walkthrough
        pointing at the three canvas concepts most users miss:
        ⌘K palette, Edit toggle + bubble menu, and the right rail.
        LocalStorage remembers "seen" so power users never see it twice.
      */}
      <CoachMarks />
    </div>
  )
}
