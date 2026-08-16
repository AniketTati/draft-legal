import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Plus, Trash2, GripVertical, Settings, Layers, Bell,
  Type, Hash, Calendar, ToggleLeft, List, ChevronDown,
  AlertCircle, Check, Loader2, Mail, AtSign, FileSignature,
  CheckCircle2, AlertTriangle, Clock,
} from 'lucide-react'
import { Eyebrow, EmptyState } from '@/components/ui/primitives'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'

// ─── Constants ────────────────────────────────────────────────────────────────

const FIELD_TYPES = [
  { value: 'text',        label: 'Text',        icon: Type },
  { value: 'number',      label: 'Number',      icon: Hash },
  { value: 'date',        label: 'Date',        icon: Calendar },
  { value: 'boolean',     label: 'Yes / No',    icon: ToggleLeft },
  { value: 'select',      label: 'Select',      icon: List },
  { value: 'multiselect', label: 'Multi-select',icon: List },
]

const CONTRACT_TYPES = ['', 'NDA', 'MSA', 'SOW', 'SLA', 'VENDOR_AGREEMENT', 'EMPLOYMENT', 'PARTNERSHIP', 'LICENSE', 'OTHER']

/*
 * The six field types used to own six hues — blue, purple, green, amber, orange,
 * pink — which spent most of the meaning palette on a data type. A field being a
 * date is not "binding" and a boolean is not "your turn". Type is a machine-side
 * label, so it reads as one mono neutral chip and the word does the work.
 */
const FIELD_TYPE_CHIP = 'bg-paper-100 text-ink-700 border-paper-200 font-mono'

type Tab = 'custom-fields' | 'general' | 'notifications'

// U.8.1 — typed user preferences. Loosely-typed to keep backend
// schema simple (Record<string, unknown> on the API), but the front
// end validates shape before reading.
interface NotificationPrefs {
  approvalRequested: boolean
  approvalDecided: boolean
  contractUpdated: boolean
  contractExpiringSoon: boolean
  mentioned: boolean
  digest: 'real-time' | 'daily' | 'off'
}
interface GeneralPrefs {
  currency: string  // ISO 4217 (USD, EUR, GBP, INR…)
  dateFormat: 'us' | 'iso' | 'eu' // MM/DD/YYYY · YYYY-MM-DD · DD/MM/YYYY
  timezone: string // IANA zone (e.g. "America/New_York")
}
const DEFAULT_NOTIFS: NotificationPrefs = {
  approvalRequested: true,
  approvalDecided: true,
  contractUpdated: false,
  contractExpiringSoon: true,
  mentioned: true,
  digest: 'real-time',
}
const DEFAULT_GENERAL: GeneralPrefs = {
  currency: 'USD',
  dateFormat: 'us',
  timezone: typeof Intl !== 'undefined' ? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') : 'UTC',
}
const CURRENCY_OPTIONS = ['USD', 'EUR', 'GBP', 'INR', 'JPY', 'CAD', 'AUD', 'SGD', 'CHF']
const DATE_FORMAT_OPTIONS: { value: GeneralPrefs['dateFormat']; label: string }[] = [
  { value: 'us',  label: 'MM/DD/YYYY (12/31/2026)' },
  { value: 'iso', label: 'YYYY-MM-DD (2026-12-31)' },
  { value: 'eu',  label: 'DD/MM/YYYY (31/12/2026)' },
]
const COMMON_TIMEZONES = [
  'UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney',
]

interface NewField {
  fieldKey: string
  fieldLabel: string
  fieldType: string
  contractType: string
  required: boolean
  helpText: string
  options: string[]
  optionInput: string
}

const EMPTY_FIELD: NewField = {
  fieldKey: '',
  fieldLabel: '',
  fieldType: 'text',
  contractType: '',
  required: false,
  helpText: '',
  options: [],
  optionInput: '',
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('custom-fields')
  const [showNewForm, setShowNewForm] = useState(false)
  const [newField, setNewField] = useState<NewField>({ ...EMPTY_FIELD })
  const [formError, setFormError] = useState('')
  const [filterType, setFilterType] = useState('')

  const qc = useQueryClient()

  const { data: defsData, isLoading } = useQuery({
    queryKey: ['field-definitions', filterType],
    queryFn: () => api.get('/field-definitions', {
      params: filterType ? { contractType: filterType } : undefined,
    }).then(r => r.data),
  })

  const createField = useMutation({
    mutationFn: (body: any) => api.post('/field-definitions', body).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['field-definitions'] })
      setShowNewForm(false)
      setNewField({ ...EMPTY_FIELD })
      setFormError('')
    },
    onError: (e: any) => {
      setFormError(e.response?.data?.detail ?? 'Failed to create field')
    },
  })

  /*
   * Deleting a field definition removes that column from every contract in the
   * org, and the stored values with it. It used to fire from a bare trash icon
   * on the first click, with no confirmation and no error path — the single
   * most destructive unguarded control in the admin surfaces. It now goes
   * through the shared confirm, gated on typing the field key, because there is
   * no undo on the other side.
   */
  const [pendingDeleteField, setPendingDeleteField] = useState<any | null>(null)
  const deleteField = useMutation({
    mutationFn: (id: string) => api.delete(`/field-definitions/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['field-definitions'] })
      setPendingDeleteField(null)
    },
  })

  const defs = defsData?.data ?? []

  const handleAutoKey = (label: string) => {
    if (!newField.fieldKey) {
      const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
      setNewField(f => ({ ...f, fieldKey: key }))
    }
  }

  const handleSubmit = () => {
    setFormError('')
    if (!newField.fieldLabel.trim()) return setFormError('Label is required')
    if (!newField.fieldKey.trim()) return setFormError('Field key is required')
    if (!/^[a-z][a-z0-9_]*$/.test(newField.fieldKey)) return setFormError('Key must be snake_case (e.g. payment_terms)')
    if ((newField.fieldType === 'select' || newField.fieldType === 'multiselect') && newField.options.length < 1) {
      return setFormError('Select fields require at least one option')
    }
    createField.mutate({
      fieldLabel: newField.fieldLabel,
      fieldKey: newField.fieldKey,
      fieldType: newField.fieldType,
      contractType: newField.contractType || null,
      required: newField.required,
      helpText: newField.helpText || undefined,
      options: newField.options,
    })
  }

  const addOption = () => {
    const opt = newField.optionInput.trim()
    if (!opt || newField.options.includes(opt)) return
    setNewField(f => ({ ...f, options: [...f.options, opt], optionInput: '' }))
  }

  return (
    <div className="h-full flex bg-paper-50">
      {/* Settings sidebar */}
      <aside className="w-52 border-r border-paper-200 bg-card flex-shrink-0 p-4">
        <Eyebrow className="mb-3">Settings</Eyebrow>
        <nav className="space-y-0.5">
          {[
            { id: 'custom-fields', icon: Layers, label: 'Custom Fields' },
            { id: 'general',       icon: Settings, label: 'General' },
            { id: 'notifications', icon: Bell, label: 'Notifications' },
          ].map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id as Tab)}
              // Selected is a state, not an action, so it stays quiet. The ink
              // fill is the app sidebar's alone — spending it again on an
              // in-page rail puts a second full-weight ink block on the surface
              // and it competes with the page's actual primary button.
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-dense transition-colors ${
                activeTab === id
                  ? 'bg-paper-100 text-ink-950 font-medium'
                  : 'text-ink-700 hover:bg-paper-100'
              }`}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <div className="flex-1 overflow-auto p-6">

        {/* ─── Custom Fields ─────────────────────────────────────────────── */}
        {activeTab === 'custom-fields' && (
          <div className="max-w-3xl space-y-6">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-title text-ink-950">Custom Fields</h1>
                <p className="text-dense text-ink-500 mt-1">
                  Define extra fields for your contracts. Values are stored on each contract and fully searchable.
                </p>
              </div>
              <Button onClick={() => setShowNewForm(true)} className="gap-2">
                <Plus className="size-4" /> Add Field
              </Button>
            </div>

            {/* Filter by type */}
            <div className="flex items-center gap-2">
              <span className="text-dense text-ink-500">Show fields for:</span>
              <div className="relative">
                <select
                  value={filterType}
                  onChange={e => setFilterType(e.target.value)}
                  aria-label="Filter fields by contract type"
                  className="appearance-none h-8 pl-3 pr-7 text-[13px] text-ink-950 bg-card border border-input rounded-md focus:outline-none focus:ring-[3px] focus:ring-brand-700/15 focus:border-brand-700"
                >
                  <option value="">All contract types</option>
                  {CONTRACT_TYPES.filter(Boolean).map(t => (
                    <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 size-3.5 text-ink-400 pointer-events-none" />
              </div>
            </div>

            {/* New field form */}
            {showNewForm && (
              // Border, not a colored wash: the open form is emphasised by being a
              // lifted surface, not by a hue that would have to mean something.
              <div className="bg-card rounded-card border border-paper-300 shadow-e1 p-5 space-y-4">
                <h3 className="text-section text-ink-950">New Custom Field</h3>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Field Label *</Label>
                    <Input
                      placeholder="e.g. Survival Period"
                      value={newField.fieldLabel}
                      onChange={e => {
                        setNewField(f => ({ ...f, fieldLabel: e.target.value }))
                        handleAutoKey(e.target.value)
                      }}
                    />
                  </div>
                  <div>
                    <Label className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Field Key * (snake_case)</Label>
                    <Input
                      placeholder="e.g. survival_period"
                      value={newField.fieldKey}
                      onChange={e => setNewField(f => ({ ...f, fieldKey: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') }))}
                      className="font-mono text-[13px]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Field Type *</Label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {FIELD_TYPES.map(({ value, label, icon: Icon }) => (
                        <button
                          key={value}
                          onClick={() => setNewField(f => ({ ...f, fieldType: value }))}
                          className={`flex flex-col items-center gap-1 p-2 rounded-md border text-dense transition-colors ${
                            newField.fieldType === value
                              ? 'border-ink-950 bg-paper-100 text-ink-950'
                              : 'border-paper-200 text-ink-700 hover:bg-paper-50'
                          }`}
                        >
                          <Icon className="size-3.5" />
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <Label className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Contract Type (optional)</Label>
                      <div className="relative">
                        <select
                          value={newField.contractType}
                          onChange={e => setNewField(f => ({ ...f, contractType: e.target.value }))}
                          aria-label="Contract type for new field"
                          className="w-full appearance-none h-8 pl-3 pr-7 text-[13px] text-ink-950 bg-card border border-input rounded-md focus:outline-none focus:ring-[3px] focus:ring-brand-700/15 focus:border-brand-700"
                        >
                          <option value="">All types (global)</option>
                          {CONTRACT_TYPES.filter(Boolean).map(t => (
                            <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
                          ))}
                        </select>
                        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 size-3.5 text-ink-400 pointer-events-none" />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="required"
                        checked={newField.required}
                        onChange={e => setNewField(f => ({ ...f, required: e.target.checked }))}
                        className="rounded-chip border-paper-300 accent-ink-950"
                      />
                      <label htmlFor="required" className="text-body text-ink-700">Required field</label>
                    </div>
                  </div>
                </div>

                {/* Options for select/multiselect */}
                {(newField.fieldType === 'select' || newField.fieldType === 'multiselect') && (
                  <div>
                    <Label className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Options *</Label>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {newField.options.map(opt => (
                        <span key={opt} className="inline-flex items-center gap-1 px-2.5 py-0.5 border border-paper-200 bg-paper-100 text-ink-950 rounded-full text-[11.5px]">
                          {opt}
                          <button onClick={() => setNewField(f => ({ ...f, options: f.options.filter(o => o !== opt) }))} className="text-ink-400 hover:text-ink-700">×</button>
                        </span>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Input
                        placeholder="Add an option…"
                        value={newField.optionInput}
                        onChange={e => setNewField(f => ({ ...f, optionInput: e.target.value }))}
                        onKeyDown={e => e.key === 'Enter' && addOption()}
                        className="flex-1"
                      />
                      <Button variant="outline" size="sm" onClick={addOption}>Add</Button>
                    </div>
                  </div>
                )}

                <div>
                  <Label className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Help Text (optional)</Label>
                  <Input
                    placeholder="Shown below the field in the contract form"
                    value={newField.helpText}
                    onChange={e => setNewField(f => ({ ...f, helpText: e.target.value }))}
                  />
                </div>

                {formError && (
                  <div className="flex items-center gap-2 p-3 bg-risk-50 border border-risk-200 rounded-md">
                    <AlertCircle className="size-4 text-risk-600 flex-shrink-0" />
                    <p className="text-dense text-risk-700">{formError}</p>
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-paper-200">
                  <Button variant="outline" onClick={() => { setShowNewForm(false); setNewField({ ...EMPTY_FIELD }); setFormError('') }}>
                    Cancel
                  </Button>
                  <Button onClick={handleSubmit} disabled={createField.isPending} className="gap-2">
                    {createField.isPending ? 'Saving…' : <><Check className="size-4" /> Save Field</>}
                  </Button>
                </div>
              </div>
            )}

            {/* Field list */}
            {isLoading ? (
              <div className="flex justify-center py-12">
                <div className="size-5 border-2 border-paper-300 border-t-ink-950 rounded-full animate-spin" />
              </div>
            ) : defs.length === 0 ? (
              <EmptyState
                icon={<Layers />}
                title="No custom fields yet"
                description={'Add fields like "Survival Period" or "Auto-Renewal Notice Days" to capture org-specific data'}
                action={
                  <Button onClick={() => setShowNewForm(true)} variant="outline" className="gap-2">
                    <Plus className="size-4" /> Add your first field
                  </Button>
                }
              />
            ) : (
              <div className="bg-card rounded-card border border-paper-200 divide-y divide-paper-200 overflow-hidden">
                {/* Group by contract type */}
                {Array.from(new Set(defs.map((d: any) => d.contractType ?? ''))).map(group => {
                  const groupDefs = defs.filter((d: any) => (d.contractType ?? '') === group)
                  return (
                    <div key={String(group)}>
                      <div className="px-5 py-2 bg-paper-50 border-b border-paper-200">
                        <Eyebrow>
                          {group ? String(group).replace(/_/g, ' ') : 'Global (all contract types)'}
                        </Eyebrow>
                      </div>
                      {groupDefs.map((def: any) => (
                        <div key={def.id} className="flex items-center gap-4 px-5 py-2 hover:bg-paper-50">
                          <GripVertical className="size-4 text-ink-400 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-body font-medium text-ink-950">{def.fieldLabel}</p>
                              {/* A required flag is a schema constraint, not legal
                                  exposure — red would have overstated it. */}
                              {def.required && (
                                <span className="text-[10px] font-bold text-ink-500 uppercase tracking-[0.08em]">Required</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="font-mono text-[11px] text-ink-400">{def.fieldKey}</span>
                              <span className={`inline-flex items-center px-1.5 py-0.5 rounded-chip border text-[10px] ${FIELD_TYPE_CHIP}`}>
                                {def.fieldType}
                              </span>
                              {def.options?.length > 0 && (
                                <span className="text-[11px] text-ink-400">{def.options.join(' · ')}</span>
                              )}
                            </div>
                            {def.helpText && (
                              <p className="text-dense text-ink-400 mt-0.5 italic">{def.helpText}</p>
                            )}
                          </div>
                          <button
                            onClick={() => setPendingDeleteField(def)}
                            aria-label={`Delete field ${def.fieldLabel}`}
                            title={`Delete field "${def.fieldLabel}"`}
                            data-testid={`delete-field-${def.id}`}
                            className="rounded-md p-2 text-ink-400 transition-colors hover:bg-risk-50 hover:text-risk-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ─── General ───────────────────────────────────────────────────── */}
        {activeTab === 'general' && <GeneralTab />}

        {/* ─── Notifications ─────────────────────────────────────────────── */}
        {activeTab === 'notifications' && <NotificationsTab />}
      </div>

      <ConfirmDialog
        open={pendingDeleteField != null}
        testId="delete-field-confirm"
        title="Delete this custom field?"
        confirmLabel={deleteField.isPending ? 'Deleting…' : 'Delete field'}
        isPending={deleteField.isPending}
        error={
          deleteField.isError
            ? ((deleteField.error as any)?.response?.data?.detail ?? 'Could not delete this field.')
            : null
        }
        requireTyped={pendingDeleteField?.fieldKey}
        requireTypedHint={
          <>
            Type the field key <span className="font-mono text-ink-700">{pendingDeleteField?.fieldKey}</span> to confirm
          </>
        }
        body={
          <>
            <span className="font-medium text-ink-950">{pendingDeleteField?.fieldLabel}</span> is
            removed from every contract in the organisation, along with the value
            stored on each one. Saved views, exports and reports that reference{' '}
            <span className="font-mono text-[11.5px] text-ink-500">{pendingDeleteField?.fieldKey}</span>{' '}
            stop returning it. This cannot be undone.
          </>
        }
        onConfirm={() => pendingDeleteField && deleteField.mutate(pendingDeleteField.id)}
        onCancel={() => {
          deleteField.reset()
          setPendingDeleteField(null)
        }}
      />
    </div>
  )
}

// ─── General tab ──────────────────────────────────────────────────────────────
//
// U.8.1 — replaces the "coming in Phase 10" stub with a real form.
// Profile fields (name) save via PATCH /users/me; org-level fields
// (currency / date format / timezone) are stored in user.preferences
// for now — they're per-user display preferences, not org-wide policy.
// The auth store is updated optimistically so the avatar pill in the
// header re-renders immediately.

function GeneralTab() {
  const { user, setUser } = useAuthStore()
  const qc = useQueryClient()

  const { data: me } = useQuery({
    queryKey: ['users-me'],
    queryFn: () => api.get('/users/me').then(r => r.data),
    staleTime: 30_000,
  })

  const initialPrefs: GeneralPrefs = {
    ...DEFAULT_GENERAL,
    ...(me?.preferences?.general ?? {}),
  }

  const [name, setName] = useState(user?.name ?? '')
  const [prefs, setPrefs] = useState<GeneralPrefs>(initialPrefs)
  const [savedFlash, setSavedFlash] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  // Sync state when /me loads or changes upstream.
  useEffect(() => {
    if (me?.name) setName(me.name)
    if (me?.preferences?.general) {
      setPrefs({ ...DEFAULT_GENERAL, ...me.preferences.general })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id])

  const save = useMutation({
    mutationFn: (patch: { name?: string; preferences?: Record<string, unknown> }) =>
      api.patch('/users/me', patch).then(r => r.data),
    onMutate: () => { setSavedFlash('saving'); setErrorMsg('') },
    onSuccess: (data) => {
      setSavedFlash('saved')
      qc.invalidateQueries({ queryKey: ['users-me'] })
      // Optimistically update authStore so the header chip + avatar refresh.
      if (user && data?.name) {
        setUser({ ...user, name: data.name })
      }
      setTimeout(() => setSavedFlash('idle'), 2000)
    },
    onError: (e: { response?: { data?: { detail?: string } } }) => {
      setSavedFlash('error')
      setErrorMsg(e?.response?.data?.detail ?? 'Could not save. Try again.')
    },
  })

  const onSaveProfile = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setErrorMsg('Name cannot be empty.')
      setSavedFlash('error')
      return
    }
    save.mutate({ name: trimmed })
  }

  const onPrefChange = (next: GeneralPrefs) => {
    setPrefs(next)
    // Merge with existing preferences server-side — we send only the
    // {general: ...} sub-tree so we don't clobber {notifications: ...}.
    save.mutate({
      preferences: { ...(me?.preferences ?? {}), general: next },
    })
  }

  const orgName = (me as { orgName?: string } | undefined)?.orgName
    ?? (user as unknown as { orgName?: string })?.orgName
    ?? null

  return (
    <div className="max-w-2xl space-y-6" data-testid="general-tab">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-title text-ink-950">General</h1>
          <p className="text-dense text-ink-500 mt-1">Your profile and display preferences.</p>
        </div>
        <SaveBadge state={savedFlash} />
      </div>

      {/* Profile */}
      <section className="bg-card rounded-card border border-paper-200 p-5 space-y-4" data-testid="general-profile">
        <h2 className="text-section text-ink-950">Profile</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Display name</Label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              data-testid="general-name-input"
              placeholder="Your name"
            />
            <p className="text-[11px] text-ink-400 mt-1">Shown on contracts you own and in the activity feed.</p>
          </div>
          <div>
            <Label className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Email</Label>
            <div
              className="flex h-8 items-center rounded-md border border-input bg-paper-50 px-3 text-[13px] text-ink-700 select-text"
              data-testid="general-email-readonly"
            >
              {user?.email ?? '—'}
            </div>
            <p className="text-[11px] text-ink-400 mt-1">Contact your admin to change.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Button onClick={onSaveProfile} disabled={save.isPending || name.trim() === (me?.name ?? user?.name ?? '')} data-testid="general-save-profile" size="sm">
            {save.isPending ? <><Loader2 className="size-3.5 animate-spin mr-1.5" /> Saving…</> : 'Save profile'}
          </Button>
          {errorMsg && <span className="text-[11.5px] text-risk-700">{errorMsg}</span>}
        </div>
      </section>

      {/* Workspace */}
      <section className="bg-card rounded-card border border-paper-200 p-5 space-y-4" data-testid="general-workspace">
        <h2 className="text-section text-ink-950">Workspace</h2>
        {orgName && (
          <div>
            <Label className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Organization</Label>
            <div className="flex h-8 items-center rounded-md border border-input bg-paper-50 px-3 text-[13px] text-ink-700 select-text">
              {orgName}
            </div>
          </div>
        )}
        <div className="grid grid-cols-3 gap-4">
          <div>
            <Label className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Default currency</Label>
            <select
              value={prefs.currency}
              onChange={e => onPrefChange({ ...prefs, currency: e.target.value })}
              data-testid="general-currency"
              className="w-full h-8 text-[13px] text-ink-950 border border-input bg-card rounded-md px-2 focus:outline-none focus:ring-[3px] focus:ring-brand-700/15 focus:border-brand-700"
            >
              {CURRENCY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Date format</Label>
            <select
              value={prefs.dateFormat}
              onChange={e => onPrefChange({ ...prefs, dateFormat: e.target.value as GeneralPrefs['dateFormat'] })}
              data-testid="general-date-format"
              className="w-full h-8 text-[13px] text-ink-950 border border-input bg-card rounded-md px-2 focus:outline-none focus:ring-[3px] focus:ring-brand-700/15 focus:border-brand-700"
            >
              {DATE_FORMAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Timezone</Label>
            <select
              value={prefs.timezone}
              onChange={e => onPrefChange({ ...prefs, timezone: e.target.value })}
              data-testid="general-timezone"
              className="w-full h-8 text-[13px] text-ink-950 border border-input bg-card rounded-md px-2 focus:outline-none focus:ring-[3px] focus:ring-brand-700/15 focus:border-brand-700"
            >
              {COMMON_TIMEZONES.map(z => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
              {!COMMON_TIMEZONES.includes(prefs.timezone) && (
                <option value={prefs.timezone}>{prefs.timezone.replace(/_/g, ' ')} (current)</option>
              )}
            </select>
          </div>
        </div>
        <p className="text-[11px] text-ink-400">Used for date display, currency formatting and digest delivery time.</p>
      </section>
    </div>
  )
}

// ─── Notifications tab ────────────────────────────────────────────────────────
//
// U.8.1 — toggles for each notification trigger + a digest cadence
// radio. Stored in user.preferences.notifications. Backend already
// reads/writes via PATCH /users/me; the actual delivery side
// (notification.worker.ts) reads these flags before sending.

function NotificationsTab() {
  const qc = useQueryClient()

  const { data: me } = useQuery({
    queryKey: ['users-me'],
    queryFn: () => api.get('/users/me').then(r => r.data),
    staleTime: 30_000,
  })

  const initial: NotificationPrefs = { ...DEFAULT_NOTIFS, ...(me?.preferences?.notifications ?? {}) }
  const [prefs, setPrefs] = useState<NotificationPrefs>(initial)
  const [savedFlash, setSavedFlash] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  useEffect(() => {
    if (me?.preferences?.notifications) {
      setPrefs({ ...DEFAULT_NOTIFS, ...me.preferences.notifications })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id])

  const save = useMutation({
    mutationFn: (next: NotificationPrefs) =>
      api.patch('/users/me', {
        preferences: { ...(me?.preferences ?? {}), notifications: next },
      }).then(r => r.data),
    onMutate: () => setSavedFlash('saving'),
    onSuccess: () => {
      setSavedFlash('saved')
      qc.invalidateQueries({ queryKey: ['users-me'] })
      setTimeout(() => setSavedFlash('idle'), 2000)
    },
    onError: () => setSavedFlash('error'),
  })

  const update = (patch: Partial<NotificationPrefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    save.mutate(next)
  }

  const triggers: { key: keyof NotificationPrefs; icon: typeof Bell; title: string; body: string }[] = [
    { key: 'approvalRequested',    icon: FileSignature,  title: 'Approval requested from me',          body: 'Get notified when a contract enters your approval queue.' },
    { key: 'approvalDecided',      icon: CheckCircle2,   title: 'My approval request gets a decision', body: 'Know the moment one of your contracts is approved or rejected.' },
    { key: 'contractUpdated',      icon: Mail,           title: 'A contract I own is updated',         body: 'Counterparty edits, version uploads, status changes.' },
    { key: 'contractExpiringSoon', icon: AlertTriangle,  title: 'A contract I own is expiring soon',   body: '90, 60, 30 days before expiry.' },
    { key: 'mentioned',            icon: AtSign,         title: 'Someone @mentions me in a comment',   body: 'Direct mentions in clause-scoped or contract-level comments.' },
  ]

  return (
    <div className="max-w-2xl space-y-6" data-testid="notifications-tab">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-title text-ink-950">Notifications</h1>
          <p className="text-dense text-ink-500 mt-1">Pick what reaches you and how often.</p>
        </div>
        <SaveBadge state={savedFlash} />
      </div>

      <section className="bg-card rounded-card border border-paper-200 divide-y divide-paper-200 overflow-hidden" data-testid="notifications-triggers">
        <div className="p-4 flex items-center justify-between">
          <h2 className="text-section text-ink-950">Email me when…</h2>
          <span className="text-[11px] text-ink-400">All toggles persist immediately</span>
        </div>
        {triggers.map(({ key, icon: Icon, title, body }) => (
          <label
            key={key}
            className="flex items-start gap-3 p-4 cursor-pointer hover:bg-paper-50 transition-colors"
            data-testid={`notif-${key}-row`}
          >
            <span className="size-9 rounded-md bg-paper-100 flex items-center justify-center flex-shrink-0">
              <Icon className="size-4 text-ink-500" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-body font-medium text-ink-950">{title}</p>
              <p className="text-dense text-ink-500 mt-0.5 leading-relaxed">{body}</p>
            </div>
            <input
              type="checkbox"
              checked={!!prefs[key]}
              onChange={e => update({ [key]: e.target.checked } as Partial<NotificationPrefs>)}
              data-testid={`notif-${key}-toggle`}
              className="mt-1 size-4 rounded-chip border-paper-300 accent-ink-950 focus:ring-[3px] focus:ring-brand-700/15"
            />
          </label>
        ))}
      </section>

      <section className="bg-card rounded-card border border-paper-200 p-4 space-y-3" data-testid="notifications-digest">
        <div className="flex items-center gap-2">
          <Clock className="size-4 text-ink-500" />
          <h2 className="text-section text-ink-950">Delivery cadence</h2>
        </div>
        <p className="text-dense text-ink-500">How often we should batch and send the notifications you've chosen.</p>
        <div className="grid grid-cols-3 gap-2">
          {[
            { value: 'real-time', label: 'Real-time',     hint: 'As things happen' },
            { value: 'daily',     label: 'Daily digest',  hint: 'One email at 9am' },
            { value: 'off',       label: 'Off',           hint: 'Pause email' },
          ].map(opt => (
            <button
              key={opt.value}
              onClick={() => update({ digest: opt.value as NotificationPrefs['digest'] })}
              data-testid={`notif-digest-${opt.value}`}
              aria-pressed={prefs.digest === opt.value}
              // Selection is an action — ink, not a colored wash.
              className={`p-3 rounded-md border text-left transition-colors ${
                prefs.digest === opt.value
                  ? 'border-ink-950 bg-paper-100'
                  : 'border-paper-200 hover:bg-paper-50'
              }`}
            >
              <p className={`text-body font-medium ${prefs.digest === opt.value ? 'text-ink-950' : 'text-ink-700'}`}>{opt.label}</p>
              <p className="text-[11px] text-ink-500 mt-0.5">{opt.hint}</p>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

// ─── Save badge (shared) ──────────────────────────────────────────────────────
function SaveBadge({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (state === 'idle') return null
  return (
    <span
      data-testid="settings-save-badge"
      data-state={state}
      /*
       * "Saved" stays neutral. Emerald is the binding color — approved, executed,
       * signed — and a preferences write is an acknowledgement, not a legal event.
       * Only the failure earns a meaning color here.
       */
      className={`inline-flex items-center gap-1.5 text-[11.5px] px-2 py-1 rounded-full ${
        state === 'saving' ? 'bg-paper-100 text-ink-500' :
        state === 'saved' ? 'bg-paper-100 text-ink-950 ring-1 ring-paper-200' :
        'bg-risk-50 text-risk-700 ring-1 ring-risk-200'
      }`}
    >
      {state === 'saving' ? <><Loader2 className="size-3 animate-spin" /> Saving…</> :
       state === 'saved'  ? <><Check className="size-3" /> Saved</> :
                            <><AlertCircle className="size-3" /> Could not save</>}
    </span>
  )
}
