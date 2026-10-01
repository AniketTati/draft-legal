"""
Playbook Review Agent

Scores the clauses of a SINGLE contract against the org's playbook positions.

This is the counterpart to the Redline Agent. Redline diffs two versions, so it
can only run once a counterparty has returned a turn — a contract we just
received from a vendor has exactly one version, which meant it could never be
reviewed against the playbook at all. The automatic pipeline produced only
generic per-clause risk ratings and never consulted the playbook. This closes
that gap.

Input is the clause segments the extraction pipeline already produced, so this
costs one scoring call rather than re-reading the whole document.

Output is persisted by the caller into contract.metadata._playbookReview.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from ..jsonish import loads_lenient
from ..router import resolve_llm
from ..untrusted import sanitize_untrusted, wrap_untrusted_document
from ..pii_tokens import PII_TOKEN_RULE

logger = logging.getLogger(__name__)


_REVIEW_PROMPT = """You are a contract negotiation specialist reviewing a contract we RECEIVED from a counterparty. Score each clause below against our playbook positions.

Our playbook positions (our preferred, acceptable, fallback and walkaway language per clause type):
{playbook_json}

Contract type: {contract_type}

For each clause you report, return:
- clauseId: echo the clause's id EXACTLY as given (used to link the finding back to the clause)
- clauseType: echo the clause's type
- playbookAlignment: "preferred" | "acceptable" | "fallback" | "walkaway" | "outside_playbook" | "not_covered"
  Use "not_covered" when the playbook has no position for this clause type. Do not guess a position that isn't there.
- severity: "low" | "medium" | "high" | "critical"
- recommendation: "accept" | "negotiate" | "reject"
- reasoning: ONE sentence, quoting the specific wording that drove the decision
- requiresHumanReview: true when playbookAlignment is "walkaway" or "outside_playbook", or severity is "critical"

FIGURES — a clause may come with "facts": its liability caps, measured from its own words (months of fees, times a year's fees). Use those figures as given when you compare a cap with the playbook. Do not work out a cap's size yourself, and do not speculate about payment schedules. A cap for some claims only (a super-cap) is its own term: compare it with what the playbook says about super-caps.

IMPORTANT — only report clauses that DEVIATE from the playbook or are not covered by it. Omit any clause that already matches a preferred position, so the reviewer gets a short actionable list instead of the entire contract restated.

Return ONLY a valid JSON array — no markdown, no prose:

Clauses:
{clauses_json}"""


def _parse_json(text: str) -> Any:
    """Extract and parse the first JSON array/object from LLM output."""
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        return loads_lenient(text)
    except json.JSONDecodeError:
        for start_char, end_char in [("[", "]"), ("{", "}")]:
            start = text.find(start_char)
            end = text.rfind(end_char)
            if start != -1 and end != -1:
                try:
                    return json.loads(text[start:end + 1])
                except json.JSONDecodeError:
                    pass
        return None


# Clause bodies can be long; cap what we send so a 200-page contract doesn't
# blow the context window. The clause list is already the distilled form.
_MAX_CLAUSE_CHARS = 4_000
_MAX_CLAUSES = 60


async def run_playbook_review(
    clauses: list[dict],
    playbook_positions: list[dict],
    contract_type: str,
    org_id: str | None = None,
) -> dict:
    """
    Returns:
      {
        findings: [...],            # deviations only
        summary: str,
        requiresHumanGate: bool,
        clausesReviewed: int,
        playbookPositions: int,
      }
    """
    if not clauses:
        return {
            "findings": [], "summary": "No clauses were extracted for this contract.",
            "requiresHumanGate": False, "clausesReviewed": 0,
            "playbookPositions": len(playbook_positions),
        }

    if not playbook_positions:
        # Be explicit rather than returning an empty result that looks like a
        # clean bill of health — "nothing to compare against" is not "no risk".
        return {
            "findings": [], "summary": "No playbook positions are configured for this org, so the contract could not be scored against one.",
            "requiresHumanGate": False, "clausesReviewed": len(clauses),
            "playbookPositions": 0,
        }

    # Clause bodies are verbatim counterparty text. Truncate FIRST (so framing is
    # never what gets cut), then sanitize each body while it still has real line
    # breaks — json.dumps escapes newlines to "\n", which would hide a forged
    # leading "[chip]:" marker from the line-anchored sanitizer.
    trimmed = [
        {
            "id": c.get("id"),
            "clauseType": c.get("clauseType"),
            "sectionRef": c.get("sectionRef"),
            "content": sanitize_untrusted((c.get("content") or "")[:_MAX_CLAUSE_CHARS]),
            **({"facts": [sanitize_untrusted(f) for f in c["facts"]]} if c.get("facts") else {}),
        }
        for c in clauses[:_MAX_CLAUSES]
    ]

    resolved = await resolve_llm(
        "reasoning",
        org_id=org_id,
        streaming=True,
        trace_name="playbook_review.score_clauses",
    )
    prompt = _REVIEW_PROMPT.format(
        # Our playbook positions are authored by the customer's own legal team,
        # not the counterparty — they are trusted instructions-adjacent content
        # and are deliberately NOT framed as untrusted.
        playbook_json=json.dumps(playbook_positions, indent=2)[:60_000],
        contract_type=contract_type or "general commercial",
        # The clause payload is counterparty text. Framed once for the whole
        # block (~120 tokens) rather than per clause.
        clauses_json=wrap_untrusted_document(
            json.dumps(trimmed, indent=2),
            source="counterparty contract clause text",
        ),
    ) + PII_TOKEN_RULE

    response = await resolved.llm.ainvoke([
        SystemMessage(content="You are a contract negotiation specialist. Return only valid JSON."),
        HumanMessage(content=prompt),
    ], config={"callbacks": resolved.callbacks})
    findings = _parse_json(response.content)
    if not isinstance(findings, list):
        logger.warning("[playbook-review] model did not return a JSON array — treating as no findings")
        findings = []

    # Drop anything that doesn't reference a real clause: the id is what links a
    # finding back to the document, so a hallucinated one is worse than useless.
    valid_ids = {c["id"] for c in trimmed if c.get("id")}
    findings = [f for f in findings if isinstance(f, dict) and f.get("clauseId") in valid_ids]

    requires_gate = any(
        f.get("playbookAlignment") in ("walkaway", "outside_playbook")
        or f.get("severity") == "critical"
        for f in findings
    )

    by_severity: dict[str, int] = {}
    for f in findings:
        sev = f.get("severity", "low")
        by_severity[sev] = by_severity.get(sev, 0) + 1

    if not findings:
        summary = f"Reviewed {len(trimmed)} clause(s) against {len(playbook_positions)} playbook position(s); none deviate."
    else:
        parts = [f"{n} {sev}" for sev, n in sorted(by_severity.items())]
        summary = (
            f"{len(findings)} of {len(trimmed)} clause(s) deviate from the playbook "
            f"({', '.join(parts)})."
        )

    logger.info(
        "[playbook-review] scored %d clauses → %d findings, gate=%s",
        len(trimmed), len(findings), requires_gate,
    )

    return {
        "findings": findings,
        "summary": summary,
        "requiresHumanGate": requires_gate,
        "clausesReviewed": len(trimmed),
        "playbookPositions": len(playbook_positions),
    }


# ─── docs/41 P1 — the position check ──────────────────────────────────────────
#
# The API now sends only the clauses that changed since the version a person
# relied on, or that no template fingerprint matches: text left as our
# template wrote it is Standard and is not sent. For each clause it gets one
# verdict, with the words that decided it. The verdict is never the
# recommendation: the API's policy over all the findings decides that.

VERDICTS = ("meets_preferred", "meets_fallback", "needs_approval", "not_met", "not_covered")

_POSITION_PROMPT = """You are checking clauses of a contract against our playbook positions. Judge EVERY clause below, one by one.

Our positions. Each has an id, the kind of clause it is for, its rung (preferred, acceptable, fallback, walkaway) and its language:
{positions_json}

Contract type: {contract_type}

For each clause return one object:
- clauseId: the clause's id, exactly as given
- positionId: the id of the position whose language this clause is closest to, or null when none of our positions is for this kind of clause
- verdict, one of:
  "meets_preferred" — it gives us what our preferred or acceptable position asks for
  "meets_fallback" — it only reaches our fallback position
  "needs_approval" — it is worse than our fallback position but does not reach our walkaway position
  "not_met" — it reaches or goes beyond our walkaway position, or contradicts what our positions ask for
  "not_covered" — none of our positions is for this kind of clause (positionId is then null)
- quote: the exact words of the clause, copied character for character (at most 40 words), that decided the verdict
- explanation: one plain sentence for a lawyer: what the clause says, and what our position asks for

FIGURES — a clause may come with "facts": its liability caps, measured from its own words. Use those figures as given; do not work out a cap's size yourself.

Do not judge whether the clause is common or usual in the market: judge it only against OUR positions above.

Return ONLY a valid JSON array, one object per clause — no markdown, no prose.

Clauses:
{clauses_json}"""


async def run_position_check(
    clauses: list[dict],
    playbook_positions: list[dict],
    contract_type: str,
    org_id: str | None = None,
) -> dict:
    """
    Returns:
      {
        verdicts: [{clauseId, positionId, verdict, quote, explanation}],  # one per clause judged
        clausesChecked: int,
        playbookPositions: int,
      }
    A verdict whose clause, position or kind isn't one we sent is dropped:
    the API would otherwise show a judgement about text that isn't there.
    """
    if not clauses or not playbook_positions:
        return {"verdicts": [], "clausesChecked": 0, "playbookPositions": len(playbook_positions)}

    trimmed = [
        {
            "id": c.get("id"),
            "clauseType": c.get("clauseType"),
            "sectionRef": c.get("sectionRef"),
            "content": sanitize_untrusted((c.get("content") or "")[:_MAX_CLAUSE_CHARS]),
            **({"facts": [sanitize_untrusted(f) for f in c["facts"]]} if c.get("facts") else {}),
        }
        for c in clauses[:_MAX_CLAUSES]
    ]
    resolved = await resolve_llm(
        "reasoning",
        org_id=org_id,
        streaming=True,
        trace_name="playbook_review.position_check",
    )
    prompt = _POSITION_PROMPT.format(
        # The org's own positions: trusted, not framed as untrusted.
        positions_json=json.dumps(playbook_positions, indent=2)[:60_000],
        contract_type=contract_type or "unknown",
        clauses_json=wrap_untrusted_document(
            json.dumps(trimmed, indent=2),
            source="contract clause text",
        ),
    ) + PII_TOKEN_RULE

    response = await resolved.llm.ainvoke([
        SystemMessage(content="You check contract clauses against a company's own playbook. Return only valid JSON."),
        HumanMessage(content=prompt),
    ], config={"callbacks": resolved.callbacks})
    raw = _parse_json(response.content)
    if not isinstance(raw, list):
        logger.warning("[position-check] model did not return a JSON array — no verdicts")
        raw = []

    clause_ids = {c["id"] for c in trimmed if c.get("id")}
    position_ids = {p.get("id") for p in playbook_positions if p.get("id")}
    seen: set[str] = set()
    verdicts = []
    for v in raw:
        if not isinstance(v, dict):
            continue
        cid = v.get("clauseId")
        verdict = v.get("verdict")
        if cid not in clause_ids or cid in seen or verdict not in VERDICTS:
            continue
        pid = v.get("positionId")
        if pid is not None and pid not in position_ids:
            pid = None
        if verdict != "not_covered" and pid is None:
            # A judgement against no position of ours is not a judgement against the playbook.
            verdict = "not_covered"
        seen.add(cid)
        verdicts.append({
            "clauseId": cid,
            "positionId": pid,
            "verdict": verdict,
            "quote": str(v.get("quote") or "")[:600],
            "explanation": str(v.get("explanation") or "")[:600],
        })

    logger.info("[position-check] %d clauses → %d verdicts", len(trimmed), len(verdicts))
    return {"verdicts": verdicts, "clausesChecked": len(trimmed), "playbookPositions": len(playbook_positions)}
