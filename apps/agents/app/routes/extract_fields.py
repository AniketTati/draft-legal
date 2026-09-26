"""
POST /extract-fields — X2: extract org-defined custom fields from one contract.

Called by the API's custom-field backfill (agent.worker.ts) when an admin adds
a field after contracts were analysed. Re-running the whole /review for one
field would replace every clause row and re-embed the contract; this asks the
model for the named fields only, a chunk at a time, and stops as soon as each
has a value.

Returns: { customFields: { <fieldKey>: { value, confidence, quote } } }
(fields the contract doesn't state are absent).
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

from fastapi import APIRouter
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel

from ..agents.review_agent import _chunk_text
from ..jsonish import loads_lenient
from ..pii_tokens import PII_TOKEN_RULE
from ..router import resolve_llm
from ..untrusted import wrap_untrusted_document

router = APIRouter()
logger = logging.getLogger(__name__)

_SYSTEM = """You are a contract data extraction specialist. Extract the organisation-defined fields below from the contract text.

Return ONLY valid JSON: {"customFields": {"<key>": {"value": <value matching the field's type, or null>, "confidence": <0.0-1.0>, "quote": "<verbatim source text, or null>"}}}
Include every key listed. Use null when the text does not state the field; never guess.

Fields:
"""


class FieldSpec(BaseModel):
    fieldKey:   str
    fieldLabel: str
    fieldType:  str
    options:    list[str] = []
    helpText:   Optional[str] = None


class ExtractFieldsRequest(BaseModel):
    plainText:    str
    fields:       list[FieldSpec]
    contractType: Optional[str] = None
    orgId:        Optional[str] = None


def _text(content: Any) -> str:
    if isinstance(content, list):
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    return str(content)


@router.post("/extract-fields")
async def extract_fields(req: ExtractFieldsRequest) -> dict[str, Any]:
    wanted = {f.fieldKey for f in req.fields}
    specs = [
        {"key": f.fieldKey, "label": f.fieldLabel, "type": f.fieldType, "options": f.options, "hint": f.helpText or ""}
        for f in req.fields
    ]
    system = _SYSTEM + json.dumps(specs, indent=2)
    if req.contractType:
        system += f"\n\nThis is a {req.contractType} contract."
    system += PII_TOKEN_RULE

    resolved = await resolve_llm("default", org_id=req.orgId, streaming=False, trace_name="extract_fields.backfill")
    found: dict[str, dict[str, Any]] = {}
    chunks = _chunk_text(req.plainText)
    for i, chunk in enumerate(chunks):
        resp = await resolved.llm.ainvoke(
            [
                SystemMessage(content=system),
                # Counterparty-authored text: framed as data, never instructions.
                HumanMessage(content=wrap_untrusted_document(chunk, source=f"contract body (chunk {i + 1} of {len(chunks)})")),
            ],
            config={"callbacks": resolved.callbacks},
        )
        data = loads_lenient(_text(resp.content))
        if isinstance(data, list):
            data = next((d for d in data if isinstance(d, dict)), {})
        fields = data.get("customFields") if isinstance(data, dict) else None
        if isinstance(fields, dict):
            for key, v in fields.items():
                if key in wanted and key not in found and isinstance(v, dict) and v.get("value") is not None:
                    found[key] = {"value": v.get("value"), "confidence": v.get("confidence", 0.5), "quote": v.get("quote")}
        if wanted <= found.keys():
            break
    logger.info("[extract-fields] fields=%d found=%d chunks_read=%d/%d", len(wanted), len(found), i + 1 if chunks else 0, len(chunks))
    return {"customFields": found}
