"""compliance_get tool (Phase 10 — Compliance Agent).

Reads the persisted GDPR/HIPAA/SOX/CCPA compliance report from
Contract.metadata._compliance via POST /api/internal/ai/tools/
compliance_get. Fast read — answers "is this contract GDPR compliant?"
from the stored report (per-framework status, score, grounded findings
with quotes + recommendations). When no report exists the response says
so and points the user at the Compliance section on the contract page.
"""
from __future__ import annotations

import logging

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..config import settings

log = logging.getLogger(__name__)


class ComplianceGetArgs(BaseModel):
    contract_id: str = Field(..., description="Contract CUID (from a prior contract_search/contract_get call).")


def build_compliance_get(org_id: str) -> StructuredTool:
    async def _arun(contract_id: str) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/compliance_get"
        headers = {"x-internal-secret": settings.internal_service_secret, "x-internal-service": "agents", "content-type": "application/json"}
        payload = {"orgId": org_id, "contractId": contract_id}
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code == 404:
            return '{"error":"contract_not_found"}'
        if r.status_code >= 400:
            log.warning("[compliance_get] Node %s: %s", r.status_code, r.text[:200])
            return '{"error":"compliance_get_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(contract_id: str) -> str:
        import asyncio
        return asyncio.run(_arun(contract_id))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="compliance_get",
        description=(
            "Get the contract's regulatory compliance report (GDPR, HIPAA, "
            "SOX, CCPA): per-framework applicability, status, 0-100 score, "
            "and clause-grounded findings with quotes + recommendations. "
            "Use for 'is this contract GDPR compliant?' / 'what compliance "
            "gaps does this have?'. If report is null, tell the user to run "
            "a compliance check from the Compliance section on the contract "
            "page — do NOT guess compliance status from prose."
        ),
        args_schema=ComplianceGetArgs,
    )
