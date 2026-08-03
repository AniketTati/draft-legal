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

from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel

from app.providers import build_llm
from app.config import active_provider, smart_model, settings
from app.router import resolve_llm
from langchain_core.messages import HumanMessage, SystemMessage

logger = logging.getLogger("obligations")
router = APIRouter()
INTERNAL_SECRET = settings.internal_service_secret


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

    # P7.5.3 — go through resolve_llm so Langfuse callbacks attach.
    # Falls back to build_llm if router/keys aren't configured for tracing.
    try:
        resolved = await resolve_llm(
            "default",
            org_id=req.orgId,
            streaming=False,
            trace_name="obligations.extract",
        )
        llm = resolved.llm
        callbacks = resolved.callbacks
        provider = getattr(resolved, "provider", active_provider())
        model = getattr(resolved, "model", smart_model())
    except Exception:
        provider = active_provider()
        model = smart_model()
        llm = build_llm(provider, model, streaming=False)
        callbacks = []

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
        content = content.strip()
        if content.startswith("```"):
            content = content.split("```", 2)[1]
            if content.startswith("json"):
                content = content[4:]
        parsed = loads_lenient(content)
        obligations = parsed.get("obligations") or []
        # Lightweight normalisation — coerce each entry to the expected
        # keys + types so downstream code never has to defensive-check.
        cleaned = []
        for o in obligations[:25]:
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
                "quote":       str(o.get("quote") or "")[:240],
                "severity":    str(o.get("severity") or "medium"),
                "sectionRef":  (o.get("sectionRef") or None),
            })
        return {
            "obligations":   cleaned,
            "summary":       parsed.get("summary") or "",
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
