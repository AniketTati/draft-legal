"""
Draft API — Phase 4.2
POST /draft — run the 5-step draft pipeline
"""
from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel
from typing import Any

from app.agents.draft_agent import run_draft
from app.config import settings

router = APIRouter()
INTERNAL_SECRET = settings.internal_service_secret


class DraftRequest(BaseModel):
    user_message: str
    org_id: str
    user_id: str = "system"
    context: dict[str, Any] = {}


@router.post("/draft")
async def draft_contract(req: DraftRequest, x_internal_secret: str = Header(default="")):
    if INTERNAL_SECRET and x_internal_secret != INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")

    if not req.user_message.strip():
        raise HTTPException(status_code=400, detail="user_message is required")

    result = await run_draft(
        user_message=req.user_message,
        org_id=req.org_id,
        user_id=req.user_id,
        context=req.context,
    )

    # A.1 — return the structured result even when `error` is set, so the API
    # wrapper can map typed errors (NO_TEMPLATE_MATCH, etc.) to proper HTTP
    # codes. Previously we raised HTTPException(500) for *any* error, which
    # turned user errors into server errors and also lost the error code.
    return result
