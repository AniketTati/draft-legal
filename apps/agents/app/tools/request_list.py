"""request_list tool (P4.5)"""
from __future__ import annotations
import logging, httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field
from ..config import settings

log = logging.getLogger(__name__)


class RequestListArgs(BaseModel):
    status:         str | None = Field(
        None,
        description="Filter by request status (SUBMITTED | IN_REVIEW | ACCEPTED | REJECTED | MORE_INFO_NEEDED | COMPLETED).",
    )
    assigned_to_id: str | None = Field(None, description="Filter by assigned user id.")
    priority:       str | None = Field(None, description="LOW | MEDIUM | HIGH | URGENT.")
    type:           str | None = Field(None, description="Contract type filter (NDA / MSA / …).")
    limit:          int = Field(20, ge=1, le=100)


def build_request_list(org_id: str) -> StructuredTool:
    async def _arun(status=None, assigned_to_id=None, priority=None, type=None, limit: int = 20) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/request_list"
        headers = {"x-internal-secret": settings.internal_service_secret, "x-internal-service": "agents", "content-type": "application/json"}
        payload: dict = {"orgId": org_id, "limit": limit}
        if status:         payload["status"]       = status
        if assigned_to_id: payload["assignedToId"] = assigned_to_id
        if priority:       payload["priority"]     = priority
        if type:           payload["type"]         = type
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            log.warning("[request_list] Node %s: %s", r.status_code, r.text[:200])
            return '{"error":"request_list_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(status=None, assigned_to_id=None, priority=None, type=None, limit: int = 20):
        import asyncio
        return asyncio.run(_arun(status, assigned_to_id, priority, type, limit))

    return StructuredTool.from_function(
        coroutine=_arun, func=_run, name="request_list",
        description=(
            "List open contract requests (intake queue). Filters: status, "
            "assigned_to_id, priority, type. Use when the user asks 'what "
            "intake requests are open?', 'what's assigned to Alice?', or "
            "'show me the URGENT NDAs waiting for draft'."
        ),
        args_schema=RequestListArgs,
    )
