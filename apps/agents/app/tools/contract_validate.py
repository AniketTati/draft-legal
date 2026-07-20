"""
contract_validate tool (P3.4 / docs/30 D.5.10)

Lightweight pre-signature validator that catches the dumb-but-
embarrassing errors reviewers waste 30 minutes finding. Three passes,
no LLM calls:

  • Defined-term drift — "Company" in §1 vs "the company" later
  • Unresolved cross-refs — "Section ___" / "§ ___" never filled
  • Dangling section refs — "see Section 12.3" when §12.3 doesn't exist

Returns structured issues the UI can render as a banner or the agent
can read aloud before sending for review.
"""
from __future__ import annotations

import logging

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..config import settings

log = logging.getLogger(__name__)


class ContractValidateArgs(BaseModel):
    contract_id: str = Field(
        ...,
        description="The CUID of the contract to validate.",
    )
    max_issues: int = Field(
        50, ge=1, le=200,
        description="Hard cap on issues returned.",
    )


def build_contract_validate(org_id: str) -> StructuredTool:

    async def _arun(contract_id: str, max_issues: int = 50) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/contract_validate"
        headers = {
            "x-internal-secret": settings.internal_service_secret,
            "x-internal-service": "agents",
            "content-type":      "application/json",
        }
        payload = {"orgId": org_id, "contractId": contract_id, "maxIssues": max_issues}
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            log.warning("[contract_validate] Node %s: %s", r.status_code, r.text[:200])
            return '{"error":"contract_validate_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(contract_id: str, max_issues: int = 50):
        import asyncio
        return asyncio.run(_arun(contract_id, max_issues))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="contract_validate",
        description=(
            "Fast sanity-check on a contract draft — defined-term "
            "consistency (Company vs Customer vs 'the company'), "
            "unresolved 'Section ___' placeholders, dangling section "
            "references. Runs in ~50ms with no LLM calls. Call this "
            "ANY TIME the user asks 'is this ready to send?' or "
            "'check for errors' or 'is there anything I'm missing?', "
            "and call it automatically before routing a contract for "
            "approval."
        ),
        args_schema=ContractValidateArgs,
    )
