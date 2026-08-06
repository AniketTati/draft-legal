"""
POST /playbook-review — score one contract's clauses against the org playbook.

Deliberately SYNCHRONOUS, unlike /redline which fires a BackgroundTask and
PATCHes the result back itself. The caller (agent.worker) already runs inside a
retryable BullMQ job and already holds a DB connection, so:
  * it sends the clauses + playbook rather than making this service re-fetch
    them (no widening of the org-scoped clause endpoint for internal callers),
  * it persists the result itself,
  * and a failure here surfaces as a non-2xx the job can retry, instead of
    disappearing into a background task.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..agents.playbook_review_agent import run_playbook_review

router = APIRouter()
logger = logging.getLogger(__name__)


class Clause(BaseModel):
    id: str
    clauseType: Optional[str] = None
    content: Optional[str] = ""
    sectionRef: Optional[str] = None


class PlaybookReviewRequest(BaseModel):
    contractId: str
    clauses: list[Clause] = []
    playbookPositions: list[dict] = []
    contractType: Optional[str] = None
    # Optional (not required) so an older worker build that doesn't yet send
    # orgId keeps working during a rolling deploy — it just resolves against
    # the platform key instead of the org's BYOK key.
    orgId: Optional[str] = None


@router.post("/playbook-review")
async def playbook_review(body: PlaybookReviewRequest):
    logger.info(
        "[playbook-review] START contractId=%s clauses=%d positions=%d",
        body.contractId, len(body.clauses), len(body.playbookPositions),
    )
    try:
        result = await run_playbook_review(
            clauses=[c.model_dump() for c in body.clauses],
            playbook_positions=body.playbookPositions,
            contract_type=body.contractType or "general commercial",
            org_id=body.orgId,
        )
    except Exception as e:
        logger.error("[playbook-review] FAILED contractId=%s: %s", body.contractId, e)
        # 502 (not 500) so the caller can distinguish an upstream model failure
        # from a malformed request, and retry accordingly.
        raise HTTPException(status_code=502, detail=f"Playbook review failed: {e}") from e

    logger.info(
        "[playbook-review] DONE contractId=%s findings=%d gate=%s",
        body.contractId, len(result["findings"]), result["requiresHumanGate"],
    )
    return result
