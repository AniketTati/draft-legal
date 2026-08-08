/**
 * RedlinePanel — AI-powered redline analysis results.
 * Shows per-change recommendations, playbook alignment, and counter-proposals.
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  CheckCircle2, XCircle, RefreshCw, AlertTriangle, Loader2,
  ChevronDown, ChevronRight, Copy, Check, Sparkles, Shield,
} from 'lucide-react'

interface RedlineChange {
  changeId: string
  clauseType: string
  ourText: string
  theirText: string
  context?: string
  sectionRef?: string | null
  recommendation?: 'accept' | 'reject' | 'counter'
  playbookAlignment?: 'preferred' | 'acceptable' | 'fallback' | 'walkaway' | 'outside_playbook'
  severity?: 'low' | 'medium' | 'high' | 'critical'
  reasoning?: string
  requiresHumanReview?: boolean
  counterText?: string
  counterNote?: string
}

interface RedlineAnalysis {
  v1Id: string
  v2Id: string
  analyzedAt: string
  changes: RedlineChange[]
  summary: string
  recommendedAction: 'accept_all' | 'counter' | 'reject'
  requiresHumanGate: boolean
  confidence: number
}

interface Version {
  id: string
  versionNumber: number
  createdAt: string
}

interface RedlinePanelProps {
  analysis?: RedlineAnalysis | null
  isAnalyzing: boolean
  versions: Version[]
  onRequestAnalysis: (v1Id: string, v2Id: string) => void
}

const SEVERITY_COLORS: Record<string, string> = {
  low:      'bg-paper-100 text-ink-700',
  medium:   'bg-attention-50 text-attention-700',
  high:     'bg-risk-50 text-risk-700',
  critical: 'bg-risk-100 text-risk-900',
}

// Where a change sits against the playbook. `outside_playbook` was purple,
// which now belongs to the machine — and this is a playbook verdict, not
// something the model authored. It reads as attention instead: nobody has a
// position on this clause, so a human has to take one. `acceptable` loses its
// green: brand means binding, and "acceptable" asserts nothing — it is the
// same neutral rung it takes on the playbook page and the review drawer.
const ALIGNMENT_COLORS: Record<string, string> = {
  preferred:       'bg-brand-100 text-brand-700',
  acceptable:      'bg-paper-100 text-ink-700',
  fallback:        'bg-attention-50 text-attention-700',
  walkaway:        'bg-risk-100 text-risk-900',
  outside_playbook: 'bg-attention-100 text-attention-700',
}

const RECOMMENDATION_CONFIG = {
  accept:  { icon: CheckCircle2, color: 'text-brand-700',     label: 'Accept',  bg: 'bg-brand-50'     },
  reject:  { icon: XCircle,      color: 'text-risk-600',      label: 'Reject',  bg: 'bg-risk-50'      },
  counter: { icon: RefreshCw,    color: 'text-attention-700', label: 'Counter', bg: 'bg-attention-50' },
}

function ChangeCard({ change }: { change: RedlineChange }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const rec = change.recommendation ? RECOMMENDATION_CONFIG[change.recommendation] : null

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="bg-card border border-paper-200 rounded-card overflow-hidden">
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5 flex-1 min-w-0">
            {rec && (
              <div className={`flex-shrink-0 mt-0.5 p-1.5 rounded-md ${rec.bg}`}>
                <rec.icon className={`size-3.5 ${rec.color}`} />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {rec && (
                  <span className={`text-dense font-semibold ${rec.color}`}>{rec.label}</span>
                )}
                <span className="text-dense text-ink-700 font-medium capitalize">
                  {change.clauseType.replace(/_/g, ' ')}
                </span>
                {change.sectionRef && (
                  <span className="text-dense text-ink-400 font-mono">{change.sectionRef}</span>
                )}
                {change.severity && (
                  <span className={`text-dense px-1.5 py-0.5 rounded-chip font-medium capitalize ${SEVERITY_COLORS[change.severity] ?? ''}`}>
                    {change.severity}
                  </span>
                )}
                {change.playbookAlignment && (
                  <span className={`text-dense px-1.5 py-0.5 rounded-chip font-medium ${ALIGNMENT_COLORS[change.playbookAlignment] ?? ''}`}>
                    {change.playbookAlignment.replace(/_/g, ' ')}
                  </span>
                )}
                {change.requiresHumanReview && (
                  <span className="text-dense bg-risk-100 text-risk-900 px-1.5 py-0.5 rounded-chip font-medium flex items-center gap-1">
                    <Shield className="size-3" /> Human review
                  </span>
                )}
              </div>
              {change.reasoning && (
                <p className="text-dense text-ink-500 mt-1 leading-relaxed">{change.reasoning}</p>
              )}
            </div>
          </div>
          <button
            onClick={() => setExpanded(e => !e)}
            className="p-1 text-ink-400 hover:text-ink-700 rounded-md flex-shrink-0"
          >
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        </div>

        {expanded && (
          <div className="mt-3 space-y-3">
            {change.ourText && (
              <div>
                <p className="text-eyebrow text-ink-400 uppercase mb-1">Original</p>
                {/* Our text is what the counterparty wants gone, so it sits on
                    the risk wash; their proposal is the incoming language. */}
                <div className="bg-risk-50 border border-risk-100 rounded-md px-3 py-2">
                  <p className="text-dense text-ink-950 leading-relaxed font-mono">{change.ourText}</p>
                </div>
              </div>
            )}
            {change.theirText && (
              <div>
                <p className="text-eyebrow text-ink-400 uppercase mb-1">Counterparty proposes</p>
                <div className="bg-paper-100 border border-paper-200 rounded-md px-3 py-2">
                  <p className="text-dense text-ink-950 leading-relaxed font-mono">{change.theirText}</p>
                </div>
              </div>
            )}
            {change.counterText && (
              <div>
                <p className="text-eyebrow text-attention-700 uppercase mb-1">Our counter-proposal</p>
                <div className="bg-attention-50 border border-attention-200 rounded-md px-3 py-2">
                  <p className="text-dense text-ink-950 leading-relaxed font-mono">{change.counterText}</p>
                  {change.counterNote && (
                    <p className="text-dense text-attention-700 mt-1.5 italic">{change.counterNote}</p>
                  )}
                  <button
                    onClick={() => handleCopy(change.counterText!)}
                    className="mt-2 flex items-center gap-1 text-dense text-ink-700 hover:text-ink-950 font-medium"
                  >
                    {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                    {copied ? 'Copied!' : 'Copy counter text'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function RedlinePanel({
  analysis, isAnalyzing, versions, onRequestAnalysis,
}: RedlinePanelProps) {
  const [v1Id, setV1Id] = useState(versions[1]?.id ?? '')
  const [v2Id, setV2Id] = useState(versions[0]?.id ?? '')

  if (versions.length < 2) {
    return (
      <div className="text-center py-12 text-ink-400">
        <AlertTriangle className="size-6 mx-auto mb-2 opacity-30" />
        <p className="text-body font-medium text-ink-500">Upload a counterparty version to analyze redlines</p>
        <p className="text-dense mt-1">Upload a new version on the Versions tab, then come back here.</p>
      </div>
    )
  }

  const acceptN  = analysis?.changes.filter(c => c.recommendation === 'accept').length ?? 0
  const counterN = analysis?.changes.filter(c => c.recommendation === 'counter').length ?? 0
  const rejectN  = analysis?.changes.filter(c => c.recommendation === 'reject').length ?? 0

  return (
    <div className="space-y-4">
      {/* Version selectors + trigger */}
      <div className="bg-card border border-paper-200 rounded-card p-4 space-y-3">
        <p className="text-section text-ink-950">Select versions to compare</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-dense text-ink-500 font-medium block mb-1">Baseline (our version)</label>
            <select
              value={v1Id}
              onChange={e => setV1Id(e.target.value)}
              className="w-full h-8 text-[13px] border border-input bg-card rounded-md px-2.5 focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/12"
            >
              {versions.map(v => (
                <option key={v.id} value={v.id}>v{v.versionNumber}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-dense text-ink-500 font-medium block mb-1">Counterparty redlines</label>
            <select
              value={v2Id}
              onChange={e => setV2Id(e.target.value)}
              className="w-full h-8 text-[13px] border border-input bg-card rounded-md px-2.5 focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/12"
            >
              {versions.map(v => (
                <option key={v.id} value={v.id}>v{v.versionNumber}</option>
              ))}
            </select>
          </div>
        </div>
        <Button
          className="w-full gap-2"
          disabled={!v1Id || !v2Id || v1Id === v2Id || isAnalyzing}
          onClick={() => onRequestAnalysis(v1Id, v2Id)}
        >
          {isAnalyzing
            ? <><Loader2 className="size-3.5 animate-spin" /> Analyzing redlines…</>
            : <><Sparkles className="size-3.5" /> Analyze Redlines</>
          }
        </Button>
      </div>

      {/* Human gate banner */}
      {analysis?.requiresHumanGate && (
        <div className="bg-attention-50 border border-attention-200 rounded-card p-4 flex items-start gap-3">
          <AlertTriangle className="size-4 text-attention-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-body font-semibold text-attention-700">Legal review required</p>
            <p className="text-dense text-attention-700 mt-0.5">
              One or more changes involve walkaway positions or terms outside the playbook. Please escalate to legal counsel before proceeding.
            </p>
          </div>
        </div>
      )}

      {/* Summary */}
      {analysis && (
        <div className="bg-card border border-paper-200 rounded-card p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-section text-ink-950">Analysis summary</p>
              <p className="text-dense text-ink-500 mt-0.5">{analysis.summary}</p>
            </div>
            <div className="text-right flex-shrink-0">
              <span className={`text-dense font-semibold px-2 py-1 rounded-md ${
                analysis.recommendedAction === 'accept_all' ? 'bg-brand-50 text-brand-700' :
                analysis.recommendedAction === 'reject'    ? 'bg-risk-50 text-risk-700' :
                'bg-attention-50 text-attention-700'
              }`}>
                {analysis.recommendedAction === 'accept_all' ? 'Accept all'
                  : analysis.recommendedAction === 'reject'   ? 'Reject'
                  : 'Counter required'}
              </span>
              <p className="text-dense text-ink-400 mt-1 tabular-nums">{Math.round(analysis.confidence * 100)}% confidence</p>
            </div>
          </div>
          <div className="flex items-center gap-4 text-dense tabular-nums">
            <span className="text-brand-700 font-medium">{acceptN} accept</span>
            <span className="text-attention-700 font-medium">{counterN} counter</span>
            <span className="text-risk-700 font-medium">{rejectN} reject</span>
          </div>
        </div>
      )}

      {/* Change list */}
      {analysis && analysis.changes.length > 0 && (
        <div className="space-y-2.5">
          <p className="text-eyebrow text-ink-700 uppercase px-1">
            {analysis.changes.length} change{analysis.changes.length !== 1 ? 's' : ''} detected
          </p>
          {analysis.changes.map(change => (
            <ChangeCard key={change.changeId} change={change} />
          ))}
        </div>
      )}
    </div>
  )
}
