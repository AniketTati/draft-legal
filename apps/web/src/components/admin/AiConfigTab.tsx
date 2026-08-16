/**
 * AI Config tab (D.0.8)
 *
 * The single surface where an org admin sees + controls how their tenant's
 * AI calls are routed. Five sections landing incrementally:
 *
 *   D.0.8a — Model routing  ← this commit
 *   D.0.8b — API keys (BYOK)
 *   D.0.8c — Cost cap + policy
 *   D.0.8d — Usage (30 days)
 *   D.0.8e — Audit log
 *
 * Section order mirrors the pattern from OpenAI Platform + Vercel settings:
 * routing first (the decision) → keys (the secret material) → cap (the guard
 * rail) → usage (the reality check) → audit (the evidence trail).
 */
import { useEffect, useState } from 'react'
import { sanitizeHtml } from '@/lib/sanitize'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/common/Toaster'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import {
  Cpu, Save, Info, KeyRound, Gauge, Activity, ScrollText,
  CheckCircle2, Sparkles, Plus, RotateCw, Trash2, AlertTriangle, ShieldCheck,
  X, Loader2,
} from 'lucide-react'
import { StatusPill } from '@/components/ui/status-pill'

// ─── Types ─────────────────────────────────────────────────────────────────

type Tier = 'reasoningModel' | 'defaultModel' | 'fastModel' | 'embedModel' | 'rerankModel' | 'visionOcrModel'
type PlatformTier = 'reasoning' | 'default' | 'fast' | 'embed' | 'rerank' | 'vision_ocr'

interface SettingsResponse {
  reasoningModel: string | null
  defaultModel: string | null
  fastModel: string | null
  embedModel: string | null
  rerankModel: string | null
  visionOcrModel: string | null
  dailyCostCapUsd: number | null
  capPolicy: 'block' | 'warn'
  platformRouting: Record<PlatformTier, Array<{ provider: string; model: string }>>
}

const TIER_META: Array<{
  key: Tier
  platformKey: PlatformTier
  label: string
  description: string
}> = [
  { key: 'reasoningModel', platformKey: 'reasoning',  label: 'Reasoning',  description: 'Deep analysis, multi-step planning, playbook reasoning.' },
  { key: 'defaultModel',   platformKey: 'default',    label: 'Default',    description: 'The workhorse tier — drafting, chat, routine extraction.' },
  { key: 'fastModel',      platformKey: 'fast',       label: 'Fast',       description: 'Sub-second responses — autocomplete, classification, suggestions.' },
  { key: 'embedModel',     platformKey: 'embed',      label: 'Embeddings', description: 'Vectorizes contracts + queries for semantic retrieval.' },
  { key: 'rerankModel',    platformKey: 'rerank',     label: 'Rerank',     description: 'Final-mile retrieval quality — orders candidate clauses.' },
  { key: 'visionOcrModel', platformKey: 'vision_ocr', label: 'Vision / OCR', description: 'Scanned PDFs and image-bearing prompts.' },
]

// ─── API keys (BYOK) types + metadata ─────────────────────────────────────

type Provider = 'openai' | 'anthropic' | 'google' | 'voyage' | 'cohere' | 'mistral'

interface KeyRow {
  provider: Provider
  configured: boolean
  keyPrefix: string | null
  isActive: boolean
  lastTestedAt: string | null
  testStatus: 'success' | 'failed' | null
  testError: string | null
  createdAt: string | null
  updatedAt: string | null
}

interface KeysResponse { data: KeyRow[] }

const PROVIDER_META: Array<{ id: Provider; label: string; placeholder: string; liveTest: boolean }> = [
  { id: 'openai',    label: 'OpenAI',    placeholder: 'sk-proj-…',   liveTest: true  },
  { id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…',    liveTest: true  },
  { id: 'google',    label: 'Google',    placeholder: 'AIza…',       liveTest: true  },
  { id: 'voyage',    label: 'Voyage',    placeholder: 'pa-…',        liveTest: false },
  { id: 'cohere',    label: 'Cohere',    placeholder: 'co-…',        liveTest: false },
  { id: 'mistral',   label: 'Mistral',   placeholder: 'sk-…',        liveTest: false },
]

// ─── Component ─────────────────────────────────────────────────────────────

export function AiConfigTab() {
  const queryClient = useQueryClient()

  const { data: settings, isLoading } = useQuery<SettingsResponse>({
    queryKey: ['admin-ai-settings'],
    queryFn: () => api.get('/admin/ai/settings').then(r => r.data),
  })

  // Local draft state — edits don't touch the server until Save.
  const [draft, setDraft] = useState<Record<Tier, string | null>>({
    reasoningModel:  null,
    defaultModel:    null,
    fastModel:       null,
    embedModel:      null,
    rerankModel:     null,
    visionOcrModel:  null,
  })

  // Seed draft from the server on first load (or refetch).
  useEffect(() => {
    if (!settings) return
    setDraft({
      reasoningModel:  settings.reasoningModel,
      defaultModel:    settings.defaultModel,
      fastModel:       settings.fastModel,
      embedModel:      settings.embedModel,
      rerankModel:     settings.rerankModel,
      visionOcrModel:  settings.visionOcrModel,
    })
  }, [settings])

  const isDirty = settings ? TIER_META.some(({ key }) => draft[key] !== settings[key]) : false

  const save = useMutation({
    mutationFn: (body: Partial<Record<Tier, string | null>>) =>
      api.put('/admin/ai/settings', body).then(r => r.data),
    onSuccess: () => {
      toast.success('Model routing saved')
      queryClient.invalidateQueries({ queryKey: ['admin-ai-settings'] })
    },
    onError: (e: any) => {
      toast.error('Save failed', { description: e?.response?.data?.detail ?? 'Unknown error' })
    },
  })

  const handleSave = () => {
    // Only send the fields that actually changed; backend strips undefineds
    // but sending a minimal payload keeps the audit diff tight.
    const changed: Partial<Record<Tier, string | null>> = {}
    for (const { key } of TIER_META) {
      if (settings && draft[key] !== settings[key]) changed[key] = draft[key]
    }
    if (Object.keys(changed).length === 0) return
    save.mutate(changed)
  }

  const handleReset = () => {
    if (!settings) return
    setDraft({
      reasoningModel:  settings.reasoningModel,
      defaultModel:    settings.defaultModel,
      fastModel:       settings.fastModel,
      embedModel:      settings.embedModel,
      rerankModel:     settings.rerankModel,
      visionOcrModel:  settings.visionOcrModel,
    })
  }

  return (
    <div className="max-w-3xl space-y-6">
      {/* ─── Page heading ─────────────────────────────────────────────── */}
      <div>
        {/*
          Configuring the model is admin work, not machine-authored output, so
          nothing on this tab wears the assist indigo or the diamond.
        */}
        <h1 className="text-title text-ink-950 flex items-center gap-2">
          <Cpu className="size-5 text-ink-700" />
          AI Config
        </h1>
        <p className="text-dense text-ink-500 mt-1">
          Control how this organization's AI calls are routed, billed, and audited.
        </p>
      </div>

      {/* ─── Section: Model routing ───────────────────────────────────── */}
      <section className="bg-card rounded-card border border-paper-200 p-5 space-y-4">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-section text-ink-950 flex items-center gap-2">
              <Sparkles className="size-4 text-ink-700" />
              Model routing
            </h2>
            <p className="text-dense text-ink-500 mt-1">
              Leave a tier on <span className="font-medium">Platform default</span> to let us pick the best available model,
              or pin it to a specific provider + model for reproducibility.
            </p>
          </div>
        </header>

        {isLoading && <div className="text-dense text-ink-400">Loading…</div>}

        {settings && (
          <div className="divide-y divide-paper-200 -mx-2">
            {TIER_META.map(({ key, platformKey, label, description }) => {
              const candidates = settings.platformRouting[platformKey] ?? []
              const value = draft[key] ?? '' // '' = platform default
              return (
                <div key={key} className="grid grid-cols-[minmax(0,140px)_1fr] gap-4 items-start px-2 py-3.5">
                  <div>
                    <div className="text-body font-medium text-ink-950">{label}</div>
                    <div className="text-[11px] text-ink-400 leading-snug mt-0.5">{description}</div>
                  </div>
                  <div className="space-y-1.5">
                    <select
                      value={value}
                      onChange={e => setDraft(d => ({ ...d, [key]: e.target.value || null }))}
                      className="w-full h-8 text-[13px] text-ink-950 rounded-md border border-input bg-card px-[11px] focus:outline-none focus:ring-[3px] focus:ring-brand-700/15 focus:border-brand-700 transition-colors"
                    >
                      <option value="">
                        Platform default{candidates[0] ? ` — ${candidates[0].provider}/${candidates[0].model}` : ''}
                      </option>
                      {candidates.map(c => {
                        const id = `${c.provider}/${c.model}`
                        return (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        )
                      })}
                    </select>
                    {/* A pin is a configuration fact, not a status — neutral. */}
                    {value && (
                      <div className="flex items-center gap-1.5 text-[11px] text-ink-700">
                        <CheckCircle2 className="size-3" />
                        Override active — always uses <span className="font-mono">{value}</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Info banner: explains where the platform-default list comes from */}
        {/* Standing documentation, not a state — info blue would have implied
            something was in flight. */}
        <div className="flex items-start gap-2.5 p-3 bg-paper-100 border border-paper-200 rounded-md">
          <Info className="size-4 text-ink-500 flex-shrink-0 mt-0.5" />
          <div className="text-[11px] text-ink-700 leading-relaxed">
            Platform defaults resolve in order of the tier's candidate list; the first provider with a
            configured key wins. Configure a BYOK key below to use your own provider account for any tier.
          </div>
        </div>

        {/* Save / Reset footer */}
        <div className="flex items-center justify-end gap-2 pt-3 border-t border-paper-200">
          {isDirty && (
            <Button variant="outline" onClick={handleReset} disabled={save.isPending}>
              Discard
            </Button>
          )}
          <Button onClick={handleSave} disabled={!isDirty || save.isPending} className="gap-2">
            <Save className="size-4" />
            {save.isPending ? 'Saving…' : isDirty ? 'Save changes' : 'Saved'}
          </Button>
        </div>
      </section>

      {/* ─── Section: API keys (BYOK) — D.0.8b ────────────────────────── */}
      <ApiKeysSection />

      {/* ─── Section: Cost cap — D.0.8c ──────────────────────────────── */}
      <CostCapSection />

      {/* ─── Section: Usage — D.0.8d ─────────────────────────────────── */}
      <UsageSection />

      {/* ─── Section: Audit log — D.0.8e ─────────────────────────────── */}
      <AuditLogSection />
    </div>
  )
}

// ─── AuditLogSection (D.0.8e) ──────────────────────────────────────────────
//
// Reverse-chronological timeline of every mutation to AI settings + BYOK
// keys. Reads from GET /admin/ai/audit (wired D.0.6). Each event is
// expandable to show the full metadata JSON — handy for debugging "what
// exactly did the cap move from/to?" without diving into the DB.
//
// Design reference:
//   - Stripe Events: prose "actor did X on Y" per row
//   - GitHub org audit log: filter dropdown, per-row expand with metadata
//   - Okta System Log: clear event-type pills, time-range filter
//
// We keep it to ~last 50 events for now. A "Load more" + date range picker
// is an obvious v1.1 extension; compliance teams who need wider windows
// will export via an endpoint (not built yet — filed as TODO for D1).

interface AuditEvent {
  id: string
  action: string
  resourceType: string
  resourceId: string
  metadata: Record<string, unknown>
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
  actor: { id: string; name: string | null; email: string | null } | null
}

interface AuditResponse { events: AuditEvent[] }

const AI_ACTIONS = [
  { value: '',                      label: 'All changes' },
  { value: 'AI_SETTINGS_UPDATED',   label: 'Settings updated' },
  { value: 'AI_KEY_CREATED',        label: 'Key created' },
  { value: 'AI_KEY_UPDATED',        label: 'Key rotated' },
  { value: 'AI_KEY_DELETED',        label: 'Key deleted' },
  { value: 'AI_KEY_TESTED',         label: 'Key tested' },
]

function AuditLogSection() {
  const [actionFilter, setActionFilter] = useState<string>('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const { data, isLoading } = useQuery<AuditResponse>({
    queryKey: ['admin-ai-audit', actionFilter],
    queryFn: () => {
      const q = actionFilter ? `?action=${actionFilter}&limit=50` : '?limit=50'
      return api.get(`/admin/ai/audit${q}`).then(r => r.data)
    },
  })

  const toggle = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })

  return (
    <section className="bg-card rounded-card border border-paper-200 p-5 space-y-4">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-section text-ink-950 flex items-center gap-2">
            <ScrollText className="size-4 text-ink-700" />
            Audit log
          </h2>
          <p className="text-dense text-ink-500 mt-1">
            Every change to model routing, BYOK keys, and the cost cap. Append-only —
            entries can never be edited or removed. Plaintext keys are never logged.
          </p>
        </div>
        <div>
          <select
            value={actionFilter}
            onChange={e => setActionFilter(e.target.value)}
            className="text-[13px] text-ink-950 rounded-md border border-input bg-card px-2.5 py-1.5 focus:outline-none focus:ring-[3px] focus:ring-brand-700/15 focus:border-brand-700"
            data-testid="audit-filter"
          >
            {AI_ACTIONS.map(a => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
        </div>
      </header>

      {isLoading && <div className="text-dense text-ink-400">Loading…</div>}

      {data && data.events.length === 0 && (
        <div className="py-10 text-center border border-dashed border-paper-200 rounded-md">
          <ScrollText className="size-6 text-ink-400 mx-auto mb-2" />
          <p className="text-body text-ink-950 font-semibold">
            {actionFilter ? `No "${AI_ACTIONS.find(a => a.value === actionFilter)?.label.toLowerCase()}" events yet` : 'No changes yet'}
          </p>
          <p className="text-[11px] text-ink-500 mt-1">
            Events will appear here as soon as an admin modifies AI settings or BYOK keys.
          </p>
        </div>
      )}

      {data && data.events.length > 0 && (
        <div className="divide-y divide-paper-200 -mx-2">
          {data.events.map(ev => (
            <AuditRow key={ev.id} event={ev} isOpen={expanded.has(ev.id)} onToggle={() => toggle(ev.id)} />
          ))}
        </div>
      )}

      {data && data.events.length >= 50 && (
        <div className="text-center py-2">
          <span className="text-[11px] text-ink-400">
            Showing the most recent 50 events. Export is coming in the first post-D0 iteration.
          </span>
        </div>
      )}
    </section>
  )
}

function AuditRow({ event, isOpen, onToggle }: { event: AuditEvent; isOpen: boolean; onToggle: () => void }) {
  const { icon: ActionIcon, color, bg } = actionVisual(event.action)
  const summary = summarizeEvent(event)

  return (
    <div className="px-2 py-2.5 hover:bg-paper-50 transition-colors">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-start gap-3 text-left"
        data-testid={`audit-row-${event.id}`}
      >
        <div className={`size-7 rounded-md ${bg} flex items-center justify-center flex-shrink-0 mt-0.5`}>
          <ActionIcon className={`size-3.5 ${color}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[12px] text-ink-950" dangerouslySetInnerHTML={{ __html: sanitizeHtml(summary) }} />
            <span className="text-[10px] text-ink-400 tabular-nums ml-auto flex-shrink-0" title={new Date(event.createdAt).toLocaleString()}>
              {formatRel(event.createdAt)}
            </span>
          </div>
          <div className="text-[10px] text-ink-400 mt-0.5 truncate">
            {event.actor?.email ?? 'system'}
            {event.ipAddress && <> · {event.ipAddress}</>}
          </div>
        </div>
      </button>
      {isOpen && (
        <div className="mt-2 ml-10 p-2.5 bg-paper-50 border border-paper-200 rounded-md">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-400 mb-1.5">
            Metadata
          </div>
          <pre className="text-[10px] font-mono text-ink-700 whitespace-pre-wrap break-all leading-relaxed">
{JSON.stringify(event.metadata, null, 2)}
          </pre>
          {event.userAgent && (
            <div className="mt-2 text-[10px] text-ink-400">
              <span className="font-medium">User-Agent:</span> <span className="font-mono break-all">{event.userAgent}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/*
 * Event type is taxonomy, not meaning — a config edit is not "in flight" and
 * adding a key is not "binding". Everything reads neutral so the one event that
 * genuinely removes capability, a deleted key, is the only colored glyph in the
 * timeline.
 */
function actionVisual(action: string): { icon: React.ElementType; color: string; bg: string } {
  switch (action) {
    case 'AI_SETTINGS_UPDATED': return { icon: Sparkles,    color: 'text-ink-700',  bg: 'bg-paper-100' }
    case 'AI_KEY_CREATED':      return { icon: Plus,        color: 'text-ink-700',  bg: 'bg-paper-100' }
    case 'AI_KEY_UPDATED':      return { icon: RotateCw,    color: 'text-ink-700',  bg: 'bg-paper-100' }
    case 'AI_KEY_DELETED':      return { icon: Trash2,      color: 'text-risk-700', bg: 'bg-risk-50'   }
    case 'AI_KEY_TESTED':       return { icon: ShieldCheck, color: 'text-ink-700',  bg: 'bg-paper-100' }
    default:                    return { icon: Info,        color: 'text-ink-700',  bg: 'bg-paper-100' }
  }
}

/**
 * Human-readable prose per event. Falls back to raw action name if we see
 * an action we don't have custom copy for (future-proofs when new AI_*
 * actions land). Returns HTML so we can bold actor + resource — safe
 * because every interpolated value is HTML-escaped first.
 */
function summarizeEvent(ev: AuditEvent): string {
  const actor = esc(ev.actor?.name ?? ev.actor?.email ?? 'system')
  const m = ev.metadata as Record<string, unknown>
  const provider = typeof m.provider === 'string' ? m.provider : null

  switch (ev.action) {
    case 'AI_SETTINGS_UPDATED': {
      const changed = (m.changed ?? {}) as Record<string, { from: unknown; to: unknown }>
      const fields = Object.keys(changed)
      const friendlyNames: Record<string, string> = {
        reasoningModel: 'reasoning model',
        defaultModel:   'default model',
        fastModel:      'fast model',
        embedModel:     'embedding model',
        rerankModel:    'rerank model',
        visionOcrModel: 'vision/OCR model',
        dailyCostCapUsd:'daily cap',
        capPolicy:      'enforcement policy',
      }
      if (fields.length === 0) {
        return `<b>${actor}</b> touched AI settings (no change)`
      }
      if (fields.length === 1) {
        const f = fields[0]
        const { from, to } = changed[f]
        return `<b>${actor}</b> changed ${esc(friendlyNames[f] ?? f)} from <code>${esc(String(from))}</code> to <code>${esc(String(to))}</code>`
      }
      return `<b>${actor}</b> updated ${fields.length} AI settings (${esc(fields.map(f => friendlyNames[f] ?? f).join(', '))})`
    }
    case 'AI_KEY_CREATED':
      return `<b>${actor}</b> added a <b>${esc(provider ?? 'BYOK')}</b> API key (prefix <code>${esc(String(m.keyPrefix ?? ''))}</code>)`
    case 'AI_KEY_UPDATED': {
      const prefix = m.keyPrefix as { from?: string; to?: string } | string | undefined
      if (prefix && typeof prefix === 'object' && 'from' in prefix && 'to' in prefix) {
        return `<b>${actor}</b> rotated <b>${esc(provider ?? 'BYOK')}</b> key (<code>${esc(String(prefix.from))}</code> → <code>${esc(String(prefix.to))}</code>)`
      }
      return `<b>${actor}</b> updated <b>${esc(provider ?? 'BYOK')}</b> key`
    }
    case 'AI_KEY_DELETED':
      return `<b>${actor}</b> removed the <b>${esc(provider ?? 'BYOK')}</b> API key (was <code>${esc(String(m.keyPrefix ?? ''))}</code>)`
    case 'AI_KEY_TESTED': {
      const ok = m.ok === true
      return `<b>${actor}</b> tested <b>${esc(provider ?? 'BYOK')}</b> key — ${ok ? '<span class="text-brand-700 font-medium">verified</span>' : '<span class="text-risk-700 font-medium">failed</span>'}`
    }
    default:
      return `<b>${actor}</b> performed <code>${esc(ev.action)}</code>`
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c])
}

// ─── ApiKeysSection (D.0.8b) ───────────────────────────────────────────────
//
// Shows one row per supported provider. A row has three UI states:
//   (1) Not configured → "Add key" button
//   (2) Configured     → status pill + prefix + last-tested + Test/Rotate/Remove
//   (3) Editing        → input field + Save (+Test) / Cancel
//
// Design reference: Vercel Environment Variables + Clerk integration tiles —
// per-row status dot, inline rotate, prefix-only display. We never return
// the plaintext back from GET /keys, so a "Reveal" action would be a lie.
//
// "Save & test" chains PUT /keys/:provider then POST /keys/:provider/test so
// the admin sees ✓/✗ without a second click. For providers where live-test
// is not yet implemented (voyage/cohere/mistral) we fall back to PUT only.

function ApiKeysSection() {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery<KeysResponse>({
    queryKey: ['admin-ai-keys'],
    queryFn: () => api.get('/admin/ai/keys').then(r => r.data),
  })

  // Which row is in edit mode + its input buffer.
  const [editing, setEditing] = useState<Provider | null>(null)
  const [buffer, setBuffer] = useState<string>('')
  // Per-row pending flag ("busy") so spinners don't block unrelated rows.
  const [busy, setBusy] = useState<Provider | null>(null)

  const putKey = useMutation({
    mutationFn: (params: { provider: Provider; apiKey: string }) =>
      api.put(`/admin/ai/keys/${params.provider}`, { apiKey: params.apiKey }).then(r => r.data),
  })
  const testKey = useMutation({
    mutationFn: (provider: Provider) =>
      api.post(`/admin/ai/keys/${provider}/test`, {}).then(r => r.data),
  })
  const deleteKey = useMutation({
    mutationFn: (provider: Provider) =>
      api.delete(`/admin/ai/keys/${provider}`).then(r => r.data),
  })

  const closeEditor = () => { setEditing(null); setBuffer('') }

  const handleSaveAndTest = async (provider: Provider) => {
    const key = buffer.trim()
    if (key.length < 8) {
      toast.error('Key looks too short', { description: 'Double-check you pasted the full API key.' })
      return
    }
    setBusy(provider)
    try {
      await putKey.mutateAsync({ provider, apiKey: key })
      const providerMeta = PROVIDER_META.find(p => p.id === provider)
      if (providerMeta?.liveTest) {
        const result = await testKey.mutateAsync(provider)
        if (result.ok) {
          toast.success(`${providerMeta.label} key verified`, { description: 'Next calls from your org will use this key.' })
        } else {
          toast.error(`${providerMeta.label} key saved but failed verification`, { description: result.error ?? 'Provider rejected the key.' })
        }
      } else {
        toast.success(`${providerMeta?.label ?? provider} key saved`, { description: 'We\'ll validate it on first real use.' })
      }
      closeEditor()
    } catch (e: any) {
      toast.error('Save failed', { description: e?.response?.data?.detail ?? 'Unknown error' })
    } finally {
      setBusy(null)
      queryClient.invalidateQueries({ queryKey: ['admin-ai-keys'] })
    }
  }

  const handleTest = async (provider: Provider) => {
    setBusy(provider)
    try {
      const result = await testKey.mutateAsync(provider)
      if (result.ok) toast.success('Key works ✓')
      else toast.error('Key rejected', { description: result.error ?? 'Provider returned an error.' })
    } catch (e: any) {
      toast.error('Test failed', { description: e?.response?.data?.detail ?? 'Unknown error' })
    } finally {
      setBusy(null)
      queryClient.invalidateQueries({ queryKey: ['admin-ai-keys'] })
    }
  }

  // Guarded by the shared ConfirmDialog rather than window.confirm — same
  // treatment as every other irreversible admin act on these surfaces.
  const [pendingDelete, setPendingDelete] = useState<Provider | null>(null)

  const handleDelete = async (provider: Provider) => {
    const providerMeta = PROVIDER_META.find(p => p.id === provider)
    setPendingDelete(null)
    setBusy(provider)
    try {
      await deleteKey.mutateAsync(provider)
      toast.success(`${providerMeta?.label ?? provider} key removed`)
      if (editing === provider) closeEditor()
    } catch (e: any) {
      toast.error('Remove failed', { description: e?.response?.data?.detail ?? 'Unknown error' })
    } finally {
      setBusy(null)
      queryClient.invalidateQueries({ queryKey: ['admin-ai-keys'] })
    }
  }

  const rowByProvider = new Map((data?.data ?? []).map(r => [r.provider, r]))

  return (
    <section className="bg-card rounded-card border border-paper-200 p-5 space-y-4">
      <header>
        <h2 className="text-section text-ink-950 flex items-center gap-2">
          <KeyRound className="size-4 text-ink-700" />
          API keys (BYOK)
        </h2>
        <p className="text-dense text-ink-500 mt-1">
          Use your own provider accounts. When a key is set for a provider, this org's calls to that provider
          bill your account and skip the platform cost cap.
        </p>
      </header>

      {isLoading && <div className="text-dense text-ink-400">Loading…</div>}

      {data && (
        <div className="divide-y divide-paper-200 -mx-2">
          {PROVIDER_META.map(({ id, label, placeholder, liveTest }) => {
            const row = rowByProvider.get(id)
            const isEditing = editing === id
            const isBusy = busy === id
            return (
              <div key={id} className="px-2 py-3.5">
                <div className="flex items-center gap-3">
                  {/* Provider glyph — plain text for now; swap for brand marks later */}
                  {/* Provider marks stay neutral — a vendor's brand hue would
                      collide with the five meanings this palette reserves. */}
                  <div className="size-9 rounded-md border border-paper-200 bg-paper-50 flex items-center justify-center text-[10px] font-bold uppercase tracking-[0.08em] text-ink-500 flex-shrink-0">
                    {label.slice(0, 3)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-body font-medium text-ink-950">{label}</span>
                      <KeyStatusPill row={row ?? null} liveTest={liveTest} />
                    </div>
                    <div className="text-[11px] text-ink-400 mt-0.5">
                      {row?.configured && row.keyPrefix ? (
                        <>
                          <span className="font-mono">{row.keyPrefix}••••••</span>
                          {row.lastTestedAt && <> · tested {formatRel(row.lastTestedAt)}</>}
                          {!row.lastTestedAt && liveTest && <> · untested</>}
                        </>
                      ) : (
                        <>No key configured · falls back to {row?.configured ? 'platform' : 'platform default or skips if unavailable'}</>
                      )}
                    </div>
                  </div>
                  {/* Actions column */}
                  {!isEditing && (
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {row?.configured ? (
                        <>
                          {liveTest && (
                            <Button
                              variant="ghost" size="sm"
                              onClick={() => handleTest(id)}
                              disabled={isBusy}
                              className="h-8 text-[12px] gap-1"
                            >
                              {isBusy ? <Loader2 className="size-3 animate-spin" /> : <ShieldCheck className="size-3" />}
                              Test
                            </Button>
                          )}
                          <Button
                            variant="ghost" size="sm"
                            onClick={() => { setEditing(id); setBuffer('') }}
                            disabled={isBusy}
                            className="h-8 text-[12px] gap-1"
                          >
                            <RotateCw className="size-3" />
                            Rotate
                          </Button>
                          <Button
                            variant="ghost" size="sm"
                            onClick={() => setPendingDelete(id)}
                            disabled={isBusy}
                            aria-label={`Remove ${label} key`}
                            className="h-8 text-[12px] gap-1 text-risk-700 hover:text-risk-700 hover:bg-risk-50"
                          >
                            <Trash2 className="size-3" />
                            Remove
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="outline" size="sm"
                          onClick={() => { setEditing(id); setBuffer('') }}
                          className="h-8 text-[12px] gap-1"
                        >
                          <Plus className="size-3" />
                          Add key
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                {/* ─── Inline editor ───────────────────────────────────── */}
                {isEditing && (
                  <div className="mt-3 ml-12 p-3 bg-paper-50 border border-paper-200 rounded-md space-y-2.5">
                    <div>
                      <label className="text-[11.5px] text-ink-950 font-semibold block mb-1.5">
                        {row?.configured ? `New ${label} key (replaces current)` : `${label} API key`}
                      </label>
                      <Input
                        type="password"
                        autoFocus
                        value={buffer}
                        onChange={e => setBuffer(e.target.value)}
                        placeholder={placeholder}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !isBusy) handleSaveAndTest(id)
                          if (e.key === 'Escape')          closeEditor()
                        }}
                        className="font-mono text-[11px]"
                        data-testid={`byok-input-${id}`}
                      />
                      <p className="text-[10px] text-ink-400 mt-1.5 leading-relaxed">
                        The key is encrypted at rest (AES-256-GCM) and never leaves this server in plaintext.
                        We store only the first 8 characters for display.
                      </p>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={closeEditor} disabled={isBusy} className="h-8 text-[12px] gap-1">
                        <X className="size-3" />
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleSaveAndTest(id)}
                        disabled={isBusy || buffer.trim().length < 8}
                        className="h-8 text-[12px] gap-1"
                      >
                        {isBusy ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
                        {isBusy ? 'Saving…' : liveTest ? 'Save & test' : 'Save'}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Neutral, not attention: this note is always on screen. Amber that never
          goes away stops meaning "your turn" — the Untested pill carries that. */}
      <div className="flex items-start gap-2.5 p-3 bg-paper-100 border border-paper-200 rounded-md">
        <AlertTriangle className="size-4 text-ink-500 flex-shrink-0 mt-0.5" />
        <div className="text-[11px] text-ink-700 leading-relaxed">
          Rotating a key invalidates its prior verification — we clear the tested-at timestamp and prompt
          you to test again. The action is logged in the audit trail with the old and new key prefixes
          (never the plaintext).
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete != null}
        testId="byok-delete-confirm"
        title="Remove this BYOK key?"
        confirmLabel="Remove key"
        body={
          <>
            Calls to{' '}
            <span className="font-medium text-ink-950">
              {PROVIDER_META.find(p => p.id === pendingDelete)?.label ?? pendingDelete}
            </span>{' '}
            fall back to the platform key. If your org has no platform key for this
            provider, every feature routed to it starts failing — extraction, review
            and the assistant included. The key cannot be recovered; you would need
            to paste it again.
          </>
        }
        onConfirm={() => pendingDelete && handleDelete(pendingDelete)}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  )
}

/*
 * Provider connection state, on the five meanings: no key is off (neutral), a
 * verified key is the binding "this works", a rejected one is risk, and a key
 * we could have tested but haven't is the admin's turn. Providers with no live
 * test ("Saved") stay neutral — there is nothing for the admin to do.
 */
function KeyStatusPill({ row, liveTest }: { row: KeyRow | null; liveTest: boolean }) {
  if (!row?.configured) return <StatusPill meaning="neutral">Not set</StatusPill>
  if (row.testStatus === 'success') return <StatusPill meaning="binding">Verified</StatusPill>
  if (row.testStatus === 'failed') return <StatusPill meaning="risk">Failed</StatusPill>
  return (
    <StatusPill meaning={liveTest ? 'turn' : 'neutral'}>
      {liveTest ? 'Untested' : 'Saved'}
    </StatusPill>
  )
}

function formatRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.round(ms / 60_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24)  return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return `${days}d ago`
}

// ─── CostCapSection (D.0.8c) ───────────────────────────────────────────────
//
// Shows today's spend-vs-cap progress band and controls to change the cap
// amount + the enforcement policy (block vs warn).
//
// Design reference: AWS Budgets zone-colored bar (< 50% green, 50-80% amber,
// > 80% red) + Vercel Usage Limit's hard-cap + soft-alert pair. The "reset
// at midnight UTC" caption is borrowed from OpenAI Platform's rate-limit
// dashboard so admins know when the counter flips.
//
// Sends only the changed fields to PUT /settings; backend calls
// invalidateCapConfig() (D.0.5) so the change takes effect on the next LLM
// call — not 30s later when the Redis TTL rolls.

interface CapStatus {
  usedUsd: number
  capUsd: number
  remainingUsd: number
  pctUsed: number
  policy: 'block' | 'warn'
  date: string
}

function CostCapSection() {
  const queryClient = useQueryClient()

  const { data: settings } = useQuery<SettingsResponse>({
    queryKey: ['admin-ai-settings'],
    queryFn: () => api.get('/admin/ai/settings').then(r => r.data),
  })
  // Refetch every 30s so the progress band feels live-ish without polling
  // aggressively. Real-time would need server-sent events; not worth it yet.
  const { data: capStatus } = useQuery<CapStatus>({
    queryKey: ['admin-ai-cap-status'],
    queryFn: () => api.get('/admin/ai/cap-status').then(r => r.data),
    refetchInterval: 30_000,
  })

  const [capInput, setCapInput] = useState<string>('')
  const [policyDraft, setPolicyDraft] = useState<'block' | 'warn'>('block')

  useEffect(() => {
    if (!settings) return
    setCapInput(settings.dailyCostCapUsd != null ? String(settings.dailyCostCapUsd) : '')
    setPolicyDraft(settings.capPolicy)
  }, [settings])

  const parsedCap = capInput === '' ? null : Number(capInput)
  const capValid  = parsedCap === null || (!Number.isNaN(parsedCap) && parsedCap >= 0 && parsedCap <= 100_000)
  const capDirty   = settings && (settings.dailyCostCapUsd ?? null) !== parsedCap
  const policyDirty = settings && settings.capPolicy !== policyDraft
  const isDirty = Boolean(capDirty || policyDirty)

  const save = useMutation({
    mutationFn: (body: { dailyCostCapUsd?: number | null; capPolicy?: 'block' | 'warn' }) =>
      api.put('/admin/ai/settings', body).then(r => r.data),
    onSuccess: () => {
      toast.success('Cost cap updated')
      queryClient.invalidateQueries({ queryKey: ['admin-ai-settings'] })
      queryClient.invalidateQueries({ queryKey: ['admin-ai-cap-status'] })
    },
    onError: (e: any) => {
      toast.error('Save failed', { description: e?.response?.data?.detail ?? 'Unknown error' })
    },
  })

  const handleSave = () => {
    if (!capValid || !isDirty) return
    const body: { dailyCostCapUsd?: number | null; capPolicy?: 'block' | 'warn' } = {}
    if (capDirty)    body.dailyCostCapUsd = parsedCap
    if (policyDirty) body.capPolicy = policyDraft
    save.mutate(body)
  }

  const handleReset = () => {
    if (!settings) return
    setCapInput(settings.dailyCostCapUsd != null ? String(settings.dailyCostCapUsd) : '')
    setPolicyDraft(settings.capPolicy)
  }

  // Zone color: < 50% green, 50–80% amber, > 80% red. The zone *names* feed
  // data-zone and stay as they are; only what they resolve to moves onto the
  // meaning ramp — headroom is binding, 80%+ is genuine risk of a hard stop.
  const pct = capStatus ? Math.min(1, Math.max(0, capStatus.pctUsed)) : 0
  const zone = pct < 0.5 ? 'green' : pct < 0.8 ? 'amber' : 'red'
  const barColor = zone === 'green' ? 'bg-brand-500' : zone === 'amber' ? 'bg-attention-600' : 'bg-risk-600'
  const trackColor = zone === 'green' ? 'bg-brand-50' : zone === 'amber' ? 'bg-attention-50' : 'bg-risk-50'

  return (
    <section className="bg-card rounded-card border border-paper-200 p-5 space-y-4">
      <header>
        <h2 className="text-section text-ink-950 flex items-center gap-2">
          <Gauge className="size-4 text-ink-700" />
          Cost cap
        </h2>
        <p className="text-dense text-ink-500 mt-1">
          Daily USD ceiling for platform-paid calls. BYOK calls (where you've pasted your own key above)
          bypass this cap — you bill your own provider directly.
        </p>
      </header>

      {/* ─── Progress band ───────────────────────────────────────────── */}
      {capStatus && (
        <div className="space-y-2">
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="text-title text-ink-950 tabular-nums">
                ${capStatus.usedUsd.toFixed(4)}
                <span className="text-body font-normal text-ink-400"> / ${capStatus.capUsd.toFixed(2)}</span>
              </div>
              <div className="text-[11px] text-ink-500 mt-0.5 tabular-nums">
                {(capStatus.pctUsed * 100).toFixed(1)}% of today's cap used
                {capStatus.remainingUsd > 0 && <> · ${capStatus.remainingUsd.toFixed(4)} remaining</>}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-ink-400 uppercase tracking-[0.08em] tabular-nums">{capStatus.date}</div>
              <div className="text-[10px] text-ink-400">resets at 00:00 UTC</div>
            </div>
          </div>
          <div
            className={`h-1 w-full rounded-full ${trackColor} overflow-hidden`}
            data-testid="cap-progress-bar"
            data-zone={zone}
          >
            <div
              className={`h-full ${barColor} transition-all duration-500 ease-out`}
              style={{ width: `${pct * 100}%` }}
              role="progressbar"
              aria-valuenow={Math.round(pct * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Today's AI spend as % of cap"
            />
          </div>
        </div>
      )}

      {/* ─── Controls ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-2">
        <div>
          <label className="text-[11.5px] text-ink-950 font-semibold block mb-1.5">
            Daily cap (USD)
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-ink-400 pointer-events-none">$</span>
            <Input
              type="number"
              min={0}
              max={100_000}
              step={0.01}
              value={capInput}
              onChange={e => setCapInput(e.target.value)}
              placeholder="50.00"
              className="pl-6 font-mono tabular-nums"
              data-testid="cost-cap-input"
            />
          </div>
          <p className="text-[10px] text-ink-400 mt-1 leading-relaxed">
            Leave blank to inherit the platform default ($50/day). Max $100,000.
          </p>
          {!capValid && (
            <p className="text-[11.5px] text-risk-700 mt-1">Enter a non-negative number up to 100,000.</p>
          )}
        </div>

        <div>
          <label className="text-[11.5px] text-ink-950 font-semibold block mb-1.5">
            Enforcement policy
          </label>
          <div className="inline-flex rounded-md border border-paper-200 p-0.5 bg-paper-50" role="radiogroup" aria-label="Enforcement policy">
            <PolicyChip
              value="block"
              current={policyDraft}
              onSelect={setPolicyDraft}
              label="Block"
              description="Hard stop once the cap is reached."
            />
            <PolicyChip
              value="warn"
              current={policyDraft}
              onSelect={setPolicyDraft}
              label="Warn"
              description="Log + let the call through."
            />
          </div>
          <p className="text-[10px] text-ink-400 mt-1.5 leading-relaxed">
            {policyDraft === 'block'
              ? 'Platform calls will return a CostCapExceededError once today\'s spend exceeds the cap.'
              : 'Platform calls will keep working; a warning is logged and surfaces in the audit trail.'}
          </p>
        </div>
      </div>

      {/* ─── Save footer ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-end gap-2 pt-3 border-t border-paper-200">
        {isDirty && (
          <Button variant="outline" onClick={handleReset} disabled={save.isPending}>
            Discard
          </Button>
        )}
        <Button onClick={handleSave} disabled={!isDirty || !capValid || save.isPending} className="gap-2">
          <Save className="size-4" />
          {save.isPending ? 'Saving…' : isDirty ? 'Save changes' : 'Saved'}
        </Button>
      </div>
    </section>
  )
}

// ─── UsageSection (D.0.8d) ─────────────────────────────────────────────────
//
// 30-day aggregated usage: three top-line tiles (spend, calls, tokens) plus
// horizontal-bar breakdowns by provider and by tier. No trend line yet —
// that waits for a chart dep in D1 when we'll also plot the agent-thread
// activity. Empty state is prominent because most orgs will see this
// section at $0 for the first week.
//
// Design reference: OpenAI Usage (top-line + model bars), Stripe Dashboard
// (tile row), Anthropic Console Usage (by-workspace slice).

interface UsageResponse {
  windowDays: number
  since: string
  totals: { inputTokens: number; outputTokens: number; costUsd: number; callCount: number }
  byDay:      Array<{ date: string; costUsd: number; callCount: number }>
  byProvider: Array<{ provider: string; costUsd: number; callCount: number }>
  byTier:     Array<{ tier: string; costUsd: number; callCount: number }>
}

function UsageSection() {
  const { data, isLoading } = useQuery<UsageResponse>({
    queryKey: ['admin-ai-usage'],
    queryFn: () => api.get('/admin/ai/usage').then(r => r.data),
  })

  return (
    <section className="bg-card rounded-card border border-paper-200 p-5 space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-section text-ink-950 flex items-center gap-2">
            <Activity className="size-4 text-ink-700" />
            Usage
          </h2>
          <p className="text-dense text-ink-500 mt-1">
            Platform-paid AI spend over the last {data?.windowDays ?? 30} days.
            BYOK traffic isn't tracked here — that bills your provider account directly.
          </p>
        </div>
        {data?.since && (
          <div className="text-[11px] text-ink-400 tabular-nums">
            since {data.since}
          </div>
        )}
      </header>

      {isLoading && <div className="text-dense text-ink-400">Loading…</div>}

      {data && data.totals.callCount === 0 && (
        <div className="py-10 text-center border border-dashed border-paper-200 rounded-md">
          <Activity className="size-6 text-ink-400 mx-auto mb-2" />
          <p className="text-body text-ink-950 font-semibold">No platform-paid calls yet</p>
          <p className="text-[11px] text-ink-500 mt-1 max-w-md mx-auto leading-relaxed">
            Usage fills in as the agents service records costs via <span className="font-mono">OrgUsageDaily</span>.
            BYOK calls (pasted above) do not appear here.
          </p>
        </div>
      )}

      {data && data.totals.callCount > 0 && (
        <>
          {/* Top-line tiles */}
          <div className="grid grid-cols-3 gap-3">
            <UsageTile
              label="Total spend"
              value={`$${data.totals.costUsd.toFixed(2)}`}
              sub={`${data.windowDays}d window`}
            />
            <UsageTile
              label="Calls"
              value={data.totals.callCount.toLocaleString()}
              sub={avgCost(data.totals)}
            />
            <UsageTile
              label="Tokens"
              value={formatTokens(data.totals.inputTokens + data.totals.outputTokens)}
              sub={`${formatTokens(data.totals.inputTokens)} in · ${formatTokens(data.totals.outputTokens)} out`}
            />
          </div>

          {/* Breakdowns */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
            <UsageBarCard
              title="By provider"
              rows={data.byProvider
                .slice()
                .sort((a, b) => b.costUsd - a.costUsd)
                .map(r => ({ label: r.provider, cost: r.costUsd, calls: r.callCount }))}
            />
            <UsageBarCard
              title="By tier"
              rows={data.byTier
                .slice()
                .sort((a, b) => b.costUsd - a.costUsd)
                .map(r => ({ label: r.tier, cost: r.costUsd, calls: r.callCount }))}
            />
          </div>
        </>
      )}

      <div className="flex items-start gap-2.5 p-3 bg-paper-50 border border-paper-200 rounded-md">
        <Info className="size-4 text-ink-500 flex-shrink-0 mt-0.5" />
        <div className="text-[11px] text-ink-500 leading-relaxed">
          Totals reflect completed calls only. For per-request prompts, tool invocations, and latency
          traces, open Langfuse — every call the agents service makes is recorded there with a link
          back to the contract or thread that triggered it.
        </div>
      </div>
    </section>
  )
}

function UsageTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-paper-200 rounded-card p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-400">{label}</div>
      <div className="text-title text-ink-950 mt-0.5 tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-ink-400 mt-0.5 tabular-nums">{sub}</div>}
    </div>
  )
}

function UsageBarCard({ title, rows }: { title: string; rows: Array<{ label: string; cost: number; calls: number }> }) {
  const max = Math.max(...rows.map(r => r.cost), 0)
  return (
    <div className="border border-paper-200 rounded-card p-3 space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-400">{title}</div>
      {rows.length === 0 && <div className="text-[11px] text-ink-400">No data</div>}
      {rows.map(r => (
        <div key={r.label} className="space-y-1">
          <div className="flex items-baseline justify-between text-[11px] gap-2">
            <span className="text-ink-700 font-medium truncate">{r.label}</span>
            <span className="text-ink-500 tabular-nums flex-shrink-0">
              ${r.cost.toFixed(2)} · {r.calls.toLocaleString()}
            </span>
          </div>
          {/* A share-of-spend bar carries no meaning — it's ink on paper, not a
              meter that turns amber. */}
          <div className="h-1 rounded-full bg-paper-100 overflow-hidden">
            <div
              className="h-full bg-ink-700"
              style={{ width: `${max > 0 ? (r.cost / max) * 100 : 0}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function avgCost(totals: { costUsd: number; callCount: number }): string {
  if (totals.callCount === 0) return ''
  const avg = totals.costUsd / totals.callCount
  return `avg $${avg.toFixed(4)} / call`
}

function PolicyChip({
  value, current, onSelect, label, description,
}: {
  value: 'block' | 'warn'
  current: 'block' | 'warn'
  onSelect: (v: 'block' | 'warn') => void
  label: string
  description: string
}) {
  const active = current === value
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={() => onSelect(value)}
      title={description}
      data-testid={`policy-${value}`}
      /*
       * Selection is an action, so both options invert to ink when chosen —
       * a red "Block" chip would have read as a failure rather than a setting.
       * Which policy is the strict one is carried by the caption below, which
       * already rewrites itself per choice.
       */
      className={
        'px-3 py-1.5 rounded-md text-[12px] font-semibold transition-colors ' +
        (active
          ? 'bg-ink-950 text-white shadow-e1'
          : 'text-ink-500 hover:bg-card')
      }
    >
      {label}
    </button>
  )
}
