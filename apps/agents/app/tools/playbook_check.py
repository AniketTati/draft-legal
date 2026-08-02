"""
playbook_check tool (D.5.1)

Compare a contract's extracted clauses to the org's playbook positions.
Structured output for the agent LLM to reason over — the tool itself
doesn't call another LLM to score deviations (would add per-clause
round-trips). The caller's main agent has enough context to judge
deviations from the clause excerpts + playbook positions returned here.

Returns:
  {
    contract: { id, title, type, totalClauses },
    checks: [ {clauseType, sectionRef, excerpt, riskRating,
               category: {id, name},
               positions: [{positionType, content, notes, riskThreshold}]} ],
    unmapped: [clauseType...]  # types with no matching org category
  }
"""
from __future__ import annotations

import logging

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..config import settings

log = logging.getLogger(__name__)


class PlaybookCheckArgs(BaseModel):
    contract_id: str = Field(
        ...,
        description="The CUID of the contract to check against the org's playbook.",
    )
    max_clauses: int = Field(
        10, ge=1, le=30,
        description="Max top-level clauses to return with playbook match.",
    )


def build_playbook_check(org_id: str) -> StructuredTool:

    async def _arun(contract_id: str, max_clauses: int = 10) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/playbook_check"
        headers = {
            "x-internal-secret": settings.internal_service_secret,
            "x-internal-service": "agents",
            "content-type": "application/json",
        }
        payload = {
            "orgId": org_id,
            "contractId": contract_id,
            "maxClauses": max_clauses,
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code == 404:
            return '{"error":"contract_not_found","contract_id":"' + contract_id + '"}'
        if r.status_code >= 400:
            log.warning("[playbook_check] Node returned %s: %s", r.status_code, r.text[:200])
            return '{"error":"playbook_check_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(contract_id: str, max_clauses: int = 10):
        import asyncio
        return asyncio.run(_arun(contract_id, max_clauses))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="playbook_check",
        description=(
            "Compare a contract's extracted clauses to the org's playbook "
            "positions. Returns each clause paired with its matching "
            "playbook category + the org's preferred / acceptable / "
            "fallback / walkaway positions, so you can judge deviations. "
            "Use when the user asks 'does this match our playbook?', "
            "'what's off-market here?', or 'how does this compare to our "
            "standard position?'. Read-only — no LLM is called inside "
            "this tool, so you (the agent) do the judging."
        ),
        args_schema=PlaybookCheckArgs,
    )
