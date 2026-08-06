"""
POST /detect-binder — called by agent.worker.ts after parse-document completes.
Determines if a PDF contains multiple distinct agreements (a "binder").

Uses Haiku for speed/cost — only needs first 10K chars to identify agreement headers.
Returns: { isBinder, confidence, documents: [{title, docType, charStart, pageHint}] }
"""
from __future__ import annotations

import json
import logging
from typing import List, Optional
from fastapi import APIRouter
from pydantic import BaseModel

from ..jsonish import loads_lenient
from ..router import resolve_llm

router = APIRouter()
logger = logging.getLogger(__name__)

MAX_CHARS = 10_000

_PROMPT = """\
You are a legal document classifier. Analyze the following text (beginning of a document) and determine whether it is:
  (A) A SINGLE legal agreement, or
  (B) A BINDER — a single PDF file containing MULTIPLE distinct legal agreements

Common binder types: closing packs (NDA + MSA + SOW + DPA), M&A diligence binders, template bundles.

Evidence of a binder: multiple "IN WITNESS WHEREOF" / signature blocks, multiple agreement title headers (e.g. "NON-DISCLOSURE AGREEMENT" followed later by "MASTER SERVICES AGREEMENT"), section numbering that resets to 1.

Return ONLY valid JSON in this exact structure:
{
  "isBinder": true | false,
  "confidence": 0.0 to 1.0,
  "documents": [
    {
      "title": "detected title of this agreement",
      "docType": "NDA | MSA | SOW | SLA | DPA | EMPLOYMENT | ORDER_FORM | LICENSE | PARTNERSHIP | OTHER",
      "charStart": approximate character offset where this agreement begins (integer),
      "pageHint": "~page N"
    }
  ]
}

Rules:
- If isBinder is false, documents should contain exactly ONE entry describing the single agreement.
- If isBinder is true, documents should list each detected agreement in order.
- confidence should reflect how certain you are. Use > 0.7 only when you have strong evidence.
- charStart for the first document should be 0 (or close to it).
- Do NOT include any explanation outside the JSON object.

Document text:
"""


class DetectBinderRequest(BaseModel):
    plainText: str
    orgId:     Optional[str] = None


class DetectedDocument(BaseModel):
    title:     str
    docType:   str
    charStart: int
    pageHint:  str


class DetectBinderResponse(BaseModel):
    isBinder:   bool
    confidence: float
    documents:  List[DetectedDocument]


@router.post("/detect-binder", response_model=DetectBinderResponse)
async def detect_binder(req: DetectBinderRequest) -> DetectBinderResponse:
    text_sample = req.plainText[:MAX_CHARS]
    logger.info("[detect-binder] chars_sampled=%d", len(text_sample))

    try:
        raw = await _call_llm(text_sample, req.orgId)
        parsed = loads_lenient(raw)
        docs_raw = parsed.get("documents")
        if not isinstance(docs_raw, list):  # LLM drift: object/str instead of array
            docs_raw = []
        documents = [DetectedDocument(**d) for d in docs_raw if isinstance(d, dict)]
        result = DetectBinderResponse(
            isBinder=bool(parsed.get("isBinder", False)),
            confidence=float(parsed.get("confidence", 0.0)),
            documents=documents,
        )
        logger.info("[detect-binder] isBinder=%s confidence=%.2f docs=%d",
                    result.isBinder, result.confidence, len(result.documents))
        return result
    except Exception as exc:
        logger.error("[detect-binder] LLM call or parse failed: %s", exc)
        # Fallback: single doc, not a binder
        return DetectBinderResponse(isBinder=False, confidence=0.0, documents=[])


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
        trace_name="detect_binder.detect",
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
