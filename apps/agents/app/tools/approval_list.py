"""approval_list tool (P4.5)"""
from __future__ import annotations
import logging, httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field
from ..config import settings

log = logging.getLogger(__name__)


class ApprovalListArgs(BaseModel):
    scope:  str = Field(
        "my-queue",
        description="'my-queue' (default): steps assigned to the current user. 'all': every step in the org.",
    )
    status: str | None = Field(
        None,
        description="Filter by step status (PENDING | APPROVED | REJECTED | SKIPPED | ESCALATED).",
    )
    limit:  int = Field(20, ge=1, le=100)


def build_approval_list(org_id: str, user_id: str | None = None) -> StructuredTool:
    # user_id needs to flow through for my-queue filtering; invoked from
    # the orchestrator where we have it. Tools currently only bind
    # org_id — we'll pass user_id via closure when available.
    _user_id = user_id or "system"

    async def _arun(scope: str = "my-queue", status: str | None = None, limit: int = 20) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/approval_list"
        headers = {"x-internal-secret": settings.internal_service_secret, "x-internal-service": "agents", "content-type": "application/json"}
        payload: dict = {"orgId": org_id, "userId": _user_id, "scope": scope, "limit": limit}
        if status: payload["status"] = status
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            log.warning("[approval_list] Node %s: %s", r.status_code, r.text[:200])
            return '{"error":"approval_list_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(scope: str = "my-queue", status=None, limit: int = 20):
        import asyncio
        return asyncio.run(_arun(scope, status, limit))

    return StructuredTool.from_function(
        coroutine=_arun, func=_run, name="approval_list",
        description=(
            "List pending approval steps (default: assigned to the current user). "
            "Each hit carries {contract, instance, stepName, stepOrder, status, "
            "escalateAt}. Use when the user asks 'what's in my queue?', 'what "
            "approvals are waiting?', or 'what did I not approve yet?'."
        ),
        args_schema=ApprovalListArgs,
    )
