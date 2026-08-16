/**
 * WorkflowDefinitionList — Phase 06
 * Table of org workflow definitions with Edit / Set Default / Delete actions.
 * Edit opens a Sheet with WorkflowBuilder.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { WorkflowBuilder, type WorkflowStepDef } from './WorkflowBuilder'
import { StatusPill } from '@/components/ui/status-pill'
import { Chip } from '@/components/ui/primitives'
import { Pencil, Star, Trash2, Loader2, Plus } from 'lucide-react'

interface WorkflowDef {
  id:          string
  name:        string
  description: string | null
  steps:       WorkflowStepDef[]
  isDefault:   boolean
  isActive:    boolean
  triggerRules: Record<string, unknown>
}

export function WorkflowDefinitionList() {
  const queryClient = useQueryClient()
  const [editingWorkflow, setEditingWorkflow] = useState<WorkflowDef | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftDesc, setDraftDesc] = useState('')
  const [draftSteps, setDraftSteps] = useState<WorkflowStepDef[]>([])
  const [draftIsDefault, setDraftIsDefault] = useState(false)
  const [showNew, setShowNew] = useState(false)

  const { data: workflows, isLoading } = useQuery<WorkflowDef[]>({
    queryKey: ['approval-workflows'],
    queryFn: () => api.get('/approvals/workflows').then(r => r.data),
  })

  const saveWorkflow = useMutation({
    mutationFn: (payload: { id?: string; name: string; description: string; steps: WorkflowStepDef[]; isDefault: boolean }) => {
      if (payload.id) {
        return api.patch(`/approvals/workflows/${payload.id}`, payload).then(r => r.data)
      }
      return api.post('/approvals/workflows', payload).then(r => r.data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['approval-workflows'] })
      setEditingWorkflow(null)
      setShowNew(false)
    },
  })

  const setDefault = useMutation({
    mutationFn: (id: string) => api.patch(`/approvals/workflows/${id}`, { isDefault: true }).then(r => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['approval-workflows'] }),
  })

  const deleteWorkflow = useMutation({
    mutationFn: (id: string) => api.delete(`/approvals/workflows/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['approval-workflows'] }),
  })

  function openEdit(wf: WorkflowDef) {
    setEditingWorkflow(wf)
    setDraftName(wf.name)
    setDraftDesc(wf.description ?? '')
    setDraftSteps(wf.steps ?? [])
    setDraftIsDefault(wf.isDefault)
    setShowNew(false)
  }

  function openNew() {
    setEditingWorkflow(null)
    setDraftName('')
    setDraftDesc('')
    setDraftSteps([])
    setDraftIsDefault(false)
    setShowNew(true)
  }

  function handleSave() {
    if (!draftName.trim() || draftSteps.length === 0) return
    saveWorkflow.mutate({
      id:          editingWorkflow?.id,
      name:        draftName,
      description: draftDesc,
      steps:       draftSteps,
      isDefault:   draftIsDefault,
    })
  }

  const sheetOpen = !!editingWorkflow || showNew

  return (
    <>
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-section text-ink-950">Workflow Definitions</h3>
        <Button size="sm" variant="outline" onClick={openNew}>
          <Plus />New Workflow
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-ink-400" /></div>
      ) : !workflows?.length ? (
        <div className="text-center py-12 border-2 border-dashed rounded-card border-paper-200">
          <p className="text-body text-ink-500 mb-3">No workflows yet. Create one to route approvals.</p>
          <Button size="sm" variant="outline" onClick={openNew}><Plus />Create Workflow</Button>
        </div>
      ) : (
        <div className="border border-paper-200 rounded-card overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="bg-paper-50 border-b border-paper-200">
              <tr>
                <th className="text-left px-4 py-2 text-eyebrow uppercase text-ink-500">Name</th>
                <th className="text-left px-4 py-2 text-eyebrow uppercase text-ink-500">Steps</th>
                <th className="text-left px-4 py-2 text-eyebrow uppercase text-ink-500">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-200">
              {workflows.map(wf => (
                <tr key={wf.id} className="hover:bg-paper-50 transition-colors">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink-950">{wf.name}</span>
                      {/* "Default" is a designation, not a state waiting on
                          anyone — it loses the amber and stays a plain chip. */}
                      {wf.isDefault && (
                        <Chip>
                          <Star className="size-3" />Default
                        </Chip>
                      )}
                    </div>
                    {wf.description && <p className="text-[11px] text-ink-400 mt-0.5 truncate max-w-xs">{wf.description}</p>}
                  </td>
                  <td className="px-4 py-2 text-ink-700 tabular-nums">
                    {Array.isArray(wf.steps) ? wf.steps.length : 0} step{(Array.isArray(wf.steps) ? wf.steps.length : 0) !== 1 ? 's' : ''}
                  </td>
                  <td className="px-4 py-2">
                    {/* A live workflow is the "healthy" end of binding: it is
                        actually routing decisions right now. */}
                    <StatusPill meaning={wf.isActive ? 'binding' : 'neutral'}>
                      {wf.isActive ? 'Active' : 'Inactive'}
                    </StatusPill>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(wf)} className="h-7 px-2">
                        <Pencil className="size-3.5" />
                      </Button>
                      {!wf.isDefault && (
                        <Button
                          size="sm" variant="ghost"
                          onClick={() => setDefault.mutate(wf.id)}
                          disabled={setDefault.isPending}
                          className="h-7 px-2"
                          title="Set as default"
                        >
                          <Star className="size-3.5" />
                        </Button>
                      )}
                      <Button
                        size="sm" variant="ghost"
                        onClick={() => { if (confirm(`Delete "${wf.name}"?`)) deleteWorkflow.mutate(wf.id) }}
                        className="h-7 px-2 text-risk-600 hover:bg-risk-50 hover:text-risk-700"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit / New slide-over panel */}
      {sheetOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-ink-950/30 z-40"
            onClick={() => { setEditingWorkflow(null); setShowNew(false) }}
          />
          {/* Panel */}
          <div className="fixed inset-y-0 right-0 w-full sm:max-w-lg bg-card shadow-e3 z-50 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-paper-200">
              <h2 className="text-section text-ink-950">
                {editingWorkflow ? 'Edit Workflow' : 'New Workflow'}
              </h2>
              <button
                onClick={() => { setEditingWorkflow(null); setShowNew(false) }}
                className="p-1 rounded-md hover:bg-paper-100 text-ink-500"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              <div>
                <label className="block text-dense font-medium text-ink-700 mb-1">Workflow name *</label>
                <Input value={draftName} onChange={e => setDraftName(e.target.value)} placeholder="e.g. Standard Contract Approval" />
              </div>
              <div>
                <label className="block text-dense font-medium text-ink-700 mb-1">Description</label>
                <Input value={draftDesc} onChange={e => setDraftDesc(e.target.value)} placeholder="Optional" />
              </div>
              <label className="flex items-center gap-2 cursor-pointer text-[13px] text-ink-700">
                <input
                  type="checkbox"
                  checked={draftIsDefault}
                  onChange={e => setDraftIsDefault(e.target.checked)}
                  className="size-4 accent-ink-950"
                />
                Set as default workflow
              </label>

              <div>
                <label className="block text-dense font-medium text-ink-700 mb-2">Approval steps *</label>
                <WorkflowBuilder steps={draftSteps} onChange={setDraftSteps} />
              </div>
            </div>

            <div className="flex gap-2 px-6 py-4 border-t border-paper-200 bg-paper-50">
              <Button
                onClick={handleSave}
                disabled={saveWorkflow.isPending || !draftName.trim() || draftSteps.length === 0}
              >
                {saveWorkflow.isPending && <Loader2 className="animate-spin" />}
                {editingWorkflow ? 'Save Changes' : 'Create Workflow'}
              </Button>
              <Button variant="outline" onClick={() => { setEditingWorkflow(null); setShowNew(false) }}>
                Cancel
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
