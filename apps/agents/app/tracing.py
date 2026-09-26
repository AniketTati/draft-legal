"""
Langfuse tracing (D.0.7)

Every LLM call routed through resolve_llm() carries a Langfuse CallbackHandler
that captures prompts, tool calls, token counts, latency, and cost into a
trace you can open in the Langfuse dashboard.

Local dev traces to the open-source Langfuse in docker-compose.langfuse.yml
(`pnpm langfuse:up`); Cloud Run traces to Langfuse Cloud. Nothing here knows or
cares which — it is whatever LANGFUSE_HOST points at.
See docs/operations/LANGFUSE.md.

Why Langfuse (and not LangSmith / Helicone / OpenAI dashboard):
  - Open-source, self-hostable — customer data stays in our perimeter.
  - Native LangChain integration: wiring is one callback attribute on the
    model, no SDK changes elsewhere.
  - Structured traces (session > trace > generation > span) match how we
    already model agent runs (thread > message > tool_call).

Graceful degradation:
  - If LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are unset, get_callback()
    returns None. Callers pass [] into LangChain's `callbacks=` — a no-op.
  - If the Langfuse SDK is not installed, the import fails *here* and we
    also return None. The agent keeps running unobserved rather than crashing
    — tracing is never the critical path.

What metadata we attach to every trace:
  - tags: ['tier:<default|fast|…>', 'provider:<openai|anthropic|…>', 'model:<id>', 'source:<platform|byok>']
  - metadata: { orgId, userId?, toolName?, threadId?, ... } — filterable from the UI
  - trace_name: the caller's `trace_name` (e.g., "review.analyze", "app_agent.ask")

── SDK generations ──────────────────────────────────────────────────────────
The handler has been through two incompatible designs, and we support both
because `langfuse>=3.0.0,<5.0` can resolve to either 3 or 4:

  v2  `langfuse.callback.CallbackHandler(public_key=…, secret_key=…, host=…,
      session_id=…, user_id=…, trace_name=…, tags=…, metadata=…)`
      — everything on the constructor.

  v3+ `langfuse.langchain.CallbackHandler()` takes NO auth and NO trace
      attributes. Auth lives on a client singleton built once via
      `Langfuse(public_key=…, secret_key=…, host=…)`, and the per-call
      attributes travel in the LangChain *run config* metadata under reserved
      keys (`langfuse_session_id`, `langfuse_user_id`, `langfuse_trace_name`,
      `langfuse_tags`).

Passing v2's kwargs to a v3+ handler raises TypeError. That was swallowed by
the `except Exception` below and returned None, so on any fresh install
(pip resolves to v4) `tracing_enabled()` reported True while EVERY call ran
untraced — the exact silent-no-traces failure this module's import guard was
written to prevent, one layer further in.

The v3+ per-call attributes are the awkward part: our ~37 call sites all pass
`config={"callbacks": r.callbacks}` and nothing else, so there is no run config
for us to put them in. Rather than touch every call site, _AttributedHandler
below injects them into the run metadata itself. It overrides only the five
`on_*_start` methods of the LangChain callback protocol — public, stable API —
and never reaches into Langfuse internals.
"""
from __future__ import annotations

import logging
from contextvars import ContextVar
from typing import Any

from .config import settings

log = logging.getLogger(__name__)

# Lazy-imported lazy-instantiated — we only load the SDK when tracing is actually
# turned on, so dev environments without LANGFUSE_* keys don't pay the import cost.
_handler_factory: Any = None  # type: ignore[assignment]
_import_checked: bool = False
# True when the SDK is the v3+ client-singleton design, False for v2's
# everything-on-the-constructor design.
_modern_sdk: bool = False
# The v3+ client singleton, built once from settings. Also what flush() drains.
_client: Any = None
_client_signature: tuple[str, str, str] | None = None
# The metadata-injecting handler subclass, generated once per process.
_attributed_cls: Any = None


def _load_handler_factory() -> Any | None:
    """
    Import CallbackHandler once; cache failure so we don't retry every call.

    The handler moved between major versions: `langfuse.callback` in v2,
    `langfuse.langchain` in v3+. Try both layouts, record which one we got
    (the constructor contracts differ — see the module docstring), and if
    neither loads say so loudly: "no traces anywhere" should never be a quiet
    condition.
    """
    global _handler_factory, _import_checked, _modern_sdk
    if _import_checked:
        return _handler_factory
    _import_checked = True

    attempts: list[str] = []
    for module, attr, modern in (('langfuse.langchain', 'CallbackHandler', True),
                                 ('langfuse.callback',  'CallbackHandler', False)):
        try:
            mod = __import__(module, fromlist=[attr])
            _handler_factory = getattr(mod, attr)
            _modern_sdk = modern
            return _handler_factory
        except Exception as e:  # ImportError, or a transitive dep failing to load
            attempts.append(f'{module}: {type(e).__name__}: {e}')

    log.warning(
        '[tracing] Langfuse keys are set but no CallbackHandler could be imported — '
        'LLM traces are DISABLED for every agent. Tried %s',
        ' | '.join(attempts),
    )
    return None


def tracing_enabled() -> bool:
    """True iff all three Langfuse keys are set AND the SDK imports."""
    return bool(
        settings.langfuse_public_key
        and settings.langfuse_secret_key
        and settings.langfuse_host
        and _load_handler_factory() is not None
    )


def _get_client() -> Any | None:
    """
    Build (once) the v3+ Langfuse client that owns auth for every handler.

    Keyed on the current credentials so a settings change — which the smoke
    tests do deliberately — rebuilds rather than silently reusing a client
    pointed at the old host.
    """
    global _client, _client_signature
    signature = (
        settings.langfuse_public_key,
        settings.langfuse_secret_key,
        settings.langfuse_host,
    )
    if _client is not None and _client_signature == signature:
        return _client
    try:
        from langfuse import Langfuse  # type: ignore
        _client = Langfuse(
            public_key=settings.langfuse_public_key,
            secret_key=settings.langfuse_secret_key,
            host=settings.langfuse_host,
        )
        _client_signature = signature
        return _client
    except Exception as e:
        log.warning("[tracing] could not build Langfuse client — continuing untraced: %s", e)
        return None


def _get_attributed_cls(factory: Any) -> Any:
    """
    Build (once) a v3+ CallbackHandler subclass that carries per-call trace
    attributes, and cache it — get_callback() runs on every LLM call, so
    defining the class per call would churn a new type per request.

    In v3+ the attributes ride in the LangChain run config metadata, but our
    call sites pass only `callbacks=`. Injecting them in the five `on_*_start`
    hooks gets the same result without changing a single caller. Those five are
    the LangChain callback protocol — public, stable API — so this does not
    reach into Langfuse internals. Caller-supplied metadata always wins, so an
    explicit `config={"metadata": {...}}` still overrides.

    `name` is handled separately from the metadata because Langfuse only reads
    `langfuse_trace_name` in its on_chain_start root path. Most of our call
    sites invoke a chat model directly, so the root run is the model and the
    trace would be named after the class — a dashboard full of "ChatAnthropic"
    rows instead of "review.analyze". The run name is the handler's
    top-priority name source, so setting it on the ROOT run (only — naming
    children would flatten the tree) gets the intended name on every path.
    Verified against langfuse 4.15.1 by scripts/smoke_langfuse_live.py.
    """
    global _attributed_cls
    if _attributed_cls is not None:
        return _attributed_cls

    class _AttributedHandler(factory):  # type: ignore[misc,valid-type]
        # Set per instance by get_callback(). Class-level defaults keep the
        # handler safe to use if it is ever constructed directly.
        #
        # Exposed rather than closed over because on v2 these were constructor
        # args readable off the handler, and losing that made "is this trace
        # tagged correctly?" unanswerable without sending a trace and reading
        # the UI. smoke_d07.py asserts against them.
        langfuse_attributes: dict[str, Any] = {}
        langfuse_trace_name: str | None = None

        def _prep(self, kwargs: dict[str, Any], *, name_it: bool = True) -> dict[str, Any]:
            merged = dict(self.langfuse_attributes)
            if kwargs.get("metadata"):
                merged.update(kwargs["metadata"])
            kwargs["metadata"] = merged
            # `name_it=False` for tools and retrievers: those runs carry a name
            # that MEANS something (`renewal_advice`, `contract_search`) and
            # overwriting it with the turn's trace name produced a trace whose
            # every observation was called "agent.chat" — unfilterable, and
            # useless for step-level evaluation, which is entirely about telling
            # the retrieval step apart from the generation step.
            if name_it and kwargs.get("parent_run_id") is None and kwargs.get("name") is None:
                kwargs["name"] = self.langfuse_trace_name
            return kwargs

        def on_chat_model_start(self, serialized, messages, **kwargs):  # type: ignore[no-untyped-def]
            return super().on_chat_model_start(serialized, messages, **self._prep(kwargs))

        def on_llm_start(self, serialized, prompts, **kwargs):  # type: ignore[no-untyped-def]
            return super().on_llm_start(serialized, prompts, **self._prep(kwargs))

        def on_chain_start(self, serialized, inputs, **kwargs):  # type: ignore[no-untyped-def]
            return super().on_chain_start(serialized, inputs, **self._prep(kwargs))

        def on_tool_start(self, serialized, input_str, **kwargs):  # type: ignore[no-untyped-def]
            return super().on_tool_start(serialized, input_str, **self._prep(kwargs, name_it=False))

        def on_retriever_start(self, serialized, query, **kwargs):  # type: ignore[no-untyped-def]
            return super().on_retriever_start(serialized, query, **self._prep(kwargs, name_it=False))

    _attributed_cls = _AttributedHandler
    return _attributed_cls


def _build_attributed_handler(
    factory: Any, attributes: dict[str, Any], trace_name: str, trace_id: str | None = None
) -> Any:
    """
    Instantiate the cached handler subclass for one LLM invocation.

    `trace_id` groups several runs into ONE trace. A chat turn is a model call,
    then a tool call, then another model call; with no shared id each is its own
    root trace and the turn arrives in the dashboard as three unrelated rows,
    with no way to ask "what did the tool return that made the answer wrong".

    We pass it via the SDK's `trace_context` rather than opening a parent span,
    because the turn is an async generator: OpenTelemetry's current-span context
    is not reliably preserved across `yield` (PEP 568 was deferred), so a
    context-manager span would silently stop parenting partway through a stream.
    An explicit id has no such failure mode.
    """
    cls = _get_attributed_cls(factory)
    kwargs: dict[str, Any] = {"public_key": settings.langfuse_public_key}
    if trace_id:
        kwargs["trace_context"] = {"trace_id": trace_id}
    try:
        handler = cls(**kwargs)
    except TypeError:
        # Older handler without trace_context — group-by-trace is a nice-to-have,
        # tracing at all is not. Fall back rather than lose every span.
        log.warning("[tracing] CallbackHandler does not accept trace_context; "
                    "turn grouping disabled for this run")
        handler = cls(public_key=settings.langfuse_public_key)
    handler.langfuse_attributes = attributes
    handler.langfuse_trace_name = trace_name
    return handler


# ─── Request-scoped correlation ──────────────────────────────────────────────
# Set once per HTTP request by the middleware in main.py, read by get_callback.
#
# Why this exists: most endpoints have no thread/session concept. /classify and
# /extract_obligations take a blob of text and return JSON — there is nothing to
# group their traces by, so an eval harness (or a support engineer chasing one
# customer's bad extraction) has no way to say "the trace produced by THAT
# request". Chat gets this for free from thread_id; everything else got nothing.
#
# A ContextVar rather than threading a parameter through: there are ~37 call
# sites passing `callbacks` into LangChain, and every route would have to accept
# and forward a correlation id to reach them. This reaches all of them without
# touching any. ContextVars are per-task under asyncio, so concurrent requests
# do not see each other's value.
_correlation: ContextVar[dict[str, Any] | None] = ContextVar("langfuse_correlation", default=None)


def set_correlation(session_id: str | None = None, metadata: dict[str, Any] | None = None):
    """Bind a correlation id to the current request. Returns a reset token."""
    if not session_id and not metadata:
        return None
    return _correlation.set({"session_id": session_id, "metadata": metadata or {}})


def reset_correlation(token) -> None:
    if token is not None:
        _correlation.reset(token)


def get_callback(
    *,
    trace_name: str,
    org_id: str | None = None,
    user_id: str | None = None,
    tier: str | None = None,
    provider: str | None = None,
    model: str | None = None,
    source: str | None = None,
    thread_id: str | None = None,
    tool_name: str | None = None,
    extra_metadata: dict[str, Any] | None = None,
    trace_id: str | None = None,
) -> Any | None:
    """
    Build a Langfuse CallbackHandler for a single LLM invocation.

    `trace_id` (optional, 32 lowercase hex) groups every run that shares it into
    one trace — see _build_attributed_handler. Pass one per agent TURN so the
    model calls and the tool calls of that turn arrive as one thing.

    Returns None when tracing is disabled — safe to pass through to
    LangChain's `callbacks=[...]`: an empty list or `[None]` would be a bug,
    so callers should filter:
        handler = get_callback(...)
        callbacks = [handler] if handler else []
        llm.ainvoke(msgs, config={"callbacks": callbacks})

    Tags and metadata become filter axes in the Langfuse UI; keep them small.
    """
    factory = _load_handler_factory()
    if factory is None or not settings.langfuse_public_key or not settings.langfuse_secret_key:
        return None

    # An explicit thread_id from the caller always wins — a chat turn's real
    # session must not be overwritten by a correlation header.
    corr = _correlation.get()
    if corr:
        thread_id = thread_id or corr.get("session_id")
        merged = dict(corr.get("metadata") or {})
        merged.update(extra_metadata or {})   # caller's keys win on conflict
        extra_metadata = merged

    tags: list[str] = []
    if tier:     tags.append(f"tier:{tier}")
    if provider: tags.append(f"provider:{provider}")
    if model:    tags.append(f"model:{model}")
    if source:   tags.append(f"source:{source}")
    if tool_name: tags.append(f"tool:{tool_name}")

    metadata: dict[str, Any] = {
        "tier": tier,
        "provider": provider,
        "model": model,
        "source": source,
        "tool_name": tool_name,
        "thread_id": thread_id,
        "org_id": org_id,
    }
    if extra_metadata:
        metadata.update(extra_metadata)
    # Drop keys whose value is None so the Langfuse UI doesn't show empty rows.
    metadata = {k: v for k, v in metadata.items() if v is not None}

    try:
        if _modern_sdk:
            # Auth lives on the client singleton; without it the handler would
            # be built against an unconfigured (or wrong) project.
            if _get_client() is None:
                return None
            attributes: dict[str, Any] = dict(metadata)
            attributes["langfuse_trace_name"] = trace_name
            attributes["langfuse_tags"] = tags
            # Langfuse only accepts str here; a None would be dropped by its
            # isinstance check anyway, so omit rather than send a null.
            resolved_user = user_id or org_id
            if resolved_user:
                attributes["langfuse_user_id"] = resolved_user
            if thread_id:
                attributes["langfuse_session_id"] = thread_id
            return _build_attributed_handler(factory, attributes, trace_name, trace_id)

        # v2 — everything on the constructor.
        return factory(
            public_key=settings.langfuse_public_key,
            secret_key=settings.langfuse_secret_key,
            host=settings.langfuse_host,
            session_id=thread_id,          # groups related LLM calls within a thread
            user_id=user_id or org_id,     # Langfuse uses this for per-user filters
            trace_name=trace_name,
            tags=tags,
            metadata=metadata,
        )
    except Exception as e:
        # Never let a tracing bug break the actual LLM call. But say enough to
        # diagnose it: this branch is how tracing goes silently dark while
        # tracing_enabled() still says True, so name the SDK generation we
        # think we are talking to — a mismatch here is the usual cause.
        log.warning(
            "[tracing] failed to build Langfuse handler (sdk=%s) — this call and every "
            "other one will run UNTRACED: %s: %s",
            "v3+" if _modern_sdk else "v2", type(e).__name__, e,
        )
        return None


def flush() -> None:
    """
    Flush buffered Langfuse events before process exit.

    Langfuse batches events in a background thread for throughput. If the
    worker exits without flushing, the last couple of traces get dropped.
    Call this from a FastAPI shutdown hook or after a one-shot script.
    """
    if _load_handler_factory() is None:
        return
    if not settings.langfuse_public_key or not settings.langfuse_secret_key:
        return
    try:
        client = _get_client()
        if client is not None:
            client.flush()
    except Exception as e:
        log.warning("[tracing] flush failed: %s", e)
