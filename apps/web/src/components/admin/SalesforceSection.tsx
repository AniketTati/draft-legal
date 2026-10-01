/**
 * docs/41 Part 17 — the Salesforce tab of Settings → Integrations.
 *
 *   - Connect (production, sandbox or My Domain) / disconnect, and status.
 *   - Which contract types a rep may generate straight from Salesforce.
 *   - The field map: a Salesforce object's field ↔ a draftLegal field, its
 *     direction, and whether the launch form shows it read-only. Fields are
 *     picked from Salesforce's own describe once connected.
 *   - Changes Salesforce sent after a contract went out for signature,
 *     waiting on a decision.
 *   - The sync log, with a retry for a failed sync.
 */
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, Cloud, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusPill } from '@/components/ui/status-pill'
import { MEANING_CLASS } from '@/lib/status'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'

interface SalesforceStatus {
  connected: boolean
  status: string
  externalOrgId?: string | null
  instanceUrl?: string | null
  loginUrl?: string | null
  connectedAt?: string | null
  lastSyncAt?: string | null
  lastError?: string | null
  appConfigured: boolean
  callbackUrl: string | null
  selfServeTypes: string[]
}

interface Mapping {
  contractType: string | null
  externalObject: string
  externalField: string
  dlField: string
  direction: 'inbound' | 'outbound' | 'both'
  locked: boolean
}

interface Target { key: string; label: string; type: string; group: string }
interface SfObject { name: string; label: string }
interface SfField { name: string; label: string; type: string }

interface SyncRow {
  id: string
  direction: 'inbound' | 'outbound'
  object: string
  externalId: string | null
  contractId: string | null
  requestId: string | null
  event: string | null
  status: 'success' | 'failed' | 'skipped' | 'conflict' | 'queued'
  error: string | null
  attempt: number
  at: string
}

interface Conflict {
  id: string
  contractId: string
  contractTitle: string | null
  label: string
  externalObject: string
  externalField: string
  currentValue: unknown
  incomingValue: unknown
  createdAt: string
}

const DIRECTION_LABEL: Record<Mapping['direction'], string> = {
  inbound: 'From Salesforce',
  outbound: 'To Salesforce',
  both: 'Both ways',
}

const SYNC_MEANING = { success: 'binding', failed: 'risk', conflict: 'turn', skipped: 'neutral', queued: 'inflight' } as const
const SYNC_LABEL = { success: 'Synced', failed: 'Failed', conflict: 'Needs a decision', skipped: 'No change', queued: 'Queued' } as const

const errorText = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? fallback

const show = (v: unknown) => v === null || v === undefined ? 'empty' : typeof v === 'number' ? v.toLocaleString() : typeof v === 'object' ? JSON.stringify(v) : String(v)

function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : 'never'
}

export function SalesforceSection() {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [loginKind, setLoginKind] = useState<'production' | 'sandbox' | 'mydomain'>('production')
  const [myDomain, setMyDomain] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  // The OAuth callback lands back here with ?connected=1 or ?error=…
  const callbackError = params.get('error')
  const justConnected = params.get('connected') === '1'
  const clearCallback = () => {
    const next = new URLSearchParams(params)
    next.delete('error'); next.delete('connected')
    setParams(next, { replace: true })
  }

  const { data, isLoading } = useQuery<SalesforceStatus>({
    queryKey: ['salesforce-status'],
    queryFn: () => api.get('/admin/integrations/salesforce').then(r => r.data),
  })

  const connect = useMutation({
    mutationFn: async () => {
      const body = loginKind === 'sandbox' ? { sandbox: true } : loginKind === 'mydomain' ? { loginUrl: myDomain.trim() } : {}
      return api.post('/admin/integrations/salesforce/connect', body).then(r => r.data as { url: string })
    },
    onSuccess: ({ url }) => window.location.assign(url),
  })

  const disconnect = useMutation({
    mutationFn: async () => api.delete('/admin/integrations/salesforce'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['salesforce-status'] }),
  })

  if (isLoading) return <div className="py-12 flex items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-400" /></div>
  if (!data) return null

  return (
    <div className="max-w-4xl space-y-4" data-testid="salesforce-section">
      {callbackError && (
        <div className="flex items-start gap-2 text-dense text-risk-700 bg-risk-50 border border-risk-200 rounded-md px-3 py-2" data-testid="salesforce-callback-error">
          <AlertCircle className="size-4 shrink-0 mt-0.5" />
          <span className="flex-1">Salesforce wasn&apos;t connected: {callbackError}</span>
          <button onClick={clearCallback} aria-label="Dismiss"><X className="size-3.5" /></button>
        </div>
      )}
      {justConnected && data.connected && (
        <div className="flex items-center gap-2 text-dense text-ink-700 bg-paper-100 border border-paper-200 rounded-md px-3 py-2">
          <Check className="size-4 text-brand-700" />
          <span className="flex-1">Salesforce is connected. Map the fields below, then install the package in Salesforce.</span>
          <button onClick={clearCallback} aria-label="Dismiss"><X className="size-3.5" /></button>
        </div>
      )}

      {data.connected ? (
        <div className="bg-card border border-paper-200 rounded-card p-5" data-testid="salesforce-connected">
          <div className="flex items-center gap-2 mb-3">
            <span className={`size-1.5 rounded-full ${data.status === 'error' ? MEANING_CLASS.risk.dot : MEANING_CLASS.binding.dot}`} />
            <h2 className="text-section text-ink-950 flex-1">{data.status === 'error' ? 'Salesforce needs reconnecting' : 'Salesforce connected'}</h2>
            <SyncNowButton />
          </div>
          {data.lastError && (
            <p className="text-dense text-risk-700 bg-risk-50 border border-risk-200 rounded-md px-3 py-2 mb-3">{data.lastError}</p>
          )}
          <dl className="text-body space-y-2">
            <div className="flex justify-between"><dt className="text-ink-500">Salesforce org</dt><dd className="font-mono text-[11px] text-ink-950">{data.externalOrgId}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-500">Instance</dt><dd className="font-mono text-[11px] text-ink-950">{data.instanceUrl}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-500">Connected</dt><dd className="text-[11px] tabular-nums text-ink-700">{when(data.connectedAt)}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-500">Last sync</dt><dd className="text-[11px] tabular-nums text-ink-700">{when(data.lastSyncAt)}</dd></div>
          </dl>
          <div className="mt-4 flex justify-between items-center">
            <p className="text-dense text-ink-500">Contracts update their Salesforce record within a minute of each change.</p>
            <button
              onClick={() => setConfirmDisconnect(true)}
              data-testid="salesforce-disconnect"
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-dense text-risk-700 hover:bg-risk-50 hover:text-risk-600"
            >
              <Trash2 className="size-3.5" /> Disconnect
            </button>
          </div>
          <ConfirmDialog
            open={confirmDisconnect}
            testId="salesforce-disconnect-confirm"
            title="Disconnect Salesforce?"
            confirmLabel={disconnect.isPending ? 'Disconnecting…' : 'Disconnect Salesforce'}
            isPending={disconnect.isPending}
            error={disconnect.isError ? 'Could not disconnect. Try again.' : null}
            body={<>Contracts stop updating in Salesforce, and reps can no longer start requests from it. The access we hold is revoked and deleted. Your field map and sync history stay.</>}
            onConfirm={() => disconnect.mutate(undefined, { onSuccess: () => setConfirmDisconnect(false) })}
            onCancel={() => { disconnect.reset(); setConfirmDisconnect(false) }}
          />
        </div>
      ) : (
        <div className="bg-card border border-paper-200 rounded-card p-5" data-testid="salesforce-connect">
          <div className="flex items-center gap-2 mb-1">
            <Cloud className="size-4 text-ink-700" />
            <h2 className="text-section text-ink-950">Connect Salesforce</h2>
          </div>
          <p className="text-dense text-ink-500 mb-3">
            Sign in as your Salesforce integration user. Contracts then show their stage, whose turn it is and the signed PDF on
            the deal, and reps start contract requests from an Opportunity.
          </p>
          {!data.appConfigured ? (
            <p className="text-[11px] text-attention-700 bg-attention-50 border border-attention-200 rounded-md px-2.5 py-1.5">
              This server has no Salesforce app yet. Your operator sets SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET
              (see integrations/salesforce/README.md).
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-3 text-body">
                {(['production', 'sandbox', 'mydomain'] as const).map(k => (
                  <label key={k} className="inline-flex items-center gap-1.5 text-ink-700">
                    <input type="radio" name="sf-login" checked={loginKind === k} onChange={() => setLoginKind(k)} data-testid={`salesforce-login-${k}`} />
                    {k === 'production' ? 'Production' : k === 'sandbox' ? 'Sandbox' : 'My Domain'}
                  </label>
                ))}
              </div>
              {loginKind === 'mydomain' && (
                <Input value={myDomain} onChange={e => setMyDomain(e.target.value)} placeholder="https://yourcompany.my.salesforce.com" data-testid="salesforce-mydomain" />
              )}
              {connect.isError && <p className="text-dense text-risk-700">{errorText(connect.error, 'Could not start the Salesforce sign-in.')}</p>}
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-ink-400">Callback URL for the connected app: <span className="font-mono">{data.callbackUrl}</span></p>
                <Button onClick={() => connect.mutate()} disabled={connect.isPending || (loginKind === 'mydomain' && !myDomain.trim())} data-testid="salesforce-connect-button">
                  {connect.isPending ? <><Loader2 className="size-4 animate-spin" /> Opening Salesforce…</> : 'Connect Salesforce'}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {data.connected && <SelfServeTypes types={data.selfServeTypes} />}
      <MappingEditor connected={data.connected} />
      {data.connected && <Conflicts />}
      {data.connected && <SyncLog />}
    </div>
  )
}

function SyncNowButton() {
  const sync = useMutation({ mutationFn: async () => api.post('/admin/integrations/salesforce/sync-now') })
  return (
    <Button size="xs" variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending} data-testid="salesforce-sync-now">
      <RefreshCw className={sync.isPending ? 'animate-spin' : ''} /> {sync.isSuccess ? 'Sync queued' : 'Sync all now'}
    </Button>
  )
}

function SelfServeTypes({ types }: { types: string[] }) {
  const qc = useQueryClient()
  const [value, setValue] = useState(types.join(', '))
  useEffect(() => setValue(types.join(', ')), [types])
  const save = useMutation({
    mutationFn: async () => api.patch('/admin/integrations/salesforce/settings', {
      selfServeTypes: value.split(',').map(t => t.trim().toUpperCase()).filter(Boolean),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['salesforce-status'] }),
  })
  return (
    <div className="bg-card border border-paper-200 rounded-card p-5">
      <h2 className="text-section text-ink-950 mb-1">Generate straight from Salesforce</h2>
      <p className="text-dense text-ink-500 mb-3">
        Reps can draft these contract types at once, on your standard template. Every other type goes to Legal as a request.
      </p>
      <div className="flex gap-2">
        <Input value={value} onChange={e => setValue(e.target.value)} placeholder="NDA" data-testid="salesforce-self-serve" />
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>{save.isSuccess ? 'Saved' : 'Save'}</Button>
      </div>
    </div>
  )
}

// ─── Field map ─────────────────────────────────────────────────────────────

const EMPTY_ROW: Mapping = { contractType: null, externalObject: 'Opportunity', externalField: '', dlField: '', direction: 'inbound', locked: false }

function MappingEditor({ connected }: { connected: boolean }) {
  const qc = useQueryClient()
  const { data: saved } = useQuery<{ data: Mapping[] }>({
    queryKey: ['salesforce-mappings'],
    queryFn: () => api.get('/admin/integrations/salesforce/mappings').then(r => r.data),
  })
  const { data: targets } = useQuery<{ data: Target[] }>({
    queryKey: ['salesforce-targets'],
    queryFn: () => api.get('/admin/integrations/salesforce/targets').then(r => r.data),
  })
  const { data: objects } = useQuery<{ data: SfObject[] }>({
    queryKey: ['salesforce-objects'],
    queryFn: () => api.get('/admin/integrations/salesforce/objects').then(r => r.data),
    enabled: connected,
    retry: false,
  })
  const [rows, setRows] = useState<Mapping[] | null>(null)
  useEffect(() => {
    if (saved && rows === null) setRows(saved.data.map(m => ({ ...m, locked: !!m.locked })))
  }, [saved, rows])

  const save = useMutation({
    mutationFn: async () => api.put('/admin/integrations/salesforce/mappings', {
      mappings: (rows ?? []).filter(r => r.externalField && r.dlField).map(r => ({ ...r, contractType: r.contractType?.trim() || null })),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['salesforce-mappings'] }),
  })

  const update = (i: number, patch: Partial<Mapping>) => setRows(rs => (rs ?? []).map((r, j) => j === i ? { ...r, ...patch } : r))

  return (
    <div className="bg-card border border-paper-200 rounded-card p-5" data-testid="salesforce-mapping">
      <h2 className="text-section text-ink-950 mb-1">Field map</h2>
      <p className="text-dense text-ink-500 mb-3">
        Which Salesforce field fills which contract field. Salesforce owns a field mapped “From Salesforce” until the contract goes out
        for signature; after that, a change in Salesforce waits for someone to accept it here instead of changing the contract.
      </p>
      {rows === null ? (
        <Loader2 className="size-4 animate-spin text-ink-400" />
      ) : (
        <>
          {rows.length > 0 && <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-500">
                <tr>
                  <th className="text-left py-1.5 pr-2 font-semibold">Contract type</th>
                  <th className="text-left py-1.5 pr-2 font-semibold">Salesforce object</th>
                  <th className="text-left py-1.5 pr-2 font-semibold">Salesforce field</th>
                  <th className="text-left py-1.5 pr-2 font-semibold">draftLegal field</th>
                  <th className="text-left py-1.5 pr-2 font-semibold">Direction</th>
                  <th className="text-left py-1.5 pr-2 font-semibold whitespace-nowrap" title="Shown read-only on the Salesforce form">Read-only</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-paper-200">
                {rows.map((r, i) => (
                  <MappingRow key={i} row={r} objects={objects?.data ?? null} targets={targets?.data ?? []} connected={connected}
                    onChange={patch => update(i, patch)} onRemove={() => setRows(rs => (rs ?? []).filter((_, j) => j !== i))} />
                ))}
              </tbody>
            </table>
          </div>}
          {rows.length === 0 && <p className="text-dense text-ink-400 py-3">No fields mapped yet. Opportunity Amount → Contract value is a good first one.</p>}
          {save.isError && <p className="text-dense text-risk-700 mt-2">{errorText(save.error, 'Could not save the field map.')}</p>}
          <div className="flex justify-between mt-3">
            <Button size="sm" variant="outline" onClick={() => setRows(rs => [...(rs ?? []), { ...EMPTY_ROW }])} data-testid="salesforce-mapping-add"><Plus /> Add field</Button>
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending} data-testid="salesforce-mapping-save">
              {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved' : 'Save field map'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function MappingRow({ row, objects, targets, connected, onChange, onRemove }: {
  row: Mapping
  objects: SfObject[] | null
  targets: Target[]
  connected: boolean
  onChange: (patch: Partial<Mapping>) => void
  onRemove: () => void
}) {
  const { data: fields } = useQuery<{ data: SfField[] }>({
    queryKey: ['salesforce-fields', row.externalObject],
    queryFn: () => api.get(`/admin/integrations/salesforce/objects/${encodeURIComponent(row.externalObject)}/fields`).then(r => r.data),
    enabled: connected && /^[A-Za-z][A-Za-z0-9_]*$/.test(row.externalObject),
    retry: false,
    staleTime: 5 * 60_000,
  })
  const isVariable = row.dlField.startsWith('var:')
  const grouped = useMemo(() => {
    const by = new Map<string, Target[]>()
    for (const t of targets) by.set(t.group, [...(by.get(t.group) ?? []), t])
    return [...by.entries()]
  }, [targets])
  const cell = 'py-1.5 pr-2 align-top'
  const select = 'h-8 w-full min-w-[9rem] rounded-md border border-input bg-card px-2 text-[12.5px] text-ink-950'

  return (
    <tr>
      <td className={cell}>
        <Input value={row.contractType ?? ''} onChange={e => onChange({ contractType: e.target.value || null })} placeholder="All types" className="h-8 w-28" />
      </td>
      <td className={cell}>
        {objects ? (
          <select className={select} value={row.externalObject} onChange={e => onChange({ externalObject: e.target.value, externalField: '' })}>
            {!objects.some(o => o.name === row.externalObject) && <option value={row.externalObject}>{row.externalObject}</option>}
            {objects.map(o => <option key={o.name} value={o.name}>{o.label}</option>)}
          </select>
        ) : (
          <Input value={row.externalObject} onChange={e => onChange({ externalObject: e.target.value })} className="h-8 w-36" />
        )}
      </td>
      <td className={cell}>
        {fields ? (
          <select className={select} value={row.externalField} onChange={e => onChange({ externalField: e.target.value })}>
            <option value="">Choose…</option>
            {row.externalField && !fields.data.some(f => f.name === row.externalField) && <option value={row.externalField}>{row.externalField}</option>}
            {fields.data.map(f => <option key={f.name} value={f.name}>{f.label} ({f.type})</option>)}
          </select>
        ) : (
          <Input value={row.externalField} onChange={e => onChange({ externalField: e.target.value })} placeholder="Amount" className="h-8 w-36" />
        )}
      </td>
      <td className={cell}>
        <select className={select} value={isVariable ? '__var' : row.dlField} onChange={e => onChange({ dlField: e.target.value === '__var' ? 'var:' : e.target.value })}>
          <option value="">Choose…</option>
          {grouped.map(([group, ts]) => (
            <optgroup key={group} label={group === 'request' ? 'Request' : group[0].toUpperCase() + group.slice(1)}>
              {ts.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
            </optgroup>
          ))}
          <option value="__var">A template variable…</option>
        </select>
        {isVariable && (
          <Input value={row.dlField.slice(4)} onChange={e => onChange({ dlField: `var:${e.target.value}` })} placeholder="variable_name" className="h-8 mt-1" />
        )}
      </td>
      <td className={cell}>
        <select className={select} value={row.direction} onChange={e => onChange({ direction: e.target.value as Mapping['direction'] })}>
          {(Object.keys(DIRECTION_LABEL) as Mapping['direction'][]).map(d => <option key={d} value={d}>{DIRECTION_LABEL[d]}</option>)}
        </select>
      </td>
      <td className={`${cell} text-center`}>
        <input type="checkbox" checked={row.locked} onChange={e => onChange({ locked: e.target.checked })} aria-label="Read-only on the Salesforce form" />
      </td>
      <td className={cell}>
        <button onClick={onRemove} className="p-1 text-ink-400 hover:text-risk-700" aria-label="Remove field"><Trash2 className="size-3.5" /></button>
      </td>
    </tr>
  )
}

// ─── Conflicts and the sync log ────────────────────────────────────────────

function Conflicts() {
  const qc = useQueryClient()
  const { data } = useQuery<{ data: Conflict[] }>({
    queryKey: ['salesforce-conflicts'],
    queryFn: () => api.get('/admin/integrations/salesforce/conflicts').then(r => r.data),
  })
  const resolve = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'apply' | 'dismiss' }) => api.post(`/admin/integrations/salesforce/conflicts/${id}/resolve`, { action }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['salesforce-conflicts'] }),
  })
  const items = data?.data ?? []
  if (!items.length) return null
  return (
    <div className="bg-card border border-paper-200 rounded-card p-5" data-testid="salesforce-conflicts">
      <h2 className="text-section text-ink-950 mb-1">Salesforce changes waiting on you</h2>
      <p className="text-dense text-ink-500 mb-3">These contracts were out for signature or signed when the deal changed in Salesforce, so the contract was left as it is.</p>
      <ul className="divide-y divide-paper-200">
        {items.map(k => (
          <li key={k.id} className="py-2 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <a href={`/contracts/${k.contractId}`} className="text-body font-medium text-ink-950 hover:underline truncate block">{k.contractTitle ?? 'Contract'}</a>
              <p className="text-dense text-ink-700">{k.label}: {show(k.currentValue)} → {show(k.incomingValue)} <span className="text-ink-400">({k.externalObject}.{k.externalField})</span></p>
            </div>
            <Button size="xs" onClick={() => resolve.mutate({ id: k.id, action: 'apply' })} disabled={resolve.isPending}>Update contract</Button>
            <Button size="xs" variant="ghost" onClick={() => resolve.mutate({ id: k.id, action: 'dismiss' })} disabled={resolve.isPending}>Keep contract</Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SyncLog() {
  const qc = useQueryClient()
  const [failedOnly, setFailedOnly] = useState(false)
  const { data } = useQuery<{ data: SyncRow[] }>({
    queryKey: ['salesforce-sync-log', failedOnly],
    queryFn: () => api.get('/admin/integrations/salesforce/sync-log', { params: { limit: 50, ...(failedOnly ? { status: 'failed' } : {}) } }).then(r => r.data),
    refetchInterval: 30_000,
  })
  const retry = useMutation({
    mutationFn: async (id: string) => api.post(`/admin/integrations/salesforce/sync-log/${id}/retry`),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ['salesforce-sync-log'] }), 8000),
  })
  const rows = data?.data ?? []
  return (
    <div className="bg-card border border-paper-200 rounded-card overflow-hidden" data-testid="salesforce-sync-log">
      <div className="flex items-center justify-between px-5 py-3 border-b border-paper-200">
        <h2 className="text-section text-ink-950">Sync log</h2>
        <label className="inline-flex items-center gap-1.5 text-dense text-ink-700">
          <input type="checkbox" checked={failedOnly} onChange={e => setFailedOnly(e.target.checked)} /> Failed only
        </label>
      </div>
      {rows.length === 0 ? (
        <p className="text-dense text-ink-400 px-5 py-6 text-center">Nothing synced yet.</p>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead className="bg-paper-50 text-[11px] uppercase tracking-[0.08em] text-ink-500">
            <tr>
              <th className="text-left px-4 py-2 font-semibold">When</th>
              <th className="text-left px-4 py-2 font-semibold">What</th>
              <th className="text-left px-4 py-2 font-semibold">Result</th>
              <th className="text-left px-4 py-2 font-semibold">Detail</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-paper-200">
            {rows.map(r => (
              <tr key={r.id} data-testid={`salesforce-sync-${r.id}`}>
                <td className="px-4 py-2 text-[11px] tabular-nums text-ink-700 whitespace-nowrap">{new Date(r.at).toLocaleString()}</td>
                <td className="px-4 py-2 text-ink-950">
                  {r.direction === 'outbound' ? 'To Salesforce' : 'From Salesforce'} · {r.object}
                  {r.contractId && <a href={`/contracts/${r.contractId}`} className="block text-[11px] text-ink-500 hover:underline">Open contract</a>}
                </td>
                <td className="px-4 py-2">
                  <StatusPill meaning={SYNC_MEANING[r.status]}>{SYNC_LABEL[r.status]}</StatusPill>
                  {r.attempt > 1 && <div className="text-[10.5px] text-ink-400 mt-0.5">attempt {r.attempt}</div>}
                </td>
                <td className="px-4 py-2 text-[11px] text-ink-700 max-w-[320px]"><span className="line-clamp-2" title={r.error ?? undefined}>{r.error ?? '—'}</span></td>
                <td className="px-4 py-2 text-right">
                  {r.status === 'failed' && r.direction === 'outbound' && r.contractId && (
                    <button onClick={() => retry.mutate(r.id)} disabled={retry.isPending} className="text-dense text-ink-950 hover:text-ink-700 inline-flex items-center gap-1 disabled:opacity-50" data-testid={`salesforce-retry-${r.id}`}>
                      <RefreshCw className="size-3.5" /> Retry
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
