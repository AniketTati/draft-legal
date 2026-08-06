"""
Renewal advisor (P5.3 / docs/30 Wave H.3)

POST /renewal_advice — given a contract's plainText + expiryDate +
optional context (past deals, SLA performance, price-vs-market),
returns a structured recommendation:

  {
    "recommendation": "renew | renegotiate | let_expire | pause",
    "confidence":     "high | medium | low",
    "rationale":      "<1-3 sentence plain-English >",
    "negotiationPoints": [
      { "topic": "<e.g. price, liability cap, SLA>",
        "ourPosition": "<what to push for>",
        "reasoning":   "<why>",
        "severity":    "low | medium | high" }
    ],
    "riskFlags":      ["<auto-renew without price cap>", ...],
    "timeline":       "<recommended next-step sequence>"
  }

Single LLM call. Output is persisted by Node onto
Contract.metadata.renewalAdvice so the rail section + the
renewal_advice agent tool can both read it without re-paying
for the LLM.

JTBD — when you see "Expires in 67 days" land in your inbox,
you want to open the contract and see "Renew — SLAs hit, price
is 8% under market, renegotiate to add liability-cap floor"
instead of having to read 30 pages yourself.
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

logger = logging.getLogger("renewals")
router = APIRouter()
INTERNAL_SECRET = os.getenv("INTERNAL_SERVICE_SECRET", "")


class RenewalAdviceRequest(BaseModel):
    plainText:       str
    contractType:    str = "general commercial"
    counterparty:    str | None = None
    expiryDate:      str | None = None     # ISO YYYY-MM-DD
    valueSummary:    str | None = None     # e.g. "USD 100,000/month"
    pastPerformance: str | None = None     # optional: SLA adherence, issue count
    obligations:     list[dict] | None = None  # passed from Contract.metadata
    orgId:           str | None = None     # Wave 3.5 — enables per-org BYOK key


_SYSTEM = """You are a seasoned contracts counsel. A renewal window \
on a commercial agreement has opened. Your job: give a decisive, \
evidence-based recommendation in strict JSON.

Return ONLY this shape:

{
  "recommendation": "renew|renegotiate|let_expire|pause",
  "confidence":     "high|medium|low",
  "rationale":      "<2 sentences max, plain English>",
  "negotiationPoints": [
    {
      "topic":       "<short label, e.g. 'price', 'liability cap'>",
      "ourPosition": "<what we should push for in renewal>",
      "reasoning":   "<1 sentence>",
      "severity":    "low|medium|high"
    }
  ],
  "riskFlags":      ["<e.g. 'auto-renew without price-cap clause'>"],
  "timeline":       "<1-2 sentences: the sequence you'd run>"
}

Rules:
 • Base every point on the contract text + any obligations/performance \
context supplied. Never invent clauses.
 • Cap negotiationPoints at 5, riskFlags at 5.
 • Prefer `renegotiate` when there is upside; `renew` is the null \
hypothesis when the deal is healthy and terms are fair; `let_expire` \
when the counterparty is unreliable or terms are unrecoverable; \
`pause` when you need more data from the business.
 • `confidence=high` requires both contract text AND some perf/obligation \
context. If you only have text, cap at `medium`."""


@router.post("/renewal_advice")
async def renewal_advice(
    req: RenewalAdviceRequest,
    x_internal_secret: str = Header(default=""),
):
    if INTERNAL_SECRET and x_internal_secret != INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")
    text = (req.plainText or "").strip()
    if not text:
        return {
            "recommendation":    "pause",
            "confidence":        "low",
            "rationale":         "Empty contract text — nothing to analyse.",
            "negotiationPoints": [],
            "riskFlags":         ["no_text_available"],
            "timeline":          "",
        }

    # Resolve through the router so the org's own key (BYOK), its tier
    # override, and Langfuse callbacks all apply. No build_llm fallback — see
    # the note in obligations.py: resolve_llm already falls back to platform
    # env internally, so the outer fallback could never do anything useful.
    #
    # provider/model MUST be bound here, not only in a failure branch: they are
    # read unconditionally by the success return below. They previously lived
    # in an except: block, so every SUCCESSFUL resolve raised UnboundLocalError
    # at the return, which the broad except swallowed into the degraded
    # "pause / low confidence" payload — this endpoint only produced real
    # advice when the router failed.
    resolved = await resolve_llm("default", org_id=req.orgId, streaming=False, trace_name="renewal.advice")
    llm = resolved.llm
    callbacks = resolved.callbacks
    provider = resolved.provider
    model = resolved.model

    ob_blob = ""
    if req.obligations:
        lines = []
        for o in req.obligations[:10]:
            t = o.get("type") or "?"
            d = o.get("description") or ""
            due = o.get("dueDate") or "rel"
            sev = o.get("severity") or "?"
            lines.append(f"  • {t}/{sev} — {d[:120]} (due={due})")
        ob_blob = "Tracked obligations:\n" + "\n".join(lines)

    meta_lines = []
    if req.counterparty:    meta_lines.append(f"Counterparty: {req.counterparty}")
    if req.expiryDate:      meta_lines.append(f"Expires: {req.expiryDate}")
    if req.valueSummary:    meta_lines.append(f"Value: {req.valueSummary}")
    if req.pastPerformance: meta_lines.append(f"Performance history: {req.pastPerformance}")
    meta_blob = "\n".join(meta_lines)

    user = f"""Contract type: {req.contractType}
{meta_blob}

{ob_blob}

Contract text (truncated if very long):
\"\"\"
{text[:14000]}
\"\"\"

Produce the renewal recommendation now. JSON only."""

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

        # Coerce the structure so downstream never has to defensive-check.
        rec = str(parsed.get("recommendation") or "pause")
        if rec not in ("renew", "renegotiate", "let_expire", "pause"):
            rec = "pause"
        conf = str(parsed.get("confidence") or "low")
        if conf not in ("high", "medium", "low"):
            conf = "low"

        points_raw = parsed.get("negotiationPoints") or []
        points: list[dict] = []
        for p in points_raw[:5]:
            if not isinstance(p, dict):
                continue
            points.append({
                "topic":       str(p.get("topic") or "")[:60],
                "ourPosition": str(p.get("ourPosition") or "")[:240],
                "reasoning":   str(p.get("reasoning") or "")[:240],
                "severity":    (str(p.get("severity") or "medium").lower()
                                if str(p.get("severity") or "").lower() in ("low", "medium", "high")
                                else "medium"),
            })

        flags_raw = parsed.get("riskFlags") or []
        flags: list[str] = []
        for f in flags_raw[:5]:
            s = str(f)[:200]
            if s:
                flags.append(s)

        return {
            "recommendation":    rec,
            "confidence":        conf,
            "rationale":         str(parsed.get("rationale") or "")[:800],
            "negotiationPoints": points,
            "riskFlags":         flags,
            "timeline":          str(parsed.get("timeline") or "")[:400],
            "model":             model,
            "provider":          provider,
        }
    except (json.JSONDecodeError, Exception) as e:  # noqa: BLE001
        logger.exception("[renewal_advice] LLM call / parse failed")
        return {
            "recommendation":    "pause",
            "confidence":        "low",
            "rationale":         "LLM output could not be parsed.",
            "negotiationPoints": [],
            "riskFlags":         [],
            "timeline":          "",
            "error":             f"advice_failed: {type(e).__name__}: {str(e)[:180]}",
        }
