"""
clause_search tool (D.1.4b)

Find passages inside a contract matching a natural-language query. Returns
{matches: [{beforeContext, match, afterContext, sectionHint}]} so the model
can cite the specific clause instead of regurgitating the full body.

Today uses windowed text search over ContractVersion.plainText — the
structured ContractClause pipeline (docs/28 Wave 2) will plug in alongside
when it ships, at which point this tool returns both sources unioned.
"""
from __future__ import annotations

import logging

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..config import settings

log = logging.getLogger(__name__)


class ClauseSearchArgs(BaseModel):
    contract_id: str = Field(
        ...,
        description="The CUID of the contract to search within.",
    )
    query: str = Field(
        ...,
        description=(
            "Short phrase to look for (e.g. 'liability cap', 'termination "
            "for convenience', 'Service Credit', '99.9'). Case-insensitive."
        ),
    )
    limit: int = Field(5, ge=1, le=20, description="Max matches to return.")


def build_clause_search(org_id: str) -> StructuredTool:

    async def _arun(contract_id: str, query: str, limit: int = 5) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/clause_search"
        headers = {
            "x-internal-secret": settings.internal_service_secret,
            "x-internal-service": "agents",
            "content-type": "application/json",
        }
        payload = {
            "orgId": org_id, "contractId": contract_id,
            "query": query, "limit": limit,
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code == 404:
            return '{"error":"contract_not_found","contract_id":"' + contract_id + '"}'
        if r.status_code >= 400:
            log.warning("[clause_search] Node returned %s: %s", r.status_code, r.text[:200])
            return '{"error":"clause_search_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(contract_id: str, query: str, limit: int = 5):
        import asyncio
        return asyncio.run(_arun(contract_id, query, limit))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="clause_search",
        description=(
            "Find passages inside a specific contract matching a query. "
            "Returns matches with surrounding context and a section hint "
            "(e.g. '9.2'). Use this to cite clauses verbatim when the user "
            "asks about a specific topic. Narrower + cheaper than "
            "contract_get when you only need the relevant snippet."
        ),
        args_schema=ClauseSearchArgs,
    )
