/**
 * AgentHomePage — P7.3 (the user's "Genspark-style primary agent" ask)
 *
 * A first-class chat surface at /agent. Three-zone layout:
 *
 *   ┌─ ConversationList (260px) ─┬─────────── ChatCanvas ───────────┐
 *   │ + New conversation         │ Header: title + model + close    │
 *   │ Today                      │ ────────────────────────────────  │
 *   │   • What's in my queue?    │ <messages>                       │
 *   │   • Zynga MSA review       │ ...                              │
 *   │ Yesterday                  │ ────────────────────────────────  │
 *   │   • Datadog renewal        │ Persona starter prompts          │
 *   │   • Counterparty memory    │ Composer: full-width textarea    │
 *   └────────────────────────────┴──────────────────────────────────┘
 *
 * Key design choices:
 *
 *   • Same data plane as <SideAgentRail /> — uses `/api/v1/agent/chat`
 *     SSE streaming + GET /agent/threads. The two surfaces share thread
 *     state; switching between them mid-conversation just works.
 *
 *   • The dashboard at /dashboard remains the home (per docs/29 §3
 *     Pattern B+E). /agent is COMPLEMENTARY for users who want
 *     "everything via chat" — Genspark / Manus shape — without losing
 *     the queue-driven dashboard.
 *
 *   • Persona-curated starter prompts on empty thread: lifted from
 *     P7.1.4's buildSuggestions() but with role-aware variants (Maya
 *     sees legal-leaning prompts, Lisa sees procurement, etc.).
 *
 *   • No side rail on this page — the chat IS the page, so an
 *     additional rail would be redundant. The sidebar nav stays so
 *     users can hop back to /dashboard or /contracts in one click.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/auth'
import { useAgentStore } from '@/store/agent'
import { Button } from '@/components/ui/button'
import {
  Sparkles, Send, Plus, MessageSquare, ArrowLeft, Loader2, Bot,
  ChevronRight, ChevronDown, FileText, Building2, CalendarClock, Search, Wrench, X,
  Table as TableIcon, GitCompareArrows, ListChecks, FormInput, Trash2,
} from 'lucide-react'
import { ArtifactPane, type Artifact } from '@/components/agent/ArtifactPane'
import { artifactFromToolResult } from '@/components/agent/artifact-from-tool'
import { ActionPreview, type PendingAction } from '@/components/agent/ActionPreview'
import { parseActionChips } from '@/components/agent/action-chips'
import { ChipRow } from '@/components/agent/ChipButton'
import { MarkdownProse } from '@/components/agent/MarkdownProse'
import { cn } from '@/lib/utils'

interface ThreadSummary {
  id: string
  title: string | null
  scopeType: string | null
  scopeId: string | null
  createdAt: string
  updatedAt: string
  messageCount: number
  toolCallCount: number
}

/**
 * Turn a raw failure into something a user can act on.
 *
 * Shared by the streamed-error path and the outer catch. They used to differ:
 * the outer catch had this ladder and the streamed path had nothing, because
 * the streamed path threw from inside the frame-parse `try` and was swallowed.
 */
function friendlyAgentError(raw: string): string {
  if (/api\s+key|authentication|RuntimeError/i.test(raw)) {
    return 'The AI assistant isn\'t configured for your workspace yet. An admin needs to add an OpenAI or Anthropic API key in Organization → AI Config.'
  }
  if (/upstream|50[234]|fetch\s+failed|ECONNREFUSED|timeout/i.test(raw)) {
    return 'The AI assistant is temporarily unavailable — please try again in a moment.'
  }
  return 'Sorry, the AI assistant ran into a problem. Try again, or refresh if it persists.'
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  toolCalls?: Array<{
    name: string
    status: 'running' | 'ok' | 'error'
    // A2/U5 — entity title resolved from the tool result (contract title,
    // counterparty name, etc.) so chips read "contract_get · Mayo MSA"
    // instead of "contract_get". Populated client-side when the result
    // includes a `title`/`name` field on a single primary entity.
    entityTitle?: string
    // A4 — slow-tool heartbeat (tool_progress event) so long-running
    // calls show elapsed seconds instead of a frozen spinner.
    elapsedSec?: number
  }>
  // P5 — write-tool plan-then-execute. Proposals awaiting the user's
  // Apply/Cancel, rendered as ActionPreview cards (mirrors SideAgentRail).
  pendingActions?: PendingAction[]
  streaming?: boolean
  error?: string
  /** The user text that produced this turn, so a failed turn can be retried. */
  retryPrompt?: string
}

/**
 * The backend stores message content as Json. Concretely it's stored as
 * an array of `{ type: 'text', text: '...' }` blocks (Anthropic-shape)
 * so it can also carry tool_use / tool_result blocks in the future.
 * The chat UI wants a flat string. This function flattens any of:
 *   - a plain string (legacy / streamed)
 *   - { type: 'text', text }
 *   - [{ type: 'text', text }, { type: 'text', text }, ...]
 *   - anything else → JSON.stringify so we still render *something*
 *     instead of crashing the whole page.
 */
function normalizeMessageContent(raw: unknown): string {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw.map(b => normalizeMessageContent(b)).filter(Boolean).join('\n\n')
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    // tool_use / tool_result blocks — give a compact summary so the
    // user can see the call chain without us hiding the structured data.
    if (obj.type === 'tool_use' && typeof obj.name === 'string') {
      return `🛠 ${obj.name}(…)`
    }
    if (obj.type === 'tool_result') {
      const c = (obj.content as unknown)
      return typeof c === 'string' ? c : normalizeMessageContent(c)
    }
    // Fallback — don't crash, render the JSON in a fenced block.
    try { return '```json\n' + JSON.stringify(raw, null, 2) + '\n```' } catch { return '' }
  }
  return String(raw)
}

// ──────────────────────────────────────────────────────────────────
// Persona-curated starter prompts (P7.3.3)
// ──────────────────────────────────────────────────────────────────

interface StarterPrompt {
  icon: React.ComponentType<{ className?: string }>
  label: string
  prompt: string
}

// Persona-test fix #5: starter prompts no longer hardcode "Zynga Holdings",
// "Cloudwave", "Pacific Distribution Co." (which were sample names from the
// original demo org). Instead we hydrate `topCps` from /api/v1/counterparties
// at page mount and template the user's actual top counterparty into prompts.
// Falls back to "your top counterparty" if the org has none yet.
function starterPromptsFor(roles: string[], topCps: string[] = []): StarterPrompt[] {
  const has = (r: string) => roles.includes(r)
  // First top counterparty for "Brief me on the X relationship" prompts.
  // If the org has none, we drop the counterparty-specific starter rather
  // than show a fake name.
  const cp1 = topCps[0]
  const cp2 = topCps[1]

  if (has('LEGAL_COUNSEL') || has('LEGAL_OPS')) {
    const out: StarterPrompt[] = [
      { icon: FileText, label: 'Review my contracts in negotiation',
        prompt: 'List every contract I own that\'s in UNDER_NEGOTIATION status. For each, give me: counterparty, value, the top off-playbook risk, and what I should push back on next.' },
      { icon: Search, label: 'What\'s our typical liability cap position?',
        prompt: 'Use org_memory to retrieve our preferred / acceptable / fallback / walkaway positions on Limitation of Liability. Show me each with one example clause from a signed contract.' },
    ]
    if (cp1) {
      out.push({ icon: Building2, label: `Brief me on our ${cp1} relationship`,
        prompt: `Use counterparty_memory for ${cp1}. Show me every active and historical contract, key terms across all of them, total exposure, and any open risks.` })
    }
    out.push({ icon: CalendarClock, label: 'What\'s in my approval queue?',
      prompt: 'Use approval_list to fetch every approval awaiting my decision. For each: contract, counterparty, value, key risks, and your recommendation.' })
    return out
  }
  if (has('PROCUREMENT')) {
    const out: StarterPrompt[] = [
      { icon: CalendarClock, label: 'What renews in the next 90 days?',
        prompt: 'Use renewal_advice to list every contract I own expiring in the next 90 days. For each, show: counterparty, days to expiry, auto-renew status, and your renew/renegotiate/let-expire recommendation with rationale.' },
    ]
    if (cp1) {
      out.push({ icon: Search, label: `Decide on ${cp1}`,
        prompt: `Pull the most recent ${cp1} agreement details. What are the obligations, the renewal terms, and what should I do at the next renewal?` })
    }
    out.push({ icon: Building2, label: 'All vendor agreements at a glance',
      prompt: 'Use contract_search with type=VENDOR_AGREEMENT. For each, show counterparty, annual commit, expiry, and current health.' })
    out.push({ icon: FileText, label: 'Compare two vendors\' terms',
      prompt: 'Find every Vendor or License agreement we have. Show me a side-by-side of their payment terms, liability caps, and termination rights so I can spot the outliers.' })
    return out
  }
  if (has('SALES_REP')) {
    const out: StarterPrompt[] = [
      { icon: FileText, label: 'My deals in motion',
        prompt: 'List every contract I own that\'s in DRAFT, UNDER_NEGOTIATION, or PENDING_REVIEW. Tell me what\'s blocking each.' },
    ]
    if (cp1) {
      out.push({ icon: Building2, label: `What past deals do we have with ${cp1}?`,
        prompt: `Use counterparty_memory for ${cp1}. Show me every prior deal so I can avoid asking for terms we\\'ve already given.` })
    }
    if (cp2 || cp1) {
      const target = cp2 ?? cp1
      out.push({ icon: Sparkles, label: `Draft an SOW for the ${target} expansion`,
        prompt: `Draft an SOW for ${target} expansion based on our prior SOWs with them. Pull the template, populate with sensible defaults, and show me the draft.` })
    }
    return out
  }
  if (has('FINANCE') || has('APPROVER')) {
    const out: StarterPrompt[] = [
      { icon: CalendarClock, label: 'What\'s in my approval queue?',
        prompt: 'Use approval_list. For each pending approval: contract, counterparty, value, AI-summarised key risks, and your approve/hold/reject recommendation with reasoning.' },
      { icon: FileText, label: 'Renewals over $100K this year',
        prompt: 'Find every contract expiring in the next 12 months with annual value above $100K. Sort by expiry date and show total value at risk.' },
    ]
    if (cp1) {
      out.push({ icon: Search, label: `What\'s our exposure on ${cp1}?`,
        prompt: `Use counterparty_memory for ${cp1}. Show total committed value, payment terms, liability cap, and how much we\\'ve spent this year.` })
    }
    return out
  }
  // Default — admin / generic
  return [
    { icon: FileText, label: 'What needs my team\'s attention today?',
      prompt: 'Walk every contract that\'s currently UNDER_NEGOTIATION or PENDING_APPROVAL across the org. For each: counterparty, owner, days waiting, and what\'s blocking it.' },
    { icon: CalendarClock, label: 'Renewal pipeline next 90 days',
      prompt: 'Use renewal_advice (no contract id) to give me a portfolio view of every contract expiring in 90 days, grouped by recommendation (renew / renegotiate / let_expire).' },
    { icon: Building2, label: 'Top counterparties by exposure',
      prompt: 'List our top 5 counterparties by total contract value. For each, show contract count, total value, and any open risks.' },
    { icon: Search, label: 'Search across all contracts',
      prompt: 'Use portfolio_search to find every clause that mentions "auto-renew" or "automatic renewal" — give me a count by type and flag any with no notice-period requirement.' },
  ]
}

// ──────────────────────────────────────────────────────────────────
// Page
// ──────────────────────────────────────────────────────────────────

export function AgentHomePage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const qc = useQueryClient()
  const user = useAuthStore(s => s.user)
  const accessToken = useAuthStore(s => s.accessToken)
  const { activeThread, setActiveThread } = useAgentStore()

  const initialThreadId = searchParams.get('thread') ?? activeThread?.id ?? null
  const [threadId, setThreadId] = useState<string | null>(initialThreadId)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [composer, setComposer] = useState('')
  const [streaming, setStreaming] = useState(false)
  // U.5.1 — by-resource thread filter. null = unfiltered, 'pending' = chip
  // active but no resource picked yet (just visual cue), or a resource id.
  const [resourceFilter, setResourceFilter] = useState<string | null>(null)
  // U.5.2 — open artifacts for this thread. Latest sits on the right;
  // strip below the chat lets users re-open closed ones. The chat
  // canvas shrinks to ~480px when an artifact is open.
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  // U.5.2 / decision 14d-14 — Esc closes the artifact pane.
  useEffect(() => {
    if (!openArtifactId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenArtifactId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openArtifactId])

  // Threads list — fed by GET /agent/threads
  const { data: threadsData } = useQuery<{ threads: ThreadSummary[] }>({
    queryKey: ['agent-threads-home'],
    queryFn: () => api.get('/agent/threads?limit=30').then(r => r.data),
    staleTime: 10_000,
  })
  const threads = threadsData?.threads ?? []

  // P-feedback (2026-05-02). Load the skills catalogue so `send()` can
  // resolve `@slug` mentions to a real skillSlug and the composer can
  // surface autocomplete suggestions.
  const { data: skillsData } = useQuery<{ skills: Array<{ slug: string; name: string; description?: string }> }>({
    queryKey: ['agent-skills-home'],
    queryFn: () => api.get('/skills').then(r => r.data),
    staleTime: 60_000,
  })
  const skillsList = skillsData?.skills ?? []

  // P-feedback (2026-05-02). User reported "on assistant / ask I cannot
  // delete chats". The DELETE /agent/threads/:id endpoint already
  // exists; just exposing the action in the sidebar with optimistic
  // removal so the user gets immediate feedback.
  const deleteThread = useMutation({
    mutationFn: (id: string) => api.delete(`/agent/threads/${id}`).then(r => r.data),
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: ['agent-threads-home'] })
      const prev = qc.getQueryData<{ threads: ThreadSummary[] }>(['agent-threads-home'])
      qc.setQueryData<{ threads: ThreadSummary[] }>(['agent-threads-home'], (old) => ({
        threads: (old?.threads ?? []).filter(t => t.id !== id),
      }))
      // If user just deleted the OPEN thread, navigate away to a fresh one.
      if (id === threadId) {
        setMessages([])
        setActiveThread(null)
        setSearchParams({}, { replace: true })
      }
      return { prev }
    },
    onError: (_err, _id, ctx) => {
      // Roll back optimistic update.
      if (ctx?.prev) qc.setQueryData(['agent-threads-home'], ctx.prev)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['agent-threads-home'] })
    },
  })

  // ── Conversation-trace fix: track threadIds set by send() so the load
  // effect below doesn't refetch (and 404-wipe) a thread we JUST streamed.
  // The session_id from the agents service is used as the thread id; the
  // chat endpoint persists asynchronously after the stream, and there can
  // be a brief window where the GET would 404. Without this guard the
  // .catch() below cleared the just-streamed messages — the user-visible
  // bug "new conversation always breaks".
  const justStreamedThreadIdRef = useRef<string | null>(null)

  // Load full thread when threadId changes (only for thread CLICKS — not for
  // threads we just created via send())
  useEffect(() => {
    if (!threadId) { setMessages([]); return }
    if (justStreamedThreadIdRef.current === threadId) {
      // We set this threadId from send() — the messages are already in state,
      // do not refetch. Just keep the URL in sync.
      setSearchParams({ thread: threadId }, { replace: true })
      justStreamedThreadIdRef.current = null
      return
    }
    api.get(`/agent/threads/${threadId}`).then(r => {
      // Backend stores content as Json — concretely an array of
      // `{ type: 'text', text: '...' }` blocks (Anthropic-style) so it
      // can later carry tool_use / tool_result blocks too. The chat UI
      // wants a flat string. Normalize here so a single malformed
      // message can't blank the page.
      const data = r.data as {
        id: string
        title: string | null
        messages: Array<{ id: string; role: string; content: unknown }>
      }
      setMessages(data.messages.map(m => ({
        id: m.id,
        role: m.role as 'user' | 'assistant' | 'system',
        content: normalizeMessageContent(m.content),
      })))
      setActiveThread({ id: data.id, title: data.title ?? 'New conversation' })
      setSearchParams({ thread: data.id }, { replace: true })
    }).catch(() => {
      // Thread not found / archived — defensive: don't wipe in-memory
      // messages (we may have just streamed them), only clean the URL.
      // Resetting messages here was the source of the new-conversation bug.
      setSearchParams({}, { replace: true })
    })
  }, [threadId, setActiveThread, setSearchParams])

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ── New conversation ────────────────────────────────────────────
  const startNewConversation = () => {
    setThreadId(null)
    setMessages([])
    setActiveThread(null)
    setSearchParams({}, { replace: true })
  }

  // ── Send message ────────────────────────────────────────────────
  const send = async (text: string) => {
    const clean = text.trim()
    if (!clean || streaming) return

    // P-feedback (2026-05-02). User reported "I am not able to invoke
    // skills" on /agent. The Assistant page was sending the message
    // verbatim without extracting an `@skill-slug` token, so the API
    // never received `skillSlug`. The orchestrator's prompt-override
    // path was unreachable from this surface. Mirror what the rail
    // does: scan for the first `@slug` that resolves to a known skill
    // and forward it.
    const skillBySlug = new Set((skillsList ?? []).map(s => s.slug))
    let pickedSkill: string | undefined
    for (const m of clean.match(/@[a-z0-9-]+/gi) ?? []) {
      if (skillBySlug.has(m)) { pickedSkill = m; break }
    }

    const userMsgId = `u_${Date.now()}`
    const assistantMsgId = `a_${Date.now()}`
    setMessages(prev => [
      ...prev,
      { id: userMsgId, role: 'user', content: clean },
      { id: assistantMsgId, role: 'assistant', content: '', streaming: true, toolCalls: [], retryPrompt: clean },
    ])
    setComposer('')
    setStreaming(true)

    abortRef.current?.abort()
    abortRef.current = new AbortController()

    // Set by the error branch inside the frame loop and handled after it.
    let streamError: string | null = null

    try {
      const res = await fetch('/api/v1/agent/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${accessToken}`,
          'accept': 'text/event-stream',
        },
        body: JSON.stringify({
          message: clean,
          sessionId: threadId ?? undefined,
          agentMode: true,
          // Pin the same provider+model as the side rail (SideAgentRail) so
          // both surfaces give identical answers to identical questions.
          // Without this, the Assistant page silently used the org's default
          // model (often gpt-4o) which has known tool-call quirks — e.g.
          // passing query="*" to contract_search expecting a wildcard,
          // which returns zero hits. See "Assistant vs Ask" bug fix.
          provider: 'openai',
          modelId:  'gpt-4.1-mini',
          ...(pickedSkill ? { skillSlug: pickedSkill } : {}),
        }),
        signal: abortRef.current.signal,
      })
      if (!res.ok || !res.body) throw new Error(`Stream failed (${res.status})`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let assembled = ''
      let newSessionId: string | undefined
      // Track tool calls locally so we can persist them after stream end.
      // Reading from React state inside this fn would be a stale-closure trap.
      const localToolCalls: Array<{ name: string; status: 'running' | 'ok' | 'error'; args?: unknown; result?: string }> = []

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n'); buf = lines.pop() ?? ''
        for (const ln of lines) {
          if (!ln.startsWith('data:')) continue
          const data = ln.slice(5).trim()
          if (data === '[DONE]') continue
          try {
            const evt = JSON.parse(data)
            if (evt.session_id) newSessionId = evt.session_id
            if (evt.type === 'token' && (evt.delta || evt.content)) {
              assembled += (evt.delta ?? evt.content)
              setMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, content: assembled } : m,
              ))
            } else if (evt.type === 'tool_call_start' && evt.name) {
              localToolCalls.push({ name: evt.name, status: 'running', args: evt.args })
              setMessages(prev => prev.map(m =>
                m.id === assistantMsgId
                  ? { ...m, toolCalls: [...(m.toolCalls ?? []), { name: evt.name, status: 'running' }] }
                  : m,
              ))
            } else if (evt.type === 'tool_progress' && evt.name) {
              // A4 heartbeat — surface elapsed seconds on the running chip
              // so slow tools don't look frozen (parity with SideAgentRail).
              setMessages(prev => prev.map(m =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      toolCalls: (m.toolCalls ?? []).map(tc =>
                        tc.name === evt.name && tc.status === 'running'
                          ? { ...tc, elapsedSec: Number(evt.elapsedSec) || undefined }
                          : tc,
                      ),
                    }
                  : m,
              ))
            } else if (evt.type === 'tool_call_awaiting_confirmation' && evt.name) {
              // P5 — write-tool plan-then-execute (parity with SideAgentRail).
              // Append a PendingAction so an ActionPreview card renders;
              // Apply POSTs /agent/threads/:id/actions/apply.
              const tcId = String(evt.id ?? `tc_${Date.now()}`)
              const toolName = String(evt.name)
              const args = (evt.args && typeof evt.args === 'object') ? evt.args as Record<string, unknown> : {}
              const preview = (evt.preview && typeof evt.preview === 'object') ? evt.preview as Record<string, unknown> : null
              const summary = String(preview?.summary ?? `Apply ${toolName}`)
              const target = preview?.target ? String(preview.target)
                : preview?.title      ? String(preview.title)
                : preview?.contractId ? `Contract ${String(preview.contractId).slice(0, 12)}…`
                : undefined
              const diff = Array.isArray(preview?.diff)
                ? preview.diff as Array<{ field: string; before: string | number | null; after: string | number | null }>
                : undefined
              const action: PendingAction = {
                id: tcId,
                toolName,
                status: 'awaiting_confirmation',
                summary,
                args,
                target,
                diff,
                reversible: Boolean(evt.reversible),
              }
              // The proposal also closes out the running chip for this tool.
              setMessages(prev => prev.map(m =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      toolCalls: (m.toolCalls ?? []).map(tc =>
                        tc.name === toolName && tc.status === 'running' ? { ...tc, status: 'ok' as const } : tc,
                      ),
                      pendingActions: [...(m.pendingActions ?? []), action],
                    }
                  : m,
              ))
              const local = [...localToolCalls].reverse().find(t => t.name === toolName && t.status === 'running')
              if (local) { local.status = 'ok'; local.result = 'awaiting_user_confirmation' }
            } else if (evt.type === 'tool_call_result' && evt.name) {
              const tc = [...localToolCalls].reverse().find(t => t.name === evt.name && t.status === 'running')
              if (tc) {
                tc.status = 'ok'
                tc.result = typeof evt.result === 'string' ? evt.result : JSON.stringify(evt.result ?? null)
              }
              // A2/U5 — extract entity title from the tool result so the chip
              // shows "contract_get · Mayo Clinic — MSA" instead of "contract_get".
              // Single-entity tools only (contract_get / counterparty_get /
              // matter_get + their summarize/memory siblings).
              let entityTitle: string | undefined
              const looksLikeSingleEntity =
                evt.name === 'contract_get' ||
                evt.name === 'contract_summarize' ||
                evt.name === 'counterparty_get' ||
                evt.name === 'counterparty_memory' ||
                evt.name === 'matter_get'
              if (looksLikeSingleEntity && evt.result) {
                try {
                  const json = typeof evt.result === 'string' ? JSON.parse(evt.result) : evt.result
                  if (json && typeof json === 'object') {
                    const obj = json as Record<string, unknown>
                    const title = (obj.title ?? obj.name ?? obj.legalName) as string | undefined
                    if (typeof title === 'string' && title.length > 0) {
                      entityTitle = title.length > 50 ? title.slice(0, 49) + '…' : title
                    }
                  }
                } catch { /* result not JSON — leave entityTitle undefined */ }
              }
              setMessages(prev => prev.map(m =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      toolCalls: (m.toolCalls ?? []).map(tc =>
                        tc.name === evt.name && tc.status === 'running'
                          ? { ...tc, status: 'ok', ...(entityTitle ? { entityTitle } : {}) }
                          : tc,
                      ),
                    }
                  : m,
              ))
              // U.5.2 — try to render this tool's result as an artifact
              // on the right pane. Only structurally-rich tool calls
              // produce one (contract_search → Table, draft → Doc, etc.)
              //
              // The orchestrator emits `result` as a TRUNCATED JSON STRING
              // (cap varies per tool — see orchestrator.py limits). Parse it
              // back to an object before pattern-matching on shape; otherwise
              // .html / .items / .results are all undefined and every tool
              // result returns null. (This was the "Doc artifact not showing"
              // bug — see commit history.)
              try {
                let parsedResult: unknown = evt.result
                if (typeof parsedResult === 'string') {
                  try { parsedResult = JSON.parse(parsedResult) }
                  catch { /* leave as string — non-JSON tool results don't make artifacts anyway */ }
                }
                const artifact = artifactFromToolResult({ name: evt.name, result: parsedResult })
                if (artifact) {
                  // P61 audit (2026-05-02). Dedupe on stable content key
                  // so the same tool firing twice in a turn doesn't
                  // stack near-identical cards in the right pane.
                  // When the new artifact has the same dedupeKey as
                  // an existing one, replace it (keeping the new id
                  // so the pane re-renders with fresh content) rather
                  // than appending.
                  setArtifacts(prev => {
                    const dk = artifact.dedupeKey
                    if (!dk) return [...prev, artifact]
                    const existing = prev.findIndex(a => a.dedupeKey === dk)
                    if (existing >= 0) {
                      const next = prev.slice()
                      next[existing] = artifact
                      return next
                    }
                    return [...prev, artifact]
                  })
                  setOpenArtifactId(artifact.id)
                }
              } catch (err) {
                console.warn('[artifact] failed to render:', err)
              }
            } else if (evt.type === 'error' || evt.error) {
              // Recorded, not thrown. This catch tolerates one malformed frame
              // by ignoring it, so throwing from here discarded every agent
              // failure and left an empty bubble.
              //
              // `evt.error` without a type is also matched: routes/chat.py's
              // legacy handler emits a bare {"error": …} envelope, which the
              // old `evt.type === 'error'` test never saw at all.
              streamError = evt.error || 'agent error'
              break
            }
          } catch {
            // ignore parse errors
          }
        }
        if (streamError) break
      }

      if (streamError) {
        // Render the failure AND let the persistence block below run: the
        // guard is `assembled.trim().length > 0`, so a failed turn used to be
        // dropped entirely and vanish on refresh — the user could not even
        // show anyone what happened.
        const friendly = friendlyAgentError(streamError)
        assembled = assembled || friendly
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId
            ? { ...m, streaming: false, error: streamError!, content: m.content || friendly }
            : m,
        ))
      } else {
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId ? { ...m, streaming: false } : m,
        ))
      }

      // ── Persist this turn server-side so the conversation survives a
      // refresh. The agents service is stateless; the chat endpoint just
      // streams. Frontend captures the session_id from the stream and
      // (a) upserts an AgentThread row with id=session_id, (b) appends
      // the user msg + assistant msg + tool calls in one transaction.
      // Failures here are non-fatal — the in-memory conversation still
      // works, the user just loses persistence on this turn.
      // A run that fails before the agents service emits `session_id` — an
      // unconfigured key, a provider 400 — leaves nothing to persist against,
      // so the whole turn used to vanish on reload and the user could not show
      // anyone what happened. Mint an id for that case; the threads endpoint
      // upserts on it, so a client-minted id is a real thread from then on.
      const sidToPersist = newSessionId ?? threadId
        ?? (streamError ? (globalThis.crypto?.randomUUID?.() ?? `err-${Date.now()}`) : null)
      if (sidToPersist && assembled.trim().length > 0) {
        try {
          // Upsert thread (idempotent on id) — first turn creates, later turns no-op.
          await api.post('/agent/threads', {
            id: sidToPersist,
            title: clean.length > 60 ? clean.slice(0, 57) + '…' : clean,
          })
          // Append the turn (user msg + assistant msg + tool_calls)
          await api.post(`/agent/threads/${sidToPersist}/turns`, {
            userMessage: clean,
            assistant: {
              content: assembled,
            },
            toolCalls: localToolCalls
              .filter(tc => tc.status === 'ok' || tc.status === 'error')
              .map(tc => ({
                toolName: tc.name,
                args: (tc.args && typeof tc.args === 'object') ? tc.args as Record<string, unknown> : {},
                status: tc.status === 'ok' ? 'success' : 'error',
                result: tc.result ?? '',
              })),
          })
        } catch (e) {
          // Persistence failure is non-fatal — the user can still see + use
          // the in-memory conversation. Refresh would lose it; that's the
          // worst case, and far better than blanking the page.
          console.warn('[agent] failed to persist thread/turn:', e)
        }
      }

      // Mark the just-streamed id so the load-effect doesn't refetch (which
      // could 404 if persistence is still in flight). Set whenever this turn
      // was persisted, not only when a NEW session id appeared: on an existing
      // thread the refetch would otherwise replace local state with the
      // server's, discarding client-only fields — which is how a failed turn
      // lost its error detail and its Try again button while still showing the
      // friendly text.
      if (sidToPersist) justStreamedThreadIdRef.current = sidToPersist
      if (newSessionId && newSessionId !== threadId) {
        setThreadId(newSessionId)
      }
      // refresh thread list to surface the new conversation
      qc.invalidateQueries({ queryKey: ['agent-threads-home'] })
    } catch (e) {
      const msg = (e as Error).message
      const friendly = friendlyAgentError(msg)
      setMessages(prev => prev.map(m =>
        m.id === assistantMsgId
          ? { ...m, streaming: false, error: msg, content: m.content || friendly }
          : m,
      ))
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  // ── P5 — write-tool Apply / Cancel / Undo (parity with SideAgentRail) ──
  // Apply POSTs /agent/threads/:id/actions/apply; the server enforces
  // orgId/authorId from the JWT, records a ToolCall row, and fires the
  // AGENT_TOOL_APPLIED audit event. Undo targets the returned toolCallId
  // within the 15-min server-side window.
  const patchAction = (msgId: string, actionId: string, patch: Partial<PendingAction>) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== msgId) return m
      return {
        ...m,
        pendingActions: (m.pendingActions ?? []).map(a => a.id === actionId ? { ...a, ...patch } : a),
      }
    }))
  }

  async function applyAction(msgId: string, actionId: string, editedArgs: Record<string, unknown>) {
    // Read the toolName inside the functional update (parity with the
    // rail) — `messages` from the render closure can be stale if state
    // moved between render and click.
    let toolName = ''
    setMessages(prev => prev.map(m => {
      if (m.id !== msgId) return m
      return {
        ...m,
        pendingActions: (m.pendingActions ?? []).map(a => {
          if (a.id !== actionId) return a
          toolName = a.toolName
          return { ...a, status: 'running' as const, args: editedArgs }
        }),
      }
    }))
    // Visual yield so the "running" state renders before the await.
    await new Promise(ok => setTimeout(ok, 0))
    if (!toolName) return
    if (!threadId) {
      // No persisted thread → the apply RPC can't record a ToolCall row.
      patchAction(msgId, actionId, { status: 'error', errorMessage: 'Thread not persisted yet — try again in a moment.' })
      return
    }
    try {
      const r = await fetch(`/api/v1/agent/threads/${threadId}/actions/apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken ?? ''}`,
        },
        body: JSON.stringify({ toolName, args: editedArgs, messageId: msgId, actionId }),
      })
      const body = await r.json().catch(() => ({ ok: false, error: { detail: 'Non-JSON response' } }))
      if (r.ok && body.ok) {
        patchAction(msgId, actionId, {
          status: 'applied',
          resultPreview: JSON.stringify(body.result).slice(0, 400),
          toolCallId: body.toolCallId,
          appliedAt: Date.now(),
        })
      } else {
        const errDetail = typeof body?.error === 'object'
          ? (body.error?.detail ?? JSON.stringify(body.error).slice(0, 200))
          : (body?.error ?? body?.detail ?? `HTTP ${r.status}`)
        patchAction(msgId, actionId, { status: 'error', errorMessage: String(errDetail) })
      }
    } catch (e) {
      patchAction(msgId, actionId, { status: 'error', errorMessage: (e as Error).message })
    }
  }

  function cancelAction(msgId: string, actionId: string) {
    patchAction(msgId, actionId, { status: 'cancelled' })
  }

  async function undoAction(msgId: string, actionId: string) {
    const msg = messages.find(m => m.id === msgId)
    const action = msg?.pendingActions?.find(a => a.id === actionId)
    if (!action?.toolCallId || !threadId) return
    try {
      const r = await fetch(`/api/v1/agent/threads/${threadId}/actions/${action.toolCallId}/undo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken ?? ''}` },
      })
      const body = await r.json().catch(() => ({ ok: false }))
      if (r.ok && body.ok) patchAction(msgId, actionId, { status: 'undone' })
      else patchAction(msgId, actionId, { status: 'error', errorMessage: String(body?.detail ?? body?.error ?? `Undo failed (${r.status})`) })
    } catch (e) {
      patchAction(msgId, actionId, { status: 'error', errorMessage: (e as Error).message })
    }
  }

  // ── Render ──────────────────────────────────────────────────────
  // Persona-test fix #5: pull org's actual top counterparties so starter
  // prompts reference real names (e.g. "Brief me on Snowflake" for Vertex,
  // "Brief me on Mayo Clinic" for Caldera) instead of leaked demo names.
  const { data: topCpsData } = useQuery({
    queryKey: ['counterparties-top'],
    queryFn: async () => {
      const r = await api.get('/counterparties?limit=10&orderBy=contractCount')
      return r.data
    },
    staleTime: 5 * 60 * 1000,
  })
  const topCpNames: string[] = ((topCpsData?.data ?? topCpsData?.counterparties ?? []) as Array<{ name?: string }>)
    .map(c => c?.name ?? '')
    .filter(Boolean)
    .slice(0, 5)
  const starters = starterPromptsFor(user?.roles ?? [], topCpNames)
  const groupedThreads = groupByTime(threads)

  return (
    <div
      className="h-full flex bg-white"
      data-testid="agent-home"
      data-streaming={streaming ? 'true' : 'false'}
      aria-busy={streaming || undefined}
    >
      {/* U4/A6 — presence-based streaming markers (matches SideAgentRail). */}
      {streaming && (
        <span data-testid="agent-streaming" aria-hidden="true" className="sr-only">
          Agent is generating a response…
        </span>
      )}
      {!streaming && messages.length > 0 && (
        <span data-testid="agent-done" aria-hidden="true" className="sr-only">
          Agent response complete.
        </span>
      )}

      {/* ─── Conversation list (left) ─────────────────────────── */}
      <aside className="w-64 border-r border-gray-200 bg-gray-50/50 flex flex-col">
        <div className="px-3 py-3 border-b border-gray-200">
          <Button
            onClick={startNewConversation}
            data-testid="agent-new-conversation"
            className="w-full justify-start gap-2 bg-indigo-600 hover:bg-indigo-700 text-white"
            size="sm"
          >
            <Plus className="h-4 w-4" />
            New conversation
          </Button>
        </div>

        {/* U.5.1 — by-resource filter chip. Lets users quickly find
            "every thread about Zynga MSA" — replaces the per-contract
            "Ask" tab pattern. */}
        <div className="px-3 pt-2 pb-1.5 border-b border-gray-100 flex items-center gap-1.5 text-[11px]">
          <span className="text-gray-400">Filter:</span>
          <button
            onClick={() => setResourceFilter(resourceFilter ? null : 'pending')}
            data-testid="thread-filter-by-resource"
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border transition-colors ${
              resourceFilter
                ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                : 'bg-white border-gray-200 hover:bg-gray-50 text-gray-700'
            }`}
          >
            by resource
            {resourceFilter ? (
              <X className="h-2.5 w-2.5" />
            ) : (
              <ChevronDown className="h-2.5 w-2.5" />
            )}
          </button>
          {resourceFilter && (
            <span className="text-[10.5px] text-indigo-600 truncate">
              {resourceFilter === 'pending' ? 'pick a resource…' : resourceFilter}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
          {threads.length === 0 ? (
            <div className="text-center text-xs text-gray-400 py-6 px-2">
              No conversations yet. Ask the agent something to start.
            </div>
          ) : (
            Object.entries(groupedThreads).map(([bucket, list]) => (
              <div key={bucket}>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold px-2 mb-1">{bucket}</div>
                <ul className="space-y-0.5">
                  {list.map(t => {
                    const active = t.id === threadId
                    return (
                      <li key={t.id} className="group relative">
                        <button
                          onClick={() => setThreadId(t.id)}
                          data-testid={`thread-row-${t.id}`}
                          className={`w-full text-left px-2 py-1.5 pr-7 rounded-md transition-colors ${
                            active ? 'bg-indigo-50 text-indigo-900 border border-indigo-200' : 'hover:bg-gray-100 text-gray-700'
                          }`}
                        >
                          <div className="flex items-center gap-1.5">
                            <MessageSquare className="h-3 w-3 shrink-0 opacity-60" />
                            <span className="text-[12px] truncate">
                              {t.title || 'Untitled conversation'}
                            </span>
                          </div>
                          {(t.messageCount ?? 0) > 0 && (
                            <div className="text-[10px] text-gray-400 mt-0.5 ml-4.5">
                              {t.messageCount} message{t.messageCount === 1 ? '' : 's'}
                              {t.toolCallCount > 0 && ` · ${t.toolCallCount} tool call${t.toolCallCount === 1 ? '' : 's'}`}
                            </div>
                          )}
                        </button>
                        {/* P-feedback (2026-05-02). Delete-chat button.
                            Hidden until row hover so the list stays clean.
                            Click stops propagation so it doesn't also
                            switch to the thread we're about to delete. */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (deleteThread.isPending) return
                            if (window.confirm(`Delete "${t.title || 'this conversation'}"? This cannot be undone.`)) {
                              deleteThread.mutate(t.id)
                            }
                          }}
                          data-testid={`thread-delete-${t.id}`}
                          aria-label="Delete conversation"
                          title="Delete conversation"
                          className="absolute right-1.5 top-1.5 p-1 rounded text-gray-300 opacity-0 group-hover:opacity-100 hover:text-red-600 hover:bg-red-50 transition-all"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* ─── Chat canvas ──────────────────────────────────────── */}
      {/* U.5.2 — when an artifact is open, the chat shrinks to 480px
          (decision 14d-8) and the artifact pane takes the rest. */}
      <main
        className={cn(
          'flex flex-col min-w-0',
          openArtifactId ? 'w-[480px] shrink-0' : 'flex-1',
        )}
      >
        <header className="px-6 py-3 border-b border-gray-200 flex items-center justify-between bg-white">
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate('/dashboard')}
              className="p-1 rounded hover:bg-gray-100 text-gray-500"
              aria-label="Back to dashboard"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-2">
              {/* U.2.1 / decision 14a — indigo accent for Assistant */}
              <div className="h-7 w-7 rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center">
                <Bot className="h-3.5 w-3.5 text-indigo-600" />
              </div>
              <div>
                <h1 className="text-sm font-semibold text-gray-900">Assistant</h1>
                <p className="text-[11px] text-gray-500">{activeThread?.title ?? 'New conversation'}</p>
              </div>
            </div>
          </div>
          <div className="text-[11px] text-gray-400">
            {streaming ? <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> thinking…</span>
                       : 'Press ⌘K from anywhere to open'}
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto" data-testid="agent-messages">
          {messages.length === 0 ? (
            <EmptyChat starters={starters} userName={user?.name ?? ''} onPick={(p) => send(p)} />
          ) : (
            <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
              {messages.map(m => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  streaming={streaming}
                  onChipSelect={(text) => {
                    // P1 fix — chip click sends the chip text as the next user
                    // turn via the same path as composer-submit.
                    if (!streaming) send(text)
                  }}
                  onActionApply={(actionId, args) => applyAction(m.id, actionId, args)}
                  onActionCancel={(actionId) => cancelAction(m.id, actionId)}
                  onActionUndo={(actionId) => undoAction(m.id, actionId)}
                  onRetry={(prompt) => { if (!streaming && prompt) send(prompt) }}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* U.5.2 — artifact strip. Lets users re-open closed artifacts
            for this thread. Only renders when there's at least one. */}
        {artifacts.length > 0 && (
          <div className="border-t border-gray-100 px-4 py-2 flex items-center gap-2 text-[11.5px] flex-wrap">
            <span className="text-gray-400">Artifacts:</span>
            {artifacts.map(a => {
              const Icon =
                a.kind === 'doc'   ? FileText :
                a.kind === 'table' ? TableIcon :
                a.kind === 'diff'  ? GitCompareArrows :
                a.kind === 'form'  ? FormInput :
                                     ListChecks
              const active = a.id === openArtifactId
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setOpenArtifactId(active ? null : a.id)}
                  data-testid={`artifact-strip-${a.id}`}
                  data-artifact-kind={a.kind}
                  data-artifact-dedupe-key={a.dedupeKey ?? ''}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-2 py-1 rounded-md font-medium transition-colors',
                    active
                      ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                      : 'bg-white text-gray-700 border border-gray-200 hover:border-indigo-300',
                  )}
                >
                  <Icon className="h-3 w-3" />
                  <span className="truncate max-w-[180px]">{a.title}</span>
                </button>
              )
            })}
          </div>
        )}

        {/* Composer */}
        <div className="border-t border-gray-200 bg-white px-6 py-3">
          <div className="max-w-3xl mx-auto">
            {/* P-feedback (2026-05-02). Skill autocomplete picker —
                shows when the user types `@<query>` so they can
                discover and pick a skill. Click inserts the slug
                into the composer; the orchestrator then applies the
                skill's systemPrompt for that turn. */}
            {(() => {
              const m = composer.match(/(?:^|\s)@([a-z0-9-]*)$/i)
              if (!m) return null
              const q = (m[1] ?? '').toLowerCase()
              const matches = skillsList
                .filter(s => s.slug.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
                .slice(0, 6)
              if (matches.length === 0) return null
              return (
                <div
                  className="mb-2 max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-md text-sm"
                  data-testid="agent-skill-picker"
                >
                  {matches.map(s => (
                    <button
                      key={s.slug}
                      type="button"
                      data-testid={`agent-skill-pick-${s.slug.replace(/^@/, '')}`}
                      onClick={() => {
                        const next = composer.replace(/@[a-z0-9-]*$/i, s.slug + ' ')
                        setComposer(next)
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-indigo-50 border-b border-gray-100 last:border-b-0"
                    >
                      <div className="flex items-center gap-2">
                        <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
                        <span className="font-medium text-gray-900">{s.slug}</span>
                        <span className="text-gray-400">·</span>
                        <span className="text-gray-700">{s.name}</span>
                      </div>
                      {s.description && (
                        <p className="text-xs text-gray-500 mt-0.5 ml-5 line-clamp-1">{s.description}</p>
                      )}
                    </button>
                  ))}
                </div>
              )
            })()}
            <div className="relative">
              <textarea
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send(composer)
                  }
                }}
                placeholder="Ask anything · @ for skills · Enter to send · Shift+Enter for newline"
                rows={2}
                disabled={streaming}
                data-testid="agent-composer"
                className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 pr-12 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
              <Button
                onClick={() => send(composer)}
                disabled={!composer.trim() || streaming}
                size="sm"
                className="absolute right-2 bottom-2 bg-indigo-600 hover:bg-indigo-700 text-white"
                data-testid="agent-send"
                aria-label="Send message"
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="text-[10px] text-gray-400 text-center mt-1.5">
              The agent uses your contracts, playbook, and counterparty memory.
              Replies are grounded in tool calls — never made up.
            </p>
          </div>
        </div>
      </main>

      {/* U.5.2 — Artifact pane. Renders to the right of the chat
          canvas when an artifact is open. Esc closes; the strip above
          the composer persists closed artifacts for re-opening. */}
      {openArtifactId && (() => {
        const open = artifacts.find(a => a.id === openArtifactId)
        if (!open) return null
        return (
          <ArtifactPane
            artifact={open}
            onClose={() => setOpenArtifactId(null)}
            onAction={async (action) => {
              if (action.href) {
                navigate(action.href)
                return
              }
              // Wave 2.5 — non-href artifact actions carry a write tool; fire it
              // through the real apply endpoint (server enforces org + the
              // write-tool allowlist). Throwing on failure lets ActionButton
              // render its error state instead of the old console.log no-op that
              // silently did nothing while looking clickable.
              if (!threadId) throw new Error('No active conversation — send a message first, then apply.')
              if (!action.tool) throw new Error('This action has nothing to apply.')
              const r = await fetch(`/api/v1/agent/threads/${threadId}/actions/apply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken ?? ''}` },
                body: JSON.stringify({ toolName: action.tool, args: action.args ?? {} }),
              })
              const body = await r.json().catch(() => ({}))
              if (!r.ok || body.ok === false) {
                throw new Error(body?.detail ?? body?.error?.detail ?? `Apply failed (HTTP ${r.status})`)
              }
              qc.invalidateQueries()
            }}
          />
        )
      })()}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────

function groupByTime(threads: ThreadSummary[]): Record<string, ThreadSummary[]> {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
  const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
  const groups: Record<string, ThreadSummary[]> = {}
  for (const t of threads) {
    const d = new Date(t.updatedAt); d.setHours(0, 0, 0, 0)
    const bucket = d.getTime() === today.getTime() ? 'Today'
                 : d.getTime() === yesterday.getTime() ? 'Yesterday'
                 : d > lastWeek ? 'Last 7 days'
                 : 'Older'
    ;(groups[bucket] = groups[bucket] ?? []).push(t)
  }
  return groups
}

function MessageBubble({
  message,
  onChipSelect,
  streaming,
  onActionApply,
  onActionCancel,
  onActionUndo,
  onRetry,
}: {
  message:      ChatMessage
  onChipSelect?: (text: string) => void
  streaming?:   boolean
  onActionApply?:  (actionId: string, args: Record<string, unknown>) => void | Promise<void>
  onActionCancel?: (actionId: string) => void
  onActionUndo?:   (actionId: string) => void | Promise<void>
  onRetry?:        (prompt: string) => void
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[70%] rounded-2xl rounded-br-sm bg-blue-600 text-white px-4 py-2 text-sm whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    )
  }
  // P1 fix — parse chips out of assistant prose
  const { cleanProse, chips } = (!message.error && !message.streaming)
    ? parseActionChips(message.content ?? '')
    : { cleanProse: message.content ?? '', chips: [] as ReturnType<typeof parseActionChips>['chips'] }
  return (
    <div className="flex gap-3">
      <div className="h-7 w-7 shrink-0 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center">
        <Sparkles className="h-3.5 w-3.5 text-blue-600" />
      </div>
      <div className="min-w-0 flex-1">
        {(message.toolCalls?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1 mb-2" data-testid="agent-tool-chips">
            {message.toolCalls!.map((tc, i) => (
              <span
                key={i}
                data-testid={`tool-chip-${tc.name}`}
                data-entity-title={tc.entityTitle}
                className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                  tc.status === 'running'
                    ? 'bg-blue-50 border-blue-200 text-blue-700'
                    : tc.status === 'ok'
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : 'bg-red-50 border-red-200 text-red-700'
                }`}
              >
                <Wrench className="h-2.5 w-2.5" />
                <span>{tc.name}</span>
                {tc.entityTitle && (
                  <>
                    <span className="opacity-50">·</span>
                    <span className="font-sans normal-case opacity-90 max-w-[160px] truncate">{tc.entityTitle}</span>
                  </>
                )}
                {tc.status === 'running' && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                {tc.status === 'running' && tc.elapsedSec != null && (
                  <span className="opacity-70">{tc.elapsedSec.toFixed(0)}s</span>
                )}
              </span>
            ))}
          </div>
        )}
        <div className="text-sm text-gray-900 leading-relaxed">
          {/* Markdown rendering (bold, lists, code, links) — Gemini and
              Claude both return Markdown in assistant prose. Prior to
              this the response was rendered with whitespace-pre-wrap
              so users saw literal `**`, `*`, etc. */}
          {cleanProse && <MarkdownProse text={cleanProse} />}
          {message.streaming && !message.content && (
            <span className="inline-flex items-center gap-1 text-gray-400">
              <Loader2 className="h-3 w-3 animate-spin" /> thinking…
            </span>
          )}
        </div>
        {/* P5 — write-tool proposals. ActionPreview cards with Apply /
            Edit / Cancel (+ Undo on applied reversible actions), parity
            with SideAgentRail. */}
        {(message.pendingActions?.length ?? 0) > 0 && (
          <div className="mt-2 space-y-2" data-testid="agent-pending-actions">
            {message.pendingActions!.map(a => (
              <ActionPreview
                key={a.id}
                action={a}
                onApply={(args) => onActionApply?.(a.id, args)}
                onCancel={() => onActionCancel?.(a.id)}
                onUndo={onActionUndo ? () => onActionUndo(a.id) : undefined}
              />
            ))}
          </div>
        )}
        {/* P1 fix — render parsed chips below assistant prose.
            U10 — show skeleton placeholders while streaming so the row
            reserves space and the user knows chips are coming. */}
        {onChipSelect && (chips.length > 0 || message.streaming) && (
          <ChipRow
            chips={chips}
            onSelect={(chip) => onChipSelect(chip.label)}
            disabled={streaming}
            streaming={!!message.streaming}
          />
        )}
        {message.error && (
          <div className="mt-1.5 space-y-1" data-testid="agent-error">
            <div className="text-[11px] text-red-600">{message.error.slice(0, 200)}</div>
            {/* A diagnosis with no way forward leaves the user stuck on a dead
                thread. Retry re-sends the message that failed. */}
            {onRetry && (
              <button
                onClick={() => onRetry(message.retryPrompt ?? '')}
                className="text-[11px] font-medium text-blue-600 hover:text-blue-700 hover:underline"
                data-testid="agent-error-retry"
              >
                Try again
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyChat({
  starters, userName, onPick,
}: {
  starters: StarterPrompt[]
  userName: string
  onPick: (prompt: string) => void
}) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <div className="text-center mb-8">
        <div className="h-12 w-12 mx-auto rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center mb-4">
          <Sparkles className="h-6 w-6 text-blue-600" />
        </div>
        <h2 className="text-2xl font-semibold text-gray-900">
          Hello{userName ? `, ${userName.split(' ')[0]}` : ''} — what can I help with?
        </h2>
        <p className="text-sm text-gray-500 mt-2">
          I can search contracts, draft new ones, summarise risks, run playbook checks,
          and act on your portfolio. Pick a starter or just ask.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {starters.map((s, i) => (
          <button
            key={i}
            onClick={() => onPick(s.prompt)}
            data-testid={`starter-prompt-${i}`}
            className="group text-left p-3 rounded-lg border border-gray-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors flex items-start gap-2.5"
          >
            <div className="h-7 w-7 shrink-0 rounded-md bg-indigo-50 border border-indigo-100 flex items-center justify-center group-hover:bg-indigo-100">
              <s.icon className="h-3.5 w-3.5 text-indigo-600" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-gray-900">{s.label}</div>
              <div className="text-[11px] text-gray-500 mt-0.5 line-clamp-2">{s.prompt}</div>
            </div>
            <ChevronRight className="h-3.5 w-3.5 text-gray-300 group-hover:text-indigo-400 shrink-0 mt-1" />
          </button>
        ))}
      </div>
    </div>
  )
}
