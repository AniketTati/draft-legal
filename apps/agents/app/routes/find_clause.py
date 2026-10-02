"""
POST /find-clause — docs/39 E3: one of the organisation's own clause types,
found in one contract.

Called by the API's "Try it on a contract" (a new type's preview) and by the
run that finds a new type in the contracts read before it existed. Re-running
the whole /review for one clause type would replace every clause row and
re-embed the contract; this reads for the one type (app/agents/clause_finder.py).

Returns: { clauses: [{ content, startsWith, endsWith, sectionRef, interpretation }], chunks, usage }
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter
from pydantic import BaseModel

from ..agents.clause_finder import find_clause
from ..usage_meter import metering

router = APIRouter()
logger = logging.getLogger(__name__)


class ClauseTypeSpec(BaseModel):
    key:         str
    label:       str
    description: str = ""
    examples:    list[str] = []


class FindClauseRequest(BaseModel):
    plainText:  str
    clauseType: ClauseTypeSpec
    orgId:      Optional[str] = None


@router.post("/find-clause")
async def find_clause_route(req: FindClauseRequest) -> dict[str, Any]:
    with metering() as meter:
        clauses, chunks = await find_clause(req.plainText, req.clauseType.model_dump(), org_id=req.orgId, trace_name="find_clause")
    logger.info("[find-clause] type=%s chunks=%d found=%d", req.clauseType.key, chunks, len(clauses))
    return {"clauses": clauses, "chunks": chunks, "usage": meter.summary()}
