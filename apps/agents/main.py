import logging
import os
from app.router import CostCapExceeded, RouterRefusal
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from app.routes import chat
from app.routes import review
from app.routes import agent
from app.routes import detect_binder
from app.routes import classify
from app.routes import intake
from app.routes import draft
from app.routes import assist
from app.routes import extract
from app.routes import redline
from app.routes import playbook_review
from app.routes import approval
from app.routes import obligations
from app.routes import renewals
from app.routes import compliance
from app import tracing

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)

app = FastAPI(title="CLM Agent Service", version="0.1.0")


@app.on_event("shutdown")
async def _flush_langfuse() -> None:
    """D.0.7 — flush buffered traces so the last few requests before SIGTERM
    actually make it to Langfuse. No-op when tracing is disabled."""
    tracing.flush()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3001"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_internal_secret(request: Request, call_next):
    """Gate every request behind the shared service-to-service secret.

    Cloud Run can be set to --allow-unauthenticated so the API (which doesn't
    fetch OIDC identity tokens) can reach this service, while this middleware
    still rejects any caller that doesn't know the shared secret. /health is
    exempt so Cloud Run's startup probe still works.
    """
    if request.url.path in ("/health", "/"):
        return await call_next(request)
    expected = os.environ.get("INTERNAL_SERVICE_SECRET", "")
    if not expected:
        # Fail closed if the env var is missing — refuse all requests rather
        # than silently letting anyone through.
        return JSONResponse({"error": "agents service is misconfigured"}, status_code=503)
    if request.headers.get("x-internal-secret") != expected:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await call_next(request)


# ─── Router refusals become a status, not a 500 ──────────────────────────────
#
# A RouterRefusal means we could not learn which provider this org wants, so we
# declined rather than substituting one (see app/router.py). Every route in this
# service now lets that propagate instead of degrading into a confident wrong
# answer, which without a handler would surface as an opaque 500.
#
# The status carries the decision: 429 for "over budget" (already the contract
# Node uses at internal-ai.ts), 503 for everything else — retryable-looking to a
# caller, and honest, because the condition really is "this service cannot serve
# you right now". `error` is the same closed vocabulary the exception carries so
# a caller can branch without parsing prose.
@app.exception_handler(RouterRefusal)
async def _router_refusal_handler(_request: Request, exc: RouterRefusal) -> JSONResponse:
    if isinstance(exc, CostCapExceeded):
        return JSONResponse({"error": "cost_cap_exceeded", "detail": str(exc)}, status_code=429)
    reason = getattr(exc, "reason", "provider_resolution_failed")
    return JSONResponse(
        {"error": reason, "detail": str(exc)},
        status_code=503,
    )


app.include_router(chat.router, prefix="/agent")
app.include_router(review.router)
app.include_router(agent.router)
app.include_router(detect_binder.router)
app.include_router(classify.router)
app.include_router(intake.router)
app.include_router(draft.router)
app.include_router(assist.router)
app.include_router(extract.router)
app.include_router(redline.router)
app.include_router(playbook_review.router)
app.include_router(approval.router)
app.include_router(obligations.router)
app.include_router(renewals.router)
app.include_router(compliance.router)


@app.get("/health")
async def health():
    # docs/37 E12 — advertise the replay mode. A tier-2 check needs the service
    # to be REPLAYING, and "is it up" cannot answer that: a check that silently
    # ran against a live model would burn quota and be nondeterministic while
    # reporting as a free deterministic gate.
    from app.replay import mode as _replay_mode
    return {"status": "ok", "replayMode": _replay_mode()}
