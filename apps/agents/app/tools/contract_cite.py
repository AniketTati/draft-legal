"""
contract_cite tool (P3.1 / docs/30 D.5.8)

Find passages inside a contract that match a query and return each
anchored to its PDF page + bbox + section ref. Distinct from
clause_search because the agent here intends to CITE — the user wants
to verify the AI claim by jumping straight to that region of the
original PDF.

Return shape:
  {
    contractId, title, type, query,
    citations: [
      { quote, page, bbox: [x0,y0,x1,y1], sectionRef, sectionTitle,
        score, exact }
    ]
  }
"""
from __future__ import annotations

import logging

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..config import settings

log = logging.getLogger(__name__)


class ContractCiteArgs(BaseModel):
    contract_id: str = Field(
        ...,
        description="The CUID of the contract to cite from.",
    )
    query: str = Field(
        ...,
        description=(
            "The claim or phrase to cite. Pass short substrings when the "
            "user asks 'where does it say X?'; pass longer prose when "
            "citing a topic ('termination rights')."
        ),
    )
    limit: int = Field(
        5, ge=1, le=10,
        description="Max citations to return.",
    )


def build_contract_cite(org_id: str) -> StructuredTool:

    async def _arun(contract_id: str, query: str, limit: int = 5) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/contract_cite"
        headers = {
            "x-internal-secret": settings.internal_service_secret,
            "x-internal-service": "agents",
            "content-type":      "application/json",
        }
        payload = {
            "orgId":       org_id,
            "contractId":  contract_id,
            "query":       query,
            "limit":       limit,
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code == 404:
            return '{"error":"contract_not_found","contract_id":"' + contract_id + '"}'
        if r.status_code >= 400:
            log.warning("[contract_cite] Node %s: %s", r.status_code, r.text[:200])
            return '{"error":"contract_cite_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(contract_id: str, query: str, limit: int = 5):
        import asyncio
        return asyncio.run(_arun(contract_id, query, limit))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="contract_cite",
        description=(
            "Cite a claim back to the source contract. Returns passages "
            "matching the query, each anchored to a {page, bbox, "
            "sectionRef} so the user can click the citation and land on "
            "the exact region of the PDF. Use this EVERY TIME the user "
            "asks 'where does it say…' or 'cite that' or when you want "
            "to show your work. Preferred over clause_search when the "
            "downstream UI needs clickable citations."
        ),
        args_schema=ContractCiteArgs,
    )
