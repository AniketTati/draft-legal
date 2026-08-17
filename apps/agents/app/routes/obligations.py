"""
Obligations extractor (P5.1 / docs/30 Wave H.1)

POST /extract_obligations — given a contract's plainText, returns a
structured list of obligations covering:
  • payment     — "Pay $50k monthly on the 15th"
  • sla         — "99.9% uptime / 1-hour response on P1 incidents"
  • renewal     — "Auto-renew unless 60 days notice"
  • audit       — "Customer may audit once/year on 30 days notice"
  • report      — "Monthly usage report within 10 days of month-end"
  • termination — "Either party may terminate on 30 days notice"

Single LLM call. Returns strict JSON the Node side persists onto
Contract.metadata.obligations so the reminder cron (P5.2) + the
renewal advisor (P5.3) can walk a structured list.
"""
from __future__ import annotations

import json
from ..jsonish import loads_lenient
import logging
import os

from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel

from app.router import resolve_llm
from langchain_core.messages import HumanMessage, SystemMessage

logger = logging.getLogger("obligations")
router = APIRouter()
INTERNAL_SECRET = os.getenv("INTERNAL_SERVICE_SECRET", "")

# Caps applied to whatever the model returns. They are constants rather than
# literals inline so the golden tests can assert the boundary rather than a
# magic number, and so a change to either is a visible diff.
MAX_OBLIGATIONS = 25
MAX_QUOTE_CHARS = 240


def parse_obligations_response(content: str) -> dict:
    """Model text → the structured payload the Node side persists. PURE.

    This is the whole deterministic half of extraction: fence stripping,
    lenient JSON parsing, key coercion, and the caps. It is separated from the
    route so it can be pinned with golden fixtures — the LLM half varies run to
    run and cannot be regression-tested, but everything downstream of it must
    not, and a silent change here corrupts every obligation in the product.

    Raises whatever loads_lenient raises when nothing parses; the caller's
    try/except owns that path, exactly as before this was extracted.
    """
    text = (content or "").strip()
    # KNOWN DEFECT, kept only because it is what has been running in production.
    #
    # loads_lenient already strips fences, prose preambles and unterminated
    # fences, so this block earns nothing — proven by disabling it and watching
    # every golden test stay green. Worse, it is actively harmful on one input:
    # a ``` inside a quoted string makes split("```", 2)[1] cut mid-value, and
    # the whole extraction then returns zero obligations for a contract that
    # has some. That failure is silent — the route's except turns it into
    # {"obligations": []}, which reads as "this contract has none".
    #
    # Deleting these four lines is the fix. tests/test_obligations_parse.py
    # carries an xfail(strict=True) that flips to pass the moment it happens.
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.startswith("json"):
            text = text[4:]

    parsed = loads_lenient(text)
    obligations = parsed.get("obligations") or []

    cleaned: list[dict] = []
    for o in obligations[:MAX_OBLIGATIONS]:
        if not isinstance(o, dict):
            continue
        cleaned.append({
            "id":          str(o.get("id") or f"o_{len(cleaned)}"),
            "type":        str(o.get("type") or "other"),
            "description": str(o.get("description") or "").strip(),
            "owner":       str(o.get("owner") or "unknown"),
            "dueDate":     (o.get("dueDate") or None),
            "recurrence":  str(o.get("recurrence") or "unknown"),
            "trigger":     (o.get("trigger") or None),
            "quote":       str(o.get("quote") or "")[:MAX_QUOTE_CHARS],
            "severity":    str(o.get("severity") or "medium"),
            "sectionRef":  (o.get("sectionRef") or None),
        })

    return {"obligations": cleaned, "summary": parsed.get("summary") or ""}


class ExtractObligationsRequest(BaseModel):
    plainText:      str
    contractType:   str = "general commercial"
    effectiveDate:  str | None = None  # ISO date, anchors relative due dates
    orgId:          str | None = None  # Wave 3.5 — enables per-org BYOK key


_SYSTEM = """You are a contract operations specialist. Extract every \
actionable obligation from the contract text into a strict JSON \
structure. Do NOT invent obligations the contract doesn't state; \
obligations MUST be evidenced by a verbatim quote from the text.

Return ONLY this JSON shape:

{
  "obligations": [
    {
      "id":          "<short slug, unique within this doc>",
      "type":        "payment|sla|renewal|audit|report|termination|compliance|other",
      "description": "<one sentence, plain English>",
      "owner":       "customer|provider|either|unknown",
      "dueDate":     "<ISO date YYYY-MM-DD, or null if relative>",
      "recurrence":  "one-time|monthly|quarterly|annually|on-event|unknown",
      "trigger":     "<event that starts the clock, or null>",
      "quote":       "<verbatim excerpt ≤180 chars that grounds this obligation>",
      "severity":    "low|medium|high",
      "sectionRef":  "<section ref like '9.2' or null>"
    }
  ],
  "summary": "<1-sentence overview like '7 obligations extracted covering payment, renewal, SLA, and audit rights'>"
}

Rules:
 • If the contract says "due within 30 days of execution" and you know \
the effective date, compute dueDate; otherwise set dueDate=null + \
recurrence/trigger.
 • Don't duplicate — one entry per unique obligation, even if the \
text repeats it.
 • Cap the list at 25 obligations; rank by severity + actionability.
 • If the text contains no actionable obligations (e.g. fully \
terminated contract), return obligations: [] + a summary saying so."""


@router.post("/extract_obligations")
async def extract_obligations(
    req: ExtractObligationsRequest,
    x_internal_secret: str = Header(default=""),
):
    if INTERNAL_SECRET and x_internal_secret != INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")
    text = (req.plainText or "").strip()
    if not text:
        return {"obligations": [], "summary": "Empty contract text — nothing to extract."}

    # Resolve through the router so the org's own key (BYOK), its tier
    # override, and Langfuse callbacks all apply. There is deliberately no
    # build_llm fallback: resolve_llm already falls back to platform env
    # internally, so a fallback here could only fire when NO provider has a key
    # at all — at which point build_llm has nothing to build with either, and
    # its only real effect was to keep a platform-key path alive in the source.
    resolved = await resolve_llm(
        "default",
        org_id=req.orgId,
        streaming=False,
        trace_name="obligations.extract",
    )
    llm = resolved.llm
    callbacks = resolved.callbacks
    provider = resolved.provider
    model = resolved.model

    anchor = f"\nEffective date: {req.effectiveDate}" if req.effectiveDate else ""
    user = f"""Contract type: {req.contractType}{anchor}

Contract text (truncated if very long):
\"\"\"
{text[:16000]}
\"\"\"

Extract the obligations now. JSON only."""

    try:
        response = await llm.ainvoke(
            [
                SystemMessage(content=_SYSTEM),
                HumanMessage(content=user),
            ],
            config={"callbacks": callbacks} if callbacks else None,
        )
        content = response.content if isinstance(response.content, str) else str(response.content)
        # Everything deterministic lives in parse_obligations_response, which is
        # golden-tested. This route is now only the LLM call plus attribution.
        return {
            **parse_obligations_response(content),
            "model":         model,
            "provider":      provider,
        }
    except (json.JSONDecodeError, Exception) as e:  # noqa: BLE001
        logger.exception("[extract_obligations] LLM call / parse failed")
        return {
            "obligations": [],
            "summary":     "",
            "error":       f"extract_failed: {type(e).__name__}: {str(e)[:180]}",
        }
