/**
 * Template Selector Modal — Phase 4.3 (SCR-004)
 * Triggered from "New Contract" button or chat draft flow.
 * Shows published templates with type filter + match score.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileText, Loader2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Chip, EmptyState } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import type { Template } from '@clm/types'

const CONTRACT_TYPES = ['NDA', 'MSA', 'SOW', 'SLA', 'VENDOR_AGREEMENT', 'EMPLOYMENT', 'PARTNERSHIP', 'LICENSE', 'ORDER_FORM', 'OTHER']

interface Props {
  onSelect: (template: Template) => void
  onClose: () => void
  preferredType?: string
}

export function TemplateSelectorModal({ onSelect, onClose, preferredType }: Props) {
  const [filterType, setFilterType] = useState(preferredType ?? '')
  const [q, setQ] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['templates-selector', filterType, q],
    queryFn: () =>
      api.get('/templates', {
        params: {
          published: 'true',
          ...(filterType && { contractType: filterType }),
          ...(q && { q }),
          limit: 50,
        },
      }).then(r => r.data),
  })

  const templates: Template[] = data?.data ?? []

  // Escape closes it. This is a picker, not a form — there is nothing to lose,
  // and a modal that ignores Escape is a modal a keyboard user is stuck in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Select template"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4"
      onClick={onClose}
    >
      <div className="w-full max-w-2xl bg-card rounded-card shadow-e3 overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-paper-200">
          <div>
            <h2 className="text-section text-ink-950">Select Template</h2>
            <p className="text-dense text-ink-500">Choose a template to start your contract draft</p>
          </div>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
            <X className="size-4" />
          </button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 px-6 py-3 border-b border-paper-200 bg-paper-50">
          <Input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search templates..."
            className="flex-1"
          />
          <select
            value={filterType}
            onChange={e => setFilterType(e.target.value)}
            className="h-8 rounded-md border border-input bg-card px-2.5 text-[13px] text-ink-950 outline-none"
          >
            <option value="">All Types</option>
            {CONTRACT_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
        </div>

        {/* Template list */}
        <div className="max-h-96 overflow-y-auto divide-y divide-paper-100">
          {isLoading && (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="size-5 text-ink-400 animate-spin" />
            </div>
          )}
          {!isLoading && !templates.length && (
            <div className="p-5">
              <EmptyState
                icon={<FileText />}
                title="No published templates found"
                description="Create and publish a template first"
              />
            </div>
          )}
          {templates.map(t => (
            <button
              key={t.id}
              onClick={() => onSelect(t)}
              data-testid={`template-pick-${t.id}`}
              className={cn(
                'w-full text-left px-6 py-4 transition-colors hover:bg-paper-50',
                // The type match is a recommendation, not a binding state — so
                // it's marked in ink (the system pointing), not in brand green.
                preferredType && t.contractType === preferredType && 'bg-paper-50 border-l-2 border-ink-950',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <FileText className="size-3.5 text-ink-400 shrink-0" />
                    {/*
                      The globe next to every name said "published" on a list
                      that is filtered to published — a glyph on 100% of rows
                      carries no information, so it is gone. The name gets the
                      space instead.
                    */}
                    <span className="text-body font-medium text-ink-950">{t.name}</span>
                    {preferredType && t.contractType === preferredType && (
                      <Chip>Recommended</Chip>
                    )}
                  </div>
                  {t.description && (
                    <p className="text-dense text-ink-500 mt-0.5 line-clamp-1">{t.description}</p>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    {t.contractType && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded-chip border border-paper-200 bg-paper-100 text-ink-700">{t.contractType}</span>
                    )}
                    {/* Facts in one string — a wrap can't strand a separator. */}
                    <span className="text-[11px] tabular-nums text-ink-400">
                      {[
                        `${t.sections?.length ?? 0} sections`,
                        ...((t.usageCount ?? 0) > 0 ? [`used ${t.usageCount}×`] : []),
                      ].join(' · ')}
                    </span>
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-paper-200 bg-paper-50">
          <p className="text-[11px] tabular-nums text-ink-400">{templates.length} templates available</p>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  )
}
