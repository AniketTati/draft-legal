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
    )

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
