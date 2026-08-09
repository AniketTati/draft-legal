/**
 * WorkflowBuilder — Phase 06
 * Visual builder for approval workflow step definitions.
 * Uses up/down buttons for ordering (no external drag-drop dependency).
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Plus, Trash2, ChevronUp, ChevronDown, User } from 'lucide-react'

export interface WorkflowStepDef {
  order:            number
  name:             string
  approverId?:      string
  roleRequired?:    string
  // Wave 3.8 — plural approvers for parallel steps (N run concurrently).
  approverIds?:     string[]
  roleRequireds?:   string[]
  executionMode:    'sequential' | 'parallel'
  requiredApprovals: number
  dueSoonHours:     number
  escalateTo?:      string
}

interface Props {
  steps:    WorkflowStepDef[]
  onChange: (steps: WorkflowStepDef[]) => void
}

const SYSTEM_ROLES = ['ADMIN', 'LEGAL_COUNSEL', 'LEGAL_OPS', 'CONTRACT_MANAGER', 'FINANCE', 'APPROVER']

function newStep(order: number): WorkflowStepDef {
  return { order, name: '', approverId: undefined, roleRequired: undefined, executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 48 }
}

export function WorkflowBuilder({ steps, onChange }: Props) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(0)

  const { data: usersData } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get('/users').then(r => r.data),
  })
  const users: Array<{ id: string; name: string; email: string }> = usersData?.data ?? usersData ?? []

  function update(idx: number, patch: Partial<WorkflowStepDef>) {
    const next = steps.map((s, i) => i === idx ? { ...s, ...patch } : s)
    onChange(next)
  }

  // Wave 3.8 — multi-approver toggles for parallel steps.
  function toggleApprover(idx: number, userId: string) {
    const cur = steps[idx].approverIds ?? []
    update(idx, { approverIds: cur.includes(userId) ? cur.filter(id => id !== userId) : [...cur, userId] })
  }
  function toggleRole(idx: number, role: string) {
    const cur = steps[idx].roleRequireds ?? []
    update(idx, { roleRequireds: cur.includes(role) ? cur.filter(r => r !== role) : [...cur, role] })
  }

  function addStep() {
    const next = [...steps, newStep(steps.length)]
    onChange(next)
    setExpandedIdx(next.length - 1)
  }

  function removeStep(idx: number) {
    const next = steps.filter((_, i) => i !== idx).map((s, i) => ({ ...s, order: i }))
    onChange(next)
    if (expandedIdx !== null && expandedIdx >= next.length) setExpandedIdx(next.length - 1)
  }

  function moveUp(idx: number) {
    if (idx === 0) return
    const next = [...steps]
    ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
    onChange(next.map((s, i) => ({ ...s, order: i })))
  }

  function moveDown(idx: number) {
    if (idx === steps.length - 1) return
    const next = [...steps]
    ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
    onChange(next.map((s, i) => ({ ...s, order: i })))
  }

  if (steps.length === 0) {
    return (
      <div className="text-center py-8 border-2 border-dashed rounded-card border-paper-200">
        <User className="size-6 text-ink-400 mx-auto mb-2" />
        <p className="text-body text-ink-500 mb-3">No approval steps yet</p>
        <Button size="sm" variant="outline" onClick={addStep}>
          <Plus />Add First Step
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {steps.map((step, idx) => (
        <div key={idx} className="border border-paper-200 rounded-card overflow-hidden">
          {/* Step header */}
          <div
            className="flex items-center gap-2 px-3 py-2 bg-paper-50 cursor-pointer hover:bg-paper-100 transition-colors"
            onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
          >
            {/* A step number is an ordinal, not a state — it stays neutral. */}
            <span className="flex-shrink-0 size-6 rounded-full bg-paper-100 text-ink-700 text-[11px] font-semibold tabular-nums flex items-center justify-center">
              {idx + 1}
            </span>
            <span className="flex-1 text-[13px] font-medium text-ink-950 truncate">
              {step.name || <span className="text-ink-400">Untitled step</span>}
            </span>
            {step.executionMode === 'parallel' ? (
              (() => {
                const n = (step.approverIds?.length ?? 0)
                const roles = step.roleRequireds ?? []
                const label = [
                  n > 0 ? `${n} approver${n === 1 ? '' : 's'}` : null,
                  roles.length > 0 ? roles.join(', ') : null,
                ].filter(Boolean).join(' + ')
                return label
                  ? <span className="text-[11.5px] text-ink-500 hidden sm:block">{`${label} · ${step.requiredApprovals} required`}</span>
                  : null
              })()
            ) : (
              <>
                {step.approverId && (
                  <span className="text-[11.5px] text-ink-500 hidden sm:block">
                    {users.find(u => u.id === step.approverId)?.name ?? step.approverId}
                  </span>
                )}
                {step.roleRequired && !step.approverId && (
                  <span className="text-[11.5px] text-ink-500 hidden sm:block">{step.roleRequired}</span>
                )}
              </>
            )}
            <div className="flex items-center gap-0.5 ml-2" onClick={e => e.stopPropagation()}>
              <button onClick={() => moveUp(idx)} disabled={idx === 0} className="p-0.5 rounded-chip hover:bg-paper-200 disabled:opacity-30">
                <ChevronUp className="size-4 text-ink-500" />
              </button>
              <button onClick={() => moveDown(idx)} disabled={idx === steps.length - 1} className="p-0.5 rounded-chip hover:bg-paper-200 disabled:opacity-30">
                <ChevronDown className="size-4 text-ink-500" />
              </button>
              {/* Removing a step throws work away — the one risk-coloured control here. */}
              <button onClick={() => removeStep(idx)} className="p-0.5 rounded-chip hover:bg-risk-50 ml-1">
                <Trash2 className="size-3.5 text-risk-600" />
              </button>
            </div>
          </div>

          {/* Step body (expanded) */}
          {expandedIdx === idx && (
            <div className="px-4 py-3 space-y-3 border-t border-paper-200 bg-card">
              {/* Step name */}
              <div>
                <label className="block text-dense font-medium text-ink-700 mb-1">Step name</label>
                <Input
                  value={step.name}
                  onChange={e => update(idx, { name: e.target.value })}
                  placeholder="e.g. Legal Review, Finance Approval"
                  className="text-[13px]"
                />
              </div>

              {/* Approver(s). Sequential → one user OR role. Parallel → pick
                  the full set of concurrent approvers (users and/or roles). */}
              {step.executionMode === 'sequential' ? (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-dense font-medium text-ink-700 mb-1">Specific approver</label>
                    <select
                      value={step.approverId ?? ''}
                      onChange={e => update(idx, { approverId: e.target.value || undefined, roleRequired: e.target.value ? undefined : step.roleRequired })}
                      className="w-full rounded-md border border-input text-[13px] text-ink-950 px-2.5 py-1.5 bg-card focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15"
                    >
                      <option value="">— None —</option>
                      {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-dense font-medium text-ink-700 mb-1">Or by role</label>
                    <select
                      value={step.roleRequired ?? ''}
                      onChange={e => update(idx, { roleRequired: e.target.value || undefined, approverId: e.target.value ? undefined : step.approverId })}
                      className="w-full rounded-md border border-input text-[13px] text-ink-950 px-2.5 py-1.5 bg-card focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15"
                      disabled={!!step.approverId}
                    >
                      <option value="">— None —</option>
                      {SYSTEM_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                </div>
              ) : (
                <div>
                  <label className="block text-dense font-medium text-ink-700 mb-1">
                    Approvers (all run concurrently — every user who holds a selected role is included)
                  </label>
                  <div className="max-h-40 overflow-y-auto rounded-md border border-input divide-y divide-paper-200">
                    {users.length === 0 && <div className="px-2.5 py-2 text-dense text-ink-400">No users found</div>}
                    {users.map(u => (
                      <label key={u.id} className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-ink-950 cursor-pointer hover:bg-paper-50">
                        <input
                          type="checkbox"
                          checked={(step.approverIds ?? []).includes(u.id)}
                          onChange={() => toggleApprover(idx, u.id)}
                          className="accent-ink-950"
                        />
                        {u.name}
                      </label>
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {SYSTEM_ROLES.map(r => {
                      const on = (step.roleRequireds ?? []).includes(r)
                      return (
                        <button
                          key={r}
                          type="button"
                          onClick={() => toggleRole(idx, r)}
                          className={`px-2 py-0.5 rounded-full text-[11.5px] border transition-colors ${on ? 'bg-ink-950 border-ink-950 text-white' : 'bg-card border-paper-300 text-ink-700 hover:bg-paper-50'}`}
                        >
                          {r}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Due hours + escalation */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-dense font-medium text-ink-700 mb-1">Due in (hours)</label>
                  <Input
                    type="number"
                    min={1}
                    value={step.dueSoonHours}
                    onChange={e => update(idx, { dueSoonHours: Math.max(1, parseInt(e.target.value) || 48) })}
                    className="text-[13px]"
                  />
                </div>
                <div>
                  <label className="block text-dense font-medium text-ink-700 mb-1">Escalate to (on timeout)</label>
                  <select
                    value={step.escalateTo ?? ''}
                    onChange={e => update(idx, { escalateTo: e.target.value || undefined })}
                    className="w-full rounded-md border border-input text-[13px] text-ink-950 px-2.5 py-1.5 bg-card focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15"
                  >
                    <option value="">— No escalation —</option>
                    {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </div>
              </div>

              {/* Execution mode */}
              <div>
                <label className="block text-dense font-medium text-ink-700 mb-1.5">Execution mode</label>
                <div className="flex gap-3">
                  {(['sequential', 'parallel'] as const).map(mode => (
                    <label key={mode} className="flex items-center gap-1.5 cursor-pointer text-[13px] text-ink-700">
                      <input
                        type="radio"
                        name={`mode-${idx}`}
                        value={mode}
                        checked={step.executionMode === mode}
                        onChange={() => update(idx, {
                          executionMode: mode,
                          // Seed the parallel set from a previously-chosen single
                          // approver so switching modes doesn't lose the pick.
                          ...(mode === 'parallel' && !(step.approverIds?.length) && step.approverId
                            ? { approverIds: [step.approverId] }
                            : {}),
                        })}
                        className="accent-ink-950"
                      />
                      {mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </label>
                  ))}
                  {step.executionMode === 'parallel' && (
                    <div className="flex items-center gap-1.5 ml-4">
                      <span className="text-[11.5px] text-ink-500">Required approvals:</span>
                      <Input
                        type="number"
                        min={1}
                        value={step.requiredApprovals}
                        onChange={e => {
                          const raw = Math.max(1, parseInt(e.target.value) || 1)
                          // Cap at the explicit approver count when no roles are
                          // used (roles resolve to an unknown user count at run
                          // time; the server clamps then). Prevents an
                          // unsatisfiable "5 of 3".
                          const explicit = (step.approverIds ?? []).length
                          const hasRoles = (step.roleRequireds ?? []).length > 0
                          const capped = (!hasRoles && explicit > 0) ? Math.min(raw, explicit) : raw
                          update(idx, { requiredApprovals: capped })
                        }}
                        className="w-16 text-[13px]"
                      />
                      <span className="text-[11.5px] tabular-nums text-ink-400">
                        of {step.approverIds?.length ?? 0}{(step.roleRequireds?.length ?? 0) > 0 ? ' + role members' : ''}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      ))}

      <Button size="sm" variant="outline" onClick={addStep} className="w-full mt-1">
        <Plus />Add Step
      </Button>
    </div>
  )
}
