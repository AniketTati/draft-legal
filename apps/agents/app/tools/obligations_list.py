"""obligations_list tool (P5.1 / docs/30 Wave H.1)"""
from __future__ import annotations
import logging, httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field
from ..config import settings

log = logging.getLogger(__name__)


class ObligationsListArgs(BaseModel):
    contract_id: str | None = Field(
        None,
        description="Target a single contract's obligations. Omit to aggregate across the org.",
    )
    due_within: int | None = Field(
        None, ge=1, le=365,
        description="Only include obligations due in the next N days (0 = overdue or any date).",
    )
    type: str | None = Field(
        None,
        description="Filter by obligation type (payment / sla / renewal / audit / report / termination / compliance).",
    )
    limit: int = Field(30, ge=1, le=100)


def build_obligations_list(org_id: str) -> StructuredTool:
    async def _arun(contract_id=None, due_within=None, type=None, limit: int = 30) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/obligations_list"
        headers = {"x-internal-secret": settings.internal_service_secret, "x-internal-service": "agents", "content-type": "application/json"}
        payload: dict = {"orgId": org_id, "limit": limit}
        if contract_id: payload["contractId"] = contract_id
        if due_within:  payload["dueWithin"]  = due_within
        if type:        payload["type"]       = type
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            log.warning("[obligations_list] Node %s: %s", r.status_code, r.text[:200])
            return '{"error":"obligations_list_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(contract_id=None, due_within=None, type=None, limit: int = 30):
        import asyncio
        return asyncio.run(_arun(contract_id, due_within, type, limit))

    return StructuredTool.from_function(
        coroutine=_arun, func=_run, name="obligations_list",
        description=(
            "List contract obligations — payments, SLA windows, renewal "
            "notice periods, audit rights, quarterly reports. When "
            "contract_id is set, returns that contract's obligations; "
            "otherwise aggregates across the org. Filters: due_within "
            "(days), type. Use when the user asks 'what's due this "
            "quarter?', 'what are our obligations under the Acme MSA?', "
            "or 'show me every SLA commitment across the portfolio.' "
            "Each entry carries {type, description, owner, dueDate, "
            "recurrence, quote, severity, sectionRef}."
        ),
        args_schema=ObligationsListArgs,
    )
