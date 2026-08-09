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
          {/* The legend shows the mark itself, not a colour swatch: underline
              for in, strike for out. Read it in greyscale and it still works. */}
          <span className="flex items-center gap-1.5 text-info-700 font-medium">
            <span aria-hidden className="px-1 rounded-chip bg-info-50 border border-info-200 underline decoration-2 underline-offset-2">
              Aa
            </span>
            {stats.insertions} insertion{stats.insertions !== 1 ? 's' : ''}
          </span>
          <span className="flex items-center gap-1.5 text-info-700 font-medium">
            <span aria-hidden className="px-1 rounded-chip bg-info-50 border border-info-200 line-through decoration-2">
              Aa
            </span>
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

      {/*
        Redline marks follow the blackline conventions counsel already has in
        their hands, not this app's status palette:

          - Insertions are UNDERLINED, deletions are STRUCK. That pairing is the
            load-bearing signal; it is thirty years old, it survives a photocopy,
            and it is the only part of the mark that reads in greyscale. Colour
            is a second, redundant channel.
          - Both marks are ONE colour, info. Emerald here was actively
            misleading: brand means executed/approved/signed, so a proposed
            insertion rendered green read as language already agreed. A pending
            redline is neither binding nor a risk finding — it is a change in
            flight on someone else's turn, which is exactly info. Using the same
            colour for both marks is also what Word does per author, so the
            underline/strike does the distinguishing work rather than hue.

        Washes stay low so the serif body remains the thing you read.
      */}
      <style>{`
        /* Unified: show both ins and del */
        .diff-unified ins,
        .diff-right ins {
          background: hsl(var(--info) / 0.10);
          color: hsl(var(--info));
          text-decoration: underline;
          text-decoration-thickness: 1.5px;
          text-underline-offset: 2px;
          border-radius: 2px;
          padding: 0 1px;
        }
        .diff-unified del,
        .diff-left del {
          background: hsl(var(--info) / 0.06);
          color: hsl(var(--info));
          text-decoration: line-through;
          text-decoration-thickness: 1.5px;
          border-radius: 2px;
          padding: 0 1px;
        }
        /* Side-by-side left: hide ins (counterparty additions not in original) */
        .diff-left ins { display: none; }
        /* Side-by-side right: hide del (original text removed by counterparty) */
        .diff-right del { display: none; }

        /* Printed or photocopied, the wash and the hue are both gone. The
           decorations have to carry the whole diff on their own, so drop the
           colour rather than let it grey out into something ambiguous. */
        @media print {
          .diff-unified ins, .diff-right ins,
          .diff-unified del, .diff-left del {
            background: transparent;
            color: inherit;
          }
        }
      `}</style>
    </div>
  )
}
