"""
contract_get tool (D.1.4a)

When the model decides "I need to read THIS contract before I can answer",
it invokes contract_get(contract_id=...). The implementation calls Node's
internal endpoint which enforces tenant scoping and returns:

  - title, type, status, counterparty, jurisdiction
  - effective/expiry dates, value, currency
  - summary, key_terms, risk_score, risk_factors
  - plainText (truncated — default 12k chars) + plainTextLength + truncated
  - current version number + timestamp

Why HTTP into Node and not direct DB access from Python:
  - Single source of truth for orgId scoping (the Node layer owns auth)
  - Prisma client + relations stay on one side
  - Easy to add audit + rate-limiting later without touching Python
"""
from __future__ import annotations

import json
import logging
from typing import Any

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..config import settings

log = logging.getLogger(__name__)


class ContractGetArgs(BaseModel):
    """Arguments the LLM provides when it invokes contract_get."""
    contract_id: str = Field(
        ...,
        min_length=20,
        description=(
            "The CUID of the contract to fetch. MUST be the EXACT id value "
            "(20+ chars, starts with 'cm') from a prior tool result, a URL "
            "(/contracts/:id), or the page-context hint. "
            "DO NOT use placeholders like 'c1', 'contract_1', or 'first'. "
            "DO NOT abbreviate or shorten the cuid. "
            "If you don't have a real id from a previous tool call, run "
            "contract_search FIRST to get one, then call contract_get with "
            "the actual id from those results."
        ),
    )
    max_chars: int = Field(
        12_000,
        ge=100,
        le=200_000,
        description=(
            "Upper bound on returned plaintext length in characters. Default "
            "12000 keeps context tight; bump only if you really need the full "
            "contract body to answer."
        ),
    )


def build_contract_get(org_id: str) -> StructuredTool:
    """Return a StructuredTool bound to this org.

    The returned tool's `invoke()` hits Node's /internal/ai/tools/contract_get
    with an injected org_id so the LLM's arguments can never escape its tenant.
    """

    async def _arun(contract_id: str, max_chars: int = 12_000) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/contract_get"
        headers = {
            "x-internal-secret": settings.internal_service_secret,
            "x-internal-service": "agents",
            "content-type": "application/json",
        }
        payload = {
            "orgId":      org_id,
            "contractId": contract_id,
            "maxChars":   max_chars,
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code == 404:
            return json.dumps({"error": "contract_not_found", "contract_id": contract_id})
        if r.status_code >= 400:
            log.warning("[contract_get] Node returned %s: %s", r.status_code, r.text[:200])
            return json.dumps({"error": "contract_get_failed", "status": r.status_code})
        # Return as a JSON STRING so LangChain's tool-response path treats it
        # as text content. The LLM handles JSON natively.
        return r.text

    def _run(contract_id: str, max_chars: int = 12_000) -> str:
        # Sync fallback — not used in our async agent path but keeps
        # LangChain's schema happy.
        import asyncio
        return asyncio.run(_arun(contract_id, max_chars))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="contract_get",
        description=(
            "Fetch a contract's metadata, key terms, risk score, and "
            "(truncated) plaintext by id. Use this whenever you need to "
            "answer questions about a specific contract's contents — do "
            "NOT rely on your prior knowledge of the document. Pass the "
            "`contract_id` from the user's page context or a search result."
        ),
        args_schema=ContractGetArgs,
    )
