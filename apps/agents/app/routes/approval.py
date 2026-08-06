"""
POST /approval-summary — called by the agent worker after approval-summary job is picked up.
Fetches contract + version + clauses from the Node API, runs the 3-step Approval Agent pipeline,
and PATCHes the result back into the ApprovalInstance via PATCH /api/v1/approvals/:instanceId/summary.
"""
from __future__ import annotations

import httpx
import logging
from typing import Optional
from fastapi import APIRouter, BackgroundTasks
from pydantic import BaseModel

from ..agents.approval_agent import run_approval_summary
from ..config import settings

router = APIRouter()
logger = logging.getLogger(__name__)

_API = settings.api_url


def _internal_headers(org_id: str) -> dict[str, str]:
    """System-scoped headers for the Node API's requireAuth bypass.

    The bypass needs BOTH x-internal-service: agents AND the shared
    secret, plus x-org-id for tenant scoping (auth.ts). Sending only
    the secret falls through to the Bearer check → 401, which silently
    killed every approval summary (logs showed
    "[approval-summary] failed to fetch contract …: 401").
    """
    return {
        "Content-Type": "application/json",
        "x-internal-secret": settings.internal_service_secret,
        "x-internal-service": "agents",
        "x-org-id": org_id,
    }


class ApprovalSummaryRequest(BaseModel):
    instanceId:  str
    contractId:  str
    versionId:   str
    orgId:       str
    approverIds: list[str]


async def _process_approval_summary(
    instance_id:  str,
    contract_id:  str,
    version_id:   str,
    org_id:       str,
    approver_ids: list[str],
) -> None:
    logger.info("[approval-summary] START instanceId=%s contractId=%s", instance_id, contract_id)
    headers = _internal_headers(org_id)

    async with httpx.AsyncClient(timeout=60.0) as client:
        # 1. Fetch contract metadata
        r = await client.get(f"{_API}/api/v1/contracts/{contract_id}", headers=headers)
        if r.status_code != 200:
            logger.error("[approval-summary] failed to fetch contract %s: %s", contract_id, r.status_code)
            return
        contract = r.json()

        # 2. Fetch contract version (plain text)
        versions_r = await client.get(f"{_API}/api/v1/contracts/{contract_id}/versions", headers=headers)
        plain_text = ""
        if versions_r.status_code == 200:
            versions = versions_r.json().get("data", [])
            version = next((v for v in versions if v["id"] == version_id), versions[0] if versions else None)
            if version:
                plain_text = version.get("plainText", "")

        # 3. Fetch clauses
        clauses_r = await client.get(f"{_API}/api/v1/contracts/{contract_id}/clauses", headers=headers)
        clauses = []
        if clauses_r.status_code == 200:
            clauses_data = clauses_r.json()
            clauses = clauses_data.get("data", clauses_data) if isinstance(clauses_data, dict) else clauses_data

        # 4. Run the 3-step LangGraph pipeline
        key_terms = contract.get("keyTerms") or {}
        risk_factors = contract.get("riskFactors") or []
        result = await run_approval_summary(
            plain_text=plain_text,
            contract_type=contract.get("type", "OTHER"),
            contract_value=float(contract["value"]) if contract.get("value") else None,
            contract_title=contract.get("title", "Contract"),
            counterparty_name=contract.get("counterpartyName"),
            clauses=clauses,
            key_terms=key_terms,
            risk_factors=risk_factors,
            risk_score=contract.get("riskScore"),
            org_id=org_id,
        )

        if result.get("error"):
            logger.warning("[approval-summary] pipeline had error: %s", result["error"])

        # 5. PATCH the result back to the ApprovalInstance
        patch_r = await client.patch(
            f"{_API}/api/v1/approvals/{instance_id}/summary",
            headers=headers,
            json={
                "aiSummary":             result.get("executiveSummary", ""),
                "keyRisks":              result.get("keyRisks", []),
                "nonStandardTerms":      result.get("nonStandardTerms", []),
                "approvalRecommendation": result.get("approvalRecommendation", "review_required"),
            },
        )
        if patch_r.status_code not in (200, 204):
            logger.error("[approval-summary] PATCH summary failed: %s %s", patch_r.status_code, patch_r.text[:200])
        else:
            logger.info("[approval-summary] DONE instanceId=%s recommendation=%s", instance_id, result.get("approvalRecommendation"))


@router.post("/approval-summary")
async def generate_approval_summary(body: ApprovalSummaryRequest, background: BackgroundTasks):
    """Fire-and-forget: fetch contract data, run pipeline, PATCH result back to API."""
    background.add_task(
        _process_approval_summary,
        instance_id=body.instanceId,
        contract_id=body.contractId,
        version_id=body.versionId,
        org_id=body.orgId,
        approver_ids=body.approverIds,
    )
    return {"status": "queued", "instanceId": body.instanceId}
