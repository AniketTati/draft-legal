/**
 * AdminIntegrationsPage — Phase 10A — manage API keys + webhooks.
 *
 * Three tabs:
 *   1. API Keys — create / list / revoke (full key shown ONCE on create)
 *   2. Webhooks — create / list / edit / test / delete + delivery log
 *   3. Health  — per-webhook health state, 24h/7d delivery aggregates,
 *               last error + one-click retry (Phase 10)
 *
 * Lives at /admin/integrations.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { usePermission } from '@/lib/permissions'
import {
  Plug, Plus, Loader2, Copy, Check, Trash2, X, Send, AlertCircle, Lock,
  Key, Webhook as WebhookIcon, ChevronRight, ChevronDown,
  Activity, RefreshCw, MessageSquare,
} from 'lucide-react'
import { StatusPill } from '@/components/ui/status-pill'
import { MEANING_CLASS, type Meaning } from '@/lib/status'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'

interface ApiKey {
  id:         string
  name:       string
  prefix:     string
  scopes:     string[]
  lastUsedAt: string | null
  expiresAt:  string | null
  revokedAt:  string | null
  createdAt:  string
}

interface Webhook {
  id:                 string
  name:               string
  url:                string
  events:             string[]
  enabled:            boolean
  type:               'generic' | 'slack' | 'teams'
  lastDeliveryAt:     string | null
  lastDeliveryStatus: string | null
  failureCount:       number
  createdAt:          string
  secret:             string
}

interface Delivery {
  id:             string
  event:          string
  attempts:       number
  succeeded:      boolean
  responseStatus: number | null
  errorMessage:   string | null
  createdAt:      string
  deliveredAt:    string | null
}

type Tab = 'keys' | 'webhooks' | 'slack' | 'health'

export function AdminIntegrationsPage() {
  const [tab, setTab] = useState<Tab>('keys')
  // P14 audit (2026-04-29). Without this gate, non-admin users hitting
  // /admin/integrations triggered a 403 GET /api/v1/admin/integrations/
  // api-keys flood that surfaced in the rail console + felt broken.
  // Render a clean access-denied state instead — the route is reachable
  // by URL even though the sidebar hides the nav item for non-admins.
  const canConfigureIntegrations = usePermission('configure', 'integration')

  if (!canConfigureIntegrations) {
    return (
      <div className="px-6 py-6 max-w-2xl mx-auto" data-testid="admin-integrations-page">
        <div className="flex items-center gap-3 mb-2">
          <Plug className="size-5 text-ink-700" />
          <h1 className="text-title text-ink-950">Integrations</h1>
        </div>
        <div className="mt-6 flex items-start gap-3 rounded-card border border-paper-200 bg-paper-50 p-4 text-body text-ink-700">
          <Lock className="size-4 text-ink-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-semibold text-ink-950">Admin access required</p>
            <p className="text-ink-500 mt-1">
              Integrations (API keys, webhooks) are managed by your organization
              admin. Contact your admin to enable an API key or webhook for your team.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="px-6 py-6 max-w-6xl mx-auto" data-testid="admin-integrations-page">
      <div className="flex items-center gap-3 mb-1">
        {/* Indigo belongs to the machine; an integrations page is plain chrome. */}
        <Plug className="size-5 text-ink-700" />
        <h1 className="text-title text-ink-950">Integrations</h1>
      </div>
      <p className="text-dense text-ink-500 mb-5">
        API keys for external systems to call CLM, and webhooks for CLM to push events to you.
      </p>

      <div className="flex items-center gap-1 mb-5 border-b border-paper-200">
        <TabButton active={tab === 'keys'} onClick={() => setTab('keys')} testId="tab-api-keys">
          <Key className="size-4" /> API Keys
        </TabButton>
        <TabButton active={tab === 'webhooks'} onClick={() => setTab('webhooks')} testId="tab-webhooks">
          <WebhookIcon className="size-4" /> Webhooks
        </TabButton>
        <TabButton active={tab === 'slack'} onClick={() => setTab('slack')} testId="tab-slack">
          <MessageSquare className="size-4" /> Slack
        </TabButton>
        <TabButton active={tab === 'health'} onClick={() => setTab('health')} testId="tab-health">
          <Activity className="size-4" /> Health
        </TabButton>
      </div>

      {tab === 'keys' ? <ApiKeysSection />
        : tab === 'webhooks' ? <WebhooksSection />
        : tab === 'slack' ? <SlackSection />
        : <HealthSection />}
    </div>
  )
}

function TabButton({ active, onClick, children, testId }: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  testId: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      // A selected tab is an action, not a state — ink, never info.
      className={`px-4 py-2 text-dense border-b-2 transition-colors flex items-center gap-2 -mb-px ${
        active
          ? 'border-ink-950 text-ink-950 font-semibold'
          : 'border-transparent text-ink-500 hover:text-ink-950'
      }`}
    >
      {children}
    </button>
  )
}

// ─── API Keys ────────────────────────────────────────────────────────

function ApiKeysSection() {
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [revealKey, setRevealKey] = useState<{ id: string; key: string } | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<ApiKey | null>(null)

  const { data, isLoading } = useQuery<{ data: ApiKey[] }>({
    queryKey: ['api-keys'],
    queryFn:  () => api.get('/admin/integrations/api-keys').then(r => r.data),
  })

  const revoke = useMutation({
    mutationFn: async (id: string) => api.delete(`/admin/integrations/api-keys/${id}`),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['api-keys'] })
      setPendingRevoke(null)
    },
  })

  if (isLoading) return <div className="py-12 flex items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-400" /></div>

  const keys = data?.data ?? []

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-body font-medium text-ink-700 tabular-nums">{keys.length} {keys.length === 1 ? 'key' : 'keys'}</h2>
        <Button onClick={() => setCreateOpen(true)} data-testid="create-key-btn" className="gap-1.5">
          <Plus className="size-4" />
          New API key
        </Button>
      </div>

      {keys.length === 0 ? (
        <div className="text-center py-12 px-6 border border-dashed border-paper-200 rounded-card">
          <Key className="size-6 text-ink-400 mx-auto mb-2" />
          <p className="text-body text-ink-500 mb-1">No API keys yet.</p>
          <p className="text-dense text-ink-400">
            Create one to let an external system call <code className="font-mono text-[10.5px] bg-paper-100 text-ink-950 px-1 rounded-chip">/api/v1/*</code> with Bearer auth.
          </p>
        </div>
      ) : (
        <div className="bg-card border border-paper-200 rounded-card overflow-hidden">
          <table className="w-full text-[13px]" data-testid="api-keys-table">
            <thead className="bg-paper-50 text-[11px] uppercase tracking-[0.08em] text-ink-500">
              <tr>
                <th className="text-left px-4 py-2 font-semibold">Name</th>
                <th className="text-left px-4 py-2 font-semibold">Prefix</th>
                <th className="text-left px-4 py-2 font-semibold">Last used</th>
                <th className="text-left px-4 py-2 font-semibold">Status</th>
                <th className="text-right px-4 py-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-200">
              {keys.map(k => (
                <tr key={k.id} data-testid={`api-key-row-${k.id}`}>
                  <td className="px-4 py-2 font-medium text-ink-950">{k.name}</td>
                  <td className="px-4 py-2 font-mono text-[11px] text-ink-700">{k.prefix}…</td>
                  <td className="px-4 py-2 text-[11px] tabular-nums text-ink-500">
                    {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never'}
                  </td>
                  <td className="px-4 py-2">
                    {/*
                      Revocation is a deliberate, finished act — neutral, like an
                      archived record. Expiry is the one that bites: a key lapsed
                      on its own and something out there is failing silently, so
                      that's the state that earns risk.
                    */}
                    {k.revokedAt ? (
                      <StatusPill meaning="neutral">Revoked</StatusPill>
                    ) : k.expiresAt && new Date(k.expiresAt) < new Date() ? (
                      <StatusPill meaning="risk">Expired</StatusPill>
                    ) : (
                      <StatusPill meaning="binding">Active</StatusPill>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {!k.revokedAt && (
                      <button
                        onClick={() => setPendingRevoke(k)}
                        data-testid={`revoke-${k.id}`}
                        aria-label={`Revoke API key ${k.name}`}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-dense text-risk-700 hover:bg-risk-50 hover:text-risk-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Trash2 className="size-3.5" /> Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <CreateApiKeyDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(id, key) => {
            qc.invalidateQueries({ queryKey: ['api-keys'] })
            setRevealKey({ id, key })
          }}
        />
      )}
      {revealKey && <RevealKeyModal id={revealKey.id} keyValue={revealKey.key} onClose={() => setRevealKey(null)} />}

      {/*
        Revocation was guarded by window.confirm, which cannot name the key.
        With several keys in a table and a right-aligned Revoke on every row,
        "Revoke this API key?" is the one question the admin cannot answer.
      */}
      <ConfirmDialog
        open={pendingRevoke != null}
        testId="revoke-key-confirm"
        title="Revoke this API key?"
        confirmLabel={revoke.isPending ? 'Revoking…' : 'Revoke key'}
        isPending={revoke.isPending}
        error={revoke.isError ? 'Could not revoke this key. Try again.' : null}
        body={
          <>
            <span className="font-medium text-ink-950">{pendingRevoke?.name}</span>{' '}
            <span className="font-mono text-[11.5px] text-ink-500">{pendingRevoke?.prefix}…</span>{' '}
            stops working immediately, and every system authenticating with it
            starts getting 401s. Revocation is permanent — issue a new key to
            restore access.
            {pendingRevoke?.lastUsedAt && (
              <>
                {' '}This key was last used{' '}
                <span className="tabular-nums">
                  {new Date(pendingRevoke.lastUsedAt).toLocaleString()}
                </span>.
              </>
            )}
          </>
        }
        onConfirm={() => pendingRevoke && revoke.mutate(pendingRevoke.id)}
        onCancel={() => { revoke.reset(); setPendingRevoke(null) }}
      />
    </div>
  )
}

function CreateApiKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string, key: string) => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: async () => (await api.post('/admin/integrations/api-keys', { name: name.trim() })).data as { id: string; key: string },
    onSuccess: (data) => { onCreated(data.id, data.key); onClose() },
    onError: (err: { response?: { data?: { detail?: string } } }) => setError(err.response?.data?.detail ?? 'Failed to create.'),
  })
  return (
    <div role="dialog" className="fixed inset-0 z-50 bg-ink-950/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card rounded-card border border-paper-200 max-w-md w-full shadow-e3" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-paper-200 flex items-start justify-between">
          <h2 className="text-section text-ink-950 flex items-center gap-2"><Key className="size-5 text-ink-700" /> New API key</h2>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-paper-100 text-ink-400"><X className="size-4" /></button>
        </div>
        <div className="px-5 py-5 space-y-3">
          <div>
            <label className="block text-[11.5px] font-semibold text-ink-950 mb-1.5">Name</label>
            <Input
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              placeholder="Salesforce sync"
              data-testid="api-key-name"
              autoFocus
            />
          </div>
          {error && <div className="text-dense text-risk-700 bg-risk-50 border border-risk-200 rounded-md px-3 py-2">{error}</div>}
        </div>
        <div className="px-5 py-4 border-t border-paper-200 flex justify-end gap-2 bg-paper-50 rounded-b-card">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!name.trim() || create.isPending}
            data-testid="create-key-confirm"
          >
            {create.isPending ? <><Loader2 className="size-4 animate-spin mr-1" /> Creating…</> : 'Create key'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function RevealKeyModal({ id: _id, keyValue, onClose }: { id: string; keyValue: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div role="dialog" className="fixed inset-0 z-50 bg-ink-950/40 flex items-center justify-center p-4" data-testid="reveal-key-modal">
      <div className="bg-card rounded-card border border-paper-200 max-w-lg w-full shadow-e3">
        <div className="px-5 py-4 border-b border-paper-200">
          {/* The heading is a neutral fact; the warning below is the part that's
              genuinely blocked on this user, so attention lands there. */}
          <h2 className="text-section text-ink-950 flex items-center gap-2">
            <Check className="size-5" /> API key created
          </h2>
          <p className="text-dense text-attention-700 mt-1">
            <AlertCircle className="size-3 inline mr-1" />
            This is the only time you'll see the full key. Copy it now — we don't store it.
          </p>
        </div>
        <div className="px-5 py-5">
          <div className="flex gap-2">
            <code className="flex-1 text-[11px] bg-paper-50 border border-paper-200 rounded-md px-3 py-2.5 font-mono text-ink-950 break-all" data-testid="key-value">
              {keyValue}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { navigator.clipboard.writeText(keyValue); setCopied(true) }}
              className="gap-1.5 flex-shrink-0"
              data-testid="copy-key"
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-[11px] text-ink-500 mt-3">
            Use it as <code className="font-mono text-[10.5px] bg-paper-100 text-ink-950 px-1 rounded-chip">Authorization: Bearer {keyValue.slice(0, 20)}…</code>
          </p>
        </div>
        <div className="px-5 py-4 border-t border-paper-200 flex justify-end bg-paper-50 rounded-b-card">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  )
}

// ─── Webhooks ────────────────────────────────────────────────────────

function WebhooksSection() {
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Webhook | null>(null)

  const { data, isLoading } = useQuery<{ data: Webhook[] }>({
    queryKey: ['webhooks'],
    queryFn:  () => api.get('/admin/integrations/webhooks').then(r => r.data),
    refetchInterval: 30_000,
  })
  const { data: eventsData } = useQuery<{ events: string[] }>({
    queryKey: ['webhook-events'],
    queryFn:  () => api.get('/admin/integrations/events').then(r => r.data),
  })

  const test = useMutation({
    mutationFn: async (id: string) => api.post(`/admin/integrations/webhooks/${id}/test`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  })
  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/admin/integrations/webhooks/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['webhooks'] })
      setPendingDelete(null)
    },
  })
  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch(`/admin/integrations/webhooks/${id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  })

  if (isLoading) return <div className="py-12 flex items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-400" /></div>

  const webhooks = data?.data ?? []

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-body font-medium text-ink-700 tabular-nums">{webhooks.length} {webhooks.length === 1 ? 'webhook' : 'webhooks'}</h2>
        <Button onClick={() => setCreateOpen(true)} data-testid="create-webhook-btn" className="gap-1.5">
          <Plus className="size-4" />
          New webhook
        </Button>
      </div>

      {webhooks.length === 0 ? (
        <div className="text-center py-12 px-6 border border-dashed border-paper-200 rounded-card">
          <WebhookIcon className="size-6 text-ink-400 mx-auto mb-2" />
          <p className="text-body text-ink-500 mb-1">No webhooks configured.</p>
          <p className="text-dense text-ink-400">
            Add a webhook to receive HMAC-signed POSTs when events fire (contract executed, signature completed, etc.).
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {webhooks.map(w => (
            <div key={w.id} className="bg-card border border-paper-200 rounded-card" data-testid={`webhook-row-${w.id}`}>
              <div className="flex items-center justify-between px-4 py-3">
                <button
                  onClick={() => setExpandedId(expandedId === w.id ? null : w.id)}
                  className="flex-1 flex items-center gap-2 text-left min-w-0"
                >
                  {expandedId === w.id ? <ChevronDown className="size-4 text-ink-400" /> : <ChevronRight className="size-4 text-ink-400" />}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-ink-950 truncate flex items-center gap-2">
                      {w.name}
                      {!w.enabled && <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 bg-paper-100 text-ink-500 rounded-chip">Disabled</span>}
                      {w.lastDeliveryStatus === 'failed' && (
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 bg-risk-100 text-risk-700 rounded-chip tabular-nums">
                          {w.failureCount} failure{w.failureCount === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-ink-500 truncate font-mono">{w.url}</div>
                    <div className="text-[10.5px] text-ink-400 mt-0.5">
                      {w.events.length} event{w.events.length === 1 ? '' : 's'} ·
                      {w.lastDeliveryAt ? ` last fired ${new Date(w.lastDeliveryAt).toLocaleString()}` : ' never fired'}
                    </div>
                  </div>
                </button>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => test.mutate(w.id)}
                    disabled={test.isPending}
                    className="text-dense text-ink-700 hover:text-ink-950 inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-paper-100"
                    title="Send a test event"
                    data-testid={`test-${w.id}`}
                  >
                    <Send className="size-3.5" /> Test
                  </button>
                  <button
                    onClick={() => toggle.mutate({ id: w.id, enabled: !w.enabled })}
                    className="text-dense text-ink-700 hover:text-ink-950 px-2 py-1 rounded-md hover:bg-paper-100"
                  >
                    {w.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => setPendingDelete(w)}
                    aria-label={`Delete webhook ${w.name}`}
                    title={`Delete webhook "${w.name}"`}
                    data-testid={`delete-webhook-${w.id}`}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-dense text-risk-700 hover:bg-risk-50 hover:text-risk-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
              {expandedId === w.id && <WebhookDetail webhook={w} />}
            </div>
          ))}
        </div>
      )}

      {createOpen && eventsData && (
        <CreateWebhookDialog
          events={eventsData.events}
          onClose={() => setCreateOpen(false)}
          onCreated={() => qc.invalidateQueries({ queryKey: ['webhooks'] })}
        />
      )}

      {/* A webhook is how another system learns a contract was executed. Losing
          one silently stops that feed, so the confirm names the endpoint. */}
      <ConfirmDialog
        open={pendingDelete != null}
        testId="delete-webhook-confirm"
        title="Delete this webhook?"
        confirmLabel={remove.isPending ? 'Deleting…' : 'Delete webhook'}
        isPending={remove.isPending}
        error={remove.isError ? 'Could not delete this webhook. Try again.' : null}
        body={
          <>
            <span className="font-medium text-ink-950">{pendingDelete?.name}</span> stops
            receiving events at{' '}
            <span className="break-all font-mono text-[11.5px] text-ink-500">{pendingDelete?.url}</span>.
            Anything downstream that relies on{' '}
            {pendingDelete?.events?.length ? (
              <span className="font-mono text-[11.5px] text-ink-500">
                {pendingDelete.events.slice(0, 3).join(', ')}
                {pendingDelete.events.length > 3 ? ` +${pendingDelete.events.length - 3} more` : ''}
              </span>
            ) : (
              'these events'
            )}{' '}
            goes quiet with no error on their side. To pause instead, use Disable.
          </>
        }
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
        onCancel={() => { remove.reset(); setPendingDelete(null) }}
      />
    </div>
  )
}

function WebhookDetail({ webhook }: { webhook: Webhook }) {
  const { data } = useQuery<{ data: Delivery[] }>({
    queryKey: ['webhook-deliveries', webhook.id],
    queryFn:  () => api.get(`/admin/integrations/webhooks/${webhook.id}/deliveries`).then(r => r.data),
    refetchInterval: 5_000,
  })
  const items = data?.data ?? []
  return (
    <div className="border-t border-paper-200 px-4 py-3 bg-paper-50/50">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-700 mb-2">Subscribed events</div>
      <div className="flex flex-wrap gap-1 mb-3">
        {webhook.events.map(e => (
          <span key={e} className="inline-flex items-center px-1.5 py-0.5 rounded-chip text-[10.5px] font-mono bg-card border border-paper-200 text-ink-700">
            {e}
          </span>
        ))}
      </div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-700 mb-2">Recent deliveries ({items.length})</div>
      {items.length === 0 ? (
        <div className="text-[11px] text-ink-400 italic">No deliveries yet — fire a test event to verify connectivity.</div>
      ) : (
        <div className="space-y-1">
          {items.map(d => (
            <div key={d.id} className="flex items-center gap-2 text-[11px] py-1 border-b border-paper-200 last:border-b-0">
              <span className={`inline-block size-1.5 rounded-full flex-shrink-0 ${d.succeeded ? MEANING_CLASS.binding.dot : MEANING_CLASS.risk.dot}`} />
              <span className="font-mono text-ink-700 w-44 truncate">{d.event}</span>
              <span className="text-ink-500 w-32 tabular-nums">{new Date(d.createdAt).toLocaleString()}</span>
              <span className={`tabular-nums ${d.succeeded ? MEANING_CLASS.binding.fg : MEANING_CLASS.risk.fg}`}>
                {d.responseStatus ?? '—'} · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
              </span>
              {d.errorMessage && <span className="text-risk-700 truncate text-[10.5px]">{d.errorMessage}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="text-[10px] text-ink-400 mt-2 font-mono">
        Signing secret: {webhook.secret.slice(0, 16)}… (use to verify <code>X-CLM-Signature</code>)
      </div>
    </div>
  )
}

function CreateWebhookDialog({ events, onClose, onCreated }: {
  events: string[]
  onClose: () => void
  onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [type, setType] = useState<'generic' | 'slack' | 'teams'>('generic')
  const [selectedEvents, setSelectedEvents] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  // Auto-detect: paste a Slack / Teams URL and we'll flip the type for them.
  const detectedSlack = /^https:\/\/hooks\.slack\.com\//.test(url.trim())
  const detectedTeams = /https:\/\/[^/]+\.(logic\.azure\.com|webhook\.office\.com|powerplatform\.com)(:\d+)?\//.test(url.trim())
  const effectiveType = detectedSlack ? 'slack' : detectedTeams ? 'teams' : type

  const create = useMutation({
    mutationFn: async () => api.post('/admin/integrations/webhooks', {
      name: name.trim(), url: url.trim(), events: selectedEvents, type: effectiveType,
    }),
    onSuccess: () => { onCreated(); onClose() },
    onError: (err: { response?: { data?: { detail?: string } } }) =>
      setError(err.response?.data?.detail ?? 'Failed to create webhook.'),
  })
  const valid = name.trim() && /^https?:\/\//.test(url.trim()) && selectedEvents.length > 0

  return (
    <div role="dialog" className="fixed inset-0 z-50 bg-ink-950/40 flex items-center justify-center p-4 overflow-auto" onClick={onClose}>
      <div className="bg-card rounded-card border border-paper-200 max-w-lg w-full shadow-e3 my-8" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-paper-200 flex items-start justify-between">
          <h2 className="text-section text-ink-950 flex items-center gap-2"><WebhookIcon className="size-5 text-ink-700" /> New webhook</h2>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-paper-100 text-ink-400"><X className="size-4" /></button>
        </div>
        <div className="px-5 py-5 space-y-4">
          <div>
            <label className="block text-[11.5px] font-semibold text-ink-950 mb-1.5">Name</label>
            <Input
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              placeholder="Slack notifications"
              data-testid="webhook-name"
            />
          </div>
          <div>
            <label className="block text-[11.5px] font-semibold text-ink-950 mb-1.5">URL</label>
            <Input
              value={url}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
              placeholder="https://your.app/clm-webhook  or  https://hooks.slack.com/services/…"
              data-testid="webhook-url"
            />
            {/* "We recognised your URL" is a neutral fact about what you typed,
                not a binding outcome — so no emerald here. */}
            {detectedSlack && (
              <p className="text-[11px] text-ink-500 mt-1 inline-flex items-center gap-1">
                <Check className="size-3" /> Slack URL detected — events will be formatted as Slack messages.
              </p>
            )}
            {detectedTeams && (
              <p className="text-[11px] text-ink-500 mt-1 inline-flex items-center gap-1">
                <Check className="size-3" /> Teams workflow URL detected — events will be formatted as Adaptive Cards.
              </p>
            )}
          </div>

          {!detectedSlack && !detectedTeams && (
            <div>
              <label className="block text-[11.5px] font-semibold text-ink-950 mb-1.5">Format</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setType('generic')}
                  // Selection is an action state — ink outline, not a colored wash.
                  className={`flex-1 text-left p-2.5 rounded-md border text-dense transition-colors ${
                    type === 'generic' ? 'border-ink-950 bg-paper-100' : 'border-paper-200 hover:border-paper-300'
                  }`}
                  data-testid="type-generic"
                >
                  <div className="font-medium text-ink-950">Generic JSON</div>
                  <div className="text-[11px] text-ink-500">Standard envelope: {'{ event, timestamp, data }'}</div>
                </button>
                <button
                  type="button"
                  onClick={() => setType('slack')}
                  className={`flex-1 text-left p-2.5 rounded-md border text-dense transition-colors ${
                    type === 'slack' ? 'border-ink-950 bg-paper-100' : 'border-paper-200 hover:border-paper-300'
                  }`}
                  data-testid="type-slack"
                >
                  <div className="font-medium text-ink-950">Slack blocks</div>
                  <div className="text-[11px] text-ink-500">Pretty rendering for Slack-compatible receivers</div>
                </button>
                <button
                  type="button"
                  onClick={() => setType('teams')}
                  className={`flex-1 text-left p-2.5 rounded-md border text-dense transition-colors ${
                    type === 'teams' ? 'border-ink-950 bg-paper-100' : 'border-paper-200 hover:border-paper-300'
                  }`}
                  data-testid="type-teams"
                >
                  <div className="font-medium text-ink-950">Teams card</div>
                  <div className="text-[11px] text-ink-500">Adaptive Cards for Teams Workflows webhooks</div>
                </button>
              </div>
            </div>
          )}
          <div>
            <label className="block text-[11.5px] font-semibold text-ink-950 mb-1.5">Events</label>
            <div className="grid grid-cols-2 gap-1.5 max-h-56 overflow-y-auto p-2 border border-paper-200 rounded-md">
              {events.map(e => (
                <label key={e} className="flex items-center gap-1.5 text-dense text-ink-700 cursor-pointer hover:bg-paper-50 px-1.5 py-1 rounded-chip">
                  <input
                    type="checkbox"
                    checked={selectedEvents.includes(e)}
                    onChange={(ev) => setSelectedEvents(ev.target.checked
                      ? [...selectedEvents, e]
                      : selectedEvents.filter(x => x !== e))
                    }
                    data-testid={`event-${e}`}
                    className="size-3.5 rounded-chip border-paper-300 accent-ink-950"
                  />
                  <span className="font-mono">{e}</span>
                </label>
              ))}
            </div>
          </div>
          {error && <div className="text-dense text-risk-700 bg-risk-50 border border-risk-200 rounded-md px-3 py-2">{error}</div>}
        </div>
        <div className="px-5 py-4 border-t border-paper-200 flex justify-end gap-2 bg-paper-50 rounded-b-card">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!valid || create.isPending}
            data-testid="create-webhook-confirm"
          >
            {create.isPending ? <><Loader2 className="size-4 animate-spin mr-1" /> Creating…</> : 'Create webhook'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Health (Phase 10 — integration health dashboard) ─────────────────

interface WebhookHealth {
  id: string
  name: string
  url: string
  type: 'generic' | 'slack' | 'teams'
  enabled: boolean
  events: string[]
  health: 'healthy' | 'degraded' | 'failing' | 'disabled'
  lastDeliveryAt: string | null
  lastDeliveryStatus: string | null
  consecutiveFailures: number
  deliveries: { ok24h: number; fail24h: number; ok7d: number; fail7d: number }
  lastFailure: {
    deliveryId: string
    event: string
    errorMessage: string | null
    responseStatus: number | null
    at: string
  } | null
}

interface HealthResponse {
  webhooks: WebhookHealth[]
  summary: {
    healthy: number
    degraded: number
    failing: number
    disabled: number
    deliveries24h: number
    failed24h: number
    successRate7d: number | null
  }
  apiKeys: { active: number; expiringSoon: number; lastUsedAt: string | null }
}

/*
 * Connection health is a one-for-one fit with the meaning system: healthy is
 * the binding "it works", degraded is your turn to look at it before it breaks,
 * failing is real risk, and a disabled hook is simply off.
 */
const HEALTH_BADGE: Record<WebhookHealth['health'], { label: string; meaning: Meaning }> = {
  healthy:  { label: 'Healthy',  meaning: 'binding' },
  degraded: { label: 'Degraded', meaning: 'turn' },
  failing:  { label: 'Failing',  meaning: 'risk' },
  disabled: { label: 'Disabled', meaning: 'neutral' },
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function HealthSection() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<HealthResponse>({
    queryKey: ['integrations-health'],
    queryFn:  () => api.get('/admin/integrations/health').then(r => r.data),
    refetchInterval: 30_000,
  })

  const retry = useMutation({
    mutationFn: async ({ webhookId, deliveryId }: { webhookId: string; deliveryId: string }) =>
      api.post(`/admin/integrations/webhooks/${webhookId}/deliveries/${deliveryId}/retry`),
    onSuccess: () => {
      // Delivery is async — give the worker a beat before refreshing.
      setTimeout(() => qc.invalidateQueries({ queryKey: ['integrations-health'] }), 2000)
    },
  })

  if (isLoading) return <div className="py-12 flex items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-400" /></div>
  if (!data) return null

  const { webhooks, summary, apiKeys } = data

  return (
    <div data-testid="health-section">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <SummaryCard
          label="Webhooks"
          value={`${summary.healthy}/${webhooks.length} healthy`}
          sub={[
            summary.degraded > 0 ? `${summary.degraded} degraded` : null,
            summary.failing > 0 ? `${summary.failing} failing` : null,
            summary.disabled > 0 ? `${summary.disabled} disabled` : null,
          ].filter(Boolean).join(' · ') || 'all good'}
          tone={summary.failing > 0 ? 'red' : summary.degraded > 0 ? 'amber' : 'green'}
          testId="health-card-webhooks"
        />
        <SummaryCard
          label="Deliveries (24h)"
          value={String(summary.deliveries24h)}
          sub={summary.failed24h > 0 ? `${summary.failed24h} failed` : 'no failures'}
          tone={summary.failed24h > 0 ? 'amber' : 'green'}
          testId="health-card-deliveries"
        />
        <SummaryCard
          label="Success rate (7d)"
          value={summary.successRate7d != null ? `${summary.successRate7d}%` : '—'}
          sub={summary.successRate7d != null ? 'of webhook deliveries' : 'no deliveries yet'}
          tone={summary.successRate7d == null ? 'gray' : summary.successRate7d >= 95 ? 'green' : summary.successRate7d >= 80 ? 'amber' : 'red'}
          testId="health-card-success-rate"
        />
        <SummaryCard
          label="API keys"
          value={String(apiKeys.active)}
          sub={apiKeys.expiringSoon > 0
            ? `${apiKeys.expiringSoon} expiring within 30d`
            : apiKeys.lastUsedAt ? `last used ${relativeTime(apiKeys.lastUsedAt)}` : 'never used'}
          tone={apiKeys.expiringSoon > 0 ? 'amber' : 'gray'}
          testId="health-card-api-keys"
        />
      </div>

      {/* Per-webhook health table */}
      {webhooks.length === 0 ? (
        <div className="text-center py-12 px-6 border border-dashed border-paper-200 rounded-card">
          <Activity className="size-6 text-ink-400 mx-auto mb-2" />
          <p className="text-body text-ink-500 mb-1">No webhooks configured.</p>
          <p className="text-dense text-ink-400">Add one on the Webhooks tab — health appears here once deliveries start flowing.</p>
        </div>
      ) : (
        <div className="bg-card border border-paper-200 rounded-card overflow-hidden">
          <table className="w-full text-[13px]" data-testid="health-table">
            <thead className="bg-paper-50 text-[11px] uppercase tracking-[0.08em] text-ink-500">
              <tr>
                <th className="text-left px-4 py-2 font-semibold">Status</th>
                <th className="text-left px-4 py-2 font-semibold">Webhook</th>
                <th className="text-left px-4 py-2 font-semibold">Last delivery</th>
                <th className="text-left px-4 py-2 font-semibold">24h</th>
                <th className="text-left px-4 py-2 font-semibold">7d</th>
                <th className="text-left px-4 py-2 font-semibold">Last error</th>
                <th className="text-right px-4 py-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-200">
              {webhooks.map(w => {
                const badge = HEALTH_BADGE[w.health]
                return (
                  <tr key={w.id} data-testid={`health-row-${w.id}`} data-health={w.health}>
                    <td className="px-4 py-2">
                      <StatusPill meaning={badge.meaning}>{badge.label}</StatusPill>
                      {w.consecutiveFailures > 0 && (
                        <div className="text-[10.5px] text-risk-700 mt-1 tabular-nums">{w.consecutiveFailures} consecutive failure{w.consecutiveFailures > 1 ? 's' : ''}</div>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <div className="font-medium text-ink-950">{w.name}</div>
                      <div className="text-[11px] font-mono text-ink-400 truncate max-w-[220px]" title={w.url}>{w.url}</div>
                    </td>
                    <td className="px-4 py-2 text-[11px] text-ink-700">
                      <div className="tabular-nums">{relativeTime(w.lastDeliveryAt)}</div>
                      {w.lastDeliveryStatus && (
                        <div className={w.lastDeliveryStatus === 'success' ? MEANING_CLASS.binding.fg : MEANING_CLASS.risk.fg}>
                          {w.lastDeliveryStatus}
                        </div>
                      )}
                    </td>
                    {/*
                      Aggregate counts read the other way round from the per-row dot:
                      a column of emerald "ok" totals is the generic-success decoration
                      the system bans, so only the failures carry color.
                    */}
                    <td className="px-4 py-2 text-[11px] tabular-nums">
                      <span className="text-ink-700">{w.deliveries.ok24h} ok</span>
                      {w.deliveries.fail24h > 0 && <span className="text-risk-700"> · {w.deliveries.fail24h} failed</span>}
                    </td>
                    <td className="px-4 py-2 text-[11px] tabular-nums">
                      <span className="text-ink-700">{w.deliveries.ok7d} ok</span>
                      {w.deliveries.fail7d > 0 && <span className="text-risk-700"> · {w.deliveries.fail7d} failed</span>}
                    </td>
                    <td className="px-4 py-2 text-[11px] text-ink-700 max-w-[240px]">
                      {w.lastFailure ? (
                        <div>
                          <div className="truncate" title={w.lastFailure.errorMessage ?? undefined}>
                            {w.lastFailure.errorMessage ?? `HTTP ${w.lastFailure.responseStatus ?? '?'}`}
                          </div>
                          <div className="text-ink-400">{w.lastFailure.event} · {relativeTime(w.lastFailure.at)}</div>
                        </div>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {w.lastFailure && w.enabled && (
                        <button
                          onClick={() => retry.mutate({ webhookId: w.id, deliveryId: w.lastFailure!.deliveryId })}
                          disabled={retry.isPending}
                          data-testid={`health-retry-${w.id}`}
                          className="text-dense text-ink-950 hover:text-ink-700 inline-flex items-center gap-1 disabled:opacity-50"
                        >
                          <RefreshCw className={`size-3.5 ${retry.isPending ? 'animate-spin' : ''}`} /> Retry
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-ink-400 mt-3">
        Auto-refreshes every 30s. “Failing” = 3+ consecutive failures; “Degraded” = failures within the last 7 days.
      </p>
    </div>
  )
}

function SummaryCard({ label, value, sub, tone, testId }: {
  label: string
  value: string
  sub: string
  tone: 'green' | 'amber' | 'red' | 'gray'
  testId: string
}) {
  // The prop names stay green/amber/red/gray so callers don't move; what they
  // resolve to is now the meaning ramp.
  const toneCls = {
    green: 'text-brand-700',
    amber: 'text-attention-700',
    red:   'text-risk-700',
    gray:  'text-ink-950',
  }[tone]
  return (
    <div className="bg-card border border-paper-200 rounded-card px-4 py-3" data-testid={testId}>
      <div className="text-[11px] uppercase tracking-[0.08em] text-ink-400 font-semibold">{label}</div>
      <div className={`text-title tabular-nums mt-0.5 ${toneCls}`}>{value}</div>
      <div className="text-dense text-ink-500 mt-0.5 tabular-nums">{sub}</div>
    </div>
  )
}

// ─── Slack (Phase 10 — Slack bot setup wizard) ─────────────────────────

interface SlackConfig {
  connected: boolean
  teamId?: string
  configuredAt?: string | null
  hasSigningSecret?: boolean
  hasBotToken?: boolean
}

const API_BASE = `${window.location.origin}/api/v1`

const SLACK_MANIFEST = JSON.stringify({
  display_information: { name: 'draftLegal', description: 'Contract search + approvals from Slack' },
  features: {
    bot_user: { display_name: 'draftLegal', always_online: true },
    slash_commands: [{
      command: '/contract',
      url: `${API_BASE}/slack/commands`,
      description: 'Search contracts',
      usage_hint: 'search <query>',
    }],
  },
  oauth_config: { scopes: { bot: ['commands', 'incoming-webhook', 'users:read', 'users:read.email'] } },
  settings: {
    interactivity: { is_enabled: true, request_url: `${API_BASE}/slack/interactions` },
    org_deploy_enabled: false,
    socket_mode_enabled: false,
  },
}, null, 2)

function SlackSection() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<SlackConfig>({
    queryKey: ['slack-config'],
    queryFn:  () => api.get('/admin/integrations/slack').then(r => r.data),
  })

  const [teamId, setTeamId] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [botToken, setBotToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copiedManifest, setCopiedManifest] = useState(false)

  const save = useMutation({
    mutationFn: async () => api.put('/admin/integrations/slack', {
      teamId: teamId.trim(),
      signingSecret: signingSecret.trim(),
      ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
    }),
    onSuccess: () => {
      setTeamId(''); setSigningSecret(''); setBotToken(''); setError(null)
      qc.invalidateQueries({ queryKey: ['slack-config'] })
    },
    onError: (err: { response?: { data?: { detail?: string } } }) =>
      setError(err.response?.data?.detail ?? 'Failed to save.'),
  })

  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const disconnect = useMutation({
    mutationFn: async () => api.delete('/admin/integrations/slack'),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['slack-config'] }),
  })

  if (isLoading) return <div className="py-12 flex items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-400" /></div>

  if (data?.connected) {
    return (
      <div className="max-w-2xl" data-testid="slack-connected">
        <div className="bg-card border border-paper-200 rounded-card p-5">
          <div className="flex items-center gap-2 mb-3">
            {/* Connected = binding, the same dot a healthy webhook gets. */}
            <span className={`size-1.5 rounded-full ${MEANING_CLASS.binding.dot}`} />
            <h2 className="text-section text-ink-950">Slack workspace connected</h2>
          </div>
          <dl className="text-body space-y-2">
            <div className="flex justify-between"><dt className="text-ink-500">Workspace (team ID)</dt><dd className="font-mono text-[11px] text-ink-950">{data.teamId}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-500">Signing secret</dt><dd className="text-brand-700 text-[11px]">configured</dd></div>
            <div className="flex justify-between">
              <dt className="text-ink-500">Bot token (button-click identity)</dt>
              {/* Missing bot token is a setup step still waiting on this admin. */}
              <dd className={data.hasBotToken ? 'text-brand-700 text-[11px]' : 'text-attention-700 text-[11px]'}>
                {data.hasBotToken ? 'configured' : 'not set — buttons fall back to web links'}
              </dd>
            </div>
            {data.configuredAt && (
              <div className="flex justify-between"><dt className="text-ink-500">Connected</dt><dd className="text-[11px] tabular-nums text-ink-700">{new Date(data.configuredAt).toLocaleString()}</dd></div>
            )}
          </dl>
          <div className="mt-4 pt-4 border-t border-paper-200 text-dense text-ink-500 space-y-1">
            <p>• <code className="font-mono bg-paper-100 text-ink-950 px-1 rounded-chip">/contract search &lt;query&gt;</code> works in any channel the app is in.</p>
            <p>• Approval requests post Approve / Reject buttons via your <button className="text-ink-950 underline underline-offset-2 decoration-paper-300 hover:decoration-brand-700 hover:text-brand-700" onClick={() => { /* tab switch hint */ }}>Slack webhook</button> — add one on the Webhooks tab (paste a hooks.slack.com URL) subscribed to <code className="font-mono bg-paper-100 text-ink-950 px-1 rounded-chip">approval.submitted</code>.</p>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              onClick={() => setConfirmDisconnect(true)}
              data-testid="slack-disconnect"
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-dense text-risk-700 hover:bg-risk-50 hover:text-risk-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Trash2 className="size-3.5" /> Disconnect
            </button>
          </div>
        </div>

        <ConfirmDialog
          open={confirmDisconnect}
          testId="slack-disconnect-confirm"
          title="Disconnect Slack?"
          confirmLabel={disconnect.isPending ? 'Disconnecting…' : 'Disconnect Slack'}
          isPending={disconnect.isPending}
          error={disconnect.isError ? 'Could not disconnect. Try again.' : null}
          body={
            <>
              <code className="font-mono text-[11.5px] text-ink-700">/contract</code> stops
              responding in every channel, and Approve / Reject buttons in already-posted
              approval messages stop working — approvers will have to come back into
              draftLegal. Your signing secret and bot token are deleted; reconnecting means
              pasting them again from the Slack app config.
            </>
          }
          onConfirm={() => disconnect.mutate(undefined, { onSuccess: () => setConfirmDisconnect(false) })}
          onCancel={() => { disconnect.reset(); setConfirmDisconnect(false) }}
        />
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-4" data-testid="slack-setup">
      <div className="bg-card border border-paper-200 rounded-card p-5">
        <h2 className="text-section text-ink-950 mb-1">1 · Create the Slack app</h2>
        <p className="text-dense text-ink-500 mb-3">
          Go to <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className="text-ink-950 underline underline-offset-2 decoration-paper-300 hover:decoration-brand-700 hover:text-brand-700">api.slack.com/apps</a> →
          “Create New App” → “From a manifest”, pick your workspace, and paste this manifest. It pre-wires the
          <code className="font-mono bg-paper-100 text-ink-950 px-1 rounded-chip mx-1">/contract</code> command and the Approve/Reject interactivity URL.
        </p>
        <div className="relative">
          <pre className="font-mono text-[10.5px] bg-ink-950 text-paper-200 rounded-md p-3 overflow-x-auto max-h-48" data-testid="slack-manifest">{SLACK_MANIFEST}</pre>
          <button
            onClick={() => { navigator.clipboard.writeText(SLACK_MANIFEST); setCopiedManifest(true); setTimeout(() => setCopiedManifest(false), 1500) }}
            className="absolute top-2 right-2 p-1.5 rounded-chip bg-ink-700 hover:bg-ink-500 text-paper-100"
            data-testid="slack-copy-manifest"
            aria-label="Copy manifest"
          >
            {copiedManifest ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        </div>
        {/* Your turn: nothing works until the admin exposes a reachable URL. */}
        <p className="text-[11px] text-attention-700 bg-attention-50 border border-attention-200 rounded-md px-2.5 py-1.5 mt-3">
          Slack must be able to reach these URLs — in local dev use a tunnel (ngrok / cloudflared) and adjust the manifest.
        </p>
      </div>

      <div className="bg-card border border-paper-200 rounded-card p-5">
        <h2 className="text-section text-ink-950 mb-1">2 · Connect it here</h2>
        <p className="text-dense text-ink-500 mb-3">
          From the app's <span className="font-medium">Basic Information</span> page copy the <span className="font-medium">Signing Secret</span>;
          the <span className="font-medium">Team ID</span> (starts with T) is in your Slack workspace URL or app install page. The bot token
          (<span className="font-mono">xoxb-…</span>, after installing the app) is optional but lets Approve/Reject clicks act as the matching draftLegal user.
        </p>
        <div className="space-y-3">
          <div>
            <label className="block text-[11.5px] font-semibold text-ink-950 mb-1.5">Team ID</label>
            <Input value={teamId} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTeamId(e.target.value)} placeholder="T0123ABCD" data-testid="slack-team-id" />
          </div>
          <div>
            <label className="block text-[11.5px] font-semibold text-ink-950 mb-1.5">Signing secret</label>
            <Input value={signingSecret} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSigningSecret(e.target.value)} placeholder="8f742231b10e8888abcd99yyyzzz85a5" type="password" data-testid="slack-signing-secret" />
          </div>
          <div>
            <label className="block text-[11.5px] font-semibold text-ink-950 mb-1.5">Bot token <span className="text-ink-400 font-normal">(optional)</span></label>
            <Input value={botToken} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBotToken(e.target.value)} placeholder="xoxb-…" type="password" data-testid="slack-bot-token" />
          </div>
          {error && <div className="text-dense text-risk-700 bg-risk-50 border border-risk-200 rounded-md px-3 py-2">{error}</div>}
          <div className="flex justify-end">
            <Button
              onClick={() => save.mutate()}
              disabled={!teamId.trim() || !signingSecret.trim() || save.isPending}
              data-testid="slack-save"
            >
              {save.isPending ? <><Loader2 className="size-4 animate-spin mr-1" /> Connecting…</> : 'Connect Slack'}
            </Button>
          </div>
        </div>
      </div>

      <div className="bg-card border border-paper-200 rounded-card p-5">
        <h2 className="text-section text-ink-950 mb-1">3 · Notifications channel</h2>
        <p className="text-dense text-ink-500">
          On the <span className="font-medium">Webhooks</span> tab, add your Slack incoming-webhook URL
          (<span className="font-mono">hooks.slack.com/…</span>) subscribed to the events you care about —
          include <code className="font-mono bg-paper-100 text-ink-950 px-1 rounded-chip">approval.submitted</code> to get actionable
          Approve/Reject cards in the channel.
        </p>
      </div>
    </div>
  )
}
