"""
Provider router (D.0.3, Python side)

Asks the Node API "what's the resolved (provider, model, apiKey) tuple for
(orgId, tier)?" and returns a configured LangChain BaseChatModel.

Why a router and not just env vars?
  - Per-org BYOK: orgs can paste their own OpenAI / Anthropic / Google
    keys; we must use the org's key when present (their cost, their
    rate limit) and fall back to the platform key otherwise.
  - Per-org tier overrides: an admin can flip "all reasoning calls go
    to GPT-4.1" via the AI Config UI (D.0.8); the router honours the
    override automatically.
  - Multi-provider abstraction: code that calls resolve_llm() doesn't
    care which provider answers — just gives a tier and gets back a
    LangChain BaseChatModel.

Backward compatibility:
  - Pre-existing agents (review, redline, assist, draft, …) call
    config.active_provider() / smart_model() / active_model(). Those
    keep working — they don't pass an org_id and so don't go through
    this router.
  - New agent code (the app-wide hero + side agent landing in D1/D2)
    will pass org_id=req.user.orgId and route per-org.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

import httpx
from langchain_core.language_models.chat_models import BaseChatModel

from .config import settings
from .providers import build_llm
from .tracing import get_callback

Tier = Literal["reasoning", "default", "fast", "embed", "rerank", "vision_ocr"]
Source = Literal["platform", "byok"]


@dataclass
class ResolvedLlm:
    """Output of resolve_llm() — the configured model + metadata for tracing.

    `callbacks` is always a list (possibly empty). Callers pass it directly
    into `.ainvoke(config={"callbacks": resolved.callbacks})` — LangChain
    tolerates an empty list so this works whether Langfuse is on or off.
    """
    llm: BaseChatModel
    provider: str
    model: str
    source: Source
    tier: Tier
    callbacks: list[Any] = field(default_factory=list)


# ─── Platform fallback (when no Node call possible) ──────────────────────────
# Mirrors apps/api/src/lib/aiRouter.ts PLATFORM_TIER_DEFAULTS. Used by:
#   - Existing 7 agents that don't pass org_id
#   - Test harnesses that don't have a running Node server
# Order matters: highest-quality first; first one with an env key wins.

_PLATFORM_TIERS: dict[Tier, list[tuple[str, str]]] = {
    "reasoning":  [("anthropic", "claude-opus-4-7"),
                   ("openai",    "gpt-5"),
                   ("openai",    "gpt-4.1"),
                   ("google",    "gemini-2.5-pro")],
    "default":    [("anthropic", "claude-sonnet-4-6"),
                   ("openai",    "gpt-4.1"),
                   ("google",    "gemini-2.5-pro")],
    "fast":       [("anthropic", "claude-haiku-4-5"),
                   ("openai",    "gpt-4.1-mini"),
                   ("google",    "gemini-2.5-flash")],
    "embed":      [("openai",    "text-embedding-3-large"),
                   ("google",    "gemini-embedding-001")],
    "rerank":     [("openai",    "gpt-4.1-mini")],
    "vision_ocr": [("openai",    "gpt-4.1"),
                   ("google",    "gemini-2.5-pro")],
}

_ENV_KEY = {
    "openai":    "openai_api_key",
    "anthropic": "anthropic_api_key",
    "google":    "google_api_key",
    # voyage/cohere/mistral added when those tiers light up
}


def _platform_key(provider: str) -> str | None:
    attr = _ENV_KEY.get(provider)
    if not attr:
        return None
    return getattr(settings, attr, None) or None


def _platform_resolve(tier: Tier) -> tuple[str, str, str] | None:
    """Resolve (provider, model, key) from env only (no DB / no Node call)."""
    for provider, model in _PLATFORM_TIERS[tier]:
        key = _platform_key(provider)
        if key:
            return provider, model, key
    return None


# ─── Public resolver ─────────────────────────────────────────────────────────

async def resolve_llm(
    tier: Tier,
    org_id: str | None = None,
    streaming: bool = True,
    *,
    trace_name: str = "llm.invoke",
    user_id: str | None = None,
    thread_id: str | None = None,
    tool_name: str | None = None,
    extra_metadata: dict[str, Any] | None = None,
) -> ResolvedLlm:
    """
    Resolve a LangChain LLM for the given tier.

    If `org_id` is provided we ask the Node API for the per-org override +
    BYOK. If `org_id` is None we resolve from platform env directly (this
    is the path the existing 7 LangGraph agents take).

    The returned ResolvedLlm carries a Langfuse callback in `.callbacks`
    (or an empty list if Langfuse is unconfigured). Callers forward it:

        r = await resolve_llm("default", org_id=..., trace_name="review.analyze")
        await r.llm.ainvoke(messages, config={"callbacks": r.callbacks})

    Raises RuntimeError if no provider has a key for the tier.
    """
    if org_id and settings.api_url and settings.internal_service_secret:
        try:
            return await _resolve_via_node(
                org_id, tier, streaming,
                trace_name=trace_name, user_id=user_id,
                thread_id=thread_id, tool_name=tool_name,
                extra_metadata=extra_metadata,
            )
        except Exception as e:
            # Node unreachable / bad secret / 503 — fall back to platform env
            # so the agent doesn't hard-fail on transient infra. Logged loud
            # so we notice misconfigurations.
            import logging
            logging.warning("[router] Node resolve failed for org=%s tier=%s — falling back to platform env. Error: %s",
                            org_id, tier, e)

    # Fallback path (no org_id, or Node call failed)
    pick = _platform_resolve(tier)
    if not pick:
        raise RuntimeError(f"No provider configured for tier={tier}. Set OPENAI_API_KEY (or ANTHROPIC_API_KEY) in .env.")
    provider, model, key = pick
    return _build_resolved(
        provider=provider, model=model, api_key=key,
        source="platform", tier=tier, streaming=streaming,
        trace_name=trace_name, org_id=org_id, user_id=user_id,
        thread_id=thread_id, tool_name=tool_name,
        extra_metadata=extra_metadata,
    )


async def _resolve_via_node(
    org_id: str, tier: Tier, streaming: bool,
    *,
    trace_name: str,
    user_id: str | None,
    thread_id: str | None,
    tool_name: str | None,
    extra_metadata: dict[str, Any] | None,
) -> ResolvedLlm:
    """Internal — call Node's POST /api/internal/ai/resolve."""
    url = f"{settings.api_url.rstrip('/')}/api/internal/ai/resolve"
    headers = {"x-internal-secret": settings.internal_service_secret, "x-internal-service": "agents"}
    body = {"orgId": org_id, "tier": tier}
    async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
        r = await client.post(url, json=body, headers=headers)
        r.raise_for_status()
        data = r.json()
    return _build_resolved(
        provider=data["provider"], model=data["model"],
        api_key=data["apiKey"], source=data["source"],
        tier=tier, streaming=streaming,
        trace_name=trace_name, org_id=org_id, user_id=user_id,
        thread_id=thread_id, tool_name=tool_name,
        extra_metadata=extra_metadata,
    )


def _build_resolved(
    *,
    provider: str, model: str, api_key: str, source: Source,
    tier: Tier, streaming: bool,
    trace_name: str,
    org_id: str | None,
    user_id: str | None,
    thread_id: str | None,
    tool_name: str | None,
    extra_metadata: dict[str, Any] | None,
) -> ResolvedLlm:
    """Shared construction path for both platform and Node resolution."""
    llm = build_llm(provider, model, streaming=streaming, api_key=api_key)
    handler = get_callback(
        trace_name=trace_name,
        org_id=org_id,
        user_id=user_id,
        tier=tier,
        provider=provider,
        model=model,
        source=source,
        thread_id=thread_id,
        tool_name=tool_name,
        extra_metadata=extra_metadata,
    )
    return ResolvedLlm(
        llm=llm,
        provider=provider,
        model=model,
        source=source,
        tier=tier,
        callbacks=[handler] if handler else [],
    )


# ─── Sync wrapper for old-style callers ──────────────────────────────────────
# Some of the existing 7 agents are not async-friendly at the top level (they
# call build_llm() inline in a state-graph node). For those we expose a sync
# tier→llm helper that bypasses the Node call entirely. New code should
# always use the async resolve_llm() above.

def resolve_llm_platform_sync(
    tier: Tier,
    streaming: bool = True,
    *,
    trace_name: str = "llm.invoke",
    extra_metadata: dict[str, Any] | None = None,
) -> ResolvedLlm:
    pick = _platform_resolve(tier)
    if not pick:
        raise RuntimeError(f"No provider configured for tier={tier}.")
    provider, model, key = pick
    return _build_resolved(
        provider=provider, model=model, api_key=key,
        source="platform", tier=tier, streaming=streaming,
        trace_name=trace_name, org_id=None, user_id=None,
        thread_id=None, tool_name=None,
        extra_metadata=extra_metadata,
    )


# ─── Startup configuration check ─────────────────────────────────────────────

def assert_router_configured() -> None:
    """Log the platform routing table; raise if a critical tier is unconfigured.

    Mirrors the Node-side assertRouterConfigured(). Either side will refuse to
    start without at least one platform key for default + fast tiers.
    """
    import logging
    critical: list[Tier] = ["default", "fast"]
    lines: list[str] = []
    for tier in _PLATFORM_TIERS.keys():  # type: ignore[assignment]
        candidates = _PLATFORM_TIERS[tier]
        winner = next(((p, m) for p, m in candidates if _platform_key(p)), None)
        if winner:
            lines.append(f"  {tier:<11} → {winner[0]}/{winner[1]}")
        elif tier in critical:
            raise RuntimeError(
                f"[router] Critical tier '{tier}' has no platform key. "
                f"Tried: {[p for p, _ in candidates]}. "
                "Set OPENAI_API_KEY (or ANTHROPIC_API_KEY) in apps/agents env."
            )
        else:
            lines.append(f"  {tier:<11} → (no platform key — orgs must BYOK)")
    logging.info("[router] platform routing table:\n%s", "\n".join(lines))
