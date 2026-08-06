"""
Langfuse tracing (D.0.7)

Every LLM call routed through resolve_llm() carries a Langfuse CallbackHandler
that captures prompts, tool calls, token counts, latency, and cost into a
trace you can open in the Langfuse dashboard.

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

The SDK is lazy-imported so langfuse can be an optional install in CI.
"""
from __future__ import annotations

import logging
from typing import Any

from .config import settings

log = logging.getLogger(__name__)

# Lazy-imported lazy-instantiated — we only load the SDK when tracing is actually
# turned on, so dev environments without LANGFUSE_* keys don't pay the import cost.
_handler_factory: Any = None  # type: ignore[assignment]
_import_checked: bool = False


def _load_handler_factory() -> Any | None:
    """
    Import CallbackHandler once; cache failure so we don't retry every call.

    The handler moved between major versions: `langfuse.callback` in v2,
    `langfuse.langchain` in v3+. requirements.txt pins `langfuse>=2.55.0` with
    no upper bound, so a fresh install resolves to v4 and the v2-only import
    fails — which used to be logged at INFO and swallowed, silently disabling
    tracing across every agent while `resolve_llm` kept cheerfully returning an
    empty callback list. Try both layouts, and if neither loads say so loudly:
    "no traces anywhere" should never be a quiet condition.
    """
    global _handler_factory, _import_checked
    if _import_checked:
        return _handler_factory
    _import_checked = True

    attempts: list[str] = []
    for module, attr in (('langfuse.langchain', 'CallbackHandler'),
                         ('langfuse.callback',  'CallbackHandler')):
        try:
            mod = __import__(module, fromlist=[attr])
            _handler_factory = getattr(mod, attr)
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
) -> Any | None:
    """
    Build a Langfuse CallbackHandler for a single LLM invocation.

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
    }
    if extra_metadata:
        metadata.update(extra_metadata)
    # Drop keys whose value is None so the Langfuse UI doesn't show empty rows.
    metadata = {k: v for k, v in metadata.items() if v is not None}

    try:
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
        # Never let a tracing bug break the actual LLM call
        log.warning("[tracing] failed to build Langfuse handler — continuing untraced: %s", e)
        return None


def flush() -> None:
    """
    Flush buffered Langfuse events before process exit.

    Langfuse batches events in a background thread for throughput. If the
    worker exits without flushing, the last couple of traces get dropped.
    Call this from a FastAPI shutdown hook or after a one-shot script.
    """
    factory = _load_handler_factory()
    if factory is None:
        return
    try:
        from langfuse import Langfuse  # type: ignore
        Langfuse(
            public_key=settings.langfuse_public_key,
            secret_key=settings.langfuse_secret_key,
            host=settings.langfuse_host,
        ).flush()
    except Exception as e:
        log.warning("[tracing] flush failed: %s", e)
