"""
contract_search tool (D.1.4b)

When the user asks "which NDAs expire next quarter" or "show my open MSAs
with Acme", the model calls contract_search to get back a list of card-sized
hits that it can either summarize directly or drill into with contract_get.

Keeps results small (default 10) so the LLM's context stays focused; the
model is expected to follow up with contract_get for anything more detailed.
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..config import settings

log = logging.getLogger(__name__)


class ContractSearchArgs(BaseModel):
    query: Optional[str] = Field(
        None,
        description=(
            "Free-text query matched case-insensitively against title, "
            "counterparty, and summary. Use plain English — not SQL. "
            "OMIT this field entirely to list ALL contracts (the most common "
            "starting point for portfolio-wide questions like 'top 5 "
            "counterparties by value' or 'show all our MSAs'). "
            "DO NOT pass '*' or '%' as a wildcard — they are treated as "
            "literal text by the search backend and will return zero hits."
        ),
    )
    status: Optional[str] = Field(
        None,
        description="Filter by contract status (e.g. 'DRAFT', 'EXECUTED', 'UNDER_NEGOTIATION').",
    )
    type: Optional[str] = Field(
        None,
        description="Filter by contract type (e.g. 'NDA', 'MSA', 'SLA', 'SOW').",
    )
    counterparty_name: Optional[str] = Field(
        None,
        description="Filter by counterparty name (partial match, case-insensitive).",
    )
    limit: int = Field(10, ge=1, le=50, description="Max results (default 10, max 50).")
    sort_by: Optional[str] = Field(
        None,
        description=(
            "Sort field. One of: 'value' (contract value), 'riskScore', "
            "'effectiveDate', 'expiryDate', 'createdAt', 'updatedAt' "
            "(default). USE THIS when the user asks 'top N by value', "
            "'highest risk', 'expiring soonest' etc. — never sort manually "
            "in your prose, you'll hallucinate."
        ),
    )
    sort_order: Optional[str] = Field(
        None,
        description="'asc' or 'desc'. Default 'desc' (largest/most recent first).",
    )


def build_contract_search(org_id: str) -> StructuredTool:

    async def _arun(
        query: Optional[str] = None,
        status: Optional[str] = None,
        type: Optional[str] = None,
        counterparty_name: Optional[str] = None,
        limit: int = 10,
        sort_by: Optional[str] = None,
        sort_order: Optional[str] = None,
    ) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/contract_search"
        headers = {
            "x-internal-secret": settings.internal_service_secret,
            "x-internal-service": "agents",
            "content-type": "application/json",
        }
        # Zod's .optional() rejects explicit null — only send keys that are
        # actually set so the Node endpoint's schema validates cleanly.
        payload: dict = {"orgId": org_id, "limit": limit}
        if query             is not None: payload["query"]            = query
        if status            is not None: payload["status"]           = status
        if type              is not None: payload["type"]             = type
        if counterparty_name is not None: payload["counterpartyName"] = counterparty_name
        if sort_by           is not None: payload["sortBy"]           = sort_by
        if sort_order        is not None: payload["sortOrder"]        = sort_order
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            log.warning("[contract_search] Node returned %s: %s", r.status_code, r.text[:200])
            return '{"error":"contract_search_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(**kwargs):
        import asyncio
        return asyncio.run(_arun(**kwargs))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="contract_search",
        description=(
            "Search the org's contracts by natural-language query and/or "
            "structured filters (status, type, counterparty_name). Returns "
            "card-sized results (id, title, type, status, counterparty, "
            "risk, dates, value). Use this to find the right contract, then "
            "call contract_get for the full body if the user needs details. "
            "\n\n"
            "FOR PORTFOLIO-WIDE QUESTIONS ('top 5 counterparties', 'all our "
            "MSAs', 'list every contract I own') call this with NO query "
            "argument and limit=50. Do NOT pass query='*' — wildcards are "
            "treated literally and return zero hits."
            "\n\n"
            "RANKED QUESTIONS ('top 3 by value', 'highest risk', 'expiring "
            "soonest') — set sort_by='value' / 'riskScore' / 'expiryDate' "
            "and sort_order='desc' (or 'asc' for 'expiring soonest', "
            "'lowest risk'). NEVER read 50 rows and sort them in your head: "
            "you will hallucinate values that aren't in the result set. "
            "Trust the database."
        ),
        args_schema=ContractSearchArgs,
    )
