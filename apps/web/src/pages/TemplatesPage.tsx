/**
 * Templates Page — Phase 4.3 (SCR-015)
 * Browse, create, and manage contract templates.
 * Template builder with TipTap section editor + variable definition panel.
 */
import { useState, useRef } from 'react'
import { sanitizeHtml } from '@/lib/sanitize'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Edit2, Trash2, Eye, FileText, Globe, Lock, Loader2, Search, Upload } from 'lucide-react'
import { api } from '@/lib/api'
import { ContractEditor } from '@/components/editor/ContractEditor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Template, VariableDef } from '@clm/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CONTRACT_TYPES = ['NDA', 'MSA', 'SOW', 'SLA', 'VENDOR_AGREEMENT', 'EMPLOYMENT', 'PARTNERSHIP', 'LICENSE', 'ORDER_FORM', 'OTHER']
const VARIABLE_TYPES = ['text', 'number', 'date', 'boolean', 'select'] as const

// Despite the name this renders the contract type — a category, not a state —
// so it carries no meaning color.
function RiskBadge({ type }: { type?: string | null }) {
  if (!type) return null
  return (
    <span className="text-[11px] px-2 py-0.5 rounded-full border border-paper-200 bg-paper-100 text-ink-700 font-medium">
      {type}
    </span>
  )
}

// ─── Template Card ────────────────────────────────────────────────────────────

function TemplateCard({
  template,
  onEdit,
  onDelete,
  onPreview,
}: {
  template: Template
  onEdit: () => void
  onDelete: () => void
  onPreview: () => void
}) {
  // P7.4.11 / F-60 — usageCount is on Template; surface it as a tag
  // when > 0 so the user knows which templates are battle-tested.
  // P7.4.11 / F-59 — title is now a button → opens editor (industry
  // standard for card UX). Pencil icon stays for discovery + a11y.
  const usageCount = (template as Template & { usageCount?: number }).usageCount ?? 0
  return (
    <div
      data-testid={`template-card-${template.id}`}
      className="bg-card border border-paper-200 rounded-card p-4 hover:border-paper-300 transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <FileText className="size-3.5 text-ink-400 shrink-0" />
            <button
              type="button"
              onClick={onEdit}
              data-testid={`template-card-title-${template.id}`}
              className="text-body font-semibold text-ink-950 truncate text-left hover:text-brand-700 hover:underline underline-offset-2 decoration-paper-300 hover:decoration-brand-700"
            >
              {template.name}
            </button>
            {/* Publishing is the act that makes a template usable, so the
                published/draft split is a real binding/neutral distinction. */}
            {template.isPublished
              ? <span title="Published"><Globe className="size-3.5 text-brand-700" /></span>
              : <span title="Draft"><Lock className="size-3.5 text-ink-400" /></span>
            }
            {usageCount >= 5 && (
              <span
                data-testid={`template-most-used-${template.id}`}
                title={`Used ${usageCount} times — frequently used template`}
                // "Most used" is a fact about the past, not a thing waiting on
                // the user — so it does not get the attention color.
                className="inline-flex items-center gap-0.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] px-1.5 py-0.5 rounded-chip bg-paper-100 text-ink-700 border border-paper-200"
              >
                ★ Most used
              </span>
            )}
          </div>
          {template.description && (
            <p className="text-dense text-ink-500 mt-1 line-clamp-2">{template.description}</p>
          )}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {template.contractType && <RiskBadge type={template.contractType} />}
            <span className="text-[11px] tabular-nums text-ink-400">v{template.version}</span>
            <span className="text-[11px] text-ink-400">·</span>
            <span className="text-[11px] tabular-nums text-ink-400">{(template.sections?.length ?? 0)} sections</span>
            <span className="text-[11px] text-ink-400">·</span>
            <span className="text-[11px] tabular-nums text-ink-400">{(template.variables as VariableDef[])?.length ?? 0} variables</span>
            {usageCount > 0 && (
              <>
                <span className="text-[11px] text-ink-400">·</span>
                <span
                  data-testid={`template-usage-${template.id}`}
                  className="text-[11px] text-ink-500 tabular-nums"
                >
                  Used {usageCount} {usageCount === 1 ? 'time' : 'times'}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          <button onClick={onPreview} className="p-1.5 rounded-md hover:bg-paper-100 text-ink-400 hover:text-ink-700" title="Preview"><Eye className="size-3.5" /></button>
          <button onClick={onEdit} className="p-1.5 rounded-md hover:bg-paper-100 text-ink-400 hover:text-ink-950" title="Edit"><Edit2 className="size-3.5" /></button>
          <button onClick={onDelete} className="p-1.5 rounded-md hover:bg-risk-50 text-ink-400 hover:text-risk-600" title="Delete"><Trash2 className="size-3.5" /></button>
        </div>
      </div>
    </div>
  )
}

// ─── Variable Definition Editor ───────────────────────────────────────────────

function VariableEditor({
  variables,
  onChange,
}: {
  variables: VariableDef[]
  onChange: (vars: VariableDef[]) => void
}) {
  const addVar = () =>
    onChange([...variables, { key: '', label: '', type: 'text', required: false }])

  const updateVar = (i: number, patch: Partial<VariableDef>) =>
    onChange(variables.map((v, idx) => (idx === i ? { ...v, ...patch } : v)))

  const removeVar = (i: number) =>
    onChange(variables.filter((_, idx) => idx !== i))

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-eyebrow uppercase text-ink-700">Variables</p>
        <Button variant="outline" size="xs" onClick={addVar}>+ Add</Button>
      </div>
      {variables.map((v, i) => (
        <div key={i} className="bg-paper-50 border border-paper-200 rounded-md p-2 space-y-1.5">
          {/* Row 1: key + type */}
          <div className="flex gap-1.5">
            <input
              value={v.key}
              onChange={e => updateVar(i, { key: e.target.value.replace(/[^a-z0-9_]/g, '_') })}
              placeholder="variable_key"
              className="flex-1 min-w-0 text-[11.5px] font-mono text-ink-950 border border-input bg-card rounded-md px-2 py-1 outline-none placeholder:text-ink-400 focus-visible:border-brand-700"
            />
            <select
              value={v.type}
              onChange={e => updateVar(i, { type: e.target.value as VariableDef['type'] })}
              aria-label={`Type for variable ${v.key || i + 1}`}
              className="text-[11.5px] text-ink-950 border border-input rounded-md px-1.5 py-1 outline-none bg-card"
            >
              {VARIABLE_TYPES.map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          {/* Row 2: label + required + delete */}
          <div className="flex gap-1.5 items-center">
            <input
              value={v.label}
              onChange={e => updateVar(i, { label: e.target.value })}
              placeholder="Display label"
              className="flex-1 min-w-0 text-[11.5px] text-ink-950 border border-input bg-card rounded-md px-2 py-1 outline-none placeholder:text-ink-400 focus-visible:border-brand-700"
            />
            <label className="flex items-center gap-1 text-[11.5px] text-ink-500 whitespace-nowrap shrink-0">
              <input type="checkbox" checked={v.required} onChange={e => updateVar(i, { required: e.target.checked })} className="accent-ink-950" />
              Req.
            </label>
            <button onClick={() => removeVar(i)} className="text-ink-400 hover:text-risk-600 shrink-0">
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function X({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

// ─── Template Builder Modal ───────────────────────────────────────────────────

function TemplateBuilderModal({
  template,
  onClose,
  onSave,
  onPreview,
}: {
  template?: Template
  onClose: () => void
  onSave: (data: any) => void
  onPreview?: () => void
}) {
  const [name, setName] = useState(template?.name ?? '')
  const [description, setDescription] = useState(template?.description ?? '')
  const [contractType, setContractType] = useState(template?.contractType ?? '')
  const [isPublished, setIsPublished] = useState(template?.isPublished ?? false)
  const [variables, setVariables] = useState<VariableDef[]>(
    (template?.variables as VariableDef[]) ?? [],
  )
  const [activeSectionIdx, setActiveSectionIdx] = useState(0)
  const [sections, setSections] = useState<any[]>(
    template?.sections ?? [{ title: 'Section 1', content: '', sortOrder: 0, clauseRefs: [], conditionalLogic: null }],
  )
  const [saving, setSaving] = useState(false)

  const updateSectionContent = (idx: number, html: string) => {
    setSections(s => s.map((sec, i) => (i === idx ? { ...sec, content: html } : sec)))
  }

  const addSection = () => {
    setSections(s => [...s, { title: `Section ${s.length + 1}`, content: '', sortOrder: s.length, clauseRefs: [], conditionalLogic: null }])
    setActiveSectionIdx(sections.length)
  }

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      await onSave({ name, description, contractType: contractType || null, isPublished, variables, sections })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch bg-ink-950/40">
      <div className="relative m-auto w-full max-w-6xl h-[90vh] bg-card rounded-card flex flex-col overflow-hidden shadow-e3">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-paper-200">
          <h2 className="text-section text-ink-950">
            {template ? 'Edit Template' : 'New Template'}
          </h2>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-dense text-ink-700">
              <input type="checkbox" checked={isPublished} onChange={e => setIsPublished(e.target.checked)} className="accent-ink-950" />
              Published
            </label>
            {onPreview && (
              <Button variant="outline" onClick={onPreview}>
                <Eye />
                Preview
              </Button>
            )}
            <Button
              onClick={handleSave}
              disabled={saving || !name.trim()}
              data-testid="template-save-btn"
            >
              {saving && <Loader2 className="animate-spin" />}
              Save Template
            </Button>
            <button onClick={onClose} className="text-ink-400 hover:text-ink-700"><X className="size-4" /></button>
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Left panel: metadata + variables */}
          <div className="w-72 shrink-0 border-r border-paper-200 p-4 overflow-y-auto space-y-4">
            <div className="space-y-3">
              <div>
                <label className="text-[11px] font-medium text-ink-700 mb-1 block">Template Name *</label>
                <Input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  data-testid="template-name-input"
                  placeholder="e.g. Mutual NDA — Standard"
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-ink-700 mb-1 block">Description</label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={2}
                  className="w-full border border-input bg-card rounded-md px-[11px] py-1.5 text-[13px] text-ink-950 placeholder:text-ink-400 outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/12 resize-none"
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-ink-700 mb-1 block">Contract Type</label>
                <select
                  value={contractType}
                  onChange={e => setContractType(e.target.value)}
                  className="w-full h-8 border border-input bg-card rounded-md px-2.5 text-[13px] text-ink-950 outline-none"
                >
                  <option value="">Generic (all types)</option>
                  {CONTRACT_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
            </div>

            {/* Sections list */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-eyebrow uppercase text-ink-700">Sections</p>
                <Button variant="outline" size="xs" onClick={addSection}>+ Add</Button>
              </div>
              <div className="space-y-0.5">
                {sections.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveSectionIdx(i)}
                    // Active section is the rail's nav selection — ink.
                    className={`w-full text-left text-[12.5px] px-2 py-1.5 rounded-md truncate transition-colors ${i === activeSectionIdx ? 'bg-ink-950 text-white font-medium' : 'text-ink-700 hover:bg-paper-100'}`}
                  >
                    {s.title || `Section ${i + 1}`}
                  </button>
                ))}
              </div>
            </div>

            {/* Variable definitions */}
            <VariableEditor variables={variables} onChange={setVariables} />
          </div>

          {/* Right panel: section editor */}
          <div className="flex-1 flex flex-col min-w-0 p-4">
            {sections[activeSectionIdx] && (
              <>
                <input
                  value={sections[activeSectionIdx].title}
                  onChange={e => setSections(s => s.map((sec, i) => i === activeSectionIdx ? { ...sec, title: e.target.value } : sec))}
                  className="text-section text-ink-950 border-0 border-b border-paper-200 pb-2 mb-3 w-full outline-none placeholder:text-ink-400 focus:border-brand-700"
                  placeholder="Section title..."
                />
                <div className="flex-1 min-h-0">
                  <ContractEditor
                    initialContent={sections[activeSectionIdx].content}
                    onChange={(html) => updateSectionContent(activeSectionIdx, html)}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Preview Modal ────────────────────────────────────────────────────────────

function PreviewModal({ templateId, onClose }: { templateId: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['template-preview', templateId],
    queryFn: () => api.post(`/templates/${templateId}/preview`).then(r => r.data),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-stretch bg-ink-950/40">
      <div className="m-auto w-full max-w-4xl h-[80vh] bg-card rounded-card flex flex-col overflow-hidden shadow-e3">
        <div className="flex items-center justify-between px-6 py-4 border-b border-paper-200">
          <h2 className="text-section text-ink-950">Template Preview (Sample Data)</h2>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700"><X className="size-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          {isLoading && <p className="text-dense text-ink-400">Loading preview...</p>}
          {data?.html && (
            <div
              className="prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(data.html) }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

type SortKey = 'updated' | 'used' | 'name'

export function TemplatesPage() {
  const qc = useQueryClient()
  const [showBuilder, setShowBuilder] = useState(false)
  const [editTemplate, setEditTemplate] = useState<Template | undefined>()
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [filterType, setFilterType] = useState('')
  const [filterPublished, setFilterPublished] = useState('')
  const [q, setQ] = useState('')
  // P7.4.11 / F-60 — client-side sort. Default to "Most used" so the
  // battle-tested templates float to the top (Notion-like template
  // gallery convention).
  const [sortBy, setSortBy] = useState<SortKey>('used')

  const { data, isLoading } = useQuery({
    queryKey: ['templates', filterType, filterPublished, q],
    queryFn: () =>
      api.get('/templates', {
        params: {
          ...(filterType && { contractType: filterType }),
          ...(filterPublished && { published: filterPublished }),
          ...(q && { q }),
        },
      }).then(r => r.data),
  })

  const createMutation = useMutation({
    mutationFn: (body: any) => {
      const { sections, ...templateData } = body
      return api.post('/templates', { ...templateData, sections })
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['templates'] }); setShowBuilder(false) },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) => {
      const { sections, ...templateData } = body
      return Promise.all([
        api.patch(`/templates/${id}`, templateData),
        api.put(`/templates/${id}/sections`, { sections }),
      ])
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['templates'] }); setShowBuilder(false); setEditTemplate(undefined) },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/templates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  })

  // Create a template from an existing .docx. The server converts it to HTML
  // and splits it on its heading outline; we then open the result in the
  // builder so the author reviews the conversion before publishing.
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData()
      form.append('file', file)
      // The shared api client defaults to application/json — multipart must be
      // set explicitly or the server can't parse the body (same as UploadModal).
      const r = await api.post('/templates/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return r.data as Template
    },
    onSuccess: (created) => {
      setUploadError(null)
      qc.invalidateQueries({ queryKey: ['templates'] })
      setEditTemplate(created)
      setShowBuilder(true)
    },
    onError: (err: unknown) => {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setUploadError(detail ?? 'Upload failed. Please try again.')
    },
  })

  const rawTemplates: Template[] = data?.data ?? []
  // Client-side sort — easier than threading a query param through
  // every cache key.
  const templates: Template[] = [...rawTemplates].sort((a, b) => {
    if (sortBy === 'used') {
      const au = (a as Template & { usageCount?: number }).usageCount ?? 0
      const bu = (b as Template & { usageCount?: number }).usageCount ?? 0
      if (au !== bu) return bu - au
      // tie-break on updatedAt
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    }
    if (sortBy === 'name') return a.name.localeCompare(b.name)
    // default 'updated'
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-paper-200 bg-card">
        <div>
          <h1 className="text-title text-ink-950">Templates</h1>
          <p className="text-dense text-ink-500">Contract templates for AI-powered drafting</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            data-testid="template-upload-input"
            onChange={e => {
              const file = e.target.files?.[0]
              // Reset first so picking the same file twice still fires onChange.
              e.target.value = ''
              if (file) { setUploadError(null); uploadMutation.mutate(file) }
            }}
          />
          <Button
            variant="outline"
            size="md"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadMutation.isPending}
            data-testid="upload-template-btn"
            title="Create a template from an existing .docx"
          >
            {uploadMutation.isPending
              ? <Loader2 className="animate-spin" />
              : <Upload />}
            {uploadMutation.isPending ? 'Converting…' : 'Upload .docx'}
          </Button>
          <Button
            size="md"
            onClick={() => { setEditTemplate(undefined); setShowBuilder(true) }}
            data-testid="new-template-btn"
          >
            <Plus />
            New Template
          </Button>
        </div>
      </div>

      {uploadError && (
        <div
          data-testid="template-upload-error"
          className="px-6 py-2 bg-risk-50 border-b border-risk-200 text-dense text-risk-700"
        >
          {uploadError}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-paper-200 bg-paper-50">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-ink-400" />
          <Input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search templates..."
            className="pl-8 w-52"
          />
        </div>
        <select
          value={filterType}
          onChange={e => setFilterType(e.target.value)}
          aria-label="Filter templates by contract type"
          className="h-8 text-[13px] text-ink-950 border border-input rounded-md px-2.5 outline-none bg-card"
        >
          <option value="">All Types</option>
          {CONTRACT_TYPES.map(t => <option key={t}>{t}</option>)}
        </select>
        <select
          value={filterPublished}
          onChange={e => setFilterPublished(e.target.value)}
          aria-label="Filter templates by publish status"
          className="h-8 text-[13px] text-ink-950 border border-input rounded-md px-2.5 outline-none bg-card"
        >
          <option value="">All Status</option>
          <option value="true">Published</option>
          <option value="false">Draft</option>
        </select>
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value as SortKey)}
          data-testid="template-sort"
          aria-label="Sort templates"
          className="h-8 text-[13px] text-ink-950 border border-input rounded-md px-2.5 outline-none bg-card"
        >
          <option value="used">Most used</option>
          <option value="updated">Recently updated</option>
          <option value="name">A → Z</option>
        </select>
        <span className="text-[11.5px] tabular-nums text-ink-400 ml-auto">{templates.length} templates</span>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading && (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="size-5 text-ink-400 animate-spin" />
          </div>
        )}
        {!isLoading && !templates.length && (
          <div className="flex flex-col items-center justify-center h-48 text-ink-400">
            <FileText className="size-6 mb-2" />
            <p className="text-dense">No templates yet. Create your first template.</p>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map(t => (
            <TemplateCard
              key={t.id}
              template={t}
              onEdit={() => { setEditTemplate(t); setShowBuilder(true) }}
              onDelete={() => deleteMutation.mutate(t.id)}
              onPreview={() => setPreviewId(t.id)}
            />
          ))}
        </div>
      </div>

      {/* Template Builder Modal */}
      {showBuilder && (
        <TemplateBuilderModal
          template={editTemplate}
          onClose={() => { setShowBuilder(false); setEditTemplate(undefined) }}
          onSave={(data) =>
            editTemplate
              ? updateMutation.mutateAsync({ id: editTemplate.id, body: data })
              : createMutation.mutateAsync(data)
          }
          onPreview={editTemplate ? () => setPreviewId(editTemplate.id) : undefined}
        />
      )}

      {/* Preview Modal */}
      {previewId && (
        <PreviewModal templateId={previewId} onClose={() => setPreviewId(null)} />
      )}
    </div>
  )
}
