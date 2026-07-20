"""portfolio_compare tool (2026-05-01 ADL) — true multi-doc side-by-side.

Calls POST /api/internal/ai/tools/portfolio_compare which returns a
topic × contract matrix with per-cell { found, excerpt, sectionRef } so
the UI can render real side-by-side and the LLM only narrates on top of
structured data — never pretends contract #2 matches contract #1.
Routing rule A12: "compare these N contracts" → this tool.
"""
from __future__ import annotations

import logging

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..config import settings

log = logging.getLogger(__name__)


class PortfolioCompareArgs(BaseModel):
    contract_ids: list[str] = Field(
        ...,
        min_length=2,
        max_length=10,
        description="2–10 contract CUIDs to compare (from a prior contract_search / portfolio_search call).",
    )
    topics: list[str] = Field(
        ...,
        min_length=1,
        max_length=10,
        description="1–10 topics/clause keywords to compare across the contracts, e.g. ['termination', 'liability cap', 'auto-renew'].",
    )
    excerpt_chars: int = Field(220, ge=50, le=800, description="Excerpt window size per cell.")


def build_portfolio_compare(org_id: str) -> StructuredTool:
    async def _arun(contract_ids: list[str], topics: list[str], excerpt_chars: int = 220) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/portfolio_compare"
        headers = {"x-internal-secret": settings.internal_service_secret, "x-internal-service": "agents", "content-type": "application/json"}
        payload = {
            "orgId":        org_id,
            "contractIds":  contract_ids,
            "topics":       topics,
            "excerptChars": excerpt_chars,
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            log.warning("[portfolio_compare] Node %s: %s", r.status_code, r.text[:200])
            return '{"error":"portfolio_compare_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(contract_ids: list[str], topics: list[str], excerpt_chars: int = 220) -> str:
        import asyncio
        return asyncio.run(_arun(contract_ids, topics, excerpt_chars))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="portfolio_compare",
        description=(
            "Compare 2–10 specific contracts side-by-side on named topics. "
            "Returns a topic × contract matrix with found/excerpt/sectionRef "
            "per cell. Use when the user says 'compare these contracts on X' "
            "— get the contract ids from contract_search/portfolio_search "
            "first. Never synthesise a comparison from prose; use this tool."
        ),
        args_schema=PortfolioCompareArgs,
    )
