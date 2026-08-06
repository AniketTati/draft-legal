"""
POST /redline — called by the agent worker after redline-analysis job is picked up.
Fetches diff HTML from the Node API, runs the 3-step Redline Agent pipeline,
and PATCHes the result back into contract.metadata._redlineAnalysis.
"""
from __future__ import annotations

import httpx
import logging
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, BackgroundTasks
from pydantic import BaseModel

from ..agents.redline_agent import run_redline
from ..config import settings

router = APIRouter()
logger = logging.getLogger(__name__)


class RedlineRequest(BaseModel):
    contractId:    str
    v1Id:          str
    v2Id:          str
    orgId:         str
    userId:        str
    contractType:  Optional[str] = None


async def _process_redline(
    contract_id:   str,
    v1_id:         str,
    v2_id:         str,
    org_id:        str,
    user_id:       str,
    contract_type: str | None,
) -> None:
    logger.info("[redline] START contractId=%s v1=%s v2=%s", contract_id, v1_id, v2_id)

    headers = {
        "x-internal-service": "agents",
        "x-internal-secret": settings.internal_service_secret,
    }
    api_url = settings.api_url

    async with httpx.AsyncClient(timeout=60) as client:
        # 1. Fetch diff HTML from Node API
        try:
            diff_res = await client.get(
                f"{api_url}/api/v1/contracts/{contract_id}/versions/{v1_id}/diff/{v2_id}",
                headers=headers,
            )
            if not diff_res.is_success:
                raise RuntimeError(f"Diff endpoint returned {diff_res.status_code}: {diff_res.text[:200]}")
            diff_data = diff_res.json()
            diff_html: str = diff_data.get("diffHtml", "")
        except Exception as e:
            logger.error("[redline] Failed to fetch diff: %s", e)
            await _set_failed(client, api_url, contract_id, headers, str(e))
            return

        if not diff_html.strip():
            logger.warning("[redline] Empty diff HTML for contractId=%s — nothing to analyze", contract_id)
            await _set_failed(client, api_url, contract_id, headers, "Empty diff")
            return

        # 2. Fetch playbook positions for scoring context
        playbook_positions: list[dict] = []
        try:
            pb_res = await client.get(
                f"{api_url}/api/v1/playbook",
                params={"orgId": org_id},
                headers=headers,
            )
            if pb_res.is_success:
                pb_data = pb_res.json()
                playbook_positions = pb_data.get("data", [])
        except Exception as e:
            logger.warning("[redline] Could not fetch playbook (non-fatal): %s", e)

        # 3. Run redline pipeline
        try:
            result = await run_redline(
                diff_html=diff_html,
                contract_type=contract_type or "general commercial",
                playbook_positions=playbook_positions,
                org_id=org_id,
            )
        except Exception as e:
            logger.error("[redline] Pipeline failed: %s", e)
            await _set_failed(client, api_url, contract_id, headers, str(e))
            return

        logger.info("[redline] DONE contractId=%s action=%s gate=%s confidence=%.2f changes=%d",
                    contract_id, result.get("recommendedAction"), result.get("requiresHumanGate"),
                    result.get("confidence", 0), len(result.get("changes", [])))

        # 4. Fetch existing contract metadata to merge
        try:
            contract_res = await client.get(
                f"{api_url}/api/v1/contracts/{contract_id}",
                headers=headers,
            )
            existing_meta: dict = {}
            if contract_res.is_success:
                existing_meta = contract_res.json().get("metadata") or {}
        except Exception:
            existing_meta = {}

        # Keep history of last 5 analyses
        history = existing_meta.get("_redlineHistory", [])
        if isinstance(history, list) and len(history) >= 5:
            history = history[:4]

        analysis = {
            "v1Id":             v1_id,
            "v2Id":             v2_id,
            "analyzedAt":       datetime.now(timezone.utc).isoformat(),
            "changes":          result["changes"],
            "summary":          result["summary"],
            "recommendedAction": result["recommendedAction"],
            "requiresHumanGate": result["requiresHumanGate"],
            "confidence":       result["confidence"],
        }

        updated_meta = {
            **existing_meta,
            "_redlineAnalysis": analysis,
            "_redlineStatus":   "DONE",
            "_redlineHistory":  [analysis, *history],
        }

        # 5. PATCH contract metadata
        try:
            patch_res = await client.patch(
                f"{api_url}/api/v1/contracts/{contract_id}",
                json={"metadata": updated_meta},
                headers=headers,
                timeout=10,
            )
            if not patch_res.is_success:
                logger.error("[redline] PATCH failed status=%d body=%s",
                             patch_res.status_code, patch_res.text[:300])
        except Exception as e:
            logger.error("[redline] PATCH exception: %s", e)


async def _set_failed(
    client: httpx.AsyncClient,
    api_url: str,
    contract_id: str,
    headers: dict,
    reason: str,
) -> None:
    try:
        await client.patch(
            f"{api_url}/api/v1/contracts/{contract_id}",
            json={"metadata": {"_redlineStatus": "FAILED", "_redlineError": reason[:500]}},
            headers=headers,
            timeout=5,
        )
    except Exception:
        pass


@router.post("/redline")
async def analyze_redlines(body: RedlineRequest, background: BackgroundTasks):
    """Fire-and-forget: run redline analysis pipeline in background."""
    background.add_task(
        _process_redline,
        body.contractId,
        body.v1Id,
        body.v2Id,
        body.orgId,
        body.userId,
        body.contractType,
    )
    return {"status": "queued", "contractId": body.contractId}
