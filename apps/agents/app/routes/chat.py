import uuid
import json
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from app.orchestrator import run_chat, run_agent_chat_stream
from app.providers import list_models, DEFAULT_PROVIDER, DEFAULT_MODEL, get_model_option
from app.config import resolve_provider, model_for, is_provider_configured

router = APIRouter()


class PageContext(BaseModel):
    """D.1.2 — what the user is looking at, so the agent can ground tools."""
    type: str | None = None
    id:   str | None = None
    label: str | None = None


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None
    contract_id: str | None = None
    user_id: str = "anonymous"
    org_id: str = "default"
    provider: str = DEFAULT_PROVIDER
    # None means "no pin — let org AI settings decide". It used to default to
    # DEFAULT_MODEL (claude-sonnet-4-6), which made every unpinned request look
    # like an explicit Anthropic pin. On a deployment without an Anthropic key
    # that pin no longer matches the resolved provider, so the block below
    # SYNTHESISED one (tier="smart" → gemini-2.5-pro) and passed it down as
    # model_override — which outranks the org's configured model. Net effect:
    # Admin → AI Config was silently ignored for ordinary chat, and every turn
    # ran on the expensive model regardless of what the org had chosen.
    model_id: str | None = None
    # D.1.4a — when true, run the tool-binding loop and emit typed events.
    # Legacy callers (old ChatPanel) omit this and get the fake-streamed path.
    agent_mode: bool = False
    page_context: PageContext | None = None
    # D.4.1 — Skill overrides. Resolved by the Node proxy and forwarded
    # here. `skill_system_prompt` replaces AGENT_SYSTEM_PROMPT for this
    # turn; `skill_allowed_tools` narrows the tool catalog to the slugs
    # the skill declares. Both are optional — a missing slug or an admin
    # who lists no tools falls through to the default behaviour.
    skill_slug: str | None = None
    skill_system_prompt: str | None = None
    skill_allowed_tools: list[str] | None = None
    # Tools the CALLER may not use, computed from their permissions by the API
    # proxy. Distinct from skill_allowed_tools, which is a product choice about
    # what a skill focuses on; this is an authorization boundary. Denials are
    # applied last so a skill allowlist can never re-admit a denied tool.
    denied_tools: list[str] | None = None
    # P4.3 — structured entity mentions from the rail composer.
    # Prepended to the human message as a hint so the agent calls
    # contract_get / counterparty_get with the right id instead of
    # fishing.
    mentions: list[dict] | None = None


@router.get("/models")
async def get_models():
    """Return all supported provider/model combinations."""
    return {"models": list_models()}


@router.post("/chat")
async def chat(req: ChatRequest):
    # P7.0.2 (F-82) — Auto-fallback to a configured provider when the
    # caller asks for one without an API key. Previously the request
    # would fail downstream with "Could not resolve authentication
    # method", surfaced to users as an empty stream. Now we silently
    # swap to whichever provider IS configured (logs a warning so the
    # operator still sees the fallback).
    # docs/37 E12 — under replay there is no provider and no key; validating
    # one would reinstate the key requirement this seam exists to remove.
    from app.replay import mode as _replay_mode
    resolved_provider = req.provider if _replay_mode() == "replay" else resolve_provider(req.provider)
    if _replay_mode() != "replay" and resolved_provider != req.provider:
        # Caller requested an unconfigured provider — pick a sensible
        # model id for the actual provider rather than passing through
        # the (now wrong) one (e.g. claude-sonnet-4-6 → openai breaks).
        #
        # docs/37 E13 — but ONLY when the requested model does not belong to
        # the resolved provider. This used to overwrite unconditionally, and
        # DEFAULT_PROVIDER is anthropic: on a deployment holding a single
        # provider key — the common case — every request took this branch, so
        # every model pin in the product was discarded, including pins that
        # were valid for the provider actually being used. The model id is
        # also what the orchestrator sniffs to choose a tier, so this
        # destroyed the caller's tier signal too, not just the model.
        #
        # Only ever rewrites an EXPLICIT pin. An unpinned request stays None so
        # org AI settings choose the model; substituting here would invent a
        # pin the caller never asked for and override that configuration.
        if req.model_id is not None:
            try:
                get_model_option(resolved_provider, req.model_id)
            except ValueError:
                req.model_id = model_for(resolved_provider, tier="smart")
    req.provider = resolved_provider

    # Validate provider + model before starting the stream. Skipped under
    # replay: the recorded response is served without a provider at all.
    if _replay_mode() != "replay" and req.model_id is not None:
        try:
            get_model_option(req.provider, req.model_id)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    session_id = req.session_id or str(uuid.uuid4())

    async def event_stream():
        # D.1.4a — agent mode emits a typed event stream with tool calls.
        if req.agent_mode:
            try:
                async for event in run_agent_chat_stream(
                    session_id=session_id,
                    org_id=req.org_id,
                    user_id=req.user_id,
                    message=req.message,
                    provider=req.provider,
                    model_id=req.model_id,
                    page_context=req.page_context.dict() if req.page_context else None,
                    # D.4.1 — skill overrides flow through orchestrator
                    # → narrows tools + injects system prompt.
                    skill_slug=req.skill_slug,
                    skill_system_prompt=req.skill_system_prompt,
                    skill_allowed_tools=req.skill_allowed_tools,
                    denied_tools=req.denied_tools,
                    # P4.3 — entity mentions surface to the orchestrator
                    # which prepends them as a hint to the user turn.
                    mentions=req.mentions,
                ):
                    # Tag every envelope with session_id + provider so clients
                    # that picked them up from the first frame keep working.
                    #
                    # docs/37 E2 — these are the REQUESTED values, not the
                    # resolved ones, and the spread used to put them LAST, so
                    # they overwrote anything authoritative the orchestrator
                    # set. The done frame now carries the genuinely resolved
                    # provider/model/tier/source, so the defaults fill in only
                    # where the event did not already say.
                    event = {"session_id": session_id,
                             "provider": req.provider, "model_id": req.model_id,
                             **event}
                    yield f"data: {json.dumps(event)}\n\n"
            except Exception as e:
                err = json.dumps({"type": "error", "error": str(e)})
                yield f"data: {err}\n\n"
            yield "data: [DONE]\n\n"
            return

        # Legacy non-agent path — unchanged from before D.1.4.
        try:
            response = await run_chat(
                session_id=session_id,
                org_id=req.org_id,
                user_id=req.user_id,
                message=req.message,
                provider=req.provider,
                model_id=req.model_id,
            )
        except Exception as e:
            # `type` is required, not decorative: the web clients dispatch on
            # it, so this envelope — the only one of five that lacked a type —
            # was dropped by AgentHomePage without even matching its error
            # branch. Same shape as the agentMode emitters above.
            error_data = json.dumps({"type": "error", "error": str(e)})
            yield f"data: {error_data}\n\n"
            yield "data: [DONE]\n\n"
            return

        # Stream word by word for typewriter effect
        words = response.split(" ")
        for i, word in enumerate(words):
            chunk = word + (" " if i < len(words) - 1 else "")
            data = json.dumps({
                "delta": chunk,
                "session_id": session_id,
                "provider": req.provider,
                "model_id": req.model_id,
            })
            yield f"data: {data}\n\n"

        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
