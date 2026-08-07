import { useState, useRef, useEffect, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
// B.5.2 — PDF viewer re-enabled as the "Original" view via the
// [Styled | Original] toggle. Styled (TipTap / DocumentCanvas) remains the
// default; Legal users typically flip to Original for pixel fidelity.
import { Worker, Viewer } from '@react-pdf-viewer/core'
import { defaultLayoutPlugin } from '@react-pdf-viewer/default-layout'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ArrowLeft, Copy, Download, FileText, Clock, Tag, User,
  AlertCircle, Sparkles, Loader2,
  CheckCircle2, AlertTriangle, XCircle, Shield, TrendingUp,
  ChevronDown, ChevronUp, ChevronRight, CheckSquare,
  Link, Paperclip, Trash2, ExternalLink, Scissors, RefreshCw,
  FileEdit, Share2, ArrowLeftRight, X, PenLine, GitBranch,
} from 'lucide-react'
import { toast } from '@/components/common/Toaster'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { UploadModal } from '@/components/contracts/UploadModal'
import { DiffViewer } from '@/components/contracts/DiffViewer'
import { CommentsPanel } from '@/components/contracts/CommentsPanel'
import { ShareLinkDialog } from '@/components/contracts/ShareLinkDialog'
import { ContractMatterPicker } from '@/components/contracts/ContractMatterPicker'
import { ObligationsRailSection } from '@/components/contracts/ObligationsRailSection'
import { ComplianceRailSection } from '@/components/contracts/ComplianceRailSection'
import { PlaybookRedlineRailSection } from '@/components/contracts/PlaybookRedlineRailSection'
import { MatterRailSection } from '@/components/contracts/MatterRailSection'
import { RenewalAdviceRailSection, type RenewalAdvice } from '@/components/contracts/RenewalAdviceRailSection'
import { BubbleAiPopover } from '@/components/contracts/BubbleAiPopover'
import { DefinedTermsRailSection } from '@/components/contracts/DefinedTermsRailSection'
import { ClauseDeviationPopover } from '@/components/contracts/ClauseDeviationPopover'
import { RedlinePanel } from '@/components/contracts/RedlinePanel'
import { ApprovalTimeline } from '@/components/approvals/ApprovalTimeline'
import { ApprovalCard } from '@/components/approvals/ApprovalCard'
import { StatusPill } from '@/components/contracts/StatusPill'
import { RailSection } from '@/components/contracts/RailSection'
import { DocumentCanvas, type CanvasState } from '@/components/contracts/DocumentCanvas'
import {
  FocusedReviewDrawer,
  type FocusedClause,
  type ReviewState,
} from '@/components/contracts/FocusedReviewDrawer'
import { classifyRisk } from '@/components/contracts/RiskDecorations'
// U.4.1 — AiCommandPalette deleted. ⌘K now focuses the rail composer.
import { DecisionStrip } from '@/components/contracts/DecisionStrip'
import { NegotiationStatusStrip } from '@/components/contracts/NegotiationStatusStrip'
import { CompareMode } from '@/components/contracts/CompareMode'
import { SendForReviewDialog } from '@/components/contracts/SendForReviewDialog'
import { SendForSignatureDialog } from '@/components/contracts/SendForSignatureDialog'
import { CreateAmendmentDialog } from '@/components/contracts/CreateAmendmentDialog'
import { CollabStatusBadge } from '@/components/contracts/CollabStatusBadge'
import { SignatureStatusRailSection } from '@/components/contracts/SignatureStatusRailSection'
import { CoachMarks } from '@/components/contracts/CoachMarks'
import { useMediaQuery, BREAKPOINTS } from '@/hooks/useMediaQuery'
import { track } from '@/lib/telemetry'

import '@react-pdf-viewer/core/lib/styles/index.css'
import '@react-pdf-viewer/default-layout/lib/styles/index.css'

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  NDA:              'bg-purple-100 text-purple-700 border-purple-200',
  MSA:              'bg-blue-100 text-blue-700 border-blue-200',
  SOW:              'bg-cyan-100 text-cyan-700 border-cyan-200',
  SLA:              'bg-teal-100 text-teal-700 border-teal-200',
  VENDOR_AGREEMENT: 'bg-orange-100 text-orange-700 border-orange-200',
  EMPLOYMENT:       'bg-green-100 text-green-700 border-green-200',
  PARTNERSHIP:      'bg-indigo-100 text-indigo-700 border-indigo-200',
  LICENSE:          'bg-yellow-100 text-yellow-700 border-yellow-200',
  OTHER:            'bg-gray-100 text-gray-600 border-gray-200',
}

const CONTRACT_TYPES = [
  'NDA', 'MSA', 'SOW', 'SLA', 'VENDOR_AGREEMENT',
  'EMPLOYMENT', 'PARTNERSHIP', 'LICENSE', 'OTHER',
]

const IN_PROGRESS_STATUSES = ['PENDING', 'PARSING', 'SPLITTING', 'CLASSIFYING', 'EXTRACTING', 'INDEXING', 'ANALYZING', 'DRAFTING']

// Statuses that can get "stuck" — includes queued states with a longer threshold
const STUCK_DETECTABLE = ['PENDING', 'DRAFTING', 'PARSING', 'SPLITTING', 'CLASSIFYING', 'EXTRACTING', 'INDEXING', 'ANALYZING']

const STATUS_BANNER: Record<string, { message: string; sub: string }> = {
  PENDING:     { message: 'Processing starting…',                     sub: '' },
  PARSING:     { message: 'Extracting document text…',                sub: '' },
  SPLITTING:   { message: 'Splitting binder into separate contracts…', sub: '' },
  CLASSIFYING: { message: 'Identifying contract type…',               sub: '' },
  EXTRACTING:  { message: 'Routing to AI agent…',                     sub: '' },
  ANALYZING:   { message: 'AI extracting clauses, key terms & risk…', sub: '(~30–60 seconds)' },
  INDEXING:    { message: 'Building search index…',                   sub: '' },
}

// Ordered pipeline steps — used for the step indicator in the progress banner
const PIPELINE_STEPS = [
  { statuses: ['PENDING'],                  label: 'Queue'    },
  { statuses: ['PARSING'],                  label: 'Parse'    },
  { statuses: ['SPLITTING', 'CLASSIFYING'], label: 'Classify' },
  { statuses: ['EXTRACTING'],               label: 'Extract'  },
  { statuses: ['ANALYZING'],                label: 'Analyze'  },
  { statuses: ['INDEXING'],                 label: 'Index'    },
]

// B.1.5a — STATUS_COLORS (the old pill-tint map) is no longer consumed
// here; color choices moved into StatusPill.tsx. Retained as a commented
// reference in case we need the old palette for a list-row mini-badge
// variant later. Delete after one sprint if unused.
//
// const STATUS_COLORS: Record<string, string> = {
//   DRAFT:             'bg-gray-100 text-gray-600',
//   PENDING_REVIEW:    'bg-amber-100 text-amber-700',
//   UNDER_NEGOTIATION: 'bg-orange-100 text-orange-700',
//   PENDING_APPROVAL:  'bg-blue-100 text-blue-700',
//   APPROVED:          'bg-emerald-100 text-emerald-700',
//   EXECUTED:          'bg-emerald-100 text-emerald-700',
//   EXPIRED:           'bg-red-100 text-red-700',
//   ARCHIVED:          'bg-gray-100 text-gray-500',
// }

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
type Tab = 'overview' | 'document' | 'clauses' | 'versions' | 'activity' | 'negotiate' | 'comments' | 'approval'

// ─── Valid status transitions for manual user actions ─────────────────────────
//
// A.3 — The DRAFT → PENDING_REVIEW manual button was removed. It was a
// workflow bypass that let users flip status without assigning a reviewer,
// workflow, or deadline. "Send for Review" now always goes through
// /submit-approval (the real workflow engine), producing PENDING_APPROVAL.
// PENDING_REVIEW remains reachable via the workflow engine's rejection-to-
// review path (wired in B.5).
const STATUS_TRANSITIONS: Record<string, Array<{ to: string; label: string; variant?: 'default' | 'outline' }>> = {
  PENDING_REVIEW:     [{ to: 'UNDER_NEGOTIATION', label: 'Start Negotiation' },
                       { to: 'DRAFT', label: 'Return to Draft', variant: 'outline' }],
  UNDER_NEGOTIATION:  [{ to: 'PENDING_REVIEW', label: 'Back to Review', variant: 'outline' }],
  APPROVED:           [{ to: 'EXECUTED', label: 'Mark as Executed' }],
  EXECUTED:           [{ to: 'ARCHIVED', label: 'Archive', variant: 'outline' }],
  EXPIRED:            [{ to: 'ARCHIVED', label: 'Archive', variant: 'outline' }],
}

// ─── Clause type → human-readable label ───────────────────────────────────────
const CLAUSE_TYPE_LABELS: Record<string, string> = {
  limitation_of_liability:       'Limitation of Liability',
  uncapped_liability:             'Uncapped Liability',
  indemnification:                'Indemnification',
  liquidated_damages:             'Liquidated Damages',
  payment:                        'Payment Terms',
  price_adjustment:               'Price Adjustment',
  minimum_commitment:             'Minimum Commitment',
  volume_restriction:             'Volume Restriction',
  ip_ownership:                   'IP Ownership',
  ip_license_back:                'IP License-Back',
  license_grant:                  'License Grant',
  joint_ip:                       'Joint IP Ownership',
  source_code_escrow:             'Source Code Escrow',
  termination:                    'Termination',
  post_termination_services:      'Post-Termination Services',
  confidentiality:                'Confidentiality',
  confidential_info_definition:   'Definition of Confidential Information',
  non_compete:                    'Non-Compete',
  non_solicitation:               'Non-Solicitation',
  non_disparagement:              'Non-Disparagement',
  covenant_not_to_sue:            'Covenant Not to Sue',
  governing_law:                  'Governing Law',
  dispute_resolution:             'Dispute Resolution',
  notice:                         'Notice',
  auto_renewal:                   'Auto-Renewal',
  renewal_term:                   'Renewal Terms',
  exclusivity:                    'Exclusivity',
  warranty:                       'Warranty',
  warranty_duration:              'Warranty Duration',
  representations_warranties:     'Representations & Warranties',
  force_majeure:                  'Force Majeure',
  assignment:                     'Assignment',
  change_of_control:              'Change of Control',
  mfn:                            'Most Favoured Nation',
  audit_rights:                   'Audit Rights',
  rofr:                           'Right of First Refusal/Offer',
  insurance:                      'Insurance',
  acceptance:                     'Acceptance',
  data_protection:                'Data Protection',
  third_party_beneficiary:        'Third-Party Beneficiary',
  general:                        'General',
}

const RISK_RATING_BADGE: Record<string, { label: string; cls: string }> = {
  unfavorable: { label: 'Unfavorable', cls: 'bg-red-100 text-red-700 border border-red-200' },
  favorable:   { label: 'Favorable',   cls: 'bg-emerald-100 text-emerald-700 border border-emerald-200' },
  unusual:     { label: 'Unusual',     cls: 'bg-amber-100 text-amber-700 border border-amber-200' },
  neutral:     { label: 'Neutral',     cls: 'bg-gray-100 text-gray-500 border border-gray-200' },
}

interface FieldDef {
  id: string; fieldKey: string; fieldLabel: string
  fieldType: string; contractType: string | null; options: string[]
}
interface AiFinding {
  key: string; label: string; value: unknown; confidence: number; quote?: string
}
interface TypeField {
  value: unknown; confidence: number; label: string; quote?: string
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ConfidenceIcon({ confidence }: { confidence: number }) {
  if (confidence >= 0.9) return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
  if (confidence >= 0.7) return <AlertTriangle className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" />
  return <XCircle className="h-3.5 w-3.5 text-red-400 flex-shrink-0" />
}

function RiskMeter({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  const color = score >= 0.67 ? 'bg-red-500' : score >= 0.34 ? 'bg-amber-400' : 'bg-emerald-500'
  const label = score >= 0.67 ? 'High Risk' : score >= 0.34 ? 'Medium Risk' : 'Low Risk'
  const labelColor = score >= 0.67 ? 'text-red-600' : score >= 0.34 ? 'text-amber-600' : 'text-emerald-600'
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className={`text-sm font-semibold ${labelColor}`}>{label}</span>
        <span className="text-sm font-bold text-gray-900">{pct}%</span>
      </div>
      <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
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
  typeLabel, sectionRef, badge, interpretation, content,
}: {
  typeLabel: string
  sectionRef?: string | null
  badge: { label: string; cls: string } | null
  interpretation?: string | null
  content: string
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm hover:shadow transition-shadow">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          {badge && (
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${badge.cls}`}>
              {badge.label}
            </span>
          )}
          <span className="text-sm font-semibold text-gray-800">{typeLabel}</span>
        </div>
        {sectionRef && (
          <span className="text-xs text-gray-400 flex-shrink-0 mt-0.5">{sectionRef}</span>
        )}
      </div>
      {interpretation ? (
        <p className="text-sm text-gray-600 leading-relaxed mb-2">{interpretation}</p>
      ) : (
        <p className="text-sm text-gray-400 italic mb-2">No interpretation available.</p>
      )}
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-700 font-medium"
      >
        {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        {expanded ? 'Hide' : 'View'} verbatim text
      </button>
      {expanded && (
        <div className="mt-2 p-3 bg-gray-50 rounded-lg border border-gray-100">
          <p className="text-xs text-gray-600 font-mono leading-relaxed whitespace-pre-wrap">{content}</p>
        </div>
      )}
    </div>
  )
}

// B.1 — `hideIfEmpty` suppresses the row entirely when the value is an
// empty/placeholder string. Previously the Contract Details panel showed
// 6+ rows of `—` on contracts that had no extraction yet.
function DetailRow({ label, value, hideIfEmpty = true }: { label: string; value: string; hideIfEmpty?: boolean }) {
  if (hideIfEmpty && (!value || value === '—' || value === '-')) return null
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 border-b border-gray-50 last:border-0">
      <span className="text-xs text-gray-400 whitespace-nowrap pt-0.5">{label}</span>
      <span className="text-sm text-gray-800 font-medium text-right">{value}</span>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function ContractDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  // P3.1 — when a citation pill links here with ?section=9.2, we scroll
  // the TipTap view to that heading + flash the matching TOC entry.
  const [searchParams] = useSearchParams()
  const highlightSection = searchParams.get('section') ?? null
  // B.1 — default to 'document' so the contract itself is the first thing
  // a user sees, instead of a wall of AI-generated analysis panels.
  const [tab, setTab] = useState<Tab>('document')
  // B.5.4 — showEditor + its modal were deleted; edit mode now lives on
  // this same canvas via isEditing (see B.5.3).
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [pdfError, setPdfError] = useState<string | null>(null)
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

  // B.5.2 — Styled | Original document view.
  const [docView, setDocView] = useState<'styled' | 'original'>(() => {
    if (typeof window === 'undefined') return 'styled'
    const saved = window.localStorage.getItem('clm.doc-view')
    return saved === 'original' ? 'original' : 'styled'
  })
  useEffect(() => {
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
  // P7.4.4 — Expand the REVIEW PROGRESS row into a checklist so users
  // can mark items reviewed without hunting for each red underline.
  const [reviewExpanded, setReviewExpanded] = useState(false)
  const [reviewStates, setReviewStates] = useState<Record<string, ReviewState>>({})

  // B.5.3 — Edit mode on the unified canvas.
  // Replaces the old "Open in Editor" full-screen modal flow. Edit mode
  // flips the TipTap editor to editable=true and debounces saves to the
  // existing /html-version endpoint. Exits on click, Esc, or Save.
  const [isEditing, setIsEditing] = useState(false)

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
  const [createAmendmentOpen, setCreateAmendmentOpen]   = useState(false)
  // P6.3 — streaming bubble AI popover
  const [aiPopoverOpen, setAiPopoverOpen] = useState(false)
  const [aiPopoverText, setAiPopoverText] = useState('')
  const [aiPopoverRange, setAiPopoverRange] = useState<{ from: number; to: number } | null>(null)

  // B.5.13 — Compare Versions mode (full-screen overlay).
  // Elevated from a buried tab to a first-class mode per docs/26 State 9.
  const [compareOpen, setCompareOpen] = useState(false)

  // B.5.16 — Responsive rail behaviour.
  //   xl+   (≥1280)  → static two-column layout (rail visible).
  //   md-lg (768–1279) → rail becomes a slide-in right drawer.
  //   < md   (mobile)  → rail becomes a bottom sheet with 64px peek.
  // The floating trigger button is hidden at xl+.
  const isXl = useMediaQuery(BREAKPOINTS.xl)
  const isMd = useMediaQuery(BREAKPOINTS.md)
  const [railOpen, setRailOpen] = useState(false)

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
        tocItem.classList.add('bg-blue-100', 'ring-2', 'ring-blue-400')
        tocItem.scrollIntoView({ behavior: 'smooth', block: 'center' })
        // 5s flash — long enough for users to visually register and
        // for verification scripts to catch it deterministically.
        setTimeout(() => tocItem.classList.remove('bg-blue-100', 'ring-2', 'ring-blue-400'), 5000)
      }
    }, 350)
    return () => clearTimeout(t)
  }, [highlightSection])
  const canvasEditorRef = useRef<import('@tiptap/react').Editor | null>(null)
  // Mirror the ref into state so rail sections that need the editor
  // (P6.4 DefinedTermsRailSection, P6.3 BubbleAiPopover) re-render
  // when the editor remounts on Edit-mode toggle.
  const [canvasEditor, setCanvasEditor] = useState<import('@tiptap/react').Editor | null>(null)
  const dirtyHtmlRef = useRef<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle')

  const saveHtmlVersion = useMutation({
    mutationFn: (html: string) =>
      api.post(`/contracts/${id}/html-version`, {
        htmlContent: html,
        changeNote: 'Edited in-place',
      }).then(r => r.data),
    onMutate: () => setSaveState('saving'),
    onSuccess: () => {
      setSaveState('saved')
      qc.invalidateQueries({ queryKey: ['contract', id] })
      qc.invalidateQueries({ queryKey: ['contract-versions', id] })
    },
    onError: () => setSaveState('error'),
  })

  const flushPendingSave = () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const html = dirtyHtmlRef.current
    if (html != null) {
      dirtyHtmlRef.current = null
      saveHtmlVersion.mutate(html)
    }
  }

  const enterEdit = () => {
    // Edit requires Styled view (can't edit a PDF).
    if (docView !== 'styled') setDocView('styled')
    setIsEditing(true)
    track('edit_entered', { from: docView })
  }
  const exitEdit = () => {
    flushPendingSave()
    setIsEditing(false)
    track('edit_exited', {})
  }

  // Esc exits edit mode. Cmd+S forces a flush.
  useEffect(() => {
    if (!isEditing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); exitEdit() }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flushPendingSave() }
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
      const inFlight =
        (s && IN_PROGRESS_STATUSES.includes(s)) ||
        rm === 'ANALYZING' ||
        pr === 'QUEUED' || pr === 'RUNNING'
      return inFlight ? 4000 : false
    },
  })

  const { data: versionsData } = useQuery({
    queryKey: ['contract-versions', id],
    queryFn: () => api.get(`/contracts/${id}/versions`).then(r => r.data),
    enabled: !!id,
  })

  const { data: timelineData } = useQuery({
    queryKey: ['contract-timeline', id],
    queryFn: () => api.get(`/contracts/${id}/timeline`).then(r => r.data),
    // B.1.5f — rail's Activity section is collapsed-by-default, but we still
    // want a count shown; fetch the timeline once the contract loads.
    enabled: !!id,
    staleTime: 30_000,
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
        if (s === 'unreviewed' || s === 'reviewed' || s === 'resolved') next[c.id] = s
      }
      return next
    })
  }, [clausesData])

  const updateReviewState = useMutation({
    mutationFn: ({ clauseId, state }: { clauseId: string; state: ReviewState }) =>
      api.patch(`/contracts/clauses/${clauseId}/review-state`, { state }).then(r => r.data),
    onError: () => {
      qc.invalidateQueries({ queryKey: ['contract-clauses', id] })
    },
  })

  const { data: fieldDefsData } = useQuery({
    queryKey: ['field-definitions'],
    queryFn: () => api.get('/field-definitions').then(r => r.data.data as FieldDef[]),
    enabled: !!contract,
    staleTime: 60_000,
  })

  // Phase 06 — approval instance for this contract.
  // B.5.10 — we now load this on every detail-page open (not only when
  // the approval tab is visible) so the Decision Strip can render when
  // the current user is the pending approver (docs/26 State 4).
  const { data: approvalData, refetch: refetchApproval } = useQuery({
    queryKey: ['contract-approval', id],
    queryFn: () => api.get(`/approvals/my-queue`).then(r => {
      // Filter to this contract's approval context
      const items = r.data?.data ?? []
      return items.find((i: { contract: { id: string } }) => i.contract?.id === id) ?? null
    }),
    enabled: !!id,
    staleTime: 15_000,
  })

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

  // Full approval instance (for timeline + B.5.12 negotiation strip).
  // B.5.12 relaxed the enabled gate so owners see "waiting on approver"
  // signal without opening the approval tab. Still cheap — two GETs,
  // 15s stale window.
  const { data: approvalInstanceData } = useQuery({
    queryKey: ['approval-instance-by-contract', id],
    queryFn: () => api.get(`/approvals?contractId=${id}&limit=1`).then(async r => {
      // Get the most recent instance for this contract via my-queue or direct lookup
      // Using the submit endpoint response pattern: GET /approvals/:instanceId
      const queue = r.data?.data ?? []
      const item = queue.find((i: { contract: { id: string } }) => i.contract?.id === id)
      if (!item) return null
      return api.get(`/approvals/${item.instanceId}`).then(r2 => r2.data)
    }),
    enabled: !!id && (
      tab === 'approval'
      || ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'].includes(contract?.status ?? '')
    ),
    staleTime: 15_000,
  })

  const submitForApproval = useMutation({
    mutationFn: (workflowDefinitionId?: string) =>
      api.post(`/contracts/${id}/submit-approval`, { workflowDefinitionId }).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', id] })
      qc.invalidateQueries({ queryKey: ['contract-approval', id] })
      qc.invalidateQueries({ queryKey: ['approval-instance-by-contract', id] })
    },
  })

  const analyze = useMutation({
    mutationFn: () => api.post(`/contracts/${id}/analyze`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contract', id] }),
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

  const changeStatus = useMutation({
    mutationFn: (newStatus: string) =>
      api.patch(`/contracts/${id}`, { status: newStatus }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', id] })
      qc.invalidateQueries({ queryKey: ['contracts'] })
      qc.invalidateQueries({ queryKey: ['dashboard-stats'] })
    },
  })

  const retype = useMutation({
    mutationFn: (contractType: string) => api.post(`/contracts/${id}/retype`, { contractType }),
    onSuccess: () => {
      setEditingType(false)
      qc.invalidateQueries({ queryKey: ['contract', id] })
    },
  })

  // Binder split
  const [showSplitModal, setShowSplitModal] = useState(false)
  const [splitSpecs, setSplitSpecs] = useState<Array<{ pageStart: number; pageEnd: number; title: string; type: string }>>([])
  const suggestedSplits: any[] = (contract as any)?.metadata?._suggestedSplits ?? []
  const binderDetected = !!(contract as any)?.metadata?._binderDetected
  const splitInto: string[] = (contract as any)?.metadata?._splitInto ?? []
  const autoSplitDone = splitInto.length > 0

  // Stuck detection: in-progress but updatedAt hasn't changed in 3 minutes
  // PENDING is excluded — it's just queued, not stuck
  const STUCK_THRESHOLD_MS = 3 * 60 * 1000
  const isStuck = !!(
    contract?.analysisStatus &&
    STUCK_DETECTABLE.includes(contract.analysisStatus) &&
    contract.updatedAt &&
    Date.now() - new Date(contract.updatedAt).getTime() > STUCK_THRESHOLD_MS
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
  const [diffV1Id, setDiffV1Id] = useState('')
  const [diffV2Id, setDiffV2Id] = useState('')

  const diffQuery = useQuery({
    queryKey: ['contract-diff', id, diffV1Id, diffV2Id],
    queryFn: () => api.get(`/contracts/${id}/versions/${diffV1Id}/diff/${diffV2Id}`).then(r => r.data),
    enabled: !!diffV1Id && !!diffV2Id && diffV1Id !== diffV2Id && tab === 'negotiate',
  })

  const redlineMutation = useMutation({
    mutationFn: ({ v1Id, v2Id }: { v1Id: string; v2Id: string }) =>
      api.post(`/contracts/${id}/redline`, { v1Id, v2Id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contract', id] }),
  })

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

  const handleDownload = async (versionId?: string) => {
    const res = await api.get(`/contracts/${id}/download`, {
      params: versionId ? { versionId } : undefined,
    })
    window.open(res.data.url, '_blank')
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

  // U.1.2 — does the current version have an actual PDF/source file? When
  // null it's a text-only / template-generated contract — the Original
  // toggle would crash with "Invalid PDF structure". We disable it instead.
  const hasOriginal = !!(versions[0]?.s3Key && versions[0]?.mimeType)

  const { data: commentsData } = useQuery({
    queryKey: ['comments', id],
    queryFn: () => api.get(`/contracts/${id}/comments`, { params: { limit: 1 } }).then(r => r.data),
    enabled: !!id,
    staleTime: 30_000,
  })

  // P7.4.16 / F-31 — pull active share-links so the NegotiationStatusStrip
  // can tell "we sent it" from "we never shared". Cheap query, only fires
  // when we're in a phase where it matters.
  const { data: shareLinksData } = useQuery({
    queryKey: ['share-links', id],
    queryFn: () => api.get(`/contracts/${id}/share`).then(r => r.data),
    enabled: !!id && ['UNDER_NEGOTIATION', 'PENDING_APPROVAL'].includes(contract?.status ?? ''),
    staleTime: 30_000,
  })
  const commentCount: number | undefined = commentsData?.data?.length != null
    ? (commentsData.nextCursor ? '9+' : commentsData.data.length) as any
    : undefined

  const visibleTabs = useMemo(() => {
    const tabs: Tab[] = ['overview', 'clauses', 'document', 'versions']
    if (versions.length >= 2) tabs.push('negotiate')
    tabs.push('comments')
    if (
      contract?.analysisStatus === 'DONE' ||
      ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'].includes(contract?.status ?? '')
    ) {
      tabs.push('approval')
    }
    tabs.push('activity')
    return tabs
  }, [versions.length, contract?.analysisStatus, contract?.status])

  useEffect(() => {
    if (!visibleTabs.includes(tab)) setTab('document')
  }, [visibleTabs, tab])

  // B.1 — auto-load the PDF when Document is active and we haven't yet.
  // Kills the "click Load Document to see your own contract" dance.
  useEffect(() => {
    if (tab === 'document' && !pdfUrl && !pdfError && id) {
      handleViewPdf()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, id])

  // Auto-populate version dropdowns when switching to negotiate tab
  useEffect(() => {
    if (tab === 'negotiate' && versions.length >= 2 && !diffV1Id && !diffV2Id) {
      setDiffV1Id(versions[1]?.id ?? '')
      setDiffV2Id(versions[0]?.id ?? '')
    }
    if (tab !== 'negotiate' && (diffV1Id || diffV2Id)) {
      setDiffV1Id('')
      setDiffV2Id('')
    }
  }, [tab, versions.length]) // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-gray-300" />
      </div>
    )
  }

  if (!contract) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <AlertCircle className="h-10 w-10 text-gray-300" />
        <p className="text-gray-500 font-medium">Contract not found</p>
        <Button variant="outline" onClick={() => navigate('/contracts')}>Back to Contracts</Button>
      </div>
    )
  }

  const keyTerms = contract.keyTerms ?? {}
  const fieldConfidence: Record<string, any> = contract.fieldConfidence ?? {}
  const riskFactors: string[] = contract.riskFactors ?? []
  const clauseFlags: Record<string, boolean> = contract.versions?.[0]?.clauseFlags ?? {}
  // P2.1 — trust-signal: was this version's text produced by OCR? If
  // yes, the badge in the header lets Legal eyeball "this is scan-
  // derived text; extraction confidence is lower than a digital PDF".
  // P3.1 note — the editor autosave creates new versions without
  // structure metadata. Walk versions[] and pick the most recent one
  // that actually carries structure (or extraction), falling back to
  // versions[0] so existing code paths don't regress.
  const latestVersionMeta = (() => {
    const versions = (contract.versions ?? []) as Array<{ metadata?: Record<string, unknown> }>
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
  }
  const ocrApplied = extractionMeta.ocrApplied === true
  const timeline = timelineData?.data ?? []
  const presentFlags = Object.entries(CLAUSE_FLAG_LABELS).filter(([k]) => clauseFlags[k] === true)
  const keyTermEntries = Object.entries(keyTerms).filter(([, v]) => v != null && v !== '' && v !== false)
  const hasAnalysis = !!(contract.summary || keyTermEntries.length > 0)

  // Custom fields + AI findings from contract.metadata
  const customMeta = (contract.metadata ?? {}) as Record<string, unknown>
  const aiFindings: AiFinding[] = (customMeta._aiFindings as AiFinding[]) ?? []
  const redlineMeta = (customMeta._redlineAnalysis ?? null) as any
  const redlineStatus = (customMeta._redlineStatus ?? null) as string | null
  const isAnalyzingRedlines = redlineStatus === 'ANALYZING'
  const typeFieldsMap = (customMeta._typeFields ?? {}) as Record<string, TypeField>
  const typeFieldEntries = Object.entries(typeFieldsMap).filter(([, f]) => f.value != null)
  const relevantFieldDefs = (fieldDefsData ?? []).filter(
    (fd: FieldDef) => fd.contractType === null || fd.contractType === contract.type
  )
  const populatedFields = relevantFieldDefs.filter((fd: FieldDef) => customMeta[fd.fieldKey] != null)

  // Suggested questions used to live here for the in-page Ask tab
  // (U.4.4 deleted). When we add per-contract suggested prompts on
  // the rail, the canonical seed list is in git history.

  return (
    <div className="h-full flex flex-col bg-gray-50">
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
      <div className="bg-white border-b px-6 py-4 space-y-2.5">
        {/* Row 1 — title + action buttons */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <button
              onClick={() => navigate('/contracts')}
              className="mt-0.5 p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors flex-shrink-0"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <h1
              className="text-xl font-semibold text-gray-900 leading-tight line-clamp-2 break-words flex-1 min-w-0"
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
              className="mt-0.5 p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors flex-shrink-0"
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>
          {/* Row 1 right — action buttons */}
          <div className="flex items-center gap-2 flex-shrink-0">
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
            <div className="hidden xl:inline-flex items-center rounded-md border border-gray-200 bg-gray-50 p-0.5">
              <button
                onClick={() => setDocView('styled')}
                aria-pressed={docView === 'styled'}
                disabled={isEditing}
                title={isEditing ? 'Exit Edit mode to switch to Original PDF' : undefined}
                className={cn(
                  'px-2.5 py-1 text-xs font-medium rounded transition-colors',
                  docView === 'styled'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-800',
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
                    : !hasOriginal
                      ? 'No original file — this contract was created from text or a template.'
                      : 'View the original PDF — pixel-exact, read-only.'
                }
                data-testid="doc-view-original"
                className={cn(
                  'px-2.5 py-1 text-xs font-medium rounded transition-colors',
                  docView === 'original'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-800',
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
                  <Button variant="outline" size="sm" className="hidden 2xl:inline-flex gap-1 text-xs text-gray-600">
                    Risks: <span className="font-semibold capitalize">{riskView}</span>
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={() => setRiskView('full')}>
                    <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                    Full — underlines + margin dots
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setRiskView('summary')}>
                    <span className="h-1.5 w-1.5 rounded-full bg-gray-400" />
                    Summary — margin dots only
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setRiskView('off')}>
                    <span className="h-1.5 w-1.5 rounded-full bg-transparent border border-gray-300" />
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
            <Button
              variant="outline"
              size="sm"
              disabled={versions.length < 2}
              onClick={() => {
                setCompareOpen(true)
                track('compare_opened', { versionCount: versions.length })
              }}
              className="hidden xl:inline-flex gap-1.5 text-gray-600"
              title={versions.length < 2
                ? 'Upload a second version to compare. Until then there is nothing to diff.'
                : 'Compare two versions with redline attribution'}
              data-testid="compare-btn"
            >
              <ArrowLeftRight className="h-4 w-4" />
              Compare
            </Button>

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
                  className="gap-1.5 text-gray-600"
                  aria-label="Undo"
                  title="Undo (⌘Z)"
                >
                  <RefreshCw className="h-4 w-4 -scale-x-100" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => canvasEditorRef.current?.chain().focus().redo().run()}
                  disabled={!canvasEditorRef.current?.can().redo()}
                  className="gap-1.5 text-gray-600"
                  aria-label="Redo"
                  title="Redo (⌘⇧Z)"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
                <span className={cn(
                  'text-xs text-gray-400 min-w-[4rem] text-center',
                  saveState === 'error' && 'text-red-500',
                )}>
                  {saveState === 'saving' ? 'Saving…'
                    : saveState === 'saved' ? 'Saved ✓'
                    : saveState === 'dirty' ? 'Unsaved'
                    : saveState === 'error' ? 'Save failed'
                    : ''}
                </span>
                <Button variant="default" size="sm" onClick={exitEdit} className="gap-1.5">
                  <CheckCircle2 className="h-4 w-4" /> Done
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={enterEdit}
                className="gap-1.5 text-gray-600"
                title="Edit this document (⌘E)"
                data-testid="enter-edit-btn"
              >
                <FileEdit className="h-4 w-4" /> Edit
              </Button>
            )}

            {/* Status transition buttons */}
            {(STATUS_TRANSITIONS[contract.status] ?? []).map((tr) => (
              <Button
                key={tr.to}
                variant={tr.variant ?? 'default'}
                size="sm"
                onClick={() => changeStatus.mutate(tr.to)}
                disabled={changeStatus.isPending}
                className="gap-1.5"
              >
                {changeStatus.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tr.label}
              </Button>
            ))}
            {/*
              A.3 — single primary CTA across pre-approval states. Always
              routes through the workflow engine (/submit-approval); the old
              "Send for Review" manual status-flip was removed.
            */}
            {['DRAFT', 'PENDING_REVIEW', 'UNDER_NEGOTIATION'].includes(contract?.status ?? '') && (
              <Button
                variant="default" size="sm"
                onClick={() => setSendForReviewOpen(true)}
                disabled={submitForApproval.isPending}
                className="gap-1.5"
              >
                {submitForApproval.isPending
                  ? <><Loader2 className="h-4 w-4 animate-spin" />Submitting…</>
                  : <><CheckCircle2 className="h-4 w-4" />Send for Review</>}
              </Button>
            )}
            {/* Phase 07 — Send-for-Signature primary CTA.
                Visible on every non-terminal status; the dialog itself
                handles version/perm/already-executed gating. Send-for-Review
                still owns the slot in DRAFT/PENDING_REVIEW/UNDER_NEGOTIATION
                (it remains the recommended workflow path), and Send-for-Signature
                is shown alongside it for orgs that approve outside the system
                or want to skip approvals on low-risk contracts. */}
            {!['EXECUTED', 'EXPIRED', 'TERMINATED', 'ARCHIVED'].includes(contract?.status ?? '') && (
              <Button
                variant="default" size="sm"
                onClick={() => setSendForSignatureOpen(true)}
                className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                data-testid="send-for-signature-btn"
              >
                <PenLine className="h-4 w-4" />
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
                <Button variant="outline" size="sm" className="gap-1.5 text-gray-600" aria-label="More actions">
                  Actions <ChevronDown className="h-3.5 w-3.5" />
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
                    <FileText className="h-4 w-4" />
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
                      <AlertTriangle className="h-4 w-4" />
                      Risk markers: <span className="ml-1 capitalize font-medium">{riskView}</span>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    disabled={versions.length < 2}
                    onSelect={() => {
                      if (versions.length < 2) return
                      setCompareOpen(true)
                      track('compare_opened', { versionCount: versions.length, source: 'actions_menu' })
                    }}
                    data-testid="compare-menu-item"
                  >
                    <ArrowLeftRight className="h-4 w-4" />
                    Compare versions
                    {versions.length < 2 && (
                      <span className="ml-auto text-[10px] text-muted-foreground">need 2+</span>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </div>
                <DropdownMenuItem onSelect={() => setShowShareDialog(true)}>
                  <Share2 className="h-4 w-4" /> Share
                </DropdownMenuItem>
                {/* P8 Step 8 — spawn an amendment / SOW / order-form / renewal
                    that links back to this contract via parentContractId. */}
                <DropdownMenuItem onSelect={() => setCreateAmendmentOpen(true)} data-testid="create-amendment-menu-item">
                  <GitBranch className="h-4 w-4" /> Create amendment
                </DropdownMenuItem>
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
                    <FileText className="h-4 w-4" /> Compliance package (PDF)
                  </DropdownMenuItem>
                )}
                {/* U.4.4 — Actions menu agent-item deleted. Use ⌘K or
                    the right rail. The 'ask' tab is also gone. */}
                <DropdownMenuSeparator />
                {/* U.1.2 — only offer "View PDF" when there's actually one */}
                {hasOriginal && (
                  <DropdownMenuItem onSelect={handleViewPdf}>
                    <FileText className="h-4 w-4" /> View PDF in new tab
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => handleDownload()}>
                  <Download className="h-4 w-4" /> Download
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Row 2 — full-width metadata strip. Indented `pl-11` so the
            pills line up with the title text (back-button + gap). At all
            viewports this stays a single visual row at MBA-class width
            and only wraps to 2 lines at very narrow widths. */}
        <div
          className="flex items-center flex-wrap gap-x-2 gap-y-1.5 pl-11"
          data-testid="contract-meta-row"
        >
          <StatusPill status={contract.status} />
          {ocrApplied && (
            <span
              data-testid="contract-ocr-badge"
              title={`Text was OCR'd from scan (${extractionMeta.ocrBackend ?? 'unknown'}, ${extractionMeta.ocrPages ?? 0}/${extractionMeta.pageCount ?? 0} pages). Treat extracted fields with higher review bar.`}
              className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10.5px] font-medium text-amber-900"
            >
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 8h10M7 12h10M7 16h6" /></svg>
              OCR'd
            </span>
          )}
          {id && (
            <ContractMatterPicker contractId={id} currentMatterId={(contract as unknown as { matterId?: string | null }).matterId ?? null} />
          )}
          {id && <CollabStatusBadge contractId={id} />}
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
              className="text-xs font-semibold border rounded-full px-2.5 py-0.5 bg-white cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {CONTRACT_TYPES.map(t => (
                <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
              ))}
            </select>
          ) : (
            <span className="inline-flex items-center gap-2">
              <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                TYPE_COLORS[contract.type] ?? TYPE_COLORS.OTHER
              }`}>
                {contract.type.replace(/_/g, ' ')}
              </span>
              <button
                onClick={() => setEditingType(true)}
                className="text-xs text-gray-400 hover:text-blue-500 hover:underline underline-offset-2 transition-colors"
              >
                Correct type
              </button>
            </span>
          )}
          {contract.jurisdiction && (
            <span className="text-xs text-gray-400">⚖ {contract.jurisdiction}</span>
          )}
          {contract.riskScore != null && (
            <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${
              contract.riskScore >= 0.67 ? 'bg-red-50 text-red-600' :
              contract.riskScore >= 0.34 ? 'bg-amber-50 text-amber-600' :
              'bg-emerald-50 text-emerald-600'
            }`}>
              <TrendingUp className="h-3 w-3" />
              Risk {Math.round(contract.riskScore * 100)}%
            </span>
          )}
          {/* Owner / Edited / Value / Expiry — now show at all widths
              (no `hidden xl:` gate). The dedicated Row 2 has the room. */}
          {contract.owner?.name && (
            <span
              className="inline-flex items-center gap-1.5 text-xs text-gray-600"
              title={`Owner: ${contract.owner.name}`}
              data-testid="contract-owner-chip"
            >
              <span className="text-gray-300" aria-hidden>·</span>
              <span
                aria-hidden
                className="h-5 w-5 rounded-full bg-indigo-50 text-indigo-700 flex items-center justify-center text-[9.5px] font-semibold ring-1 ring-indigo-200"
              >
                {contract.owner.name.split(/\s+/).filter(Boolean).slice(0, 2).map((p: string) => p[0]?.toUpperCase()).join('') || '?'}
              </span>
              <span className="font-medium text-gray-700">{contract.owner.name}</span>
            </span>
          )}
          {contract.updatedAt && (
            <span
              className="inline-flex items-center gap-1.5 text-xs text-gray-500"
              title={new Date(contract.updatedAt).toLocaleString()}
              data-testid="contract-edited-chip"
            >
              <span className="text-gray-300" aria-hidden>·</span>
              Edited {(() => {
                const ms = Date.now() - new Date(contract.updatedAt).getTime()
                if (ms < 60_000) return 'just now'
                if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
                if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
                return `${Math.floor(ms / 86_400_000)}d ago`
              })()}
            </span>
          )}
          {contract.value != null && (
            <span
              className="inline-flex items-center gap-1.5 text-xs"
              title="Contract value"
              data-testid="contract-value-chip"
            >
              <span className="text-gray-300" aria-hidden>·</span>
              <span className="font-medium text-gray-700 tabular-nums">
                {(contract.currency ?? 'USD')} {Number(contract.value).toLocaleString()}
              </span>
            </span>
          )}
          {contract.expiryDate && (
            <span
              className="inline-flex items-center gap-1.5 text-xs text-gray-500"
              title={`Expires ${new Date(contract.expiryDate).toLocaleDateString()}`}
              data-testid="contract-expiry-chip"
            >
              <span className="text-gray-300" aria-hidden>·</span>
              {(() => {
                const days = Math.floor((new Date(contract.expiryDate).getTime() - Date.now()) / 86_400_000)
                if (days < 0) return `Expired ${-days}d ago`
                if (days < 90) return `Expires in ${days}d`
                return `Expires ${new Date(contract.expiryDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
              })()}
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
        B.5.12 — Negotiation Status strip. State 1 addition (docs/26 §5).
        For the OWNER / submitter's view — answers "why is my deal stuck
        and what happens next" without opening a tab. Complements the
        DecisionStrip: the strip surfaces to the approver when they see
        the contract (so they decide); this surfaces to everyone ELSE.
        Two conditions it renders under:
          - UNDER_NEGOTIATION → waiting on counterparty
          - PENDING_APPROVAL → waiting on an internal approver
        We skip it when the current user IS the approver (they already
        have the DecisionStrip telling them what to do).
      */}
      {!isApproverMode && ['UNDER_NEGOTIATION', 'PENDING_APPROVAL'].includes(contract?.status ?? '') && (
        <NegotiationStatusStrip
          contract={{
            status:           contract?.status ?? '',
            counterpartyName: contract?.counterpartyName ?? null,
          }}
          approvalInstance={
            approvalInstanceData?.instance
              ? {
                  submittedAt:     approvalInstanceData.instance.submittedAt,
                  submittedByName: approvalInstanceData.instance.submittedByName,
                  currentStepName: approvalInstanceData.steps?.find((s: any) => s.status === 'PENDING')?.stepName,
                  currentApproverName: approvalInstanceData.steps?.find((s: any) => s.status === 'PENDING')?.approverName,
                }
              : null
          }
          lastComment={
            commentsData?.data?.[0]
              ? {
                  excerpt:    (commentsData.data[0].body ?? commentsData.data[0].content ?? '').toString(),
                  createdAt:  commentsData.data[0].createdAt,
                  authorName: commentsData.data[0].authorName,
                }
              : null
          }
          latestVersion={
            versions[0]
              ? {
                  versionNumber: versions[0].versionNumber,
                  createdAt:     versions[0].createdAt,
                  changeNote:    versions[0].changeNote,
                  fromCounterparty: typeof versions[0].createdById === 'string'
                    && versions[0].createdById.startsWith('portal:'),
                }
              : null
          }
          // P7.4.16 / F-31 — real signals from share + portal upload + external comment
          lastShareSentAt={(shareLinksData?.data ?? [])[0]?.createdAt ?? null}
          counterpartyUploadedVersion={(() => {
            const v = (versions as Array<any>).find(v => typeof v.createdById === 'string' && v.createdById.startsWith('portal:'))
            return v ? { versionNumber: v.versionNumber, createdAt: v.createdAt } : null
          })()}
          externalCommentAt={(commentsData?.data ?? []).find((c: any) => typeof c.authorId === 'string' && c.authorId.startsWith('portal:'))?.createdAt ?? null}
          onNudge={() => {
            // Scrolls to the comments rail or opens a composer; stubbed
            // for now — reminder send lands in post-V1.
            const section = Array.from(document.querySelectorAll('section span'))
              .find(s => /Comments/i.test((s.textContent || '').trim()))
            section?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }}
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
          onJumpToClause={(clauseId) => {
            // Scroll the underlined clause marker into view. If the risk
            // markers extension has labelled a span with data-clause-id,
            // this locates it. Falls back to opening the focused-review
            // drawer on that clause.
            const el = document.querySelector(
              `[data-clause-id="${clauseId}"]`,
            ) as HTMLElement | null
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' })
              el.classList.add('ring-2', 'ring-amber-400')
              setTimeout(() => el.classList.remove('ring-2', 'ring-amber-400'), 1500)
            } else {
              setFocusedClauseId(clauseId)
            }
          }}
          onDecided={() => {
            qc.invalidateQueries({ queryKey: ['contract', id] })
            qc.invalidateQueries({ queryKey: ['contract-approval', id] })
            qc.invalidateQueries({ queryKey: ['approval-instance-by-contract', id] })
            refetchApproval()
          }}
        />
      )}

      {/* ── AI Drafting Banner ────────────────────────────────────────────── */}
      {contract?.analysisStatus === 'DRAFTING' && (
        <div className="bg-violet-600 text-white px-6 py-3 flex items-center gap-3 text-sm">
          <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
          <div className="flex-1">
            <span className="font-medium">AI is generating a first draft from your request...</span>
            <span className="text-violet-200 text-xs ml-2">(~30–60 seconds)</span>
          </div>
          {isStuck && (
            <div className="flex items-center gap-3 flex-shrink-0 border-l border-violet-400 pl-3 ml-1">
              <span className="text-violet-200 text-xs">Taking too long?</span>
              <button
                onClick={() => cancelAnalysis.mutate()}
                disabled={cancelAnalysis.isPending}
                className="text-xs text-violet-200 hover:text-white underline underline-offset-2"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Analysis Progress Banner ─────────────────────────────────────── */}
      {contract?.analysisStatus && contract.analysisStatus !== 'DRAFTING' && STATUS_BANNER[contract.analysisStatus] && (
        <div className="bg-blue-600 text-white px-6 py-2.5 flex items-center gap-3 text-sm">
          <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
          <span className="font-medium">{STATUS_BANNER[contract.analysisStatus].message}</span>
          {STATUS_BANNER[contract.analysisStatus].sub && (
            <span className="text-blue-200 text-xs">{STATUS_BANNER[contract.analysisStatus].sub}</span>
          )}
          {/* Step indicator */}
          <div className="ml-auto flex items-center gap-2.5 flex-shrink-0">
            {PIPELINE_STEPS.map((step, i) => {
              const isActive = i === currentStepIdx
              const isPast = i < currentStepIdx
              return (
                <div
                  key={i}
                  className={`flex items-center gap-1 text-[10px] font-medium transition-colors ${
                    isActive ? 'text-white' : isPast ? 'text-blue-300' : 'text-blue-500/50'
                  }`}
                >
                  <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 transition-colors ${
                    isActive ? 'bg-white' : isPast ? 'bg-blue-300' : 'bg-blue-500/30'
                  }`} />
                  {step.label}
                </div>
              )
            })}
          </div>
          {isStuck && (
            <div className="flex items-center gap-3 flex-shrink-0 border-l border-blue-500 pl-3 ml-1">
              <span className="text-blue-200 text-xs">Taking too long?</span>
              <button
                onClick={() => cancelAnalysis.mutate()}
                disabled={cancelAnalysis.isPending}
                className="text-xs text-blue-200 hover:text-white underline underline-offset-2"
              >
                Cancel
              </button>
              <button
                onClick={() => analyze.mutate()}
                disabled={analyze.isPending}
                className="text-xs bg-white/20 hover:bg-white/30 text-white px-2.5 py-1 rounded"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}
      {contract?.analysisStatus === 'FAILED' && (
        <div className="bg-red-50 border-b border-red-200 text-red-700 px-6 py-2.5 flex items-center gap-3 text-sm">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span className="font-medium">
            {versions.length === 0 ? 'Draft generation failed' : 'Analysis failed'}
          </span>
          {contract.analysisError && (
            <span className="text-red-500">— {contract.analysisError}</span>
          )}
          <div className="ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={() => analyze.mutate()}
              disabled={analyze.isPending}
              className="gap-1.5 text-red-700 border-red-300 hover:bg-red-100"
            >
              {analyze.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {versions.length === 0 ? 'Retry Draft' : 'Re-analyze'}
            </Button>
          </div>
        </div>
      )}
      {/* P2.3 — binder child banner. When this contract was carved out
          of a binder (parentContractId set + relationshipType='exhibit_only'
          + family API returns a parent), surface a persistent "Split from
          <binder>" bar so the user can jump back regardless of which tab
          they're on. Renders on top of all other banners. */}
      {(contract as any)?.parentContractId && familyData?.parent && (
        <div
          data-testid="binder-child-banner"
          className="bg-indigo-50 border-b border-indigo-200 text-indigo-800 px-6 py-2 flex items-center gap-2 text-sm"
        >
          <Scissors className="h-3.5 w-3.5 flex-shrink-0 text-indigo-500" />
          <span className="text-[12px]">Split from binder:</span>
          <button
            onClick={() => navigate(`/contracts/${familyData.parent.id}`)}
            data-testid="binder-child-parent-link"
            className="text-[12px] font-medium underline hover:text-indigo-900 truncate"
            title={`Open parent contract: ${familyData.parent.title}`}
          >
            {familyData.parent.title}
          </button>
          <span className="ml-auto text-[10.5px] text-indigo-500">
            {(familyData.siblings?.length ?? 0) + 1} total agreements in this binder
          </span>
        </div>
      )}
      {autoSplitDone && (
        <div className="bg-blue-50 border-b border-blue-200 text-blue-800 px-6 py-2.5 flex items-center gap-3 text-sm">
          <Scissors className="h-4 w-4 flex-shrink-0 text-blue-500" />
          <span className="font-medium">Auto-split into {splitInto.length} contracts</span>
          <span className="text-blue-600">— AI split this binder automatically. Each contract is processing independently.</span>
          <button
            onClick={() => {
              setSplitSpecs(suggestedSplits.map((s: any, i: number) => ({
                pageStart: s.pageStart ?? 1,
                pageEnd:   s.pageEnd ?? 99,
                title:     s.title ?? `Agreement ${i + 1}`,
                type:      s.type ?? 'OTHER',
              })))
              setShowSplitModal(true)
            }}
            className="ml-auto flex-shrink-0 px-3 py-1 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700 font-medium"
          >
            Adjust splits →
          </button>
        </div>
      )}
      {binderDetected && !autoSplitDone && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-800 px-6 py-2.5 flex items-center gap-3 text-sm">
          <FileText className="h-4 w-4 flex-shrink-0 text-amber-500" />
          <span className="font-medium">Multiple agreements detected</span>
          <span className="text-amber-600">
            — We found {suggestedSplits.length > 0 ? suggestedSplits.length : 'multiple'} separate agreements in this document.
          </span>
          <button
            onClick={() => {
              setSplitSpecs(suggestedSplits.map((s: any, i: number) => ({
                pageStart: s.pageStart ?? 1,
                pageEnd:   s.pageEnd ?? 99,
                title:     s.title ?? `Agreement ${i + 1}`,
                type:      s.type ?? 'OTHER',
              })))
              setShowSplitModal(true)
            }}
            className="ml-auto flex-shrink-0 px-3 py-1 bg-amber-600 text-white text-xs rounded-lg hover:bg-amber-700 font-medium"
          >
            Review &amp; Split →
          </button>
        </div>
      )}

      {/* ── Tab nav (P-feedback 2026-05-02) ──────────────────────────────────
          User feedback: "when I open clauses in contracts I cannot go back
          to the contract." `setTab` was reachable via "View all" links but
          had no visible tab bar to switch back. This renders one. */}
      {tab !== 'document' && (
        <div className="flex items-center gap-1 px-6 py-2 border-b border-gray-100 bg-white sticky top-0 z-10">
          <button
            type="button"
            onClick={() => setTab('document')}
            data-testid="tab-back-to-document"
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-gray-600 hover:text-blue-600 hover:bg-blue-50 mr-2"
            title="Back to document view"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Document
          </button>
          <span className="text-gray-200" aria-hidden>·</span>
          {visibleTabs.filter(t => t !== 'document').map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              data-testid={`tab-${t}`}
              className={cn(
                'px-2.5 py-1 rounded-md text-xs font-medium capitalize transition-colors',
                tab === t
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {/* ── Content ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">

        {/* ─── Overview ──────────────────────────────────────────────────── */}
        {tab === 'overview' && (
          <div className="p-6 max-w-6xl mx-auto">
            <div className="grid grid-cols-5 gap-6">

              {/* Left column (3/5) */}
              <div className="col-span-3 space-y-4">

                {/* AI Summary */}
                <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
                  <div className="px-5 py-4 border-b bg-gradient-to-r from-blue-50 to-indigo-50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-blue-500" />
                      <span className="text-sm font-semibold text-blue-800">AI Analysis</span>
                    </div>
                    {/* Split button: primary = smart resume, dropdown = full reprocess */}
                    {(() => {
                      const isAnalyzing = analyze.isPending || reprocess.isPending || IN_PROGRESS_STATUSES.includes(contract.analysisStatus)
                      return (
                        <div className="relative flex-shrink-0" onClick={e => e.stopPropagation()}>
                          <div className="flex h-7 rounded-lg overflow-hidden border border-blue-200">
                            <button
                              onClick={() => { analyze.mutate(); setShowReanalyzeMenu(false) }}
                              disabled={isAnalyzing}
                              className="flex items-center gap-1 px-3 text-xs font-medium text-blue-700 bg-white hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              {isAnalyzing
                                ? <><Loader2 className="h-3 w-3 animate-spin" /> Analyzing…</>
                                : <><Sparkles className="h-3 w-3" /> {hasAnalysis ? 'Re-analyze' : 'Run Analysis'}</>
                              }
                            </button>
                            {hasAnalysis && !isAnalyzing && (
                              <button
                                onClick={e => { e.stopPropagation(); setShowReanalyzeMenu(m => !m) }}
                                className="px-1.5 border-l border-blue-200 text-blue-500 hover:bg-blue-50 hover:text-blue-700 transition-colors"
                              >
                                <ChevronDown className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                          {showReanalyzeMenu && (
                            <div className="absolute right-0 top-full mt-1 z-50 bg-white border border-gray-200 rounded-lg shadow-lg py-1 w-52" onMouseDown={e => e.stopPropagation()}>
                              <button
                                onClick={() => { reprocess.mutate(); setShowReanalyzeMenu(false) }}
                                className="w-full px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                              >
                                <RefreshCw className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                                <div>
                                  <div className="font-medium">Full re-process from file</div>
                                  <div className="text-gray-400 mt-0.5">Re-parse PDF, re-classify, re-extract</div>
                                </div>
                              </button>
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                  <div className="p-5">
                    {contract.summary ? (
                      <p className="text-sm text-gray-700 leading-relaxed">{contract.summary}</p>
                    ) : (
                      <div className="flex flex-col items-center py-6 gap-3">
                        <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
                          <Sparkles className="h-5 w-5 text-gray-400" />
                        </div>
                        <div className="text-center">
                          <p className="text-sm font-medium text-gray-600">No analysis yet</p>
                          <p className="text-xs text-gray-400 mt-0.5">Click "Run Analysis" to extract key terms, risk score, and summary</p>
                        </div>
                        <Button size="sm" onClick={() => analyze.mutate()} disabled={analyze.isPending || IN_PROGRESS_STATUSES.includes(contract.analysisStatus)} className="gap-1.5">
                          <Sparkles className="h-3.5 w-3.5" /> Run Analysis
                        </Button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Clause Flags */}
                {presentFlags.length > 0 && (
                  <div className="bg-white rounded-xl border shadow-sm p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <Shield className="h-4 w-4 text-amber-500" />
                      <h3 className="text-sm font-semibold text-gray-800">Clause Flags</h3>
                      <span className="ml-auto text-xs text-gray-400">{presentFlags.length} detected</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(showAllFlags ? presentFlags : presentFlags.slice(0, 6)).map(([k, label]) => (
                        <span key={k} className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                          {label}
                        </span>
                      ))}
                      {presentFlags.length > 6 && (
                        <button
                          onClick={() => setShowAllFlags(!showAllFlags)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs text-gray-400 hover:text-gray-600"
                        >
                          {showAllFlags ? <><ChevronUp className="h-3 w-3" /> Less</> : <><ChevronDown className="h-3 w-3" /> +{presentFlags.length - 6} more</>}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Key Terms */}
                {keyTermEntries.length > 0 ? (
                  <div className="bg-white rounded-xl border shadow-sm p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold text-gray-800">Key Terms</h3>
                      <div className="flex items-center gap-3 text-xs text-gray-400">
                        <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-500" />High</span>
                        <span className="flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-amber-400" />Review</span>
                        <span className="flex items-center gap-1"><XCircle className="h-3 w-3 text-red-400" />Uncertain</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {keyTermEntries.map(([k, v]) => {
                        const conf = fieldConfidence[k]
                        return (
                          <div key={k} className="group relative rounded-lg p-3 bg-gray-50 hover:bg-gray-100 transition-colors">
                            <div className="flex items-start gap-2">
                              {conf && <ConfidenceIcon confidence={conf.confidence} />}
                              <div className="min-w-0">
                                <p className="text-xs text-gray-400 capitalize mb-0.5">
                                  {k.replace(/([A-Z])/g, ' $1').trim()}
                                </p>
                                <p className="text-sm font-semibold text-gray-800 truncate">
                                  {formatTermValue(k, v)}
                                </p>
                                {conf?.issue && (
                                  <p className="text-xs text-orange-500 mt-0.5">{conf.issue}</p>
                                )}
                              </div>
                            </div>
                            {conf?.quote && (
                              <div className="hidden group-hover:block absolute z-20 bottom-full left-0 mb-1.5 w-72 bg-gray-900 text-white text-xs rounded-xl p-3 shadow-2xl">
                                <p className="text-gray-400 text-[10px] uppercase tracking-wider mb-1.5">Source</p>
                                <p className="italic text-gray-100">&ldquo;{conf.quote}&rdquo;</p>
                                {conf.section && <p className="text-gray-400 mt-1.5 text-[10px]">{conf.section}</p>}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ) : hasAnalysis ? null : null}

                {/* Contract-Type-Specific Fields */}
                {typeFieldEntries.length > 0 && (
                  <div className="bg-white rounded-xl border shadow-sm p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold text-gray-800">
                        {contract.type.replace(/_/g, ' ')} — Specific Terms
                      </h3>
                      <span className="text-xs text-gray-400">{typeFieldEntries.length} fields extracted</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {typeFieldEntries.map(([key, field]) => (
                        <div key={key} className="group relative rounded-lg p-3 bg-gray-50 hover:bg-gray-100 transition-colors">
                          <p className="text-xs text-gray-500 mb-1 truncate">{field.label}</p>
                          <div className="flex items-center gap-1.5">
                            <p className="text-xs font-semibold text-gray-800 truncate flex-1">
                              {formatTermValue(key, field.value)}
                            </p>
                            <ConfidenceIcon confidence={field.confidence} />
                          </div>
                          {field.quote && (
                            <div className="hidden group-hover:block absolute z-20 bottom-full left-0 mb-1.5 w-72 bg-gray-900 text-white text-xs rounded-xl p-3 shadow-2xl">
                              <p className="text-gray-400 text-[10px] uppercase tracking-wider mb-1.5">Source</p>
                              <p className="italic text-gray-100">&ldquo;{field.quote}&rdquo;</p>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Custom Fields */}
                {populatedFields.length > 0 && (
                  <div className="bg-white rounded-xl border shadow-sm p-5">
                    <h3 className="text-sm font-semibold text-gray-800 mb-3">Custom Fields</h3>
                    <div className="divide-y divide-gray-50">
                      {populatedFields.map((fd: FieldDef) => (
                        <DetailRow
                          key={fd.fieldKey}
                          label={fd.fieldLabel}
                          value={formatTermValue(fd.fieldKey, customMeta[fd.fieldKey])}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* AI Findings — extra terms the LLM found beyond defined fields */}
                {aiFindings.length > 0 && (
                  <div className="bg-white rounded-xl border shadow-sm p-5">
                    <button
                      onClick={() => setShowFindings(v => !v)}
                      className="flex items-center justify-between w-full mb-1"
                    >
                      <div className="flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-purple-400" />
                        <h3 className="text-sm font-semibold text-gray-800">AI Findings</h3>
                        <span className="px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 text-xs font-medium">
                          {aiFindings.length}
                        </span>
                      </div>
                      {showFindings
                        ? <ChevronUp className="h-4 w-4 text-gray-400" />
                        : <ChevronDown className="h-4 w-4 text-gray-400" />
                      }
                    </button>
                    {showFindings && (
                      <div className="mt-3 divide-y divide-gray-50">
                        {aiFindings.map((f) => (
                          <div key={f.key} className="py-2.5 flex items-start justify-between gap-3">
                            <span className="text-xs text-gray-500 w-1/3 flex-shrink-0">{f.label}</span>
                            <div className="flex items-center gap-2 flex-1 justify-end">
                              <span className="text-xs text-gray-800 text-right">
                                {formatTermValue(f.key, f.value)}
                              </span>
                              <ConfidenceIcon confidence={f.confidence} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Tags */}
                {contract.tags?.length > 0 && (
                  <div className="bg-white rounded-xl border shadow-sm p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <Tag className="h-4 w-4 text-gray-400" />
                      <h3 className="text-sm font-semibold text-gray-800">Tags</h3>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {contract.tags.map((tag: string) => (
                        <span key={tag} className="px-3 py-1 bg-gray-100 rounded-full text-xs text-gray-600 font-medium">{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Right column (2/5) */}
              <div className="col-span-2 space-y-4">

                {/* Contract Details */}
                <div className="bg-white rounded-xl border shadow-sm p-5">
                  <h3 className="text-sm font-semibold text-gray-800 mb-3">Contract Details</h3>
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
                  <div className="bg-white rounded-xl border shadow-sm p-5">
                    <div className="flex items-center gap-2 mb-4">
                      <TrendingUp className="h-4 w-4 text-gray-400" />
                      <h3 className="text-sm font-semibold text-gray-800">Risk Assessment</h3>
                    </div>
                    <RiskMeter score={contract.riskScore} />
                    {riskFactors.length > 0 && (
                      <div className="mt-4">
                        <p className="text-xs font-medium text-gray-500 mb-2">Risk Factors</p>
                        <ul className="space-y-1.5">
                          {riskFactors.map((f, i) => (
                            <li key={i} className="flex items-start gap-2 text-xs text-gray-600">
                              <span className="w-1.5 h-1.5 rounded-full bg-red-400 mt-1.5 flex-shrink-0" />
                              {f}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {contract.overallConfidence != null && (
                      <div className="mt-4 pt-4 border-t">
                        <p className="text-xs text-gray-400">
                          Extraction confidence: <span className="font-semibold text-gray-700">{Math.round((contract.overallConfidence ?? 0) * 100)}%</span>
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Versions quick view */}
                <div className="bg-white rounded-xl border shadow-sm p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-gray-800">Versions</h3>
                    <button onClick={() => setTab('versions')} className="text-xs text-blue-600 hover:underline">View all</button>
                  </div>
                  {versions.length === 0 ? (
                    <p className="text-xs text-gray-400">No versions yet</p>
                  ) : (
                    <div className="space-y-2">
                      {versions.slice(0, 3).map((v: any) => (
                        <div key={v.id} className="flex items-center justify-between">
                          <div>
                            <p className="text-xs font-medium text-gray-700">v{v.versionNumber}</p>
                            <p className="text-[10px] text-gray-400">{new Date(v.createdAt).toLocaleDateString()}</p>
                          </div>
                          <button
                            onClick={() => handleDownload(v.id)}
                            className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Contract Family */}
                <div className="bg-white rounded-xl border shadow-sm p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Link className="h-4 w-4 text-gray-400" />
                      <h3 className="text-sm font-semibold text-gray-800">Contract Family</h3>
                    </div>
                    <button
                      onClick={() => setShowAddRelated(true)}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      + Add related
                    </button>
                  </div>

                  {/* Parent */}
                  {familyData?.parent && (
                    <div className="mb-3">
                      <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-1.5">Parent</p>
                      <button
                        onClick={() => navigate(`/contracts/${familyData.parent.id}`)}
                        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border border-blue-200 bg-blue-50 hover:bg-blue-100 transition-colors text-left"
                      >
                        <ExternalLink className="h-3 w-3 text-blue-500 flex-shrink-0" />
                        <span className="text-xs font-medium text-blue-800 truncate">{familyData.parent.title}</span>
                        <span className="ml-auto text-[10px] text-blue-400 flex-shrink-0">{familyData.parent.type}</span>
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
                          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-gray-50 transition-colors text-left"
                        >
                          <FileText className="h-3 w-3 text-gray-400 flex-shrink-0" />
                          <span className="text-xs text-gray-700 truncate">{child.title}</span>
                          {child.relationshipType && (
                            <span className="ml-auto text-[10px] text-gray-400 flex-shrink-0 capitalize">
                              {child.relationshipType.replace(/_/g, ' ')}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  ) : !familyData?.parent ? (
                    <p className="text-xs text-gray-400">No related documents yet.</p>
                  ) : null}
                </div>

                {/* Attachments */}
                <div className="bg-white rounded-xl border shadow-sm p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Paperclip className="h-4 w-4 text-gray-400" />
                      <h3 className="text-sm font-semibold text-gray-800">Attachments</h3>
                      <span className="text-xs text-gray-400">(exhibits, schedules)</span>
                    </div>
                    <button
                      onClick={() => attachFileRef.current?.click()}
                      disabled={attachMutation.isPending}
                      className="text-xs text-blue-600 hover:underline disabled:opacity-50"
                    >
                      {attachMutation.isPending ? 'Uploading…' : '+ Attach'}
                    </button>
                    <input
                      ref={attachFileRef}
                      type="file"
                      accept=".pdf,.docx,.doc,.txt,.xlsx,.csv"
                      className="hidden"
                      onChange={e => {
                        const file = e.target.files?.[0]
                        if (file) {
                          attachMutation.mutate(file)
                          e.target.value = ''
                        }
                      }}
                    />
                  </div>
                  {(contract.attachments as any[] ?? []).length === 0 ? (
                    <p className="text-xs text-gray-400">No attachments. Click "+ Attach" to add exhibits, schedules, or reference documents.</p>
                  ) : (
                    <div className="space-y-1">
                      {(contract.attachments as any[]).map((att: any, idx: number) => (
                        <div key={idx} className="flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-gray-50 group">
                          <Paperclip className="h-3 w-3 text-gray-400 flex-shrink-0" />
                          <span className="text-xs text-gray-700 truncate flex-1">{att.label || att.filename}</span>
                          <span className="text-[10px] text-gray-400">{(att.size / 1024).toFixed(0)} KB</span>
                          <button
                            onClick={() => downloadAttachment(idx, att.filename)}
                            className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-gray-200 text-gray-500 transition-all"
                            title="Download"
                          >
                            <Download className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => deleteAttachment.mutate(idx)}
                            className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-50 text-red-400 transition-all"
                            title="Remove"
                          >
                            <Trash2 className="h-3 w-3" />
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
              (CLAUSE_TYPE_LABELS[c.clauseType] ?? c.clauseType).toLowerCase().includes(clauseSearch.toLowerCase())
            return matchesRating && matchesSearch
          })

          const unfavorableCount = allClauses.filter(c => c.riskRating === 'unfavorable').length
          const unusualCount     = allClauses.filter(c => c.riskRating === 'unusual').length

          return (
            <div className="p-6 max-w-4xl mx-auto">
              {!['INDEXING', 'DONE'].includes(contract?.analysisStatus ?? '') ? (
                <div className="text-center py-16 text-gray-400">
                  <Sparkles className="h-8 w-8 mx-auto mb-3 opacity-40" />
                  <p className="text-sm">Clause extraction will appear here once analysis is complete.</p>
                </div>
              ) : allClauses.length === 0 ? (
                <div className="text-center py-16 text-gray-400">
                  <FileText className="h-8 w-8 mx-auto mb-3 opacity-40" />
                  <p className="text-sm">No clauses extracted yet. Try re-analyzing this contract.</p>
                </div>
              ) : (
                <>
                  {/* Filter bar */}
                  <div className="flex items-center gap-3 mb-6 flex-wrap">
                    <div className="flex-1 min-w-48">
                      <input
                        type="text"
                        placeholder="Search clauses…"
                        value={clauseSearch}
                        onChange={e => setClauseSearch(e.target.value)}
                        className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                          className={`px-2.5 py-1 text-xs rounded-full font-medium border transition-colors ${
                            clauseRatingFilter === f.key
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Clause list */}
                  {filtered.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-8">No clauses match this filter.</p>
                  ) : (
                    <div className="space-y-3">
                      {filtered.map(clause => {
                        const badge = clause.riskRating ? RISK_RATING_BADGE[clause.riskRating] : null
                        const typeLabel = CLAUSE_TYPE_LABELS[clause.clauseType] ?? clause.clauseType.replace(/_/g, ' ')
                        return (
                          <ClauseCard
                            key={clause.id}
                            typeLabel={typeLabel}
                            sectionRef={clause.sectionRef}
                            badge={badge}
                            interpretation={clause.interpretation}
                            content={clause.content}
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
                <div className="flex flex-col items-center justify-center h-64 bg-white rounded-xl border shadow-sm m-4" data-testid="no-original-pdf">
                  <FileText className="h-8 w-8 text-gray-300 mb-3" />
                  <p className="text-gray-700 text-sm font-medium">No original file</p>
                  <p className="text-gray-400 text-xs mt-1 text-center max-w-sm">This contract was created from text or a template — there's no source PDF to display.</p>
                  <Button variant="outline" size="sm" className="mt-3 text-xs" onClick={() => setDocView('styled')}>
                    Switch to Styled view
                  </Button>
                </div>
              )
            }
            if (pdfError) {
              return (
                <div className="flex flex-col items-center justify-center h-64 bg-white rounded-xl border shadow-sm m-4">
                  <AlertCircle className="h-8 w-8 text-red-400 mb-3" />
                  <p className="text-gray-700 text-sm font-medium">Failed to load original PDF</p>
                  <p className="text-gray-400 text-xs mt-1 text-center max-w-sm">{pdfError}</p>
                  <Button variant="outline" className="mt-3" onClick={handleViewPdf}>Retry</Button>
                  <Button variant="ghost" size="sm" className="mt-2 text-xs" onClick={() => setDocView('styled')}>
                    Switch to Styled view
                  </Button>
                </div>
              )
            }
            if (!pdfUrl) {
              return (
                <div className="flex flex-col items-center justify-center h-64 bg-gray-50">
                  <Loader2 className="h-6 w-6 text-gray-300 mb-3 animate-spin" />
                  <p className="text-sm text-gray-500">Loading original PDF…</p>
                </div>
              )
            }
            return (
              <div className="h-full overflow-hidden bg-gray-50 p-4">
                <div className="bg-white rounded-sm shadow-sm h-full">
                  <Worker workerUrl="https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js">
                    <Viewer fileUrl={pdfUrl} plugins={[layoutPlugin]} />
                  </Worker>
                </div>
              </div>
            )
          }

          // B.5.1 — Styled branch. TipTap + contract-paper CSS. Default.
          const latest = (contract.versions as any[])?.[0] ?? null
          const rawHtml = latest?.htmlContent?.trim()
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
          if (contract.analysisStatus === 'FAILED') {
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
                if (canvasState.kind !== 'ready') return
                setSaveState('dirty')
                dirtyHtmlRef.current = html
                if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
                saveTimerRef.current = setTimeout(flushPendingSave, 5000)
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

        {/* ─── Versions ──────────────────────────────────────────────────── */}
        {tab === 'versions' && (
          <div className="p-6 max-w-3xl mx-auto">
            <div className="bg-white rounded-xl border shadow-sm divide-y">
              {versions.length === 0 ? (
                <p className="p-8 text-sm text-gray-400 text-center">No versions yet</p>
              ) : versions.map((v: any) => (
                <div key={v.id} className="flex items-center justify-between p-4 hover:bg-gray-50">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center text-xs font-bold text-blue-600">
                      v{v.versionNumber}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">Version {v.versionNumber}</p>
                      {v.changeNote && <p className="text-xs text-gray-500 mt-0.5">{v.changeNote}</p>}
                      {v.changeSummary && <p className="text-xs text-blue-500 mt-0.5 italic">{v.changeSummary}</p>}
                      <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {new Date(v.createdAt).toLocaleString()}
                        {v.fileSize && ` · ${(v.fileSize / 1024).toFixed(0)} KB`}
                      </p>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => handleDownload(v.id)}>
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─── Negotiate ─────────────────────────────────────────────────── */}
        {tab === 'negotiate' && (
          <div className="p-6 space-y-6">
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              {/* Left: Diff viewer */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-700">Version diff</p>
                  <div className="flex items-center gap-2">
                    <select
                      value={diffV1Id}
                      onChange={e => setDiffV1Id(e.target.value)}
                      className="text-xs border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">v1 (baseline)</option>
                      {versions.map((v: any) => (
                        <option key={v.id} value={v.id}>v{v.versionNumber}</option>
                      ))}
                    </select>
                    <span className="text-xs text-gray-400">vs</span>
                    <select
                      value={diffV2Id}
                      onChange={e => setDiffV2Id(e.target.value)}
                      className="text-xs border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">v2 (redlines)</option>
                      {versions.map((v: any) => (
                        <option key={v.id} value={v.id}>v{v.versionNumber}</option>
                      ))}
                    </select>
                  </div>
                </div>
                {diffQuery.isLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
                  </div>
                ) : diffQuery.data ? (
                  <DiffViewer
                    diffHtml={diffQuery.data.diffHtml}
                    stats={diffQuery.data.stats}
                    v1Label={`v${versions.find((v: any) => v.id === diffV1Id)?.versionNumber ?? '1'}`}
                    v2Label={`v${versions.find((v: any) => v.id === diffV2Id)?.versionNumber ?? '2'}`}
                  />
                ) : (
                  <div className="bg-white border border-gray-200 rounded-xl p-8 text-center text-gray-400 text-sm">
                    Select two versions above to view tracked changes
                  </div>
                )}
              </div>

              {/* Right: Redline AI panel */}
              <div>
                <RedlinePanel
                  analysis={redlineMeta}
                  isAnalyzing={isAnalyzingRedlines}
                  versions={versions.map((v: any) => ({ id: v.id, versionNumber: v.versionNumber, createdAt: v.createdAt }))}
                  onRequestAnalysis={(v1Id, v2Id) => {
                    setDiffV1Id(v1Id)
                    setDiffV2Id(v2Id)
                    redlineMutation.mutate({ v1Id, v2Id })
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {/* ─── Comments ───────────────────────────────────────────────────── */}
        {tab === 'comments' && (
          <div className="p-6 max-w-3xl mx-auto">
            <CommentsPanel contractId={id!} />
          </div>
        )}

        {/* ─── Activity ──────────────────────────────────────────────────── */}
        {tab === 'activity' && (
          <div className="p-6 max-w-2xl mx-auto">
            {timeline.length === 0 ? (
              <div className="flex flex-col items-center py-16 gap-2">
                <Clock className="h-8 w-8 text-gray-300" />
                <p className="text-sm text-gray-400">No activity recorded yet</p>
              </div>
            ) : (
              <div className="relative">
                <div className="absolute left-5 top-0 bottom-0 w-px bg-gray-200" />
                {timeline.map((e: any) => (
                  <div key={e.id} className="flex items-start gap-4 mb-4 relative pl-12">
                    <div className="absolute left-3.5 top-1.5 w-3 h-3 rounded-full bg-white border-2 border-blue-400" />
                    <div className="bg-white rounded-xl border shadow-sm px-4 py-3 flex-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-gray-700">{e.action.replace(/_/g, ' ')}</span>
                        <span className="text-xs text-gray-400">{new Date(e.createdAt).toLocaleString()}</span>
                      </div>
                      {e.userId && (
                        <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
                          <User className="h-3 w-3" /> {e.userId}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ─── Approval ──────────────────────────────────────────────────── */}
        {tab === 'approval' && (
          <div className="p-6 max-w-3xl mx-auto space-y-6">
            {/* Status banner */}
            {contract?.status === 'PENDING_APPROVAL' && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-800">
                <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                Contract is pending approval — waiting for approver decision.
              </div>
            )}
            {contract?.status === 'APPROVED' && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                Contract approved. Ready for execution.
              </div>
            )}

            {/* No instance yet — show submit prompt */}
            {!approvalInstanceData && !['PENDING_APPROVAL', 'APPROVED', 'REJECTED'].includes(contract?.status ?? '') && (
              <div className="text-center py-10 border-2 border-dashed rounded-xl border-gray-200">
                <CheckCircle2 className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                <p className="text-sm font-semibold text-gray-600 mb-1">Not yet in review</p>
                <p className="text-sm text-gray-400 mb-4">Send this contract to the approval workflow to start the review.</p>
                <Button
                  size="sm"
                  onClick={() => submitForApproval.mutate(undefined)}
                  disabled={submitForApproval.isPending}
                  className="gap-1.5"
                >
                  {submitForApproval.isPending
                    ? <><Loader2 className="h-4 w-4 animate-spin" />Submitting…</>
                    : <>Send for Review</>}
                </Button>
                {submitForApproval.isError && (
                  <p className="text-xs text-red-600 mt-2">
                    {(submitForApproval.error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to submit'}
                  </p>
                )}
              </div>
            )}

            {/* My pending step on this contract */}
            {approvalData && (
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3">Your Pending Approval</h3>
                <ApprovalCard
                  stepId={approvalData.stepId}
                  instanceId={approvalData.instanceId}
                  stepName={approvalData.stepName}
                  contract={approvalData.contract}
                  instance={approvalData.instance}
                  onDecided={() => {
                    qc.invalidateQueries({ queryKey: ['contract', id] })
                    qc.invalidateQueries({ queryKey: ['contract-approval', id] })
                    qc.invalidateQueries({ queryKey: ['approval-instance-by-contract', id] })
                    refetchApproval()
                  }}
                />
              </div>
            )}

            {/* Timeline */}
            {approvalInstanceData && (
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3">Approval Timeline</h3>
                <div className="bg-white rounded-xl border shadow-sm p-5">
                  <ApprovalTimeline
                    instance={approvalInstanceData}
                    steps={approvalInstanceData.steps ?? []}
                  />
                </div>
              </div>
            )}
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
        // Only risk/deviation clauses are navigable in the drawer.
        const riskyClauses = allClauses.filter((c) => classifyRisk(c.riskRating) !== null)
        const focusedIdx = focusedClauseId
          ? riskyClauses.findIndex((c) => c.id === focusedClauseId)
          : -1

        if (focusedClauseId && focusedIdx >= 0) {
          return (
            <FocusedReviewDrawer
              contractId={id!}
              clauses={riskyClauses}
              currentIndex={focusedIdx}
              reviewStates={reviewStates}
              onPrev={() => {
                if (focusedIdx > 0) setFocusedClauseId(riskyClauses[focusedIdx - 1].id)
              }}
              onNext={() => {
                if (focusedIdx < riskyClauses.length - 1) setFocusedClauseId(riskyClauses[focusedIdx + 1].id)
              }}
              onAccept={(cid) => {
                setReviewStates((s) => ({ ...s, [cid]: 'resolved' }))
                updateReviewState.mutate({ clauseId: cid, state: 'resolved' })
                if (focusedIdx < riskyClauses.length - 1) setFocusedClauseId(riskyClauses[focusedIdx + 1].id)
                else setFocusedClauseId(null)
              }}
              onReject={(cid) => {
                setReviewStates((s) => ({ ...s, [cid]: 'reviewed' }))
                updateReviewState.mutate({ clauseId: cid, state: 'reviewed' })
                if (focusedIdx < riskyClauses.length - 1) setFocusedClauseId(riskyClauses[focusedIdx + 1].id)
                else setFocusedClauseId(null)
              }}
              onMarkReviewed={(cid) => {
                setReviewStates((s) => ({ ...s, [cid]: 'reviewed' }))
                updateReviewState.mutate({ clauseId: cid, state: 'reviewed' })
              }}
              onEditManually={() => {
                // Exit drawer, enter edit mode. A future commit will also
                // scroll to and focus the specific clause in the editor.
                setFocusedClauseId(null)
                enterEdit()
              }}
              onClose={() => setFocusedClauseId(null)}
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
                'bg-gray-900 text-white shadow-lg hover:bg-gray-800',
                'text-xs font-medium',
              )}
            >
              <ChevronUp className="h-3.5 w-3.5" />
              Details
            </button>
          )}
        </>
      )}
      <aside
        role="complementary"
        aria-label="Contract rail"
        className={cn(
          // B.5.16 — responsive positioning.
          isXl
            ? 'hidden xl:flex w-80 border-l bg-white overflow-y-auto flex-col'
            : isMd
              ? cn(
                  'fixed inset-y-0 right-0 z-40 w-[min(420px,100vw)] bg-white shadow-2xl border-l overflow-y-auto flex flex-col transition-transform',
                  railOpen ? 'translate-x-0' : 'translate-x-full',
                )
              : cn(
                  // Mobile bottom sheet: always anchored to bottom, 64px peek when closed, near-full when open.
                  'fixed inset-x-0 bottom-0 z-40 bg-white shadow-2xl border-t rounded-t-2xl overflow-y-auto flex flex-col transition-[max-height]',
                  railOpen ? 'max-h-[85vh]' : 'max-h-16',
                ),
          // When the focused-review drawer is showing, hide the normal rail.
          focusedClauseId != null &&
            (clausesData?.data ?? []).some((c: any) => c.id === focusedClauseId && classifyRisk(c.riskRating) !== null) &&
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
              'flex items-center justify-between px-4 py-2 border-b border-gray-100 bg-gray-50',
              !isMd && 'cursor-pointer',
            )}
          >
            <div className="flex items-center gap-2">
              {!isMd && (
                <span
                  aria-hidden
                  className="inline-block h-1 w-10 rounded-full bg-gray-300"
                />
              )}
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600">
                Details
              </span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); setRailOpen(false) }}
              className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100"
              aria-label="Close details"
            >
              <X className="h-4 w-4" />
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

          // Severity dot colour per risk rating
          const riskDot = (rating: string | null | undefined): string => {
            if (rating === 'unfavorable') return 'bg-red-500'
            if (rating === 'unusual') return 'bg-amber-500'
            return 'bg-blue-500' // deviation / neutral
          }

          return (
            <div className="px-5 pt-4 pb-3 border-b border-gray-100" data-testid="review-progress">
              {/* Click the row header to expand/collapse the checklist */}
              <button
                type="button"
                onClick={() => setReviewExpanded(v => !v)}
                aria-expanded={reviewExpanded}
                data-testid="review-progress-toggle"
                className="w-full flex items-center justify-between mb-1.5 group"
              >
                <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600 inline-flex items-center gap-1">
                  Review progress
                  <ChevronRight
                    className={cn(
                      'h-3 w-3 text-gray-400 transition-transform',
                      reviewExpanded && 'rotate-90',
                    )}
                  />
                </span>
                <span className={cn(
                  'text-xs tabular-nums font-medium',
                  complete ? 'text-emerald-700' : 'text-gray-600',
                )}>
                  {reviewedCount} / {risky.length}{complete && ' ✓'}
                </span>
              </button>
              <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
                <div
                  className={cn(
                    'h-full transition-all',
                    complete ? 'bg-emerald-500' : 'bg-blue-500',
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>

              {/* Expanded checklist */}
              {reviewExpanded && (
                <div className="mt-3 space-y-1" data-testid="review-progress-list">
                  {risky.map((c: any) => {
                    const isReviewed = (reviewStates[c.id] ?? c.reviewState ?? 'unreviewed') !== 'unreviewed'
                    const cleanType = (c.clauseType ?? 'clause').replace(/_/g, ' ')
                    return (
                      <div
                        key={c.id}
                        data-testid={`review-row-${c.id}`}
                        className={cn(
                          'group flex items-center gap-2 text-[11.5px] rounded px-1.5 py-1 transition-colors',
                          isReviewed ? 'opacity-60 hover:bg-gray-50' : 'hover:bg-blue-50',
                        )}
                      >
                        <span
                          className={cn(
                            'h-1.5 w-1.5 rounded-full shrink-0',
                            isReviewed ? 'bg-emerald-500' : riskDot(c.riskRating),
                          )}
                        />
                        <button
                          type="button"
                          onClick={() => setFocusedClauseId(c.id)}
                          className="flex-1 min-w-0 text-left truncate text-gray-800 hover:text-blue-700"
                          title={`${cleanType}${c.sectionRef ? ' · §' + c.sectionRef : ''}`}
                        >
                          {cleanType}
                          {c.sectionRef && <span className="text-gray-400 ml-1">§{c.sectionRef}</span>}
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
                            className="text-[10.5px] text-blue-700 hover:underline opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                          >
                            Mark reviewed
                          </button>
                        )}
                        {isReviewed && (
                          <span className="text-[10.5px] text-emerald-700 shrink-0 inline-flex items-center gap-0.5">
                            <CheckSquare className="h-3 w-3" />
                            done
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
                      className="mt-1.5 text-[11px] text-blue-700 hover:underline font-medium"
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
                  'mb-2 inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border',
                  /higher/.test(precedentsData.riskDeltaLabel)
                    ? 'bg-red-50 text-red-700 border-red-200'
                    : /lower/.test(precedentsData.riskDeltaLabel)
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : 'bg-gray-50 text-gray-600 border-gray-200',
                )}
                title="Compared to signed peers of the same contract type"
              >
                <TrendingUp className="h-3 w-3" />
                {precedentsData.riskDeltaLabel}
              </div>
            )}

            {(!precedentsData?.data || precedentsData.data.length === 0) ? (
              <p className="text-xs text-gray-400 italic">
                No signed precedents of this type yet in your workspace.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {precedentsData.data.map((p: any) => (
                  <li key={p.contractId} className="flex items-start gap-2.5">
                    <div className="h-6 px-1.5 rounded bg-violet-50 text-violet-700 text-[10px] font-semibold flex items-center justify-center flex-shrink-0">
                      {Math.round((p.similarity ?? 0) * 100)}%
                    </div>
                    <div className="min-w-0 flex-1">
                      <button
                        onClick={() => navigate(`/contracts/${p.contractId}`)}
                        className="text-sm text-gray-900 hover:text-blue-700 hover:underline truncate text-left w-full"
                        title={p.title}
                      >
                        {p.title}
                      </button>
                      <div className="text-[11px] text-gray-400 flex items-center gap-1.5 flex-wrap">
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
                                p.riskScore >= 0.67 ? 'text-red-500'
                                  : p.riskScore >= 0.34 ? 'text-amber-600'
                                  : 'text-emerald-600',
                              )}
                            >
                              Risk {Math.round(p.riskScore * 100)}%
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
          {contract.summary ? (
            <p className="text-sm text-gray-700 leading-relaxed">{contract.summary}</p>
          ) : (
            <p className="text-sm text-gray-400 italic">
              {contract.analysisStatus === 'DONE'
                ? 'No AI summary available.'
                : contract.analysisStatus === 'FAILED'
                  ? 'Analysis failed — re-run to generate a summary.'
                  : 'Generating summary…'}
            </p>
          )}
        </RailSection>

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

        {/* Phase 3 — whole-document playbook redline. Stages a first-pass
            markup the reviewer accepts change by change; nothing reaches the
            document until they do. Status lives in contract.metadata, which is
            what the 4s poll above is already watching. */}
        {id && (
          <PlaybookRedlineRailSection
            contractId={id}
            status={((contract?.metadata as Record<string, unknown> | undefined)
              ?._playbookRedlineStatus as 'IDLE' | 'QUEUED' | 'RUNNING' | 'DONE' | 'APPLIED' | 'FAILED') ?? 'IDLE'}
            staged={(contract?.metadata as Record<string, unknown> | undefined)?._playbookRedline as never}
            error={(contract?.metadata as Record<string, unknown> | undefined)?._playbookRedlineError as string | null}
          />
        )}

        {/* Phase 10 — Compliance Agent. GDPR / HIPAA / SOX / CCPA clause
            checks with per-framework status, grounded quotes, and
            remediation suggestions. Empty state offers a run button. */}
        {id && (
          <ComplianceRailSection
            contractId={id}
            onAfterCheck={() => qc.invalidateQueries({ queryKey: ['contract', id] })}
          />
        )}

        {/* P6.4 — Defined-term guard. Surfaces canonical defined
            terms + any inconsistent author-typed variants + an
            "Apply defined term everywhere" action. Only renders when
            the doc has ≥1 defined term pattern. */}
        <DefinedTermsRailSection editor={canvasEditor} />

        {/* P5.3 — Renewal advisor. Shows inside the 180-day expiry
            window; offers an LLM-backed recommendation + decision
            logging so the RENEWAL_DUE reminder stops firing. */}
        <RenewalAdviceRailSection
          contractId={id ?? ''}
          expiryDate={contract.expiryDate ?? null}
          advice={(contract.metadata?.renewalAdvice as RenewalAdvice | undefined) ?? null}
          decision={(contract.metadata?.renewalDecision as string | undefined) ?? null}
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
                      className="text-left w-full truncate py-0.5 px-1 rounded hover:bg-blue-50 hover:text-blue-700 transition-colors flex items-baseline gap-1.5"
                    >
                      {n.ref && (
                        <span className="font-mono text-[10.5px] text-gray-500 flex-shrink-0">
                          {n.ref}
                        </span>
                      )}
                      <span className="truncate flex-1">{n.title}</span>
                      {n.page && (
                        <span
                          data-testid={`toc-page-${n.id}`}
                          className="font-mono text-[9.5px] text-gray-400 flex-shrink-0 tabular-nums"
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

        <RailSection title="Key Terms" defaultOpen>
          <dl className="space-y-0">
            <DetailRow label="Owner" value={contract.owner?.name ?? '—'} />
            <DetailRow
              label="Counterparty"
              value={contract.counterpartyName ?? contract.counterparty?.name ?? '—'}
            />
            <DetailRow
              label="Effective"
              value={
                contract.effectiveDate
                  ? new Date(contract.effectiveDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                  : keyTerms.effectiveDate ? formatTermValue('effectiveDate', keyTerms.effectiveDate) : '—'
              }
            />
            <DetailRow
              label="Expires"
              value={
                contract.expiryDate
                  ? new Date(contract.expiryDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                  : keyTerms.expiryDate ? formatTermValue('expiryDate', keyTerms.expiryDate) : '—'
              }
            />
            <DetailRow
              label="Value"
              value={
                contract.value
                  ? `${contract.currency ?? keyTerms.currency ?? 'USD'} ${Number(contract.value).toLocaleString()}`
                  : keyTerms.value ? `${keyTerms.currency ?? 'USD'} ${Number(keyTerms.value).toLocaleString()}` : '—'
              }
            />
            <DetailRow label="Jurisdiction" value={contract.jurisdiction ?? keyTerms.governingLaw ?? '—'} />
            <DetailRow label="Contract No." value={contract.contractNumber ?? '—'} />
          </dl>
        </RailSection>

        {/* B.1.5d — Risks (collapsed by default, count in header) */}
        <RailSection
          title="Risks"
          count={
            contract.riskScore != null
              ? `${Math.round(contract.riskScore * 100)}%`
              : riskFactors.length || null
          }
        >
          {contract.riskScore != null && (
            <div className="mb-3">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className={cn(
                  'font-medium',
                  contract.riskScore >= 0.67 ? 'text-red-700' :
                  contract.riskScore >= 0.34 ? 'text-amber-700' : 'text-emerald-700',
                )}>
                  {contract.riskScore >= 0.67 ? 'High Risk' :
                   contract.riskScore >= 0.34 ? 'Medium Risk' : 'Low Risk'}
                </span>
                <span className="text-gray-500 tabular-nums">{Math.round(contract.riskScore * 100)}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    contract.riskScore >= 0.67 ? 'bg-red-500' :
                    contract.riskScore >= 0.34 ? 'bg-amber-500' : 'bg-emerald-500',
                  )}
                  style={{ width: `${Math.round(contract.riskScore * 100)}%` }}
                />
              </div>
            </div>
          )}
          {riskFactors.length > 0 ? (
            <ul className="space-y-1.5">
              {riskFactors.map((rf, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                  <span className="mt-1.5 h-1 w-1 rounded-full bg-red-400 flex-shrink-0" />
                  <span>{rf}</span>
                </li>
              ))}
            </ul>
          ) : contract.riskScore == null ? (
            <p className="text-sm text-gray-400 italic">No risk analysis yet.</p>
          ) : null}
        </RailSection>

        {/* B.1.5d — Clause flags (collapsed; count = present flags) */}
        {presentFlags.length > 0 && (
          <RailSection title="Clause Flags" count={presentFlags.length}>
            <div className="flex flex-wrap gap-1.5">
              {presentFlags.map(([k, label]) => (
                <span
                  key={k}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-xs font-medium border border-amber-100"
                >
                  <AlertTriangle className="h-3 w-3" /> {label}
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
                className="text-[11px] font-medium text-blue-600 hover:underline"
              >
                View all
              </button>
            ) : null
          }
        >
          {clausesData?.data?.length ? (
            <ul className="space-y-2">
              {clausesData.data.slice(0, 6).map((c: any) => (
                <li key={c.id} className="text-sm">
                  <div className="font-medium text-gray-900 truncate">
                    {CLAUSE_TYPE_LABELS[c.clauseType] ?? c.clauseType.replace(/_/g, ' ')}
                  </div>
                  {c.riskRating && (
                    <div className={cn(
                      'text-xs mt-0.5',
                      c.riskRating === 'HIGH' ? 'text-red-600' :
                      c.riskRating === 'MEDIUM' ? 'text-amber-600' : 'text-emerald-600',
                    )}>
                      {c.riskRating.toLowerCase()} risk
                    </div>
                  )}
                </li>
              ))}
              {clausesData.data.length > 6 && (
                <li className="text-xs text-gray-400">+ {clausesData.data.length - 6} more</li>
              )}
            </ul>
          ) : (
            <p className="text-sm text-gray-400 italic">No clauses extracted yet.</p>
          )}
        </RailSection>

        {/*
          B.1.5e — unified History: versions + attachments + parent/child all
          live in one timeline. Per plan this is also B.2. Merging because
          they share the rail and are conceptually "documents related to
          this contract" — users shouldn't have to tell us whether a
          counter-redline is a version, attachment, or child.
        */}
        <RailSection
          title="History"
          count={
            (versions.length || 0) +
            ((contract.attachments as any[] ?? []).length || 0) +
            (familyData?.children?.length ?? 0) +
            (familyData?.parent ? 1 : 0) || null
          }
        >
          <ol className="space-y-2.5">
            {/* Parent contract — hierarchical link */}
            {familyData?.parent && (
              <li className="flex items-start gap-2.5">
                <Link className="h-3.5 w-3.5 text-blue-500 mt-0.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] uppercase tracking-wide text-gray-400 font-medium">Parent</div>
                  <button
                    onClick={() => navigate(`/contracts/${familyData.parent.id}`)}
                    className="text-sm text-blue-700 hover:underline truncate text-left w-full"
                  >
                    {familyData.parent.title}
                  </button>
                </div>
              </li>
            )}

            {/* Versions */}
            {versions.map((v: any) => (
              <li key={v.id} className="flex items-start gap-2.5">
                <div className="h-5 w-5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-semibold flex items-center justify-center flex-shrink-0">
                  v{v.versionNumber}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-900 font-medium truncate">
                    {v.changeNote?.replace(/\s*\(\s*\)\s*$/, '') || `Version ${v.versionNumber}`}
                  </div>
                  <div className="text-[11px] text-gray-400">
                    {new Date(v.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                </div>
              </li>
            ))}

            {/* Attachments */}
            {((contract.attachments as any[] ?? []) as any[]).map((att: any, i: number) => (
              <li key={`att-${i}`} className="flex items-start gap-2.5">
                <Paperclip className="h-3.5 w-3.5 text-gray-400 mt-1 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-700 truncate">{att.label || att.filename}</div>
                  <div className="text-[11px] text-gray-400">Attachment</div>
                </div>
              </li>
            ))}

            {/* Children (amendments, SOWs, etc.) */}
            {familyData?.children && (familyData.children as any[]).map((child: any) => (
              <li key={`child-${child.id}`} className="flex items-start gap-2.5">
                <Link className="h-3.5 w-3.5 text-emerald-500 mt-0.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] uppercase tracking-wide text-gray-400 font-medium">
                    {child.relationshipType ?? 'Related'}
                  </div>
                  <button
                    onClick={() => navigate(`/contracts/${child.id}`)}
                    className="text-sm text-emerald-700 hover:underline truncate text-left w-full"
                  >
                    {child.title}
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </RailSection>

        {/* B.1.5f — Approval (conditional: only if instance or in-flow) */}
        {(approvalInstanceData || ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'].includes(contract?.status ?? '')) && (
          <RailSection
            title="Approval"
            count={approvalInstanceData?.instance?.status ?? null}
            defaultOpen={contract?.status === 'PENDING_APPROVAL'}
          >
            {approvalData ? (
              <div className="space-y-2">
                <div className="text-xs text-gray-500">
                  Waiting on you: <span className="font-medium text-gray-900">{approvalData.stepName}</span>
                </div>
                <button
                  onClick={() => {
                    // Wave 2.3 — scroll to the real DecisionStrip (Approve /
                    // Reject / Delegate) that renders above the document when
                    // the current user is the pending approver. Falls back to
                    // the Approvals tab's ApprovalCard if the strip isn't
                    // mounted. (Replaces the window.alert placeholder.)
                    const strip = document.getElementById('approval-decision-strip')
                    if (strip) {
                      strip.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    } else {
                      setTab('approval')
                    }
                  }}
                  className="w-full text-center py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                >
                  Review & Decide
                </button>
              </div>
            ) : approvalInstanceData?.instance ? (
              <p className="text-sm text-gray-600">
                Status: <span className="font-medium">{approvalInstanceData.instance.status}</span>
              </p>
            ) : (
              <p className="text-sm text-gray-400 italic">Not yet submitted for approval.</p>
            )}
          </RailSection>
        )}

        {/* B.1.5f — Comments */}
        <RailSection
          title="Comments"
          count={commentCount || null}
        >
          {commentCount ? (
            <p className="text-sm text-gray-600">
              {commentCount} comment{commentCount === 1 ? '' : 's'}. Full thread in the editor's inline comments (coming in B.3).
            </p>
          ) : (
            <p className="text-sm text-gray-400 italic">No comments yet.</p>
          )}
        </RailSection>

        {/* B.1.5f — Activity */}
        <RailSection
          title="Activity"
          count={timeline.length || null}
        >
          {timeline.length ? (
            <ol className="space-y-2">
              {timeline.slice(0, 8).map((evt: any, i: number) => (
                <li key={evt.id ?? i} className="flex gap-2 text-xs">
                  <span className="text-gray-400 tabular-nums min-w-[3.5rem]">
                    {new Date(evt.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                  <span className="text-gray-700">
                    {evt.action?.replace(/_/g, ' ').toLowerCase().replace(/\b./g, (c: string) => c.toUpperCase())}
                  </span>
                </li>
              ))}
              {timeline.length > 8 && (
                <li className="text-xs text-gray-400">+ {timeline.length - 8} more events</li>
              )}
            </ol>
          ) : (
            <p className="text-sm text-gray-400 italic">No activity yet.</p>
          )}
        </RailSection>
      </aside>

      {/* end of two-column body */}
      </div>

      {/* Share dialog */}
      {showShareDialog && id && (
        <ShareLinkDialog contractId={id} onClose={() => setShowShareDialog(false)} />
      )}

      {/* Binder split modal */}
      {showSplitModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-5 border-b">
              <div>
                <h2 className="text-lg font-semibold">Split into separate contracts</h2>
                <p className="text-xs text-gray-500 mt-0.5">Set the page range, title, and type for each agreement</p>
              </div>
              <button onClick={() => setShowSplitModal(false)} className="text-gray-400 hover:text-gray-600">
                <XCircle className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-4 max-h-96 overflow-y-auto">
              {splitSpecs.map((spec, i) => (
                <div key={i} className="border rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-600">Agreement {i + 1}</span>
                    {splitSpecs.length > 2 && (
                      <button
                        onClick={() => setSplitSpecs(prev => prev.filter((_, j) => j !== i))}
                        className="text-xs text-red-400 hover:text-red-600"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <Input
                    value={spec.title}
                    onChange={e => setSplitSpecs(prev => prev.map((s, j) => j === i ? { ...s, title: e.target.value } : s))}
                    placeholder="Agreement title"
                    className="text-sm"
                  />
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="text-xs text-gray-500 mb-1 block">Page start</label>
                      <Input
                        type="number" min={1}
                        value={spec.pageStart}
                        onChange={e => setSplitSpecs(prev => prev.map((s, j) => j === i ? { ...s, pageStart: parseInt(e.target.value) || 1 } : s))}
                        className="text-sm"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs text-gray-500 mb-1 block">Page end</label>
                      <Input
                        type="number" min={1}
                        value={spec.pageEnd}
                        onChange={e => setSplitSpecs(prev => prev.map((s, j) => j === i ? { ...s, pageEnd: parseInt(e.target.value) || 1 } : s))}
                        className="text-sm"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs text-gray-500 mb-1 block">Type</label>
                      <select
                        value={spec.type}
                        onChange={e => setSplitSpecs(prev => prev.map((s, j) => j === i ? { ...s, type: e.target.value } : s))}
                        className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        {CONTRACT_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                      </select>
                    </div>
                  </div>
                </div>
              ))}
              <button
                onClick={() => setSplitSpecs(prev => [...prev, { pageStart: 1, pageEnd: 10, title: `Agreement ${prev.length + 1}`, type: 'OTHER' }])}
                className="text-xs text-blue-600 hover:underline"
              >
                + Add another split
              </button>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50 rounded-b-xl">
              <Button variant="outline" onClick={() => setShowSplitModal(false)}>Cancel</Button>
              <Button
                onClick={() => splitMutation.mutate(splitSpecs)}
                disabled={splitMutation.isPending || splitSpecs.length < 2}
              >
                {splitMutation.isPending
                  ? <><Loader2 className="h-4 w-4 animate-spin mr-1.5" /> Splitting…</>
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

      {/* U.6.1 — Send-for-Review dialog. Picks workflow + adds optional
          message. Replaces the silent state flip the toolbar button did. */}
      {id && (
        <SendForReviewDialog
          contractId={id}
          contractType={contract?.type}
          open={sendForReviewOpen}
          onClose={() => setSendForReviewOpen(false)}
          onSent={() => {
            qc.invalidateQueries({ queryKey: ['contract', id] })
            qc.invalidateQueries({ queryKey: ['approval-instance-by-contract', id] })
          }}
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
        B.5.13 — Compare Versions fullscreen mode. See docs/26 State 9.
        We render conditionally on `id` being present (same guard as the
        palette) so we don't mount the mode during the initial loading
        flash. Entering is cheap (no data fetched until user picks two
        versions that differ); exiting is Esc or the × button.
      */}
      {id && (
        <CompareMode
          open={compareOpen}
          onClose={() => setCompareOpen(false)}
          contractId={id}
          versions={versions.map((v: any) => ({
            id:            v.id,
            versionNumber: v.versionNumber,
            createdAt:     v.createdAt,
            authorName:    v.createdByName ?? v.authorName ?? null,
            changeNote:    v.changeNote ?? null,
          }))}
        />
      )}

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
