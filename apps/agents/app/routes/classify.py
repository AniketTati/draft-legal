"""
POST /classify — called by agent.worker.ts after detect-binder determines no split is needed.
Identifies the contract type from the document's opening and its headings
(fast, cheap, Haiku). docs/39 A13 — it read the first 5K characters only, so
an MSA whose first pages are definitions, or a SOW behind a long cover
letter, could come back as whatever the opening sounded like.

Returns: { contractType, confidence, reason }
"""
from __future__ import annotations

import json
import logging
import re
from typing import Optional
from fastapi import APIRouter
from pydantic import BaseModel

from ..jsonish import loads_lenient
from ..router import resolve_llm

router = APIRouter()
logger = logging.getLogger(__name__)

MAX_CHARS = 5_000
# Of which the opening: the rest of the sample is the document's headings.
OPENING_CHARS = 3_500
MAX_HEADINGS = 40

_HEADING = re.compile(
    r"^(?:(?:section|article|clause|schedule|exhibit|annex|appendix|part)\s+[\w.]+|\d+(?:\.\d+)*[.)]?\s+[A-Z]|[A-Z][A-Z0-9 ,&'()/-]{4,})",
    re.IGNORECASE,
)


def structure_sample(text: str) -> str:
    """The document's opening, then the headings of the rest: its structure
    (the sections an MSA has, a SOW's deliverables and milestones) in the few
    thousand characters the classifier reads."""
    if len(text) <= MAX_CHARS:
        return text
    opening = text[:OPENING_CHARS]
    headings: list[str] = []
    seen: set[str] = set()
    for line in text[OPENING_CHARS:].splitlines():
        line = line.strip()
        if not (4 <= len(line) <= 90) or not _HEADING.match(line):
            continue
        # A heading is short; a sentence that happens to start with a number isn't.
        if line.endswith(('.', ';', ',')) and len(line) > 40:
            continue
        key = line.lower()
        if key in seen:
            continue
        seen.add(key)
        headings.append(line)
        if len(headings) >= MAX_HEADINGS:
            break
    tail = "\n".join(headings)
    return f"{opening}\n\n[…]\n\nHEADINGS FROM THE REST OF THE DOCUMENT:\n{tail}"[:MAX_CHARS + 400] if headings else opening

VALID_TYPES = {
    "NDA", "MSA", "SOW", "SLA", "VENDOR_AGREEMENT", "EMPLOYMENT",
    "PARTNERSHIP", "LICENSE", "DATA_PROCESSING", "ORDER_FORM", "OTHER",
}

_PROMPT = """\
You are a legal contract classifier. Read the beginning of the following legal document, and the headings of the rest of it when they are given, and identify its primary contract type.

Return ONLY valid JSON in this exact structure:
{
  "contractType": "one of the types listed below",
  "confidence": 0.0 to 1.0,
  "reason": "one sentence explaining the key signal that determined the type"
}

Valid contract types:
- NDA: Non-Disclosure / Confidentiality Agreement
- MSA: Master Services Agreement / Master Subscription Agreement
- SOW: Statement of Work / Independent Contractor Agreement
- SLA: Service Level Agreement
- VENDOR_AGREEMENT: Vendor / Supplier Agreement (generic procurement)
- EMPLOYMENT: Employment Agreement / Offer Letter
- PARTNERSHIP: Partnership Agreement / Joint Venture Agreement
- LICENSE: Software or IP License Agreement
- DATA_PROCESSING: Data Processing Addendum / Data Protection Agreement
- ORDER_FORM: Order Form / Purchase Order
- OTHER: Does not match any of the above

Rules:
- Use the most specific matching type. If it could be MSA or VENDOR_AGREEMENT, prefer MSA if it governs ongoing services.
- confidence > 0.8 means the title or opening paragraph makes the type unambiguous.
- confidence 0.5–0.8 means you inferred from content, not explicit title.
- Do NOT include any explanation outside the JSON object.

Document text:
"""


class ClassifyRequest(BaseModel):
    plainText: str
    orgId:     Optional[str] = None


class ClassifyResponse(BaseModel):
    contractType: str
    confidence:   float
    reason:       str


@router.post("/classify", response_model=ClassifyResponse)
async def classify_document(req: ClassifyRequest) -> ClassifyResponse:
    text_sample = structure_sample(req.plainText)
    logger.info("[classify] chars_sampled=%d", len(text_sample))

    try:
        raw    = await _call_llm(text_sample, req.orgId)
        parsed = loads_lenient(raw)
        ctype  = parsed.get("contractType", "OTHER")
        if ctype not in VALID_TYPES:
            ctype = "OTHER"
        result = ClassifyResponse(
            contractType=ctype,
            confidence=float(parsed.get("confidence", 0.5)),
            reason=str(parsed.get("reason", "")),
        )
        logger.info("[classify] contractType=%s confidence=%.2f", result.contractType, result.confidence)
        return result
    except Exception as exc:
        logger.error("[classify] LLM call or parse failed: %s", exc)
        return ClassifyResponse(contractType="OTHER", confidence=0.0, reason="classification failed")


async def _call_llm(text: str, org_id: Optional[str]) -> str:
    prompt = _PROMPT + text

    # Routed through resolve_llm so per-org BYOK keys, tier overrides and
    # Langfuse tracing apply. resolve_llm hands back a ready LangChain
    # BaseChatModel for whichever provider resolved, so the old per-provider
    # branch (raw AsyncAnthropic / AsyncOpenAI / ChatGoogleGenerativeAI built
    # straight from platform settings) is no longer needed.
    resolved = await resolve_llm(
        "default",
        org_id=org_id,
        streaming=False,
        trace_name="classify.detect",
    )
    resp = await resolved.llm.ainvoke(prompt, config={"callbacks": resolved.callbacks})
    content = resp.content
    if isinstance(content, list):
        # LangChain can return content as a list of blocks — extract
        # text parts instead of str()-ing the Python repr.
        content = "".join(
            p.get("text", "") if isinstance(p, dict) else str(p)
            for p in content
        )
    return content
