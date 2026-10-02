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

from ..agents.redline_agent import run_redline, counter_change, NOT_COVERED_NOTE
from ..config import settings

router = APIRouter()
logger = logging.getLogger(__name__)


def _internal_headers(org_id: str) -> dict:
    """All three internal-service headers (see approval.py / clm-debug-multilayer).

    Without x-org-id, requireAuth resolves the caller's org to 'system', and
    the org-scoped diff route 404s the contract — which is how every
    Negotiate-tab analysis failed before (C8).
    """
    return {
        "x-internal-service": "agents",
        "x-internal-secret": settings.internal_service_secret,
        "x-org-id": org_id,
    }


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

    headers = _internal_headers(org_id)
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

        if not diff_html.strip() or ("<ins" not in diff_html and "<del" not in diff_html):
            logger.warning("[redline] No changes between versions for contractId=%s — nothing to analyze", contract_id)
            await _set_failed(client, api_url, contract_id, headers,
                              "The two versions have no differences, so there is nothing to analyze.")
            return

        # 2. Fetch playbook positions for scoring context. Non-fatal, but never
        # silent: an analysis scored without the playbook says so (C8 — this
        # used to call a route that doesn't exist and score against nothing).
        playbook_positions: list[dict] = []
        playbook_note: str | None = None
        try:
            pb_params = {"contractType": contract_type} if contract_type else {}
            pb_res = await client.get(
                f"{api_url}/api/v1/playbook/positions",
                params=pb_params,
                headers=headers,
            )
            if pb_res.is_success:
                playbook_positions = pb_res.json().get("data", [])
                if not playbook_positions:
                    # docs/41 P0.5 — said as it is: nothing was compared with a market.
                    playbook_note = NOT_COVERED_NOTE
            else:
                playbook_note = f"The playbook could not be loaded ({pb_res.status_code}), so changes were scored without it."
                logger.warning("[redline] playbook fetch returned %s: %s", pb_res.status_code, pb_res.text[:200])
        except Exception as e:
            playbook_note = "The playbook could not be loaded, so changes were scored without it."
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

        # A step can fail inside the pipeline and still return a result: no
        # changes plus an error. That used to be written as a DONE analysis
        # with nothing in it — an empty success. Fail it with the reason.
        if result.get("error") and not result.get("changes"):
            logger.error("[redline] Pipeline error with no changes: %s", result["error"])
            await _set_failed(client, api_url, contract_id, headers,
                              f"The analysis could not be completed: {result['error']}")
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
            "playbookPositionCount": len(playbook_positions),
            **({"playbookNote": playbook_note} if playbook_note else {}),
            # Partial result: some changes were extracted but a later step
            # (scoring / summary) failed.
            **({"warning": f"Part of the analysis failed: {result['error']}"} if result.get("error") else {}),
        }

        updated_meta = {
            **existing_meta,
            "_redlineAnalysis": analysis,
            "_redlineStatus":   "DONE",
            "_redlineError":    None,   # clear a previous failure (the API deletes null keys)
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


class ScoreRequest(BaseModel):
    diffHtml:          str
    orgId:             str
    contractType:      Optional[str] = None
    playbookPositions: list[dict] = []


@router.post("/redline/score")
async def score_redlines(body: ScoreRequest):
    """docs/41 Part 15 — the change scoring as a findings stage: the API sends
    the diff and the playbook and stores the advice on the version's findings
    itself (lib/change-advice.ts), so nothing is written back from here."""
    if not body.diffHtml.strip() or ("<ins" not in body.diffHtml and "<del" not in body.diffHtml):
        return {"changes": [], "summary": "", "error": None}
    result = await run_redline(
        diff_html=body.diffHtml,
        contract_type=body.contractType or "general commercial",
        playbook_positions=body.playbookPositions,
        org_id=body.orgId,
    )
    return {"changes": result["changes"], "summary": result["summary"], "error": result.get("error")}


class CounterRequest(BaseModel):
    ourText:           str
    theirText:         str
    orgId:             str
    contractType:      Optional[str] = None
    clauseType:        Optional[str] = None
    playbookPositions: list[dict] = []


@router.post("/redline/counter")
async def counter_redline(body: CounterRequest):
    """docs/41 Part 15 — Counter… on one change: counter wording with its rationale."""
    return await counter_change(
        our_text=body.ourText,
        their_text=body.theirText,
        contract_type=body.contractType or "general commercial",
        playbook_positions=body.playbookPositions,
        clause_type=body.clauseType,
        org_id=body.orgId,
    )
