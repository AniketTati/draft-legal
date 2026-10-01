/**
 * docs/41 Part 20 — the Single sign-on tab of Settings → Integrations:
 * the OIDC connection (Okta, Entra ID, Google Workspace…), SCIM tokens for
 * the identity provider's provisioning, and the role each SCIM group gives.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MEANING_CLASS } from '@/lib/status'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { useRoles } from '@/lib/permissions'

interface SsoConfig {
  callbackUrl: string
  scimBaseUrl: string
  connection: {
    issuer: string
    clientId: string
    hasClientSecret: boolean
    allowedDomains: string[]
    jitProvisioning: boolean
    defaultRole: string
    enabled: boolean
    lastLoginAt: string | null
  } | null
}

interface ScimToken { id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }
interface ScimGroup { id: string; displayName: string; roleName: string | null; memberCount: number }

const errorText = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? fallback

const label = 'block text-[11.5px] font-semibold text-ink-950 mb-1.5'

function CopyValue({ value, testId }: { value: string; testId?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 font-mono text-[11px] bg-paper-100 text-ink-950 px-2 py-1.5 rounded-chip truncate" data-testid={testId}>{value}</code>
      <button
        onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
        className="p-1.5 rounded-chip text-ink-500 hover:bg-paper-100 hover:text-ink-950"
        aria-label="Copy"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  )
}

/** "LEGAL_COUNSEL" → "Legal counsel". */
const roleLabel = (name: string) => name.charAt(0) + name.slice(1).toLowerCase().replace(/_/g, ' ')

export function SsoSection() {
  const { data: roles } = useRoles()
  const roleNames = (roles ?? []).map(r => r.name)
  const options = roleNames.length ? roleNames : ['VIEWER', 'SALES_REP', 'LEGAL_COUNSEL', 'LEGAL_OPS', 'CONTRACT_MANAGER', 'APPROVER', 'FINANCE', 'PROCUREMENT', 'ADMIN']

  return (
    <div className="max-w-3xl space-y-4" data-testid="sso-section">
      <OidcConnection roles={options} />
      <ScimTokens />
      <ScimGroups roles={options} />
    </div>
  )
}

function OidcConnection({ roles }: { roles: string[] }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<SsoConfig>({ queryKey: ['sso-config'], queryFn: () => api.get('/admin/sso').then(r => r.data) })
  const [form, setForm] = useState({ issuer: '', clientId: '', clientSecret: '', domains: '', jitProvisioning: true, defaultRole: 'VIEWER', enabled: false })
  const [confirmRemove, setConfirmRemove] = useState(false)
  useEffect(() => {
    const c = data?.connection
    if (c) setForm({ issuer: c.issuer, clientId: c.clientId, clientSecret: '', domains: c.allowedDomains.join(', '), jitProvisioning: c.jitProvisioning, defaultRole: c.defaultRole, enabled: c.enabled })
  }, [data])

  const save = useMutation({
    mutationFn: async () => api.put('/admin/sso', {
      issuer: form.issuer.trim(), clientId: form.clientId.trim(),
      ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
      allowedDomains: form.domains.split(/[\s,]+/).map(d => d.trim()).filter(Boolean),
      jitProvisioning: form.jitProvisioning, defaultRole: form.defaultRole, enabled: form.enabled,
    }),
    onSuccess: () => { setForm(f => ({ ...f, clientSecret: '' })); qc.invalidateQueries({ queryKey: ['sso-config'] }) },
  })
  const test = useMutation({ mutationFn: async () => api.post('/admin/sso/test').then(r => r.data as { ok: boolean; detail?: string; issuer?: string }) })
  const remove = useMutation({
    mutationFn: async () => api.delete('/admin/sso'),
    onSuccess: () => { setForm({ issuer: '', clientId: '', clientSecret: '', domains: '', jitProvisioning: true, defaultRole: 'VIEWER', enabled: false }); qc.invalidateQueries({ queryKey: ['sso-config'] }) },
  })

  if (isLoading || !data) return <div className="py-12 flex items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-400" /></div>
  const c = data.connection
  const set = (patch: Partial<typeof form>) => setForm(f => ({ ...f, ...patch }))

  return (
    <div className="bg-card border border-paper-200 rounded-card p-5" data-testid="sso-oidc">
      <div className="flex items-center gap-2 mb-1">
        {c && <span className={`size-1.5 rounded-full ${c.enabled ? MEANING_CLASS.binding.dot : MEANING_CLASS.neutral.dot}`} />}
        <h2 className="text-section text-ink-950 flex-1">Single sign-on (OIDC)</h2>
        {c && <span className="text-[11px] text-ink-500">{c.enabled ? 'On' : 'Off'}{c.lastLoginAt ? ` · last sign-in ${new Date(c.lastLoginAt).toLocaleString()}` : ''}</span>}
      </div>
      <p className="text-dense text-ink-500 mb-3">
        People whose email is in your domains sign in through your identity provider (Okta, Microsoft Entra ID, Google Workspace,
        OneLogin…). Password sign-in stays available.
      </p>
      <div className="mb-3">
        <span className={label}>Sign-in redirect URI for your provider</span>
        <CopyValue value={data.callbackUrl} testId="sso-callback-url" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="md:col-span-2">
          <label className={label}>Issuer URL</label>
          <Input value={form.issuer} onChange={e => set({ issuer: e.target.value })} placeholder="https://yourcompany.okta.com" data-testid="sso-issuer" />
        </div>
        <div>
          <label className={label}>Client ID</label>
          <Input value={form.clientId} onChange={e => set({ clientId: e.target.value })} data-testid="sso-client-id" />
        </div>
        <div>
          <label className={label}>Client secret {c?.hasClientSecret && <span className="text-ink-400 font-normal">(saved; enter a new one to replace it)</span>}</label>
          <Input type="password" value={form.clientSecret} onChange={e => set({ clientSecret: e.target.value })} placeholder={c?.hasClientSecret ? '••••••••' : ''} data-testid="sso-client-secret" />
        </div>
        <div className="md:col-span-2">
          <label className={label}>Email domains</label>
          <Input value={form.domains} onChange={e => set({ domains: e.target.value })} placeholder="acme.com, acme.co.uk" data-testid="sso-domains" />
        </div>
        <div>
          <label className="inline-flex items-center gap-2 text-body text-ink-700">
            <input type="checkbox" checked={form.jitProvisioning} onChange={e => set({ jitProvisioning: e.target.checked })} data-testid="sso-jit" />
            Create an account on first sign-in
          </label>
        </div>
        <div>
          <label className={label}>Role for new accounts</label>
          <select className="h-8 w-full rounded-md border border-input bg-card px-2 text-[12.5px] text-ink-950" value={form.defaultRole} onChange={e => set({ defaultRole: e.target.value })} disabled={!form.jitProvisioning}>
            {[...new Set([form.defaultRole, ...roles])].map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="inline-flex items-center gap-2 text-body text-ink-700">
            <input type="checkbox" checked={form.enabled} onChange={e => set({ enabled: e.target.checked })} data-testid="sso-enabled" />
            Turn on single sign-on for these domains
          </label>
        </div>
      </div>
      {save.isError && <p className="text-dense text-risk-700 mt-3">{errorText(save.error, 'Could not save.')}</p>}
      {test.data && (
        <p className={`text-dense mt-3 ${test.data.ok ? 'text-ink-700' : 'text-risk-700'}`} data-testid="sso-test-result">
          {test.data.ok ? `Reached ${test.data.issuer}.` : test.data.detail}
        </p>
      )}
      <div className="flex items-center justify-between mt-4">
        <div>
          {c && (
            <button onClick={() => setConfirmRemove(true)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-dense text-risk-700 hover:bg-risk-50">
              <Trash2 className="size-3.5" /> Remove
            </button>
          )}
        </div>
        <div className="flex gap-2">
          {c && <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? 'Testing…' : 'Test connection'}</Button>}
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !form.issuer || !form.clientId || !form.domains || (!c && !form.clientSecret)} data-testid="sso-save">
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        title="Remove single sign-on?"
        confirmLabel={remove.isPending ? 'Removing…' : 'Remove'}
        isPending={remove.isPending}
        body={<>People in your domains go back to signing in with a password. Anyone created through single sign-on has no password yet and will need to reset it.</>}
        onConfirm={() => remove.mutate(undefined, { onSuccess: () => setConfirmRemove(false) })}
        onCancel={() => setConfirmRemove(false)}
      />
    </div>
  )
}

function ScimTokens() {
  const qc = useQueryClient()
  const { data: cfg } = useQuery<SsoConfig>({ queryKey: ['sso-config'], queryFn: () => api.get('/admin/sso').then(r => r.data) })
  const { data } = useQuery<{ data: ScimToken[] }>({ queryKey: ['scim-tokens'], queryFn: () => api.get('/admin/sso/scim-tokens').then(r => r.data) })
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<ScimToken | null>(null)
  const create = useMutation({
    mutationFn: async () => api.post('/admin/sso/scim-tokens', { name: name.trim() }).then(r => r.data as { token: string }),
    onSuccess: ({ token }) => { setFresh(token); setName(''); qc.invalidateQueries({ queryKey: ['scim-tokens'] }) },
  })
  const revoke = useMutation({
    mutationFn: async (id: string) => api.delete(`/admin/sso/scim-tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scim-tokens'] }),
  })
  const live = (data?.data ?? []).filter(t => !t.revokedAt)

  return (
    <div className="bg-card border border-paper-200 rounded-card p-5" data-testid="scim-tokens">
      <div className="flex items-center gap-2 mb-1">
        <KeyRound className="size-4 text-ink-700" />
        <h2 className="text-section text-ink-950">User provisioning (SCIM)</h2>
      </div>
      <p className="text-dense text-ink-500 mb-3">
        Your identity provider creates and deactivates people here as you assign and unassign them. Give it this URL and a token.
      </p>
      {cfg && <div className="mb-3"><span className={label}>SCIM base URL</span><CopyValue value={cfg.scimBaseUrl} testId="scim-base-url" /></div>}
      {fresh && (
        <div className="mb-3 rounded-md border border-attention-200 bg-attention-50 p-3" data-testid="scim-token-reveal">
          <p className="text-dense text-attention-700 mb-1.5">Copy this token now. It won&apos;t be shown again.</p>
          <CopyValue value={fresh} />
          <div className="flex justify-end mt-2"><Button size="xs" variant="ghost" onClick={() => setFresh(null)}>Done</Button></div>
        </div>
      )}
      <ul className="divide-y divide-paper-200 mb-3">
        {live.map(t => (
          <li key={t.id} className="py-2 flex items-center gap-3 text-body">
            <span className="flex-1 text-ink-950">{t.name} <span className="font-mono text-[11px] text-ink-400">{t.prefix}…</span></span>
            <span className="text-[11px] text-ink-500 tabular-nums">{t.lastUsedAt ? `used ${new Date(t.lastUsedAt).toLocaleString()}` : 'never used'}</span>
            <button onClick={() => setRevoking(t)} className="p-1 text-ink-400 hover:text-risk-700" aria-label={`Revoke ${t.name}`}><Trash2 className="size-3.5" /></button>
          </li>
        ))}
        {!live.length && <li className="py-2 text-dense text-ink-400">No tokens yet.</li>}
      </ul>
      <div className="flex gap-2">
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="Okta" data-testid="scim-token-name" />
        <Button size="sm" onClick={() => create.mutate()} disabled={!name.trim() || create.isPending} data-testid="scim-token-create"><Plus /> New token</Button>
      </div>
      <ConfirmDialog
        open={!!revoking}
        title={`Revoke ${revoking?.name ?? 'token'}?`}
        confirmLabel={revoke.isPending ? 'Revoking…' : 'Revoke'}
        isPending={revoke.isPending}
        body={<>Your identity provider stops being able to create or deactivate people until you give it a new token.</>}
        onConfirm={() => revoking && revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) })}
        onCancel={() => setRevoking(null)}
      />
    </div>
  )
}

function ScimGroups({ roles }: { roles: string[] }) {
  const qc = useQueryClient()
  const { data } = useQuery<{ data: ScimGroup[] }>({ queryKey: ['scim-groups'], queryFn: () => api.get('/admin/sso/scim-groups').then(r => r.data) })
  const map = useMutation({
    mutationFn: async ({ id, roleName }: { id: string; roleName: string | null }) => api.patch(`/admin/sso/scim-groups/${id}`, { roleName }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scim-groups'] }),
  })
  const groups = data?.data ?? []
  if (!groups.length) return null
  return (
    <div className="bg-card border border-paper-200 rounded-card p-5" data-testid="scim-groups">
      <h2 className="text-section text-ink-950 mb-1">Groups</h2>
      <p className="text-dense text-ink-500 mb-3">Members of a group get its role, and lose it when they leave the group. Roles you gave by hand stay.</p>
      <ul className="divide-y divide-paper-200">
        {groups.map(g => (
          <li key={g.id} className="py-2 flex items-center gap-3 text-body">
            <span className="flex-1 text-ink-950">{g.displayName} <span className="text-[11px] text-ink-400">{g.memberCount} {g.memberCount === 1 ? 'member' : 'members'}</span></span>
            <select
              className="h-8 rounded-md border border-input bg-card px-2 text-[12.5px] text-ink-950"
              value={g.roleName ?? ''}
              onChange={e => map.mutate({ id: g.id, roleName: e.target.value || null })}
              aria-label={`Role for ${g.displayName}`}
            >
              <option value="">No role</option>
              {[...new Set([...(g.roleName ? [g.roleName] : []), ...roles])].map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
          </li>
        ))}
      </ul>
    </div>
  )
}
