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

# OpenRouter is listed last in every LLM tier on purpose: it is a gateway, so
# it only wins when no first-party key is configured. It MUST be present here.
# config.active_provider() and providers.build_llm() both support openrouter,
# so leaving it out made resolve_llm raise for every tier on an
# OpenRouter-only deployment while the old build_llm fallbacks kept working —
# which is exactly what made those fallbacks look like dead code when they
# were in fact the only thing holding that deployment up.
_PLATFORM_TIERS: dict[Tier, list[tuple[str, str]]] = {
    "reasoning":  [("anthropic",  "claude-opus-4-7"),
                   ("openai",     "gpt-5"),
                   ("openai",     "gpt-4.1"),
                   ("google",     "gemini-2.5-pro"),
                   ("openrouter", "openai/gpt-4.1")],
    "default":    [("anthropic",  "claude-sonnet-4-6"),
                   ("openai",     "gpt-4.1"),
                   ("google",     "gemini-2.5-pro"),
                   ("openrouter", "openai/gpt-4.1")],
    "fast":       [("anthropic",  "claude-haiku-4-5"),
                   ("openai",     "gpt-4.1-mini"),
                   ("google",     "gemini-2.5-flash"),
                   ("openrouter", "google/gemini-2.5-flash")],
    # embed/rerank/vision are not routed through OpenRouter — the registry has
    # no gateway entry for those model classes.
    "embed":      [("openai",     "text-embedding-3-large"),
                   ("google",     "gemini-embedding-001")],
    "rerank":     [("openai",     "gpt-4.1-mini")],
    "vision_ocr": [("openai",     "gpt-4.1"),
                   ("google",     "gemini-2.5-pro")],
}

_ENV_KEY = {
    "openai":     "openai_api_key",
    "anthropic":  "anthropic_api_key",
    "google":     "google_api_key",
    "openrouter": "openrouter_api_key",
    # voyage/cohere/mistral added when those tiers light up
}

# Values that appear in unconfigured .env files and Secret Manager stubs. Treated
# as absent: a placeholder that counts as a key resolves the tier to a provider
# that then 401s at call time, instead of falling through to one that works.
_PLACEHOLDER_KEYS = {'placeholder', 'todo', 'unset', 'changeme', 'none', 'null', ''}


def _platform_key(provider: str) -> str | None:
    attr = _ENV_KEY.get(provider)
    if not attr:
        return None
    key = getattr(settings, attr, None) or None
    if key and key.strip().lower() in _PLACEHOLDER_KEYS:
        return None
    return key


def _platform_resolve(tier: Tier) -> tuple[str, str, str] | None:
    """Resolve (provider, model, key) from env only (no DB / no Node call)."""
    for provider, model in _PLATFORM_TIERS[tier]:
        key = _platform_key(provider)
        if key:
            return provider, model, key
    return None


def _tier_model_for(provider: str, tier: Tier) -> str | None:
    """The platform default model listed for `provider` at `tier` (None if unlisted)."""
    for p, m in _PLATFORM_TIERS[tier]:
        if p == provider:
            return m
    return None


# ─── Caller-pinned provider/model override ───────────────────────────────────

class CostCapExceeded(RuntimeError):
    """The org has spent past its daily cap and the policy is `block`.

    Raised, never swallowed: the whole point of a cap is that the call does not
    happen. Distinct from transport failure so the platform fallback below
    cannot quietly pay for it.
    """


class ModelOverrideUnavailable(RuntimeError):
    """A caller-pinned provider has no model we can build for the tier."""


def _apply_override(
    *,
    provider: str,
    model: str,
    api_key: str | None,
    source: Source,
    tier: Tier,
    provider_override: str | None,
    model_override: str | None,
) -> tuple[str, str, str | None, Source]:
    """Substitute a caller-pinned provider/model onto an already-resolved tuple.

    Key resolution is deliberately left alone when the override only pins a
    model, or pins the same provider we already resolved: the org's BYOK key
    is still the correct key for that provider, so BYOK + Langfuse tracing
    behave exactly as they do on the default path.

    When the override names a DIFFERENT provider we must swap the key too.
    BYOK keys are stored per provider (`getByokKey(orgId, provider)` in
    apps/api/src/lib/aiRouter.ts) and Node's POST /api/internal/ai/resolve
    accepts only (orgId, tier) — there is no way to ask it for the org's key
    for an arbitrary provider. Sending the resolved key would hand provider A's
    secret to provider B, so instead we fall back to the platform key for the
    overridden provider and report source="platform" honestly.
    """
    if not provider_override and not model_override:
        return provider, model, api_key, source

    if provider_override and provider_override != provider:
        new_model = model_override or _tier_model_for(provider_override, tier)
        if not new_model:
            raise ModelOverrideUnavailable(
                f"provider_override={provider_override!r} has no platform default model "
                f"for tier={tier}; pass model_override as well."
            )
        # `_platform_key` may return None for providers with no tier entry
        # (e.g. openrouter) — build_llm then falls back to its own env key.
        return provider_override, new_model, _platform_key(provider_override), "platform"

    return provider, (model_override or model), api_key, source


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
    provider_override: str | None = None,
    model_override: str | None = None,
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

    `provider_override` / `model_override` let a caller pin a specific
    provider and/or model (e.g. a request that carries an explicit
    provider/model_id) WITHOUT dropping out of the router: BYOK key
    resolution and the Langfuse callbacks are unchanged — only which
    provider/model gets built is substituted. See _apply_override for the
    one case where the key has to change (a different provider).

    Raises RuntimeError if no provider has a key for the tier.
    """
    # A caller that supplies an org expects that org's configuration to be
    # consulted. If we can't reach Node to do that, we silently serve the
    # platform key — which is precisely the BYOK bypass, wearing a different
    # hat. Missing config is a deployment mistake that would otherwise be
    # invisible, so say so rather than degrading quietly.
    if org_id and not (settings.api_url and settings.internal_service_secret):
        import logging
        logging.getLogger(__name__).warning(
            "[router] org_id=%s was supplied but API_URL/INTERNAL_SERVICE_SECRET are not "
            "configured — per-org BYOK keys and tier overrides CANNOT be applied, and this "
            "request will bill the platform key.", org_id,
        )

    if org_id and settings.api_url and settings.internal_service_secret:
        try:
            return await _resolve_via_node(
                org_id, tier, streaming,
                trace_name=trace_name, user_id=user_id,
                thread_id=thread_id, tool_name=tool_name,
                extra_metadata=extra_metadata,
                provider_override=provider_override,
                model_override=model_override,
            )
        except ModelOverrideUnavailable:
            # A bad caller-pinned override is a caller bug, not flaky infra —
            # don't mask it behind the platform fallback.
            raise
        except CostCapExceeded:
            # The org is over its daily budget. This is a DECISION, not flaky
            # infra, and falling through to _platform_resolve() would bill the
            # platform key for a call the platform just refused — one turn is up
            # to seven LLM calls, so the Node proxy's per-request gate does not
            # cover it.
            raise
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
        provider_override=provider_override, model_override=model_override,
    )


async def _resolve_via_node(
    org_id: str, tier: Tier, streaming: bool,
    *,
    trace_name: str,
    user_id: str | None,
    thread_id: str | None,
    tool_name: str | None,
    extra_metadata: dict[str, Any] | None,
    provider_override: str | None = None,
    model_override: str | None = None,
) -> ResolvedLlm:
    """Internal — call Node's POST /api/internal/ai/resolve."""
    url = f"{settings.api_url.rstrip('/')}/api/internal/ai/resolve"
    headers = {"x-internal-secret": settings.internal_service_secret}
    body = {"orgId": org_id, "tier": tier}
    async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
        r = await client.post(url, json=body, headers=headers)
        # 429 is a refusal, not a transport failure. raise_for_status() would
        # turn it into a generic HTTPStatusError that the caller's blanket
        # `except Exception` treats as flaky infra -- and the platform fallback
        # would then pay for the very call the cap just declined.
        if r.status_code == 429:
            detail = ""
            try:
                detail = r.json().get("detail", "")
            except Exception:
                detail = r.text[:200]
            raise CostCapExceeded(detail or "daily AI spend cap reached for this organization")
        r.raise_for_status()
        data = r.json()
    return _build_resolved(
        provider=data["provider"], model=data["model"],
        api_key=data["apiKey"], source=data["source"],
        tier=tier, streaming=streaming,
        trace_name=trace_name, org_id=org_id, user_id=user_id,
        thread_id=thread_id, tool_name=tool_name,
        extra_metadata=extra_metadata,
        provider_override=provider_override, model_override=model_override,
    )


def _build_resolved(
    *,
    provider: str, model: str, api_key: str | None, source: Source,
    tier: Tier, streaming: bool,
    trace_name: str,
    org_id: str | None,
    user_id: str | None,
    thread_id: str | None,
    tool_name: str | None,
    extra_metadata: dict[str, Any] | None,
    provider_override: str | None = None,
    model_override: str | None = None,
) -> ResolvedLlm:
    """Shared construction path for both platform and Node resolution."""
    provider, model, api_key, source = _apply_override(
        provider=provider, model=model, api_key=api_key, source=source, tier=tier,
        provider_override=provider_override, model_override=model_override,
    )
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


# NOTE: `resolve_llm_platform_sync()` used to live here as a sync tier→llm
# helper that deliberately skipped the Node call (and therefore per-org BYOK).
# It was removed in Wave 3.5 — every remaining caller now awaits resolve_llm(),
# which resolves per-org when an org_id is given and falls back to the same
# platform env path when it isn't.


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
