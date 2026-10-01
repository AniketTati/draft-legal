"""
POST /extract-fields — X2: extract org-defined custom fields from one contract.

Called by the API's custom-field backfill (agent.worker.ts) when an admin adds
a field after contracts were analysed, by the field preview (D1) and its
re-check (D5), and for a diligence room's columns (D6: a question, sent as a
field with `question` set, or a field read for the documents without it). Re-running the whole /review for one field would replace every
clause row and re-embed the contract; this asks for the named fields only
(docs/39 A5: app/agents/custom_fields.py — with examples, the most relevant
chunk first, and each answer checked).

Returns: { customFields: { <fieldKey>: { value, confidence, quote, issue? } }, usage }
(fields the contract doesn't state are absent; usage is the call's real token
use by model, docs/39 A15, which the API records and prices).
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter
from pydantic import BaseModel

from ..agents.custom_fields import extract_custom_fields
from ..usage_meter import metering

router = APIRouter()
logger = logging.getLogger(__name__)


class FieldExample(BaseModel):
    value: str
    quote: Optional[str] = None


class FieldSpec(BaseModel):
    fieldKey:   str
    fieldLabel: str
    fieldType:  str
    options:    list[str] = []
    helpText:   Optional[str] = None
    # docs/39 A5 — how people filled it in on other contracts.
    examples:   list[FieldExample] = []
    # docs/39 D6 — a diligence room's question: the value is the contract's answer to it.
    question:   Optional[str] = None


class ExtractFieldsRequest(BaseModel):
    plainText:    str
    fields:       list[FieldSpec]
    contractType: Optional[str] = None
    orgId:        Optional[str] = None


@router.post("/extract-fields")
async def extract_fields(req: ExtractFieldsRequest) -> dict[str, Any]:
    with metering() as meter:
        found, read, total = await extract_custom_fields(
            req.plainText,
            [f.model_dump() for f in req.fields],
            contract_type=req.contractType,
            org_id=req.orgId,
            trace_name="extract_fields.backfill",
        )
    logger.info("[extract-fields] fields=%d found=%d chunks_read=%d/%d", len(req.fields), len(found), read, total)
    return {"customFields": found, "usage": meter.summary()}
