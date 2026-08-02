"""
contract_summarize tool (D.1.4b)

Returns summary-shaped metadata for a contract — title, dates, parties,
risk, keyTerms, cached AI summary, plus a 1500-char opening snippet.

Use this instead of contract_get when the user wants an overview and
doesn't need the full body. Smaller context → faster + cheaper.
"""
from __future__ import annotations

import logging

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..config import settings

log = logging.getLogger(__name__)


class ContractSummarizeArgs(BaseModel):
    contract_id: str = Field(
        ...,
        description="The CUID of the contract to summarize. Same id format contract_get uses.",
    )


def build_contract_summarize(org_id: str) -> StructuredTool:

    async def _arun(contract_id: str) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/contract_summarize"
        headers = {
            "x-internal-secret": settings.internal_service_secret,
            "x-internal-service": "agents",
            "content-type": "application/json",
        }
        payload = {"orgId": org_id, "contractId": contract_id}
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code == 404:
            return '{"error":"contract_not_found","contract_id":"' + contract_id + '"}'
        if r.status_code >= 400:
            log.warning("[contract_summarize] Node returned %s: %s", r.status_code, r.text[:200])
            return '{"error":"contract_summarize_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(contract_id: str):
        import asyncio
        return asyncio.run(_arun(contract_id))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="contract_summarize",
        description=(
            "Get a compact summary of a contract (title, type, status, "
            "parties, dates, value, risk, key terms, cached AI summary, "
            "opening 1500 chars). Use this when the user wants a high-level "
            "overview; use contract_get when the user asks about a specific "
            "clause or needs the full body."
        ),
        args_schema=ContractSummarizeArgs,
    )
