/**
 * SideAgentRail (D.1.1)
 *
 * Persistent right-rail AI assistant. D0 built every endpoint for routing,
 * BYOK, caps, audit, tracing; D.0.8 gave admins their surface. This is the
 * surface an end-user touches — the one that makes the platform feel
 * agent-first.
 *
 * Design reference (what "best-in-class" looks like today):
 *   - Cursor's right side panel: always visible, collapsible, thread
 *     header + composer. Stickiness matters: it's not a modal you open.
 *   - Claude.ai Artifacts rail: slides in/out with a clear pin vs peek
 *     distinction
 *   - Linear AI panel: context-aware (knows what issue you're on)
 *   - Notion Ask AI: supports both compact and full-screen
 *   - Dia browser: treats the side agent as the first-class UI
 *
 * Pattern we've picked for D1:
 *   - Default width 420px (Cursor's sweet spot)
 *   - Collapsed state: 48px vertical strip with a chat glyph → click to expand
 *   - Header: thread name + overflow menu (settings, new thread)
 *   - Body: scrollable message list (empty state in D.1.1)
 *   - Footer: composer (textarea + send)
 *
 * Scope for D.1.1 — SHELL ONLY. No streaming, no tools, no persistence.
 * D.1.2 adds the auto-context chip; D.1.3 the SSE hookup. Each lands as
 * its own commit so it can be verified in isolation.
 *
 * Persisted UX state: rail-open boolean in localStorage so reloads respect
 * the user's last choice.
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, ChevronLeft, ChevronDown, Send, Sparkles, MessageSquarePlus, X, Loader2, AlertTriangle, CheckCircle2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAgentContext } from '@/hooks/useAgentContext'
import { useAuthStore } from '@/store/auth'
import { useAgentStore } from '@/store/agent'
import { ActionPreview, type PendingAction } from './ActionPreview'
import { RedlinePreview, type RedlineProposal } from './RedlinePreview'
import { CitationPills, type CitationBundle } from './CitationPills'
import { parseActionChips } from './action-chips'
import { ChipRow } from './ChipButton'
import { MarkdownProse } from './MarkdownProse'

const STORAGE_KEY = 'side-agent-rail:open'

/**
 * Coerce whatever the server returned into a short displayable string.
 * Zod errors come back as {detail, issues:[{...}]} objects, raw HTTP
 * errors as strings, sometimes we get a deep nested shape — ActionPreview's
 * errorMessage expects a string, so we normalise here before storing it.
 */
function toErrorString(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c
    if (c && typeof c === 'object') {
      const anyC = c as { detail?: unknown; message?: unknown }
      if (typeof anyC.detail === 'string') return anyC.detail
      if (typeof anyC.message === 'string') return anyC.message
      try { return JSON.stringify(c).slice(0, 300) } catch { /* fall through */ }
    }
  }
  return 'Unknown error'
}

// D.1.3 — message shape rendered in the rail.
// D.1.4a adds per-message `toolCalls` so the model's tool invocations are
// kept alongside the prose. D.1.5 renders them as collapsible trace chips.
export interface RailToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  status: 'running' | 'ok' | 'error'
  resultPreview?: string
  truncated?: boolean
  // P1.6 — when name='redline_propose' and status='ok', we parse the
  // result JSON into this field so MessageBubble can render the rich
  // RedlinePreview component instead of a generic JSON preview.
  redlineProposal?: unknown
  // P3.1 — when name='contract_cite' and status='ok', parsed
  // {citations, contractId, title} bundle for the CitationPills UI.
  citationBundle?: unknown
  // A2/U5 — entity title resolved from the tool result when the tool
  // returns a single primary entity (contract_get → contract title,
  // counterparty_get → counterparty name, matter_get → matter name).
  // The chip shows this instead of the truncated cuid.
  entityHint?: { kind: 'contract' | 'counterparty' | 'matter'; title: string }
  // A4 — slow-tool heartbeat. Server emits tool_progress every ~4s while
  // a tool is running; chip displays this so users see forward motion.
  elapsedSec?: number
}

interface RailMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  // True while the assistant message is still streaming — powers the cursor.
  streaming?: boolean
  // Terminal-state error captured from the SSE envelope.
  error?: string
  // Tool invocations attached to this assistant turn (D.1.4a+).
  toolCalls?: RailToolCall[]
  // D.3.1 — write-tool proposals awaiting user confirmation. Separate from
  // toolCalls because their lifecycle is interactive: user sees card →
  // clicks Apply/Edit/Cancel → then we either dispatch the real tool call
  // (which becomes a RailToolCall) or drop it.
  pendingActions?: PendingAction[]
  // D.4.4 — if the user invoked a skill on this turn, the resolved slug.
  // Displayed as a "skill chip" above the user bubble so it's obvious
  // which named workflow ran (and makes the invocation inspectable when
  // someone asks "why did the agent give me that answer?").
  skillSlug?: string
}

// D.4.4 — Skill catalog entry (trimmed shape we actually render).
export interface RailSkill {
  id:             string
  slug:           string
  name:           string
  description:    string
  ownerType:      'built_in' | 'org' | 'user'
  contextScope:   'dashboard' | 'current_contract' | 'current_request' | 'selection' | 'portfolio' | 'any'
  triggerTypes:   string[]
  allowedTools:   string[]
  followUps:      string[]
}

export function SideAgentRail() {
  // Persist open/closed — read eagerly so first paint doesn't flicker.
  // U.8 — default depends on viewport: at 2xl+ (≥1536px) the rail sits
  // in-flex so opening by default is fine. Below 2xl it's a drawer with
  // a modal backdrop, so default-open would block the page on first
  // visit. Honour an explicit user choice in localStorage; otherwise
  // pick the right default for the viewport.
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === '1') return true
    if (raw === '0') return false
    // U1 — first-visit default: open at ≥ 1280px (most laptops + every
    // external monitor). Rail is 420px wide, leaving ≥860px for main
    // content which fits every list page comfortably. Below 1280 we
    // start collapsed so the page isn't squeezed; user can expand
    // explicitly via the Ask·⌘K chip on the right edge.
    return window.innerWidth >= 1280
  })

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, open ? '1' : '0')
  }, [open])

  const [composer, setComposer] = useState('')
  const [messages, setMessages] = useState<RailMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  // D.4.4 — skill catalog for @mention autocomplete. Fetched once on mount.
  // We filter client-side by contextScope + prefix match as the user types.
  const [skills, setSkills] = useState<RailSkill[]>([])
  // Mention-dropdown state. `query` is the text AFTER the trailing '@' (or
  // null when the dropdown is closed). Keyboard nav uses highlightIdx.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  // U.3.2 — /-slash quick-action menu state. Null = closed.
  const [slashQuery, setSlashQuery] = useState<string | null>(null)
  const [slashIdx, setSlashIdx] = useState(0)
  const [mentionIdx, setMentionIdx] = useState(0)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  // P4.3 — entity results fetched on demand when mentionQuery has ≥2 chars.
  // Shape: {kind, id, label, sub} — normalized across contracts / matters /
  // counterparties so the picker renders uniformly.
  interface EntityResult { kind: 'contract' | 'matter' | 'counterparty'; id: string; label: string; sub: string | null }
  const [entityResults, setEntityResults] = useState<EntityResult[]>([])
  // Mentions the user has inserted into the current draft, kept as a
  // separate structured list so the chat payload can include
  // {contractIds, matterIds, counterpartyIds} resolved at send-time.
  const [pendingEntityMentions, setPendingEntityMentions] = useState<EntityResult[]>([])
  const accessToken = useAuthStore((s) => s.accessToken)
  const sessionIdRef = useRef<string>('')
  // D.1.6a — persistent AgentThread id. Null until the first user message of
  // a thread creates one. Reset by newThread(). Kept as a ref so concurrent
  // turns in the same thread can share it without triggering re-renders.
  const threadIdRef = useRef<string | null>(null)
  // D.1.6b — reactive thread summary for the header. Mirrors threadIdRef
  // but also carries the title so the header dropdown can render it.
  // D.2.3 — promoted to the shared agent store so the dashboard hero can
  // offer a "Continue: <title>" affordance pointing at the rail's active
  // thread. Local setter wraps the store setter to preserve the existing
  // call sites unchanged.
  const activeThread = useAgentStore((s) => s.activeThread)
  const setActiveThread = useAgentStore((s) => s.setActiveThread)
  // D.1.6b — thread picker dropdown open state + fetched thread list.
  const [pickerOpen, setPickerOpen] = useState(false)
  // D.2.4 — when a hero-submit routes into the rail, briefly flash the rail
  // header so the user's attention follows the answer. Reset after ~1.4s.
  const [attentionFlash, setAttentionFlash] = useState(false)
  const [threadList, setThreadList] = useState<Array<{
    id: string; title: string; scopeType: string | null; scopeId: string | null;
    messageCount: number; updatedAt: string
  }>>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  // Abort controller so clicking "new thread" mid-stream doesn't keep
  // piping tokens into a discarded conversation.
  const abortRef = useRef<AbortController | null>(null)

  // D.1.2 — route-aware context chip. The rail knows what page the user is
  // on and surfaces it above the composer so "summarise risks" means
  // "of THIS contract" without re-stating it. Dismissed state is per-session
  // and per-context-id, so navigating to a different contract re-surfaces
  // its chip.
  const routeContext = useAgentContext()
  // U6 audit (2026-04-29). Thread context is sticky once the user has sent
  // a message: navigating to a sibling entity (e.g. clicking a renewal row
  // mid-conversation) used to silently reset the rail's focus, derailing
  // the in-flight ask. Lock the context at first message; route changes
  // surface a "Switch to current page" hint instead of clobbering scope.
  // Resets on new-thread / thread-switch via threadIdRef effect below.
  const lockedContextRef = useRef<ReturnType<typeof useAgentContext>>(null)
  const [, forceLockUpdate] = useState(0)  // pump renders when ref changes
  const context = lockedContextRef.current ?? routeContext
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())
  const chipVisible = context && !dismissedIds.has(`${context.type}:${context.id}`)
  // True when a thread is locked AND the user has navigated to a different
  // resource — surface the affordance to switch the rail to the new page.
  const routeDiverged = !!(
    lockedContextRef.current && routeContext &&
    (lockedContextRef.current.type !== routeContext.type ||
     lockedContextRef.current.id   !== routeContext.id)
  )

  // U.3.1 — count of prior threads for the current page context. Used by
  // the Context header just under the rail header: "3 prior threads on
  // this contract ▾". Cheap query — runs once per context change.
  const [contextThreadCount, setContextThreadCount] = useState<number>(0)
  useEffect(() => {
    if (!context || !accessToken) { setContextThreadCount(0); return }
    let cancelled = false
    ;(async () => {
      try {
        const url = `/api/v1/agent/threads?scopeType=${context.scopeType}&scopeId=${context.scopeId}&limit=20`
        const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
        if (!r.ok || cancelled) return
        const j = await r.json()
        if (!cancelled) setContextThreadCount((j.threads ?? []).length)
      } catch { /* non-fatal */ }
    })()
    return () => { cancelled = true }
  }, [context?.type, context?.id, accessToken])

  // Auto-scroll when a new delta arrives or a message is added.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  // D.4.4 — hydrate the skill catalog once. Failing silently is fine: no
  // skills just means no @mention autocomplete, the rail still works as a
  // plain chat.
  useEffect(() => {
    if (!accessToken) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/v1/skills', {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        if (!r.ok) return
        const body = await r.json()
        if (!cancelled) setSkills(body.skills ?? [])
      } catch { /* non-fatal */ }
    })()
    return () => { cancelled = true }
  }, [accessToken])

  // D.2.1 — listen for the dashboard hero agent's submit event. Open the
  // rail (if collapsed), drop the text into the composer, and fire the
  // send. Shared transport via a CustomEvent means the hero stays a thin
  // stateless form without having to reach into the rail's internals.
  useEffect(() => {
    function onHeroSubmit(e: Event) {
      const text = (e as CustomEvent<{ text: string }>).detail?.text ?? ''
      if (!text.trim()) return
      setOpen(true)
      setComposer(text)
      // D.2.4 — flash the header so the user's attention follows.
      setAttentionFlash(true)
      setTimeout(() => setAttentionFlash(false), 1400)
      // Fire the send on the next tick so setComposer has flushed.
      setTimeout(() => { sendMessage(text) }, 0)
    }
    // D.2.3 — "Continue last thread" from the hero. No text — just open
    // the rail so the user can type directly into the existing thread.
    function onHeroOpen() { setOpen(true) }
    // D.3.1 — dev test hook: inject a mock PendingAction into the last
    // assistant message so Playwright can exercise the ActionPreview UI
    // without a real write-tool dispatch. D.3.2 replaces this with the
    // real tool_call_awaiting_confirmation SSE path.
    function onInjectAction(e: Event) {
      const action = (e as CustomEvent<PendingAction>).detail
      if (!action?.id) return
      setOpen(true)
      setMessages(prev => {
        if (prev.length === 0) {
          // No assistant turn yet — create a shell to attach to
          return [{
            id: `a_mock_${Date.now()}`,
            role: 'assistant',
            content: '',
            pendingActions: [action],
          } as RailMessage]
        }
        const last = prev[prev.length - 1]
        if (last.role !== 'assistant') {
          return [...prev, {
            id: `a_mock_${Date.now()}`,
            role: 'assistant',
            content: '',
            pendingActions: [action],
          } as RailMessage]
        }
        return prev.map((m, i) => i === prev.length - 1
          ? { ...m, pendingActions: [...(m.pendingActions ?? []), action] }
          : m)
      })
    }
    // D.4.6 — "prefill" (no auto-send). Skill chips in the hero push the
    // slug into our composer so the user can append specifics before
    // hitting send.
    function onHeroPrefill(e: Event) {
      const text = (e as CustomEvent<{ text: string }>).detail?.text ?? ''
      if (!text) return
      setOpen(true)
      setComposer(text)
      // Focus on the next tick so the caret lands AFTER the prefill.
      requestAnimationFrame(() => {
        const el = composerRef.current
        if (el) {
          el.focus()
          el.setSelectionRange(text.length, text.length)
        }
      })
    }
    // P1.6 — dev test hook: inject a synthetic tool_call_result into the
    // last assistant bubble. Lets Playwright exercise the RedlinePreview
    // component without relying on the LLM to actually emit a
    // redline_propose call. Shape matches the SSE envelope: {id, name,
    // args, status, resultPreview, (optional) redlineProposal}.
    function onInjectToolResult(e: Event) {
      const tc = (e as CustomEvent<RailToolCall>).detail
      if (!tc?.id || !tc.name) return
      setOpen(true)
      setMessages(prev => {
        if (prev.length === 0) {
          return [{
            id: `a_mock_${Date.now()}`,
            role: 'assistant',
            content: '',
            toolCalls: [tc],
          } as RailMessage]
        }
        const last = prev[prev.length - 1]
        if (last.role !== 'assistant') {
          return [...prev, {
            id: `a_mock_${Date.now()}`,
            role: 'assistant',
            content: '',
            toolCalls: [tc],
          } as RailMessage]
        }
        return prev.map((m, i) => i === prev.length - 1
          ? { ...m, toolCalls: [...(m.toolCalls ?? []), tc] }
          : m)
      })
    }
    // U.4.1 — global ⌘K hotkey + 'rail-focus-composer' event focus the
    // rail composer (replaces the deleted Cmd-K palette modal).
    function onCmdK(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(true)
        // Defer focus to next tick so the rail has rendered if it was collapsed.
        setTimeout(() => composerRef.current?.focus(), 50)
      }
    }
    function onFocusComposer() {
      setOpen(true)
      setTimeout(() => composerRef.current?.focus(), 50)
    }
    window.addEventListener('hero-agent-submit', onHeroSubmit)
    window.addEventListener('hero-agent-open-rail', onHeroOpen)
    window.addEventListener('hero-agent-prefill', onHeroPrefill)
    window.addEventListener('rail-inject-action', onInjectAction)
    window.addEventListener('rail-inject-tool-result', onInjectToolResult)
    window.addEventListener('keydown', onCmdK)
    window.addEventListener('rail-focus-composer', onFocusComposer)
    return () => {
      window.removeEventListener('hero-agent-submit', onHeroSubmit)
      window.removeEventListener('hero-agent-open-rail', onHeroOpen)
      window.removeEventListener('hero-agent-prefill', onHeroPrefill)
      window.removeEventListener('rail-inject-action', onInjectAction)
      window.removeEventListener('rail-inject-tool-result', onInjectToolResult)
      window.removeEventListener('keydown', onCmdK)
      window.removeEventListener('rail-focus-composer', onFocusComposer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, context])

  async function sendMessage(text: string) {
    const clean = text.trim()
    if (!clean || streaming) return

    // D.4.4 — if the user typed an `@slug` that resolves to a known skill,
    // pull it out so the chat proxy can narrow tools + inject the skill's
    // prompt. The slug stays in the user-visible content so the thread
    // transcript shows what workflow ran.
    const skillSlug = extractSkillSlug(clean)

    // Add the user turn immediately + a streaming assistant placeholder so
    // the UI feels responsive before the first token arrives.
    const userId = `u_${Date.now()}`
    const assistantId = `a_${Date.now()}`
    // P4.3 — snapshot the entity mentions pulled from the picker so they
    // ride with this turn's payload, then clear for the next draft.
    const mentionsForTurn = pendingEntityMentions
    setMessages(prev => [
      ...prev,
      { id: userId,      role: 'user',      content: clean, skillSlug: skillSlug ?? undefined },
      { id: assistantId, role: 'assistant', content: '', streaming: true },
    ])
    setComposer('')
    setMentionQuery(null)
    setPendingEntityMentions([])
    setStreaming(true)

    // U6 — first message of a thread locks the page context. If the
    // user navigates later, the conversation continues with the original
    // focus until they explicitly click "Switch to current page" or
    // start a new thread. Without this, mid-conversation row clicks
    // (renewal → contract detail) silently re-scoped the rail and
    // derailed the in-flight ask.
    if (threadIdRef.current === null && routeContext && !lockedContextRef.current) {
      lockedContextRef.current = routeContext
      forceLockUpdate(t => t + 1)
    }

    // D.1.6a — ensure we have an AgentThread id before the first message of a
    // thread. Scoped by page context so threads opened from /contracts/:id
    // live under that contract; free chat on /dashboard is unscoped. If the
    // create call fails we continue without persistence — streaming still
    // works, just the turn won't show up in the thread picker (D.1.6b).
    if (threadIdRef.current === null) {
      try {
        const body: Record<string, unknown> = {}
        if (context?.type === 'contract' && context.id) {
          body.scopeType = 'contract'
          body.scopeId = context.id
        }
        const createRes = await fetch('/api/v1/agent/threads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken ?? ''}`,
          },
          body: JSON.stringify(body),
        })
        if (createRes.ok) {
          const thread = await createRes.json()
          threadIdRef.current = thread.id
          setActiveThread({ id: thread.id, title: thread.title })
        }
      } catch {
        // non-fatal: continue with ephemeral streaming.
      }
    }

    const ctl = new AbortController()
    abortRef.current = ctl

    // Set by the error branch inside the frame loop and rethrown after it, so
    // the friendly ladder in the outer catch actually sees agent failures.
    let streamError: string | null = null

    try {
      const res = await fetch('/api/v1/agent/chat', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${accessToken ?? ''}`,
        },
        body: JSON.stringify({
          message: clean,
          // Reuse the same server-side session for the lifetime of this rail's
          // thread. AgentThread persistence lands in D.1.6; this keeps the
          // existing chat memory in Redis working in the meantime.
          sessionId: sessionIdRef.current || threadIdRef.current || undefined,
          provider: 'openai',
          modelId: 'gpt-4.1-mini',
          // D.1.4a — opt into tool-binding + typed event stream.
          agentMode: true,
          // D.1.4a — let the agent know what page the user is on so
          // contract_get can be called with the right id automatically.
          pageContext: context
            ? { type: context.type, id: context.id, label: context.label }
            : undefined,
          // D.4.4 — resolved skill slug so the API layer can narrow tools
          // and inject the skill's system prompt. Undefined = default loop.
          skillSlug: skillSlug ?? undefined,
          // P4.3 — structured entity mentions from the composer picker.
          // Python orchestrator prepends hints to the user message so
          // the agent knows to call contract_get / counterparty_get
          // with these ids rather than fishing for them.
          mentions: mentionsForTurn.length > 0
            ? mentionsForTurn.map(m => ({ kind: m.kind, id: m.id, label: m.label }))
            : undefined,
        }),
        signal: ctl.signal,
      })

      if (!res.ok || !res.body) throw new Error(`agent ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let assembled = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE frames are separated by a blank line; delimit on that.
        let idx
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6)
            if (data === '[DONE]') continue
            try {
              const parsed = JSON.parse(data)
              // Terminal-error envelopes surface as a string bubble.
              //
              // Recorded rather than thrown. This `try` exists to tolerate ONE
              // malformed frame — its catch logs and continues, and in a
              // production build does not even log — so throwing from here
              // discarded every agent failure silently and left an empty
              // bubble. The outer catch below holds the friendly three-tier
              // ladder; rethrowing after the read loop is what finally lets it
              // run.
              if (parsed.type === 'error' || parsed.error) {
                streamError = parsed.error || 'agent error'
                break
              }
              if (parsed.session_id) sessionIdRef.current = parsed.session_id

              // D.1.4a — tool-call envelopes. `type` drives the dispatch.
              // "token" (or legacy untyped {delta}) → append delta
              // "tool_call_start" → record a running tool call
              // "tool_call_result" → flip status + attach preview
              // "done" → noop (the stream close handles finalization)
              const kind = parsed.type ?? (typeof parsed.delta === 'string' ? 'token' : null)
              if (kind === 'token' && typeof parsed.delta === 'string') {
                assembled += parsed.delta
                setMessages(prev =>
                  prev.map(m => m.id === assistantId ? { ...m, content: assembled } : m)
                )
              } else if (kind === 'tool_call_start') {
                const tc: RailToolCall = {
                  id:     String(parsed.id ?? `tc_${Date.now()}`),
                  name:   String(parsed.name ?? 'unknown'),
                  args:   (parsed.args && typeof parsed.args === 'object') ? parsed.args : {},
                  status: 'running',
                }
                setMessages(prev => prev.map(m =>
                  m.id === assistantId
                    ? { ...m, toolCalls: [...(m.toolCalls ?? []), tc] }
                    : m
                ))
              } else if (kind === 'tool_progress') {
                // A4 — slow-tool heartbeat. Update the running chip's
                // elapsed time so the user sees forward motion instead
                // of a frozen spinner.
                const tcId = String(parsed.id ?? '')
                const elapsedSec = Number(parsed.elapsedSec ?? 0)
                setMessages(prev => prev.map(m => {
                  if (m.id !== assistantId) return m
                  return {
                    ...m,
                    toolCalls: (m.toolCalls ?? []).map(tc =>
                      tc.id === tcId ? { ...tc, elapsedSec } : tc,
                    ),
                  }
                }))
              } else if (kind === 'tool_call_awaiting_confirmation') {
                // P5 fix — write-tool plan-then-execute. Append a
                // PendingAction so the rail renders an ActionPreview
                // card. User clicks Apply → applyAction() POSTs to
                // /agent/threads/:id/actions/apply for the actual
                // mutation.
                const tcId = String(parsed.id ?? `tc_${Date.now()}`)
                const toolName = String(parsed.name ?? 'unknown')
                const args = (parsed.args && typeof parsed.args === 'object') ? parsed.args as Record<string, unknown> : {}
                const preview = (parsed.preview && typeof parsed.preview === 'object') ? parsed.preview as Record<string, unknown> : null
                const summary = String(preview?.summary ?? `Apply ${toolName}`)
                // Target label — contract title, request subject, etc. The
                // tool's preview can pass an explicit `target`, or we
                // derive from common fields.
                const target = preview?.target ? String(preview.target)
                  : preview?.title    ? String(preview.title)
                  : preview?.contractId ? `Contract ${String(preview.contractId).slice(0, 12)}…`
                  : undefined
                // Structured diff for *_update tools — the tool can pass
                // an explicit `diff` array, otherwise nothing renders.
                const diff = Array.isArray(preview?.diff)
                  ? preview.diff as Array<{ field: string; before: string | number | null; after: string | number | null }>
                  : undefined
                const action: PendingAction = {
                  id:           tcId,
                  toolName,
                  status:       'awaiting_confirmation',
                  summary,
                  args,
                  target,
                  diff,
                  reversible:   Boolean(parsed.reversible),
                }
                setMessages(prev => prev.map(m =>
                  m.id === assistantId
                    ? { ...m, pendingActions: [...(m.pendingActions ?? []), action] }
                    : m
                ))
              } else if (kind === 'tool_call_result') {
                const tcId = String(parsed.id ?? '')
                setMessages(prev => prev.map(m => {
                  if (m.id !== assistantId) return m
                  return {
                    ...m,
                    toolCalls: (m.toolCalls ?? []).map(tc => {
                      if (tc.id !== tcId) return tc
                      const resultStr = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result)
                      const status: 'ok' | 'error' = parsed.result && !(typeof parsed.result === 'string' && parsed.result.includes('"error"')) ? 'ok' : 'error'
                      // P1.6 — when the agent called redline_propose and
                      // it succeeded, parse the result JSON so
                      // MessageBubble can render the rich RedlinePreview.
                      // Truncation is possible (the rail stream truncates
                      // at 800 chars); if the preview doesn't parse, we
                      // fall back to the generic trace chip by leaving
                      // redlineProposal undefined.
                      let redlineProposal: unknown
                      let citationBundle: unknown
                      let entityHint: RailToolCall['entityHint']
                      if (status === 'ok' && typeof parsed.result === 'string') {
                        try {
                          const json = JSON.parse(parsed.result)
                          if (tc.name === 'redline_propose' &&
                              json && typeof json === 'object' &&
                              Array.isArray((json as { variants?: unknown }).variants)) {
                            redlineProposal = json
                          }
                          // P3.1 — contract_cite parses into citationBundle
                          else if (tc.name === 'contract_cite' &&
                                   json && typeof json === 'object' &&
                                   Array.isArray((json as { citations?: unknown }).citations)) {
                            citationBundle = json
                          }
                          // A2/U5 — extract entity title from single-entity
                          // tool results so the chip shows "MSA — Snowflake"
                          // instead of "cmogr4…".
                          if (json && typeof json === 'object') {
                            const obj = json as Record<string, unknown>
                            const title = (obj.title ?? obj.name ?? obj.legalName) as string | undefined
                            if (typeof title === 'string' && title.length > 0) {
                              if (tc.name === 'contract_get' || tc.name === 'contract_summarize') {
                                entityHint = { kind: 'contract', title }
                              } else if (tc.name === 'counterparty_get' || tc.name === 'counterparty_memory') {
                                entityHint = { kind: 'counterparty', title }
                              } else if (tc.name === 'matter_get') {
                                entityHint = { kind: 'matter', title }
                              }
                            }
                          }
                        } catch { /* fall through — show raw preview */ }
                      }
                      return {
                        ...tc,
                        status,
                        resultPreview: resultStr,
                        truncated: Boolean(parsed.truncated),
                        redlineProposal,
                        citationBundle,
                        entityHint,
                      }
                    }),
                  }
                }))
              }
            } catch (e) {
              // One malformed frame shouldn't tank the stream; log + continue.
              if (process.env.NODE_ENV !== 'production') console.warn('[rail] bad SSE frame', line, e)
            }
          }
          if (streamError) break
        }
      }

      // The agent reported a failure. Raise it here, OUTSIDE the frame-parse
      // try, so the outer catch's friendly ladder runs — the stream itself was
      // fine (HTTP 200), which is why `!res.ok` never caught this.
      if (streamError) throw new Error(streamError)

      // Mark assistant message complete so the cursor stops blinking.
      setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, streaming: false } : m))

      // D.1.6a — persist the turn to AgentThread. We snapshot the current
      // assistant message + its tool calls from state. Non-fatal if this
      // write fails; the rail UI is already correct and the next refresh
      // would just not see this turn in the picker.
      if (threadIdRef.current) {
        const finalMsg = (await new Promise<RailMessage | null>(r => setMessages(prev => {
          r(prev.find(m => m.id === assistantId) ?? null); return prev
        })))
        const finalText  = finalMsg?.content ?? ''
        const toolCalls  = (finalMsg?.toolCalls ?? []).map(tc => ({
          id:       tc.id,
          toolName: tc.name,
          args:     tc.args,
          status:   tc.status === 'ok' ? 'success' as const : tc.status === 'error' ? 'error' as const : 'success' as const,
          result:   tc.resultPreview,
        }))
        try {
          await fetch(`/api/v1/agent/threads/${threadIdRef.current}/turns`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken ?? ''}`,
            },
            body: JSON.stringify({
              userMessage: clean,
              assistant: {
                content: finalText,
                provider: 'openai',
                model: 'gpt-4.1-mini',
                tier: 'default',
              },
              toolCalls,
            }),
          })
          // D.1.6b — title gets backfilled server-side from the first user
          // message; reflect that in the header so the dropdown label updates.
          if (activeThread?.title === 'New chat') {
            setActiveThread({ id: activeThread.id, title: defaultHeaderTitle(clean) })
          }
        } catch { /* non-fatal */ }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        // User hit "new thread" mid-stream — drop the partial assistant turn.
        setMessages(prev => prev.filter(m => m.id !== assistantId))
        return
      }
      // P7.0.4 — Friendly, actionable error states. Detect the common
      // F-82 family ("no LLM provider configured") and route the user to
      // a fix instead of dumping a stack trace into the bubble. Three
      // tiers:
      //   1. "no API key" → admin-actionable: link to /admin/org → AI Config
      //   2. transient HTTP / network → suggest retry
      //   3. anything else → generic "temporarily unavailable"
      const raw = String(e?.message ?? 'Stream failed')
      const noKey = /no\s+llm\s+api\s+key|api\s+key|authentication\s+method|RuntimeError.*api/i.test(raw)
      const transient = /upstream|502|503|504|fetch\s+failed|ECONNREFUSED/i.test(raw)
      const friendly = noKey
        ? 'The AI assistant isn\'t configured for your workspace yet. An admin needs to add an OpenAI or Anthropic API key in Organization → AI Config.'
        : transient
          ? 'The AI assistant is temporarily unavailable — please try again in a moment.'
          : 'Sorry, the AI assistant ran into a problem. Try again, or refresh if it persists.'
      setMessages(prev => prev.map(m =>
        m.id === assistantId
          ? { ...m, streaming: false, error: raw, content: m.content || friendly }
          : m
      ))
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  // D.3.1 + D.3.2 — handlers for ActionPreview cards attached to
  // assistant turns. applyAction transitions the pending action to
  // 'running', POSTs /agent/threads/:id/actions/apply so the tool runs
  // server-side against a real Prisma write, then transitions to
  // 'applied' or 'error'. cancelAction is UI-only for now (D.3.2 doesn't
  // require server notification; the agent loop already ended when the
  // write proposal was emitted).
  async function applyAction(msgId: string, actionId: string, editedArgs: Record<string, unknown>) {
    // Flip to running first so the user sees immediate feedback.
    let toolName = ''
    setMessages(prev => prev.map(m => {
      if (m.id !== msgId) return m
      const pending = (m.pendingActions ?? []).map(a => {
        if (a.id !== actionId) return a
        toolName = a.toolName
        return { ...a, status: 'running' as const, args: editedArgs }
      })
      return { ...m, pendingActions: pending }
    }))

    // Small visual yield so the "running" state renders before the await.
    await new Promise(ok => setTimeout(ok, 0))

    // Wave 2.5 — without a persisted thread the apply endpoint can't write a
    // ToolCall row, so the action CANNOT actually be applied. Surface an honest
    // error instead of the old 600ms fake "applied" transition, which reported
    // a contract mutation that never reached the server.
    if (!threadIdRef.current || !toolName) {
      setMessages(prev => prev.map(m => {
        if (m.id !== msgId) return m
        const pending = (m.pendingActions ?? []).map(a =>
          a.id === actionId
            ? { ...a, status: 'error' as const, errorMessage: 'Cannot apply yet — send a message to start a conversation so this action can be saved, then try again.' }
            : a)
        return { ...m, pendingActions: pending }
      }))
      return
    }

    try {
      const r = await fetch(`/api/v1/agent/threads/${threadIdRef.current}/actions/apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken ?? ''}`,
        },
        body: JSON.stringify({
          toolName,
          args: editedArgs,
          messageId: msgId,
          actionId,
        }),
      })
      const body = await r.json().catch(() => ({ ok: false, error: { detail: 'Non-JSON response' } }))
      setMessages(prev => prev.map(m => {
        if (m.id !== msgId) return m
        const pending = (m.pendingActions ?? []).map(a => {
          if (a.id !== actionId) return a
          return r.ok && body.ok
            ? {
                ...a,
                status: 'applied' as const,
                resultPreview: JSON.stringify(body.result).slice(0, 400),
                // D.3.5 — capture the server toolCallId + applied time so
                // the receipt can render an Undo button within the 15-min
                // window and POST to the undo RPC.
                toolCallId: body.toolCallId,
                appliedAt: Date.now(),
              }
            : { ...a, status: 'error' as const, errorMessage: toErrorString(body?.error, body?.detail, `HTTP ${r.status}`) }
        })
        return { ...m, pendingActions: pending }
      }))
    } catch (e) {
      setMessages(prev => prev.map(m => {
        if (m.id !== msgId) return m
        const pending = (m.pendingActions ?? []).map(a =>
          a.id === actionId ? { ...a, status: 'error' as const, errorMessage: (e as Error).message } : a)
        return { ...m, pendingActions: pending }
      }))
    }
  }
  function cancelAction(msgId: string, actionId: string) {
    setMessages(prev => prev.map(m => {
      if (m.id !== msgId) return m
      const pending = (m.pendingActions ?? []).map(a =>
        a.id === actionId ? { ...a, status: 'cancelled' as const } : a)
      return { ...m, pendingActions: pending }
    }))
  }

  // D.3.5 — reverse a previously-applied reversible write. Server enforces
  // the 15-min window + idempotency; the rail mirrors the result into the
  // receipt (status → 'undone') so the UI stays in sync on success or
  // pops an error label on failure.
  async function undoAction(msgId: string, actionId: string) {
    const msg = messages.find(m => m.id === msgId)
    const action = msg?.pendingActions?.find(a => a.id === actionId)
    if (!action?.toolCallId || !threadIdRef.current) return

    try {
      const r = await fetch(
        `/api/v1/agent/threads/${threadIdRef.current}/actions/${action.toolCallId}/undo`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken ?? ''}` },
        }
      )
      const body = await r.json().catch(() => ({ ok: false }))
      setMessages(prev => prev.map(m => {
        if (m.id !== msgId) return m
        const pending = (m.pendingActions ?? []).map(a => {
          if (a.id !== actionId) return a
          return r.ok && body.ok
            ? { ...a, status: 'undone' as const }
            : { ...a, status: 'error' as const, errorMessage: toErrorString(body?.detail, body?.error, `Undo failed (${r.status})`) }
        })
        return { ...m, pendingActions: pending }
      }))
    } catch (e) {
      setMessages(prev => prev.map(m => {
        if (m.id !== msgId) return m
        const pending = (m.pendingActions ?? []).map(a =>
          a.id === actionId ? { ...a, status: 'error' as const, errorMessage: (e as Error).message } : a)
        return { ...m, pendingActions: pending }
      }))
    }
  }

  function newThread() {
    abortRef.current?.abort()
    sessionIdRef.current = ''
    threadIdRef.current = null  // D.1.6a — next send will POST a fresh AgentThread
    setActiveThread(null)       // D.2.3 — clears the shared store too
    setMessages([])
    setComposer('')
    setPickerOpen(false)
    // U6 — fresh thread, fresh route-driven context.
    lockedContextRef.current = null
    forceLockUpdate(t => t + 1)
  }

  // U6 — manually re-bind the rail to the current page. Used when the
  // user navigated mid-thread and wants to ask about the new resource.
  function adoptCurrentPage() {
    lockedContextRef.current = routeContext
    forceLockUpdate(t => t + 1)
  }

  // D.1.6b — refresh the thread list when the picker opens. Small enough
  // (<=20 rows) that a refetch-on-open is fine — no need for smart cache
  // invalidation around mutations.
  async function fetchThreadList() {
    try {
      const res = await fetch(`/api/v1/agent/threads?limit=20`, {
        headers: { Authorization: `Bearer ${accessToken ?? ''}` },
      })
      if (!res.ok) return
      const j = await res.json()
      setThreadList(j.threads ?? [])
    } catch { /* non-fatal */ }
  }

  // D.1.6b — hydrate an existing thread's messages into the rail when the
  // user picks it from the dropdown. Converts persisted AgentMessage content
  // blocks back into RailMessage objects. Tool calls are re-attached by
  // messageId so the trace chips from D.1.5 render on the right turn.
  async function loadThread(id: string) {
    abortRef.current?.abort()
    try {
      const res = await fetch(`/api/v1/agent/threads/${id}`, {
        headers: { Authorization: `Bearer ${accessToken ?? ''}` },
      })
      if (!res.ok) return
      const t = await res.json()
      // Rebuild rail messages in order, bucket tool calls by messageId.
      const toolByMsg = new Map<string, RailToolCall[]>()
      for (const tc of (t.toolCalls ?? [])) {
        const arr = toolByMsg.get(tc.messageId) ?? []
        // P1.6 — when rebuilding a thread from DB, try to re-parse the
        // redline_propose tool's output preview so RedlinePreview
        // renders on reload. P3.1 does the same for contract_cite.
        // Silent fallback to the JSON chip if the preview can't be
        // parsed (older turns / truncated rows).
        let redlineProposal: unknown
        let citationBundle: unknown
        const previewStr = typeof tc.output?.preview === 'string'
          ? tc.output.preview
          : undefined
        if (previewStr) {
          try {
            const json = JSON.parse(previewStr)
            if (tc.toolName === 'redline_propose' &&
                json && typeof json === 'object' && Array.isArray(json.variants)) {
              redlineProposal = json
            } else if (tc.toolName === 'contract_cite' &&
                       json && typeof json === 'object' && Array.isArray(json.citations)) {
              citationBundle = json
            }
          } catch { /* not parseable — chip only */ }
        }
        arr.push({
          id:     tc.id,
          name:   tc.toolName,
          args:   (tc.input ?? {}) as Record<string, unknown>,
          status: tc.status === 'success' ? 'ok' : tc.status === 'error' ? 'error' : 'ok',
          resultPreview: previewStr,
          truncated: false,
          redlineProposal,
          citationBundle,
        })
        toolByMsg.set(tc.messageId, arr)
      }
      const hydrated: RailMessage[] = (t.messages ?? []).map((m: {
        id: string; role: 'user' | 'assistant'; content: Array<{ type: string; text?: string }>
      }) => ({
        id: m.id,
        role: m.role,
        content: (m.content ?? []).map((b) => (b as { text?: string }).text ?? '').join(''),
        toolCalls: toolByMsg.get(m.id),
      }))
      threadIdRef.current = t.id
      sessionIdRef.current = ''  // local orchestrator session reset; fresh context on next turn
      setActiveThread({ id: t.id, title: t.title })
      setMessages(hydrated)
      setPickerOpen(false)
      setComposer('')
      // U6 — opening a thread restores its scope. Use the thread row's
      // scopeType/scopeId if present; otherwise fall back to current
      // route context. The thread picker passes scopeType/scopeId on
      // the selected `t` row so we have the data here.
      if (t.scopeType && t.scopeId) {
        lockedContextRef.current = {
          type:      t.scopeType as 'contract' | 'matter' | 'counterparty',
          id:        t.scopeId,
          label:     t.title ?? '',
          icon:      '📄',
          url:       `/${t.scopeType}s/${t.scopeId}`,
          scopeType: t.scopeType,
          scopeId:   t.scopeId,
        }
      } else {
        lockedContextRef.current = null
      }
      forceLockUpdate(x => x + 1)
    } catch { /* non-fatal */ }
  }

  // ─── D.4.4: @skill mention autocomplete ──────────────────────────────────
  // Show skills that (a) match the current page scope and (b) start with
  // the user's query after @. Page-aware filter so on a contract page we
  // don't clutter the dropdown with portfolio-scoped skills.
  const currentScope = (() => {
    if (context?.type === 'contract')     return 'current_contract'
    if (context?.type === 'matter')       return 'current_matter'
    if (context?.type === 'counterparty') return 'current_counterparty'
    return 'dashboard'
  })()
  const visibleSkills = skills.filter(s => {
    // 'any' skills show everywhere; scope-specific only on matching pages.
    // 'selection' skills are only useful with a selection — hide from the
    // composer picker (they'll surface from the in-editor toolbar later).
    if (s.contextScope === 'selection') return false
    if (s.contextScope !== 'any' && s.contextScope !== currentScope) {
      // Portfolio + dashboard both surface on the dashboard so the hero
      // composer isn't starved for options; on a contract page we tighten.
      if (currentScope === 'dashboard' && s.contextScope === 'portfolio') return true
      return false
    }
    return true
  })
  // Skill suggestions (D.4.4). Returned as a unified shape with
  // kind='skill' so the picker renders with the same pattern as
  // entity mentions (P4.3).
  const skillMatches = mentionQuery == null ? [] : (() => {
    const q = mentionQuery.toLowerCase()
    return visibleSkills.filter(s =>
      s.slug.slice(1).toLowerCase().startsWith(q) ||
      s.name.toLowerCase().includes(q)
    ).slice(0, 5).map(s => ({ kind: 'skill' as const, id: s.id, slug: s.slug, name: s.name, description: s.description }))
  })()
  // P4.3 — fetch entities when the query has enough signal. Fires
  // client-side with a small debounce baked in via the effect's deps.
  useEffect(() => {
    if (mentionQuery == null || mentionQuery.length < 2 || !accessToken) {
      setEntityResults([])
      return
    }
    const q = mentionQuery
    let cancelled = false
    const tid = setTimeout(async () => {
      try {
        const [contractsRes, mattersRes, cpsRes] = await Promise.all([
          fetch(`/api/v1/contracts?pageSize=5&search=${encodeURIComponent(q)}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          }).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
          fetch(`/api/v1/matters?limit=5&status=all`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          }).then(r => r.ok ? r.json() : { items: [] }).catch(() => ({ items: [] })),
          fetch(`/api/v1/counterparties?pageSize=5&search=${encodeURIComponent(q)}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          }).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
        ])
        if (cancelled) return
        const contracts: EntityResult[] = (contractsRes.data ?? contractsRes.contracts ?? [])
          .filter((c: { title?: string }) => c.title?.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 3)
          .map((c: { id: string; title: string; counterpartyName?: string | null; type?: string }) => ({
            kind: 'contract' as const, id: c.id, label: c.title,
            sub: c.counterpartyName ?? c.type ?? null,
          }))
        const matters: EntityResult[] = (mattersRes.items ?? [])
          .filter((m: { name: string }) => m.name.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 3)
          .map((m: { id: string; name: string; counterpartyName?: string | null }) => ({
            kind: 'matter' as const, id: m.id, label: m.name,
            sub: m.counterpartyName ?? null,
          }))
        const counterparties: EntityResult[] = (cpsRes.data ?? cpsRes.counterparties ?? [])
          .filter((cp: { name?: string }) => cp.name?.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 3)
          .map((cp: { id: string; name: string; website?: string | null }) => ({
            kind: 'counterparty' as const, id: cp.id, label: cp.name,
            sub: cp.website ?? null,
          }))
        setEntityResults([...contracts, ...matters, ...counterparties])
      } catch { /* network blip — keep whatever was there */ }
    }, 150)
    return () => { cancelled = true; clearTimeout(tid) }
  }, [mentionQuery, accessToken])

  // Unified list — skills first (fast path for D.4.4 behaviour), then
  // entity results. Capped at 8 visible rows.
  const mentionMatches = [
    ...skillMatches,
    ...entityResults.map(e => ({ ...e })),
  ].slice(0, 8)

  // U.3.2 — /-slash quick-action menu items. Replaces the Cmd-K palette.
  // The action templates fill the composer when picked, so the user can
  // tweak before sending. Page-context aware: contract pages get clause-
  // type actions; otherwise general ones.
  type SlashAction = { id: string; icon: string; label: string; template: string; description?: string }
  const ALL_SLASH_ACTIONS: SlashAction[] = [
    // Universal — work everywhere
    { id: 'queue',       icon: '📥', label: 'My approval queue',      template: 'What is in my approval queue?', description: 'List approvals awaiting my decision.' },
    { id: 'expiring',    icon: '⏰', label: 'Expiring contracts',     template: 'Which contracts in my portfolio expire in the next 90 days?', description: 'Renewal pipeline.' },
    { id: 'in-flight',   icon: '🔄', label: 'In-flight negotiations', template: 'Brief me on every contract I own that is in negotiation.', description: 'What needs my attention.' },
    // Contract-context specific
    ...(context?.type === 'contract' ? [
      { id: 'summarize',  icon: '📝', label: 'Summarise risks',          template: 'Summarise the top 3 risks in this contract in plain English.', description: 'Quick risk scan with citations.' },
      { id: 'compare',    icon: '⚖',  label: 'Compare to playbook',      template: 'Compare this contract to our playbook and flag every deviation.', description: 'Where we differ from preferred.' },
      { id: 'liability',  icon: '🛡',  label: 'Liability cap',            template: 'What is the liability cap on this contract?', description: 'Cap, carve-outs, exclusions.' },
      { id: 'auto-renew', icon: '🔁', label: 'Auto-renewal terms',       template: 'What are the auto-renewal and notice-period terms?', description: 'Renewal trigger + opt-out window.' },
      { id: 'terminate',  icon: '🚪', label: 'Termination conditions',    template: 'How can either party terminate this contract?', description: 'Notice / for-cause / convenience.' },
    ] : []),
    // Counterparty-context specific
    ...(context?.type === 'counterparty' ? [
      { id: 'cp-brief',   icon: '🏢', label: 'Brief me on this counterparty', template: 'Brief me on this counterparty — active contracts, total value, risk patterns.', description: 'Relationship summary.' },
    ] : []),
  ]
  const slashMatches = slashQuery == null
    ? []
    : ALL_SLASH_ACTIONS
        .filter(a => a.label.toLowerCase().includes(slashQuery.toLowerCase()) || a.id.includes(slashQuery.toLowerCase()))
        .slice(0, 8)
  // When user typed just `/` (empty query), show top 5 instead of 0.
  const slashVisible = slashQuery !== null
    ? (slashQuery.length === 0 ? ALL_SLASH_ACTIONS.slice(0, 5) : slashMatches)
    : []

  function pickSlash(action: SlashAction) {
    // Replace the /<query> fragment with the action's template, then fire.
    const el = composerRef.current
    if (!el) return
    setSlashQuery(null)
    setComposer(action.template)
    // Send immediately — feels snappier than requiring a second Enter.
    sendMessage(action.template)
  }

  /** Replace the pending `@query` fragment with either a skill slug
   *  or a user-visible entity token ("@Acme MSA"). Entity picks also
   *  get pushed onto pendingEntityMentions so the chat payload can
   *  send the resolved {kind,id} alongside. */
  function pickMention(item: typeof mentionMatches[number]) {
    const el = composerRef.current
    if (!el) return
    const caret = el.selectionStart ?? composer.length
    const before = composer.slice(0, caret)
    const after  = composer.slice(caret)
    const at = before.lastIndexOf('@')
    if (at < 0) return

    let token: string
    if (item.kind === 'skill') {
      token = item.slug
    } else {
      // Human-readable inline token. We DON'T embed the id in the text —
      // that goes to the chat payload separately via pendingEntityMentions.
      // The '@' is preserved to keep it visually distinct from prose.
      token = `@${item.label}`
      setPendingEntityMentions(prev => {
        const next = prev.filter(p => !(p.kind === item.kind && p.id === item.id))
        next.push({ kind: item.kind, id: item.id, label: item.label, sub: item.sub ?? null })
        return next
      })
    }
    const replaced = before.slice(0, at) + token + ' ' + after
    setComposer(replaced)
    setMentionQuery(null)
    setMentionIdx(0)
    requestAnimationFrame(() => {
      el.focus()
      const pos = at + token.length + 1
      el.setSelectionRange(pos, pos)
    })
  }

  /** Watch composer changes to open/close the mention dropdown. */
  function handleComposerChange(v: string, caret: number) {
    setComposer(v)
    const before = v.slice(0, caret)
    // @mention: skill / entity picker
    const mAt = before.match(/(?:^|\s)@([a-z0-9-]*)$/i)
    if (mAt) {
      setMentionQuery(mAt[1])
      setMentionIdx(0)
      setSlashQuery(null)
      return
    }
    setMentionQuery(null)
    // U.3.2 — /slash: quick-action menu (replaces Cmd-K palette).
    // Triggers when the user types `/` at start-of-input or after
    // whitespace, with no spaces in the action token.
    const mSlash = before.match(/(?:^|\s)\/([a-z0-9-]*)$/i)
    if (mSlash) {
      setSlashQuery(mSlash[1])
      setSlashIdx(0)
    } else {
      setSlashQuery(null)
    }
  }

  /** First @slug token in the text that matches a known skill, if any. */
  function extractSkillSlug(text: string): string | null {
    const bySlug = new Set(skills.map(s => s.slug))
    const matches = text.match(/@[a-z0-9-]+/gi) ?? []
    for (const m of matches) {
      if (bySlug.has(m)) return m
    }
    return null
  }

  if (!open) {
    // U.3.1 / decision 7 — 32px collapsed rail "chip" (per doc 32 §6c).
    // Persistent, discoverable, never intrusive. Click anywhere expands.
    return (
      <aside
        aria-label="Ask (collapsed)"
        data-testid="side-agent-rail"
        data-state="collapsed"
        onClick={() => setOpen(true)}
        className="w-8 border-l border-border bg-white hover:bg-indigo-50 transition-colors flex flex-col items-center py-4 gap-3 flex-shrink-0 cursor-pointer group"
        title="Open Ask · ⌘K"
      >
        <Sparkles className="h-3.5 w-3.5 text-indigo-600 group-hover:scale-110 transition-transform" />
        <div className="w-px h-12 bg-gray-200 group-hover:bg-indigo-200 transition-colors" />
        <span
          className="text-[10.5px] tracking-wide font-medium text-gray-500 group-hover:text-indigo-700 select-none"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
        >
          Ask · ⌘K
        </span>
        <div className="flex-1" />
        <ChevronLeft className="h-3 w-3 text-gray-300 group-hover:text-indigo-500" />
      </aside>
    )
  }

  // U4/A6 — expose streaming state as a stable testid so:
  //   • Automation can `waitForSelector('[data-testid="agent-streaming"]')`
  //     to detect stream start, then wait for it to disappear for stream end.
  //   • Future a11y / UX can surface "agent is generating" affordances.
  // The aria-busy attribute on the rail signals to assistive tech that
  // content is being updated; matches the WAI-ARIA pattern for live regions.
  const isStreaming = messages.some(m => m.streaming)

  return (
    <aside
      aria-label="AI assistant"
      aria-busy={isStreaming || undefined}
      data-testid="side-agent-rail"
      data-state="expanded"
      data-streaming={isStreaming ? 'true' : 'false'}
      // U.8 (revert): rail is ALWAYS an in-flex column when open — never
      // a modal overlay. The drawer-with-backdrop mode at narrow widths
      // looked clever but blocked interaction with the page underneath
      // (every Linear / Notion / Slack right-panel behaves this way).
      // If a viewport is too narrow for both rail + content, the user
      // collapses the rail explicitly via the chevron in the header.
      className="w-[420px] border-l border-border bg-card flex flex-col flex-shrink-0"
    >
      {/* U4/A6 — presence-based streaming marker. Mounted only while a
          message is streaming; absence == stream complete. Hidden visually
          but discoverable by Playwright / a11y. */}
      {isStreaming && (
        <span
          data-testid="agent-streaming"
          aria-hidden="true"
          className="sr-only"
        >
          Agent is generating a response…
        </span>
      )}
      {!isStreaming && messages.length > 0 && (
        <span
          data-testid="agent-done"
          aria-hidden="true"
          className="sr-only"
        >
          Agent response complete.
        </span>
      )}
      {/* ─── Header ──────────────────────────────────────────────────── */}
      <header
        data-testid="side-agent-header"
        data-attention={attentionFlash ? 'pulse' : 'idle'}
        className={`h-14 border-b border-border px-4 flex items-center justify-between flex-shrink-0 relative transition-colors duration-300 ${attentionFlash ? 'bg-blue-50' : ''}`}
      >
        <button
          type="button"
          data-testid="side-agent-thread-picker"
          onClick={() => {
            setPickerOpen(v => {
              const next = !v
              if (next) void fetchThreadList()
              return next
            })
          }}
          className="flex items-center gap-2 min-w-0 text-left hover:bg-gray-50 rounded-lg px-1.5 py-1 -ml-1.5 transition-colors"
        >
          {/* U.2.1 — indigo accent (decision 14a) — distinct from product blue */}
          <div className="h-7 w-7 rounded-md bg-indigo-50 border border-indigo-100 flex items-center justify-center flex-shrink-0">
            <Sparkles className="h-3.5 w-3.5 text-indigo-600" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-900 truncate">
              {activeThread ? activeThread.title : 'Ask'}
            </div>
            <div className="text-[10px] text-gray-400 flex items-center gap-0.5">
              {activeThread ? 'Recent threads' : 'New thread'}
              <ChevronDown className="h-2.5 w-2.5" />
            </div>
          </div>
        </button>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost" size="icon"
            title="New thread"
            data-testid="side-agent-new-thread"
            className="h-8 w-8"
            onClick={newThread}
          >
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost" size="icon"
            title="Collapse rail"
            data-testid="side-agent-collapse"
            className="h-8 w-8"
            onClick={() => setOpen(false)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {/* D.1.6b — Thread picker flyout. Anchored under the header's left side,
            covers recent threads grouped by scope (this contract first, if
            context present, then other threads). */}
        {pickerOpen && (
          <ThreadPickerPanel
            threads={threadList}
            activeId={activeThread?.id ?? null}
            currentContext={context}
            onSelect={loadThread}
            onNewThread={newThread}
            onClose={() => setPickerOpen(false)}
            accessToken={accessToken ?? ''}
            onAfterArchive={fetchThreadList}
          />
        )}
      </header>

      {/* ─── U.3.1 — Context header band ──────────────────────────────────
          Shows directly under the rail header when on a resource page
          (contract / matter / counterparty). Surfaces:
            • the current resource (icon + name + type)
            • count of prior threads on this resource — clicking opens the
              picker pre-filtered to this scope (replaces the deleted
              per-contract "Ask" tab so per-resource memory still works).
          Read-only routes (dashboard, /agent etc.) → null. */}
      {context && (
        <div
          data-testid="side-agent-context-header"
          className="px-4 py-2 border-b border-border bg-indigo-50/40"
        >
          <div className="flex items-start gap-2">
            <span className="text-base shrink-0 leading-tight" aria-hidden>{context.icon}</span>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-wider font-semibold text-indigo-700">
                Focused on {context.type}
              </div>
              <div className="text-[12.5px] font-medium text-gray-900 truncate" title={context.label}>
                {context.label}
              </div>
              <button
                type="button"
                data-testid="side-agent-context-history"
                onClick={() => {
                  setPickerOpen(true)
                  void fetchThreadList()
                }}
                className="text-[10.5px] text-indigo-700 hover:underline mt-0.5 inline-flex items-center gap-0.5"
              >
                {contextThreadCount > 0
                  ? `${contextThreadCount} prior thread${contextThreadCount === 1 ? '' : 's'} on this ${context.type}`
                  : `No prior threads on this ${context.type}`}
                <ChevronDown className="h-2.5 w-2.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── D.4.6 Skill chips ──────────────────────────────────────────── */}
      {(() => {
        // Chip-triggered skills that match the current page scope, capped
        // so the strip never scrolls horizontally forever. Always-on chips
        // ('any' scope) show everywhere.
        const chipSkills = skills
          .filter(s => s.triggerTypes.includes('chip'))
          .filter(s => s.contextScope === currentScope || s.contextScope === 'any')
          .slice(0, 4)
        if (chipSkills.length === 0) return null
        return (
          <div
            data-testid="side-agent-skill-chips"
            className="px-4 py-2 border-b border-border bg-indigo-50/30 flex flex-wrap gap-1.5"
          >
            {chipSkills.map(s => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setComposer(`${s.slug} `)
                  composerRef.current?.focus()
                }}
                data-testid={`side-agent-skill-chip-${s.slug.slice(1)}`}
                data-slug={s.slug}
                title={s.description}
                className="text-[11px] inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-white px-2.5 py-1 text-indigo-800 hover:border-indigo-400 hover:bg-indigo-50 transition-colors"
              >
                <Sparkles className="h-2.5 w-2.5" />
                {s.name}
              </button>
            ))}
          </div>
        )
      })()}

      {/* ─── Message list ─────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0
          ? <SideAgentEmptyState
              onSuggestion={(text) => setComposer(text)}
              context={context}
            />
          : (
            <div className="space-y-3" data-testid="side-agent-messages">
              {messages.map(m => (
                <MessageBubble
                  key={m.id}
                  msg={m}
                  onActionApply={applyAction}
                  onActionCancel={cancelAction}
                  onActionUndo={undoAction}
                  onChipSelect={(text) => {
                    // P1 fix — chip click sends as next user turn.
                    if (!streaming) sendMessage(text)
                  }}
                  streaming={streaming}
                />
              ))}
              <div ref={bottomRef} />
            </div>
          )}
      </div>

      {/* ─── Composer ────────────────────────────────────────────────── */}
      <footer className="border-t border-border p-3 flex-shrink-0 space-y-2">
        {/* D.1.7 — Quick-action chips. Contextual preset prompts that drop
            into the composer on click (doesn't auto-send, so the user can
            tweak first). Source today is a hard-coded catalog per page
            context; D.4 swaps this out for the real Skill table so org
            admins can author + share their own chips. */}
        <QuickActionChips
          context={context}
          disabled={streaming}
          onPick={(text) => setComposer(text)}
        />
        {/* D.1.2 — Context chip (above composer). Visually echoes the page
            context so the user knows the agent has already scoped its
            answers to this object. ✕ dismisses for the session/this id. */}
        {chipVisible && context && (
          <div
            data-testid="side-agent-context-chip"
            data-context-type={context.type}
            data-context-id={context.id}
            data-route-diverged={routeDiverged ? 'true' : 'false'}
            className="inline-flex w-full items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] text-indigo-900"
          >
            <span className="flex-shrink-0">{context.icon}</span>
            <span className="truncate">
              <span className="text-indigo-600 font-medium">Context:</span> <span title={context.label}>{context.label}</span>
            </span>
            <button
              type="button"
              onClick={() =>
                setDismissedIds(prev => {
                  const next = new Set(prev)
                  next.add(`${context.type}:${context.id}`)
                  return next
                })
              }
              title="Remove this context from the next message"
              aria-label="Dismiss context"
              data-testid="side-agent-context-dismiss"
              className="ml-auto flex-shrink-0 rounded-full p-0.5 hover:bg-indigo-100 transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        {/* U6 — when the user has navigated to a different resource mid-
            thread, surface a one-tap affordance to re-bind. Without this
            the rail silently keeps the original focus and the user can't
            tell why their question went somewhere unexpected. */}
        {routeDiverged && routeContext && (
          <button
            type="button"
            onClick={adoptCurrentPage}
            data-testid="side-agent-adopt-page"
            className="mt-1 inline-flex w-full items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10.5px] text-amber-900 hover:bg-amber-100 transition-colors"
            title="The thread is still focused on the previous page. Click to adopt the current page."
          >
            <span className="flex-shrink-0">{routeContext.icon}</span>
            <span className="truncate text-left">
              You're now on <span className="font-medium">{routeContext.label}</span> — switch focus?
            </span>
            <span className="ml-auto flex-shrink-0 text-amber-600 font-medium">Switch</span>
          </button>
        )}
        <form
          className="relative"
          onSubmit={e => {
            e.preventDefault()
            sendMessage(composer)
          }}
        >
          {/* U.3.2 — /-slash quick-action menu. Replaces the deleted
              Cmd-K palette modal. Filters live as user types. Picking
              an item fills the composer + sends immediately. */}
          {slashVisible.length > 0 && (
            <div
              data-testid="side-agent-slash-popover"
              className="absolute bottom-full left-0 right-0 mb-1.5 rounded-lg border border-indigo-200 bg-card shadow-lg overflow-hidden text-[12px] z-10"
            >
              <div className="px-2.5 py-1 text-[9.5px] uppercase tracking-wider text-indigo-700 border-b border-indigo-100 bg-indigo-50/60">
                Quick actions · type to filter
              </div>
              <ul role="listbox" aria-label="Quick actions">
                {slashVisible.map((a, i) => {
                  const active = i === slashIdx
                  return (
                    <li
                      key={a.id}
                      role="option"
                      aria-selected={active}
                      onMouseDown={e => { e.preventDefault(); pickSlash(a) }}
                      onMouseEnter={() => setSlashIdx(i)}
                      data-testid={`side-agent-slash-item-${a.id}`}
                      data-active={active ? '1' : '0'}
                      className={`px-2.5 py-2 cursor-pointer flex items-start gap-2 ${active ? 'bg-indigo-50' : 'hover:bg-muted/50'}`}
                    >
                      <span className="text-base mt-0.5">{a.icon}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-medium text-gray-900 truncate">{a.label}</div>
                        {a.description && (
                          <div className="text-[10.5px] text-muted-foreground truncate">{a.description}</div>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {/* D.4.4 — @mention autocomplete. Positioned above the composer
              so the list grows upward (closest visual anchor to the '@'). */}
          {mentionQuery !== null && mentionMatches.length > 0 && (
            <div
              data-testid="side-agent-mention-popover"
              className="absolute bottom-full left-0 right-0 mb-1.5 rounded-lg border border-border bg-card shadow-lg overflow-hidden text-[12px] z-10"
            >
              <div className="px-2.5 py-1 text-[9.5px] uppercase tracking-wider text-muted-foreground border-b border-border bg-muted/40">
                Skills + entities · type to filter
              </div>
              <ul role="listbox" aria-label="Mention picker">
                {mentionMatches.map((item, i) => {
                  const active = i === mentionIdx
                  if (item.kind === 'skill') {
                    return (
                      <li
                        key={`skill::${item.id}`}
                        role="option"
                        aria-selected={active}
                        onMouseDown={e => { e.preventDefault(); pickMention(item) }}
                        onMouseEnter={() => setMentionIdx(i)}
                        data-testid={`side-agent-mention-item-${item.slug.slice(1)}`}
                        data-kind="skill"
                        data-active={active ? '1' : '0'}
                        className={`px-2.5 py-1.5 cursor-pointer flex items-start gap-2 ${active ? 'bg-blue-50' : 'hover:bg-muted/50'}`}
                      >
                        <Sparkles className={`h-3 w-3 mt-0.5 flex-shrink-0 ${active ? 'text-blue-600' : 'text-muted-foreground'}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-1.5">
                            <span className="font-mono text-[11px] text-blue-700">{item.slug}</span>
                            <span className="truncate text-[11px] text-foreground">{item.name}</span>
                          </div>
                          <div className="text-[10.5px] text-muted-foreground truncate">{item.description}</div>
                        </div>
                      </li>
                    )
                  }
                  // P4.3 — entity row (contract / matter / counterparty)
                  const tone = item.kind === 'contract' ? 'text-gray-700'
                    : item.kind === 'matter' ? 'text-indigo-700'
                    : 'text-emerald-700'
                  const kindLabel = item.kind === 'contract' ? 'Contract'
                    : item.kind === 'matter' ? 'Matter'
                    : 'Counterparty'
                  return (
                    <li
                      key={`${item.kind}::${item.id}`}
                      role="option"
                      aria-selected={active}
                      onMouseDown={e => { e.preventDefault(); pickMention(item) }}
                      onMouseEnter={() => setMentionIdx(i)}
                      data-testid={`side-agent-mention-entity-${item.kind}-${item.id}`}
                      data-kind={item.kind}
                      data-active={active ? '1' : '0'}
                      className={`px-2.5 py-1.5 cursor-pointer flex items-start gap-2 ${active ? 'bg-blue-50' : 'hover:bg-muted/50'}`}
                    >
                      <span className={`text-[10.5px] font-mono ${tone} flex-shrink-0 mt-0.5`}>
                        {kindLabel[0]}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5">
                          <span className="truncate text-[11.5px] text-foreground font-medium">{item.label}</span>
                        </div>
                        {item.sub && (
                          <div className="text-[10.5px] text-muted-foreground truncate">{item.sub}</div>
                        )}
                      </div>
                      <span className="text-[9.5px] uppercase tracking-wider text-muted-foreground flex-shrink-0 mt-0.5">
                        {kindLabel}
                      </span>
                    </li>
                  )
                })}
              </ul>
              <div className="px-2.5 py-1 text-[9.5px] text-muted-foreground border-t border-border bg-muted/40 flex items-center justify-between">
                <span>↑↓ navigate · Enter insert · Esc close</span>
                <span>{mentionMatches.length}</span>
              </div>
            </div>
          )}
          <textarea
            ref={composerRef}
            value={composer}
            onChange={e => handleComposerChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onKeyDown={e => {
              // U.3.2 — /-slash menu keyboard nav (priority).
              if (slashVisible.length > 0) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx(i => (i + 1) % slashVisible.length); return }
                if (e.key === 'ArrowUp')   { e.preventDefault(); setSlashIdx(i => (i - 1 + slashVisible.length) % slashVisible.length); return }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  pickSlash(slashVisible[slashIdx])
                  return
                }
                if (e.key === 'Escape') { e.preventDefault(); setSlashQuery(null); return }
              }
              // D.4.4 — dropdown keyboard controls take priority when open.
              if (mentionQuery !== null && mentionMatches.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setMentionIdx(i => (i + 1) % mentionMatches.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMentionIdx(i => (i - 1 + mentionMatches.length) % mentionMatches.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  pickMention(mentionMatches[mentionIdx])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setMentionQuery(null)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                e.currentTarget.form?.requestSubmit()
              }
            }}
            disabled={streaming}
            placeholder={streaming ? 'Generating…' : 'Ask anything · @ for skills · / for actions'}
            rows={2}
            data-testid="side-agent-composer"
            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 pr-10 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition-colors disabled:opacity-60"
          />
          <Button
            type="submit"
            size="icon"
            disabled={composer.trim().length === 0 || streaming}
            title="Send (Enter)"
            data-testid="side-agent-send"
            className="absolute right-1.5 bottom-1.5 h-7 w-7"
          >
            {streaming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </Button>
        </form>
        <div className="text-[10px] text-gray-400 mt-1.5 flex items-center justify-between">
          <span>⌘K focus · Enter send · @ skills · / actions</span>
          <span className="font-mono">v3</span>
        </div>
        {/* U.3.1 / decision 13 — read-only handoff. Always-visible footer
            link points users to Assistant for multi-step / artifact work
            (drafts, exports, sends). Keeps rail intentionally lean. */}
        <a
          href="/agent"
          data-testid="side-agent-handoff-link"
          className="block mt-2 px-2.5 py-1.5 rounded-md bg-gray-50 border border-gray-200 hover:border-indigo-300 hover:bg-indigo-50 text-[11px] text-gray-600 hover:text-indigo-700 transition-colors text-center"
        >
          For drafts, exports, multi-step work → <span className="font-medium">open Assistant ↗</span>
        </a>
      </footer>
    </aside>
  )
}

/**
 * P7.1.4 (F-17 fix) — Build route-aware starter prompts. The previous
 * version hardcoded "Acme Corp" + generic prompts on every page; the
 * agent's "context-aware" promise was unmet.
 *
 * Now the prompt list adapts to the current page:
 *   • on /contracts/:id     → 4 contract-scoped prompts (use this contract)
 *   • on /matters/:id       → 4 matter-scoped prompts
 *   • on /counterparties/:id → 4 counterparty-scoped prompts
 *   • on /approvals         → "What's in my approval queue?" + decision-focused
 *   • on /requests          → request-scoped
 *   • on /dashboard or default → portfolio-level prompts
 *
 * Each prompt is written so the agent uses the right tool (contract_get
 * with the current id, renewal_advice, approval_list, etc.) — see
 * docs/30 §5 for tool catalog.
 */
function buildSuggestions(context: { type: string; id: string; label: string } | null): string[] {
  const label = context?.label ?? 'this'
  if (context?.type === 'contract') {
    return [
      `Summarise ${label} — risks, key terms, what stands out`,
      `Compare ${label} to our playbook positions`,
      `What's the timeline / status on ${label}?`,
      `Find similar past deals in our portfolio`,
    ]
  }
  if (context?.type === 'matter') {
    return [
      `Summarise the ${label} matter — all contracts at a glance`,
      `What risks are open across ${label}?`,
      `What's the next step on each contract in ${label}?`,
    ]
  }
  if (context?.type === 'counterparty') {
    return [
      `What contracts do we have with ${label}?`,
      `What's our negotiation history with ${label}?`,
      `Brief me on every open deal with ${label}`,
    ]
  }
  if (context?.type === 'approval') {
    return [
      `Summarise this approval — what am I being asked to decide?`,
      `What are the top 3 risks I should weigh before approving?`,
    ]
  }
  // Default — dashboard / list views / no entity context
  return [
    "What's in my approval queue?",
    'Which contracts in my portfolio expire in the next 90 days?',
    "What's blocking each of my drafts in progress?",
    'Brief me on every contract I own that\'s in negotiation',
  ]
}

function SideAgentEmptyState({
  onSuggestion,
  context,
}: {
  onSuggestion: (text: string) => void
  context: { type: string; id: string; label: string } | null
}) {
  const suggestions = buildSuggestions(context)
  return (
    <div className="text-center py-8">
      <div className="h-10 w-10 mx-auto rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center mb-3">
        <Sparkles className="h-5 w-5 text-blue-600" />
      </div>
      <div className="text-sm font-medium text-gray-900">How can I help?</div>
      <p className="text-[11px] text-gray-500 mt-1 max-w-[260px] mx-auto leading-relaxed">
        {context
          ? `I'm focused on this ${context.type} — start with one below or ask anything.`
          : 'I\'m context-aware — the page you\'re on, the contract you\'re viewing, the matter you\'re working. Start with one below or type a question.'}
      </p>
      <div className="mt-4 space-y-1.5 text-left max-w-[280px] mx-auto">
        {suggestions.map((s, i) => (
          <SuggestedPrompt key={i} text={s} onSelect={onSuggestion} />
        ))}
      </div>
    </div>
  )
}

function SuggestedPrompt({ text, onSelect }: { text: string; onSelect: (t: string) => void }) {
  return (
    <button
      type="button"
      data-testid="side-agent-suggestion"
      onClick={() => onSelect(text)}
      className="w-full text-left px-3 py-2 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 transition-colors"
    >
      <span className="text-[12px] text-gray-700">{text}</span>
    </button>
  )
}

function MessageBubble({
  msg, onActionApply, onActionCancel, onActionUndo, onChipSelect, streaming,
}: {
  msg: RailMessage
  onActionApply?:  (msgId: string, actionId: string, args: Record<string, unknown>) => void
  onActionCancel?: (msgId: string, actionId: string) => void
  onActionUndo?:   (msgId: string, actionId: string) => void
  /** P1 fix — chip click sends the chip text as the next user turn. */
  onChipSelect?:   (text: string) => void
  /** Disable chips while a turn is streaming. */
  streaming?:      boolean
}) {
  const isUser = msg.role === 'user'
  // P1 fix — parse [chip]: lines out of assistant prose so they render
  // as ChipButton, not raw text in the bubble. Skip on user / streaming
  // / error messages — chips only attach to a finalized assistant prose.
  const { cleanProse, chips } = (!isUser && !msg.error && !msg.streaming)
    ? parseActionChips(msg.content ?? '')
    : { cleanProse: msg.content ?? '', chips: [] as ReturnType<typeof parseActionChips>['chips'] }
  return (
    <div
      className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} gap-1.5`}
      data-testid={`side-agent-msg-${msg.role}`}
      data-skill-slug={msg.skillSlug ?? undefined}
    >
      {/* D.4.4 — when the user invoked a skill, chip it above the bubble so
          the provenance of the answer is obvious. */}
      {isUser && msg.skillSlug && (
        <div
          data-testid="side-agent-skill-chip"
          data-slug={msg.skillSlug}
          className="text-[10px] inline-flex items-center gap-1 text-blue-700 bg-blue-50 border border-blue-100 rounded-full px-2 py-0.5 font-mono"
        >
          <Sparkles className="h-2.5 w-2.5" />
          {msg.skillSlug}
        </div>
      )}
      {/* D.1.5 — Tool-call traces stack above the assistant bubble so you see
          "looked at X, searched for Y" → "here's my answer" in reading order.
          Skipped on user bubbles (users don't call tools).

          P1.6 — when a tool call is redline_propose + succeeded, render
          the richer RedlinePreview component instead of the generic
          JSON chip. Everything else falls through to ToolCallChip. */}
      {!isUser && msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="flex flex-col gap-1 w-full max-w-[95%]" data-testid="side-agent-tool-trace">
          {msg.toolCalls.map(tc => {
            if (tc.name === 'redline_propose' && tc.redlineProposal) {
              return (
                <RedlinePreview
                  key={tc.id}
                  proposal={tc.redlineProposal as RedlineProposal}
                  onApplyVariant={(_variant, action) => {
                    // Reuse the rail-inject-action hook — same surface
                    // every inline "Apply this" ships through.
                    window.dispatchEvent(new CustomEvent('rail-inject-action', { detail: action }))
                  }}
                />
              )
            }
            // P3.1 — contract_cite → inline citation pills
            if (tc.name === 'contract_cite' && tc.citationBundle) {
              return <CitationPills key={tc.id} bundle={tc.citationBundle as CitationBundle} />
            }
            return <ToolCallChip key={tc.id} call={tc} />
          })}
        </div>
      )}
      {/* D.3.1 — Pending write actions render inline above the prose bubble.
          Each awaiting_confirmation stays until the user clicks Apply or
          Cancel; terminal states collapse to a one-line receipt. */}
      {!isUser && msg.pendingActions && msg.pendingActions.length > 0 && (
        <div className="flex flex-col gap-1 w-full max-w-[85%]" data-testid="side-agent-pending-actions">
          {msg.pendingActions.map(a => (
            <ActionPreview
              key={a.id}
              action={a}
              onApply={args => onActionApply?.(msg.id, a.id, args)}
              onCancel={() => onActionCancel?.(msg.id, a.id)}
              onUndo={() => onActionUndo?.(msg.id, a.id)}
            />
          ))}
        </div>
      )}
      <div
        className={
          'max-w-[85%] rounded-2xl px-3 py-2 text-[12.5px] leading-relaxed ' +
          // User + error bubbles stay plain-text (preserve their whitespace
          // for typed input / raw error output). Assistant bubble below
          // renders Markdown so **bold**, * lists, and `code` show correctly.
          (isUser
            ? 'bg-blue-600 text-white rounded-br-sm whitespace-pre-wrap'
            : (msg.error
                ? 'bg-red-50 border border-red-100 text-red-900 rounded-bl-sm whitespace-pre-wrap'
                : 'bg-gray-100 text-gray-900 rounded-bl-sm'))
        }
      >
        {cleanProse
          ? (isUser || msg.error
              ? cleanProse
              : <MarkdownProse text={cleanProse} compact />)
          : (msg.streaming ? <Sparkles className="h-3.5 w-3.5 animate-pulse text-gray-400" /> : null)}
        {msg.streaming && (msg.content?.length ?? 0) > 0 && (
          <span className="inline-block w-1.5 h-3 bg-gray-400 ml-0.5 animate-pulse align-middle" aria-hidden />
        )}
      </div>
      {/* P1 fix — render parsed action chips below the assistant bubble.
          U10 — and skeletons during streaming so the row reserves space
          and the user anticipates what's coming. */}
      {!isUser && onChipSelect && (chips.length > 0 || msg.streaming) && (
        <ChipRow
          chips={chips}
          onSelect={(chip) => onChipSelect(chip.label)}
          disabled={streaming}
          streaming={!!msg.streaming}
        />
      )}
    </div>
  )
}

// D.1.5 — collapsible chip for a single tool call.
//
// Closed state: one line with icon + tool name + one-line arg summary + status.
// Open state: adds formatted args + truncated result preview in a mono block.
//
// Design reference: Cursor's collapsible tool traces (one line → expand),
// Claude.ai's tool-use blocks, Perplexity's source chips. Status colors match
// the audit log chips (D.0.8e) for consistency: running=blue, ok=emerald,
// error=red.
function ToolCallChip({ call }: { call: RailToolCall }) {
  const [open, setOpen] = useState(false)

  const statusColor = call.status === 'running'
    ? 'text-blue-600 bg-blue-50 border-blue-100'
    : call.status === 'error'
      ? 'text-red-700 bg-red-50 border-red-100'
      : 'text-emerald-700 bg-emerald-50 border-emerald-100'
  const StatusIcon = call.status === 'running' ? Loader2
    : call.status === 'error' ? AlertTriangle
    : CheckCircle2
  const iconSpin = call.status === 'running' ? ' animate-spin' : ''

  // One-line arg summary — show the primary discriminator (contractId /
  // query / type) so the user gets a sense of WHAT the tool was called with
  // without expanding. A2/U5 — when an entityHint is attached (resolved from
  // the tool result), prefer the human title over the truncated cuid.
  const argsSummary = summarizeArgs(call.args, call.entityHint)

  const resultLen = (call.resultPreview ?? '').length

  return (
    <div
      className={`rounded-lg border ${statusColor} text-[11px] overflow-hidden`}
      data-testid={`tool-chip-${call.name}`}
      data-tool-status={call.status}
    >
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:brightness-95 transition-all"
      >
        <StatusIcon className={`h-3 w-3 flex-shrink-0${iconSpin}`} />
        <span className="font-mono font-medium text-[10.5px] flex-shrink-0">{call.name}</span>
        {argsSummary && (
          <span className="text-[10.5px] truncate opacity-75">{argsSummary}</span>
        )}
        <span className="ml-auto flex items-center gap-1 flex-shrink-0">
          {call.status === 'running' && typeof call.elapsedSec === 'number' && call.elapsedSec >= 3 && (
            <span className="text-[10px] opacity-70 tabular-nums">
              {call.elapsedSec.toFixed(1)}s
            </span>
          )}
          {call.status === 'ok' && resultLen > 0 && (
            <span className="text-[10px] opacity-60 tabular-nums">
              {call.truncated ? '>' : ''}{resultLen}ch
            </span>
          )}
          <ChevronRight
            className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`}
          />
        </span>
      </button>
      {open && (
        <div className="border-t border-current/10 bg-white/60 px-2 py-1.5 space-y-1.5">
          {/* Args block */}
          <div>
            <div className="text-[9px] font-medium uppercase tracking-wider opacity-60 mb-0.5">Args</div>
            <pre className="text-[10px] font-mono leading-snug whitespace-pre-wrap break-all opacity-90">
{JSON.stringify(call.args, null, 2)}
            </pre>
          </div>
          {/* Result block — only when we have one */}
          {call.status !== 'running' && call.resultPreview && (
            <div>
              <div className="text-[9px] font-medium uppercase tracking-wider opacity-60 mb-0.5">
                Result{call.truncated ? ' (truncated)' : ''}
              </div>
              <pre className="text-[10px] font-mono leading-snug whitespace-pre-wrap break-all max-h-40 overflow-y-auto opacity-90">
{call.resultPreview}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── ThreadPickerPanel (D.1.6b) ────────────────────────────────────────────
//
// Dropdown anchored under the header showing recent threads. Groups into
// "In this page context" (when useAgentContext has a contract id) + "Other
// threads". Each row = title + relative time + message count + a tiny
// trash icon to archive.
//
// Design reference: Cursor's recent-chats flyout (scoped first, everything
// below), ChatGPT's left-rail list.

function ThreadPickerPanel({
  threads, activeId, currentContext, onSelect, onNewThread, onClose,
  accessToken, onAfterArchive,
}: {
  threads: Array<{ id: string; title: string; scopeType: string | null; scopeId: string | null; messageCount: number; updatedAt: string }>
  activeId: string | null
  currentContext: { type: string; id: string; label: string } | null
  onSelect: (id: string) => void
  onNewThread: () => void
  onClose: () => void
  accessToken: string
  onAfterArchive: () => void
}) {
  // Partition by whether the thread is scoped to the current page context.
  // Then within "other", bucket by recency (Today / Yesterday / This week /
  // Older) so the demo narrative stays focused on what's recent — old
  // threads from previous demos used to leak into the visible list and
  // confuse buyers (audit U9, 2026-04-29).
  //
  // STALE_DAYS hides anything older — set to 30 because that matches the
  // expected demo cadence; the user can still find archived threads via
  // search later (D.1.7c). Returning home (no context) shows everything.
  const STALE_DAYS = 30
  const now = Date.now()
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0)
  const todayMs    = dayStart.getTime()
  const yestMs     = todayMs - 24 * 60 * 60 * 1000
  const weekMs     = todayMs - 7 * 24 * 60 * 60 * 1000
  const staleMs    = now - STALE_DAYS * 24 * 60 * 60 * 1000

  const inScope: typeof threads = []
  type Bucket = { label: string; items: typeof threads }
  const today:    typeof threads = []
  const yesterday: typeof threads = []
  const thisWeek: typeof threads = []
  const older:    typeof threads = []

  for (const t of threads) {
    const tMs = new Date(t.updatedAt).getTime()
    // Drop stale threads when we're focused on a context — their presence
    // is more confusing than helpful. On the home page (no context) we
    // keep everything so the user can rediscover history.
    if (currentContext && tMs < staleMs) continue

    if (currentContext && t.scopeType === currentContext.type && t.scopeId === currentContext.id) {
      inScope.push(t)
      continue
    }
    if (tMs >= todayMs)      today.push(t)
    else if (tMs >= yestMs)  yesterday.push(t)
    else if (tMs >= weekMs)  thisWeek.push(t)
    else                     older.push(t)
  }
  const otherBuckets: Bucket[] = [
    { label: 'Today',         items: today },
    { label: 'Yesterday',     items: yesterday },
    { label: 'Earlier this week', items: thisWeek },
    { label: 'Older',         items: older },
  ].filter(b => b.items.length > 0)
  const hasOther = otherBuckets.length > 0

  async function archive(id: string, evt: React.MouseEvent) {
    evt.stopPropagation()
    try {
      await fetch(`/api/v1/agent/threads/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      onAfterArchive()
    } catch { /* non-fatal */ }
  }

  return (
    <>
      {/* Click-catcher to close on outside click. */}
      <div className="fixed inset-0 z-30" onClick={onClose} aria-hidden />
      <div
        role="menu"
        data-testid="side-agent-thread-picker-panel"
        className="absolute left-3 top-[52px] w-[372px] max-h-[480px] overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-xl z-40 py-1.5"
      >
        {/* New thread — always first */}
        <button
          type="button"
          onClick={onNewThread}
          data-testid="side-agent-thread-picker-new"
          className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-blue-700 hover:bg-blue-50 transition-colors"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          <span className="font-medium">New thread</span>
        </button>

        {threads.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-gray-400">
            No prior threads yet. Send a message to start one.
          </div>
        )}

        {inScope.length > 0 && (
          <>
            <div className="px-3 pt-2 pb-1 text-[9px] font-medium uppercase tracking-wider text-gray-400">
              In this {currentContext?.type}
            </div>
            {inScope.map(t => (
              <ThreadPickerRow
                key={t.id} t={t} active={t.id === activeId}
                onSelect={() => onSelect(t.id)}
                onArchive={(e) => archive(t.id, e)}
              />
            ))}
          </>
        )}

        {hasOther && (
          <>
            {inScope.length > 0 && <div className="border-t border-gray-100 mt-1" />}
            {otherBuckets.map((bucket, i) => (
              <div key={bucket.label}>
                {/* Subtle divider between buckets so eye doesn't run them
                    together when there are 3+ */}
                {i > 0 && <div className="border-t border-gray-50 mt-0.5" />}
                <div
                  className="px-3 pt-2 pb-1 text-[9px] font-medium uppercase tracking-wider text-gray-400"
                  data-testid={`thread-bucket-${bucket.label.toLowerCase().replace(/\W+/g, '-')}`}
                >
                  {bucket.label}
                </div>
                {bucket.items.map(t => (
                  <ThreadPickerRow
                    key={t.id} t={t} active={t.id === activeId}
                    onSelect={() => onSelect(t.id)}
                    onArchive={(e) => archive(t.id, e)}
                  />
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </>
  )
}

function ThreadPickerRow({
  t, active, onSelect, onArchive,
}: {
  t: { id: string; title: string; messageCount: number; updatedAt: string }
  active: boolean
  onSelect: () => void
  onArchive: (e: React.MouseEvent) => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`side-agent-thread-picker-row-${t.id}`}
      className={`w-full group flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-50 transition-colors ${active ? 'bg-blue-50/50' : ''}`}
    >
      <div className="flex-1 min-w-0">
        <div className={`text-[12px] truncate ${active ? 'font-semibold text-blue-800' : 'text-gray-900'}`}>
          {t.title}
        </div>
        <div className="text-[10px] text-gray-400 flex items-center gap-1.5">
          <span>{t.messageCount} msg{t.messageCount === 1 ? '' : 's'}</span>
          <span aria-hidden>·</span>
          <span>{formatRel(t.updatedAt)}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={onArchive}
        aria-label="Archive thread"
        title="Archive thread"
        className="p-1 rounded text-gray-300 opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-red-50 transition-all"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </button>
  )
}

// ─── QuickActionChips (D.1.7) ──────────────────────────────────────────────
//
// Tiny single-tap "skill" chips above the composer. Hard-coded for D1 —
// D.4 replaces this catalog with rows from the Skill table so admins can
// author their own + share across the org.
//
// Design reference: ChatGPT's suggested-prompts row, Perplexity's focus-mode
// chips, Notion AI's contextual slash menu. Pattern: compact pill, click
// drops into the composer (not auto-send, so the user can tweak first).

interface QuickAction {
  /** Short label shown in the chip. Stays under ~20 chars. */
  label: string
  /** Full prompt text dropped into the composer on click. */
  prompt: string
}

const CONTRACT_ACTIONS: QuickAction[] = [
  { label: 'Summarise risks',
    prompt: 'Summarise the top risks in this contract in 3 bullets, citing the relevant sections.' },
  { label: 'Key terms',
    prompt: 'List the key commercial terms of this contract (value, term, renewal, liability cap, governing law, payment).' },
  { label: 'Auto-renewal?',
    prompt: 'Does this contract auto-renew? If so, what is the notice period and by when must it be served?' },
  { label: 'Termination',
    prompt: 'What are the termination rights under this contract — for convenience, for cause, and any notice periods?' },
  { label: 'Liability cap',
    prompt: 'What is the liability cap in this contract and what carve-outs apply?' },
]

const DASHBOARD_ACTIONS: QuickAction[] = [
  { label: 'My queue',
    prompt: "What's pending my action right now across contracts, requests, and approvals?" },
  { label: 'Expiring soon',
    prompt: 'Which of my contracts expire in the next 90 days?' },
  { label: 'High-risk open',
    prompt: 'Show me any open contracts with a risk score above 0.5.' },
  { label: 'Draft NDA',
    prompt: 'Draft an NDA for ' },  // deliberately trailing — user fills counterparty
]

const GENERIC_ACTIONS: QuickAction[] = [
  { label: 'Find contract',
    prompt: 'Find the contract with ' },
  { label: 'Explain a clause',
    prompt: 'Explain this clause in plain English: ' },
]

function QuickActionChips({
  context, disabled, onPick,
}: {
  context: { type: string; id: string; label: string } | null
  disabled?: boolean
  onPick: (text: string) => void
}) {
  const actions = context?.type === 'contract'
    ? CONTRACT_ACTIONS
    : DASHBOARD_ACTIONS  // D.4 routes by more scope types; D.1 only splits two ways
  return (
    <div
      className="flex gap-1.5 flex-wrap"
      data-testid="side-agent-quick-actions"
      data-context-type={context?.type ?? 'none'}
    >
      {actions.map(a => (
        <button
          key={a.label}
          type="button"
          disabled={disabled}
          onClick={() => onPick(a.prompt)}
          data-testid={`quick-action-${a.label.toLowerCase().replace(/\s+/g, '-')}`}
          className="text-[10.5px] rounded-full border border-gray-200 bg-white px-2 py-0.5 text-gray-600 hover:text-blue-700 hover:border-blue-200 hover:bg-blue-50 transition-colors disabled:opacity-50 disabled:pointer-events-none"
          title={a.prompt}
        >
          {a.label}
        </button>
      ))}
    </div>
  )
}

// Suppress unused-var warning — GENERIC_ACTIONS is reserved for a future
// "page type we don't specifically know" fallthrough; keep for D.4 wiring.
void GENERIC_ACTIONS

/** Match the server-side defaultTitle() helper so the header label updates
 *  immediately without waiting for a refetch. */
function defaultHeaderTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim().replace(/\s+/g, ' ')
  return trimmed.length <= 60 ? trimmed : trimmed.slice(0, 57) + '…'
}

/** Compact relative-time label for thread rows. "just now", "5m", "2h", "3d". */
function formatRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.round(hrs / 24)
  return `${days}d`
}

/**
 * Turn an args object into a compact one-liner for the chip's closed state.
 * Knows about our four read tools' argument shapes so the summary is useful
 * at a glance; falls through to JSON for unknown tools.
 */
function summarizeArgs(
  args: Record<string, unknown>,
  entityHint?: RailToolCall['entityHint'],
): string {
  const keys = Object.keys(args)
  if (keys.length === 0 && !entityHint) return ''
  const pick = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined)

  // A2/U5 — when the result hinted at a resolved entity title, lead with that.
  // Truncate long titles so the chip stays a single line.
  if (entityHint?.title) {
    const title = entityHint.title.length > 36
      ? entityHint.title.slice(0, 35) + '…'
      : entityHint.title
    const q = pick('query')
    return q ? `${title} · "${q}"` : title
  }

  // contract_get / contract_summarize / clause_search
  if (pick('contract_id')) {
    const id = pick('contract_id')!.slice(0, 6)
    const q = pick('query')
    return q ? `${id}… · "${q}"` : `${id}…`
  }
  // contract_search
  const bits: string[] = []
  if (pick('query'))             bits.push(`"${pick('query')}"`)
  if (pick('type'))              bits.push(`type=${pick('type')}`)
  if (pick('status'))            bits.push(`status=${pick('status')}`)
  if (pick('counterpartyName'))  bits.push(`cp=${pick('counterpartyName')}`)
  if (typeof args.limit === 'number' && args.limit !== 10) bits.push(`limit=${args.limit}`)
  if (bits.length > 0) return bits.join(' · ')

  // Fallback — stringify; truncate.
  const s = JSON.stringify(args)
  return s.length > 60 ? s.slice(0, 60) + '…' : s
}
