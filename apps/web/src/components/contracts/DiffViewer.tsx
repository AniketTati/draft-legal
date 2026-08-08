/**
 * DiffViewer — renders HTML tracked-changes diff from node-htmldiff.
 * Supports unified and side-by-side modes.
 */
import { useState } from 'react'
import { ArrowLeftRight, AlignLeft } from 'lucide-react'
import { sanitizeHtml } from '@/lib/sanitize'

interface DiffStats {
  insertions: number
  deletions: number
}

interface DiffViewerProps {
  diffHtml: string
  stats: DiffStats
  v1Label?: string
  v2Label?: string
}

export function DiffViewer({ diffHtml, stats, v1Label = 'Original', v2Label = 'Counterparty' }: DiffViewerProps) {
  const [mode, setMode] = useState<'unified' | 'side-by-side'>('unified')

  return (
    <div className="flex flex-col gap-3">
      {/* Stats bar + mode toggle */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-4 text-dense tabular-nums">
          <span className="flex items-center gap-1.5 text-brand-700 font-medium">
            <span className="size-3 rounded-sm bg-brand-100 border border-brand-500 inline-block" />
            {stats.insertions} insertion{stats.insertions !== 1 ? 's' : ''}
          </span>
          <span className="flex items-center gap-1.5 text-risk-700 font-medium">
            <span className="size-3 rounded-sm bg-risk-100 border border-risk-200 inline-block" />
            {stats.deletions} deletion{stats.deletions !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-1 p-0.5 bg-paper-100 rounded-md">
          <button
            onClick={() => setMode('unified')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-chip text-[11.5px] font-semibold transition-colors ${
              mode === 'unified' ? 'bg-card shadow-e1 text-ink-950' : 'text-ink-500 hover:text-ink-950'
            }`}
          >
            <AlignLeft className="size-3.5" /> Unified
          </button>
          <button
            onClick={() => setMode('side-by-side')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-chip text-[11.5px] font-semibold transition-colors ${
              mode === 'side-by-side' ? 'bg-card shadow-e1 text-ink-950' : 'text-ink-500 hover:text-ink-950'
            }`}
          >
            <ArrowLeftRight className="size-3.5" /> Side by side
          </button>
        </div>
      </div>

      {mode === 'unified' ? (
        <div className="bg-card border border-paper-200 rounded-card overflow-hidden">
          <div
            className="diff-unified prose prose-sm max-w-none p-6 overflow-auto max-h-[70vh]"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(diffHtml) }}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-card border border-paper-200 rounded-card overflow-hidden">
            <div className="px-4 py-2 border-b border-paper-200 bg-paper-50 text-[10px] font-bold text-ink-400 uppercase tracking-[0.09em]">
              {v1Label}
            </div>
            <div
              className="diff-left prose prose-sm max-w-none p-4 overflow-auto max-h-[65vh]"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(diffHtml) }}
            />
          </div>
          <div className="bg-card border border-paper-200 rounded-card overflow-hidden">
            <div className="px-4 py-2 border-b border-paper-200 bg-paper-50 text-[10px] font-bold text-ink-400 uppercase tracking-[0.09em]">
              {v2Label}
            </div>
            <div
              className="diff-right prose prose-sm max-w-none p-4 overflow-auto max-h-[65vh]"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(diffHtml) }}
            />
          </div>
        </div>
      )}

      {/* Redline marks read off the meaning tokens, not literal green/red: what
          survives into the agreement is brand, what is struck is risk. Washes
          are held low so the serif body stays the thing you read. */}
      <style>{`
        /* Unified: show both ins and del */
        .diff-unified ins {
          background: hsl(var(--brand) / 0.12);
          color: hsl(var(--brand));
          text-decoration: none;
          border-radius: 2px;
          padding: 0 1px;
        }
        .diff-unified del {
          background: hsl(var(--destructive) / 0.08);
          color: hsl(var(--destructive));
          text-decoration: line-through;
          border-radius: 2px;
          padding: 0 1px;
        }
        /* Side-by-side left: hide ins (counterparty additions not in original) */
        .diff-left ins { display: none; }
        .diff-left del {
          background: hsl(var(--destructive) / 0.08);
          color: hsl(var(--destructive));
          text-decoration: none;
          border-radius: 2px;
          padding: 0 1px;
        }
        /* Side-by-side right: hide del (original text removed by counterparty) */
        .diff-right del { display: none; }
        .diff-right ins {
          background: hsl(var(--brand) / 0.12);
          color: hsl(var(--brand));
          text-decoration: none;
          border-radius: 2px;
          padding: 0 1px;
        }
      `}</style>
    </div>
  )
}
