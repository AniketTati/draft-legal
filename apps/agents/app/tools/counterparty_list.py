"""counterparty_list tool — list/rank counterparties for the org.

Calls POST /api/internal/ai/tools/counterparty_list which returns
{ total, items: [{ id, name, legalName, contractCount, sumValue, updatedAt }] }.
Used for "top 5 counterparties by value" / "who do we work with most?"
style questions (orchestrator routing guidance references this tool).
"""
from __future__ import annotations

import logging
from typing import Literal

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..config import settings

log = logging.getLogger(__name__)


class CounterpartyListArgs(BaseModel):
    query: str | None = Field(None, description="Optional fuzzy name filter ('Acme').")
    sort_by: Literal["contracts", "value", "name", "recent"] = Field(
        "contracts",
        description="Ranking: 'contracts' (most contracts), 'value' (highest total contract value), 'name' (alphabetical), 'recent' (recently touched).",
    )
    limit: int = Field(20, ge=1, le=100, description="Max counterparties to return.")


def build_counterparty_list(org_id: str) -> StructuredTool:
    async def _arun(query: str | None = None, sort_by: str = "contracts", limit: int = 20) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/counterparty_list"
        headers = {"x-internal-secret": settings.internal_service_secret, "x-internal-service": "agents", "content-type": "application/json"}
        payload: dict = {"orgId": org_id, "sortBy": sort_by, "limit": limit}
        if query:
            payload["query"] = query
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            log.warning("[counterparty_list] Node %s: %s", r.status_code, r.text[:200])
            return '{"error":"counterparty_list_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(query: str | None = None, sort_by: str = "contracts", limit: int = 20) -> str:
        import asyncio
        return asyncio.run(_arun(query, sort_by, limit))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="counterparty_list",
        description=(
            "List the org's counterparties ranked by contract count, total "
            "contract value, name, or recency. Returns id, name, legalName, "
            "contractCount, sumValue per counterparty. Use for 'top N "
            "counterparties by exposure' or 'who do we work with most?'."
        ),
        args_schema=CounterpartyListArgs,
    )
