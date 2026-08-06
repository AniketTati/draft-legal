"""
POST /intake-classify — called by agent.worker.ts after a new contract request is created.
Classifies the request type and extracts key terms from the title + description.

Uses Haiku for speed/cost — quick triage, not deep analysis.
Returns: { contractType, suggestedPriority, extractedTerms, confidence, reason }
"""
from __future__ import annotations

import json
import logging
from typing import Optional
from fastapi import APIRouter
from pydantic import BaseModel

from ..jsonish import loads_lenient
from ..router import resolve_llm

router = APIRouter()
logger = logging.getLogger(__name__)

MAX_CHARS = 3_000

VALID_TYPES = {
    "NDA", "MSA", "SOW", "SLA", "VENDOR_AGREEMENT", "EMPLOYMENT",
    "PARTNERSHIP", "LICENSE", "DATA_PROCESSING", "ORDER_FORM", "OTHER",
}

VALID_PRIORITIES = {"LOW", "MEDIUM", "HIGH", "URGENT"}

_PROMPT = """\
You are a legal operations assistant. A user has submitted a contract request. Based on the title and description below, determine:
1. The contract type being requested
2. The suggested priority
3. Key terms extractable from the description

Return ONLY valid JSON in this exact structure:
{
  "contractType": "one of the types listed below",
  "suggestedPriority": "LOW | MEDIUM | HIGH | URGENT",
  "extractedTerms": {
    "counterparty": "company or person name if mentioned, else null",
    "estimatedValue": numeric value in USD if mentioned, else null,
    "governingLaw": "jurisdiction if mentioned (e.g. Delaware, California), else null",
    "duration": "contract duration if mentioned (e.g. 12 months), else null",
    "startDate": "start date if mentioned (ISO format), else null"
  },
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

Priority guidelines:
- URGENT: legal deadline < 48h, regulatory requirement, blocking a deal closure
- HIGH: executive involved, high value (> $500K), time-sensitive (< 1 week)
- MEDIUM: standard business request, no deadline pressure
- LOW: internal, low value, long lead time

Rules:
- confidence > 0.8 means title explicitly names the contract type
- confidence 0.5–0.8 means you inferred from description content
- Do NOT include any explanation outside the JSON object.

"""


class IntakeClassifyRequest(BaseModel):
    title:           str
    description:     str
    counterpartyName: Optional[str] = None
    orgId:           Optional[str] = None


class ExtractedTerms(BaseModel):
    counterparty:   Optional[str]   = None
    estimatedValue: Optional[float] = None
    governingLaw:   Optional[str]   = None
    duration:       Optional[str]   = None
    startDate:      Optional[str]   = None


class IntakeClassifyResponse(BaseModel):
    contractType:      str
    suggestedPriority: str
    extractedTerms:    ExtractedTerms
    confidence:        float
    reason:            str


@router.post("/intake-classify", response_model=IntakeClassifyResponse)
async def intake_classify(req: IntakeClassifyRequest) -> IntakeClassifyResponse:
    text = f"Title: {req.title}\n"
    if req.counterpartyName:
        text += f"Counterparty: {req.counterpartyName}\n"
    text += f"Description: {req.description}"
    text = text[:MAX_CHARS]

    logger.info("[intake-classify] chars=%d title=%r", len(text), req.title[:60])

    try:
        raw    = await _call_llm(text, req.orgId)
        parsed = loads_lenient(raw)

        ctype = parsed.get("contractType", "OTHER")
        if ctype not in VALID_TYPES:
            ctype = "OTHER"

        priority = parsed.get("suggestedPriority", "MEDIUM")
        if priority not in VALID_PRIORITIES:
            priority = "MEDIUM"

        terms_raw = parsed.get("extractedTerms")
        if not isinstance(terms_raw, dict):  # LLM drift: list/str instead of object
            terms_raw = {}
        terms = ExtractedTerms(
            counterparty=terms_raw.get("counterparty"),
            estimatedValue=terms_raw.get("estimatedValue"),
            governingLaw=terms_raw.get("governingLaw"),
            duration=terms_raw.get("duration"),
            startDate=terms_raw.get("startDate"),
        )

        result = IntakeClassifyResponse(
            contractType=ctype,
            suggestedPriority=priority,
            extractedTerms=terms,
            confidence=float(parsed.get("confidence", 0.5)),
            reason=str(parsed.get("reason", "")),
        )
        logger.info("[intake-classify] type=%s priority=%s confidence=%.2f",
                    result.contractType, result.suggestedPriority, result.confidence)
        return result

    except Exception as exc:
        logger.error("[intake-classify] LLM call or parse failed: %s", exc)
        return IntakeClassifyResponse(
            contractType="OTHER",
            suggestedPriority="MEDIUM",
            extractedTerms=ExtractedTerms(),
            confidence=0.0,
            reason="classification failed",
        )


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
        trace_name="intake.classify",
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
