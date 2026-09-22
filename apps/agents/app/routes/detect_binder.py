"""
POST /detect-binder — called by agent.worker.ts after parse-document completes.
Determines if a PDF contains multiple distinct agreements (a "binder").

Uses a fast model. X16 — a long binder is sampled: its beginning plus excerpts
around likely agreement boundaries, each marked with its character offset, so
an agreement that starts deep in the file is still seen.
Returns: { isBinder, confidence, documents: [{title, docType, charStart, pageHint}] }
"""
from __future__ import annotations

import json
import logging
import re
from typing import List, Optional
from fastapi import APIRouter
from pydantic import BaseModel

from ..jsonish import loads_lenient
from ..router import resolve_llm

router = APIRouter()
logger = logging.getLogger(__name__)

MAX_CHARS = 10_000          # texts up to this length are sent whole
HEAD_CHARS = 6_000          # otherwise: the beginning…
EXCERPT_CHARS = 1_200       # …plus excerpts of this size…
MAX_EXCERPTS = 8            # …at most this many

# Where a new agreement likely begins: an ALL-CAPS title ending in an agreement
# word, or the signature block that closes the previous one. plainText from the
# PDF extractor has no line breaks, so match phrases, not lines.
_BOUNDARY = re.compile(
    r"\b(?:[A-Z][A-Z&,'\-]+ ){0,6}(?:AGREEMENT|ADDENDUM|AMENDMENT|ORDER FORM|STATEMENT OF WORK|"
    r"EXHIBIT|SCHEDULE|LICENSE|MEMORANDUM OF UNDERSTANDING)\b|IN WITNESS WHEREOF"
)


def _sample(text: str) -> str:
    """The text the classifier sees. Short texts go whole. Long ones: the head,
    then excerpts at likely agreement boundaries (topped up with evenly spaced
    ones), each prefixed with its absolute offset so charStart stays true to
    the full document."""
    n = len(text)
    if n <= MAX_CHARS:
        return text
    starts: list[int] = []
    for m in _BOUNDARY.finditer(text, HEAD_CHARS):
        start = max(HEAD_CHARS, m.start() - 200)
        if not starts or start - starts[-1] >= EXCERPT_CHARS:
            starts.append(start)
    if len(starts) > MAX_EXCERPTS:   # spread the picks across the document
        step = len(starts) / MAX_EXCERPTS
        starts = [starts[int(i * step)] for i in range(MAX_EXCERPTS)]
    span = n - HEAD_CHARS
    for i in range(1, MAX_EXCERPTS + 1):   # top up with evenly spaced windows
        if len(starts) >= MAX_EXCERPTS:
            break
        pos = HEAD_CHARS + (span * i) // (MAX_EXCERPTS + 1)
        if all(abs(pos - s) >= EXCERPT_CHARS for s in starts):
            starts.append(pos)
    parts = [text[:HEAD_CHARS]]
    for start in sorted(starts):
        pct = round(100 * start / n)
        parts.append(
            f"\n\n[[EXCERPT starting at character {start} of {n} (about {pct}% through the document)]]\n"
            + text[start:start + EXCERPT_CHARS]
        )
    return "".join(parts)

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

- Long documents arrive as their beginning followed by excerpts. Each excerpt starts
  with a marker "[[EXCERPT starting at character N of M ...]]". An agreement's charStart
  must be its offset in the FULL document: for text inside an excerpt, count from that
  excerpt's N. Use the marker's percentage to estimate pageHint.

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
    text_sample = _sample(req.plainText)
    logger.info("[detect-binder] chars=%d chars_sampled=%d", len(req.plainText), len(text_sample))

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
