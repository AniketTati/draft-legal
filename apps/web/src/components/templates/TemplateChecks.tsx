/**
 * docs/41 Part 1 and Part 2 — a template's state in the builder: which
 * version drafts use, whether it has changes drafts don't see yet, whether
 * the clause library moved on since it was published, whether it is its
 * type's default, and what the playbook says about its wording (lint).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Info, Loader2, RefreshCw } from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Eyebrow } from '@/components/ui/primitives'
import { toast } from '@/components/common/Toaster'

export interface LintWarning {
  sectionId: string
  sectionTitle: string
  variantLabel?: string
  severity: 'warning' | 'error'
  code: string
  message: string
}

export interface TemplateState {
  id: string
  contractType: string | null
  isPublished: boolean
  isDefaultForType: boolean
  hasUnpublishedChanges: boolean
  publishedVersion: { id: string; version: number; publishedAt: string; lint: LintWarning[] } | null
  libraryChanges: Array<{ sectionId: string; familyName: string; changes: string[] }>
}

export function useTemplateState(templateId: string | undefined) {
  return useQuery({
    queryKey: ['template', templateId],
    queryFn: () => api.get<TemplateState>(`/templates/${templateId}`).then(r => r.data),
    enabled: !!templateId,
  })
}

export function LintList({ warnings }: { warnings: LintWarning[] }) {
  if (!warnings.length) {
    return <p className="text-[12px] text-ink-500 flex items-center gap-1.5"><CheckCircle2 className="size-3.5 text-ink-400" /> Agrees with your playbook.</p>
  }
  return (
    <ul className="space-y-1.5" data-testid="template-lint">
      {warnings.map((w, i) => (
        <li key={i} className={cn('flex items-start gap-1.5 text-[12px] rounded-md px-2 py-1.5 border', w.severity === 'error' ? 'bg-risk-50 border-risk-200 text-risk-900' : 'bg-attention-50 border-attention-200 text-attention-700')}>
          <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
          <span>{w.message}</span>
        </li>
      ))}
    </ul>
  )
}

export function TemplateChecks({ templateId, onPublish, publishing }: { templateId: string; onPublish: () => void; publishing: boolean }) {
  const qc = useQueryClient()
  const { data: t } = useTemplateState(templateId)
  const { data: lint } = useQuery({
    queryKey: ['template-lint', templateId, t?.hasUnpublishedChanges, t?.publishedVersion?.id],
    queryFn: () => api.get<{ data: LintWarning[] }>(`/templates/${templateId}/lint`).then(r => r.data.data),
  })
  const setDefault = useMutation({
    meta: { errorHandled: true },
    mutationFn: (isDefault: boolean) => api.put(`/templates/${templateId}/default-for-type`, { isDefault }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['template', templateId] }); qc.invalidateQueries({ queryKey: ['templates'] }) },
    onError: e => toast.error('Not changed', { description: apiErrorMessage(e) }),
  })
  if (!t) return null
  return (
    <div className="space-y-3" data-testid="template-checks">
      <div className="space-y-1.5">
        <Eyebrow>Drafts use</Eyebrow>
        {t.publishedVersion ? (
          <p className="text-[12px] text-ink-700">Version {t.publishedVersion.version}, published {new Date(t.publishedVersion.publishedAt).toLocaleDateString()}.</p>
        ) : t.isPublished ? (
          <p className="text-[12px] text-ink-700">This template as it is (published before versions were kept). Publish it to keep a version.</p>
        ) : (
          <p className="text-[12px] text-ink-700">Nothing yet: not published.</p>
        )}
        {t.hasUnpublishedChanges && (
          <p className="text-[12px] text-attention-700 bg-attention-50 border border-attention-200 rounded-md px-2 py-1.5 flex items-start gap-1.5" data-testid="template-unpublished-changes">
            <Info className="size-3.5 shrink-0 mt-0.5" /> You have changes drafts don’t use yet. Publish to use them.
          </p>
        )}
        {t.libraryChanges.length > 0 && (
          <div className="text-[12px] text-attention-700 bg-attention-50 border border-attention-200 rounded-md px-2 py-1.5 space-y-1" data-testid="template-library-changes">
            <p className="flex items-start gap-1.5"><RefreshCw className="size-3.5 shrink-0 mt-0.5" /> The clause library changed since this was published. Publish again to use:</p>
            <ul className="pl-5 list-disc">
              {t.libraryChanges.flatMap(c => c.changes.map((x, i) => <li key={`${c.sectionId}-${i}`}>{c.familyName}: {x}</li>))}
            </ul>
            <button type="button" onClick={onPublish} disabled={publishing} className="font-medium underline underline-offset-2">
              {publishing ? <Loader2 className="inline size-3 animate-spin" /> : 'Publish again'}
            </button>
          </div>
        )}
      </div>

      {t.contractType && (
        <label className="flex items-start gap-1.5 text-[12px] text-ink-700" title={t.isPublished ? undefined : 'Publish the template first'}>
          <input
            type="checkbox"
            checked={t.isDefaultForType}
            disabled={!t.isPublished || setDefault.isPending}
            onChange={e => setDefault.mutate(e.target.checked)}
            className="accent-ink-950 mt-0.5"
            data-testid="template-default-for-type"
          />
          <span>Default {t.contractType} template — used when a request or the assistant doesn’t name one</span>
        </label>
      )}

      <div className="space-y-1.5">
        <Eyebrow>Against your playbook</Eyebrow>
        {lint ? <LintList warnings={lint} /> : <Loader2 className="size-4 animate-spin text-ink-400" />}
      </div>
    </div>
  )
}
