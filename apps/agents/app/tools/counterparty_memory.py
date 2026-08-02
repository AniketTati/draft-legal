"""
counterparty_memory tool (P3.3 / docs/30 D.5.9)

Prior-deal intelligence for a named counterparty. For every contract
the org has signed with them (or is currently negotiating), returns:
  • deal count, total value, signed-since, last-signed-at
  • severity distribution of all clauses (favorable / neutral /
    unfavorable / unusual) — powers "Acme tends to push unfavorable IP
    clauses" intuition
  • per-deal excerpts filtered to a specific clauseType when asked

Answers "what's our history with Acme?" questions without the agent
running O(N) contract_get lookups.
"""
from __future__ import annotations

import logging

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..config import settings

log = logging.getLogger(__name__)


class CounterpartyMemoryArgs(BaseModel):
    counterparty_name: str = Field(
        ...,
        description=(
            "The counterparty to look up — matched case-insensitive "
            "substring ('Acme' catches 'Acme Corporation')."
        ),
    )
    clause_type: str | None = Field(
        None,
        description=(
            "Optional clause type to spotlight ('limitation_of_liability', "
            "'confidentiality', 'ip_ownership', etc.). When set, each "
            "returned deal carries an excerpt of that clause type."
        ),
    )
    limit: int = Field(
        10, ge=1, le=30,
        description="Max prior deals to return.",
    )


def build_counterparty_memory(org_id: str) -> StructuredTool:

    async def _arun(counterparty_name: str, clause_type: str | None = None, limit: int = 10) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/counterparty_memory"
        headers = {
            "x-internal-secret": settings.internal_service_secret,
            "x-internal-service": "agents",
            "content-type":      "application/json",
        }
        payload: dict = {
            "orgId":            org_id,
            "counterpartyName": counterparty_name,
            "limit":            limit,
        }
        if clause_type:
            payload["clauseType"] = clause_type
        async with httpx.AsyncClient(timeout=httpx.Timeout(12.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            log.warning("[counterparty_memory] Node %s: %s", r.status_code, r.text[:200])
            return '{"error":"counterparty_memory_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(counterparty_name: str, clause_type=None, limit: int = 10):
        import asyncio
        return asyncio.run(_arun(counterparty_name, clause_type, limit))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="counterparty_memory",
        description=(
            "Surface prior-deal intelligence for a named counterparty. "
            "Returns every contract signed with (or being negotiated "
            "against) them + aggregate metrics (dealCount, totalValue, "
            "severity distribution, avgRiskScore) + per-deal excerpts "
            "when a clauseType is specified. USE THIS any time the "
            "user asks 'what's our history with X?' or 'have we done "
            "deals with this counterparty?' or at the START of any "
            "new contract review — past-deal context is free context."
        ),
        args_schema=CounterpartyMemoryArgs,
    )
