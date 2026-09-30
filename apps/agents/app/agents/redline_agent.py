"""
Redline Agent — Phase 5.2
3-step LangGraph pipeline for AI-powered counterparty redline analysis:
  Step 1 — Extract Changes (fast model): parse ins/del HTML → ChangeItem[]
  Step 2 — Score vs Playbook (smart model): recommendation + playbook alignment + severity,
           and risk-factor ratings for our wording and theirs
  Step 3 — Counter-Proposals (smart model): counter text for changes we counter or reject;
           risk before → proposed → with our counter is computed from the ratings

Output stored in contract.metadata._redlineAnalysis.
"""
from __future__ import annotations

import json
from ..jsonish import loads_lenient
import logging
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import StateGraph, END
from typing_extensions import TypedDict

from ..router import resolve_llm
from ..untrusted import wrap_untrusted_document
from ..pii_tokens import PII_TOKEN_RULE

logger = logging.getLogger(__name__)


# ─── State ────────────────────────────────────────────────────────────────────

class RedlineState(TypedDict):
    org_id:            str | None
    diff_html:         str
    contract_type:     str
    playbook_positions: list[dict]
    changes:           list[dict]   # ChangeItem[]
    scored_changes:    list[dict]   # ChangeItem + recommendation fields
    final_changes:     list[dict]   # scored + counter-proposals
    summary:           str
    recommended_action: str
    requires_human_gate: bool
    confidence:        float
    error:             str | None


# ─── Prompts ──────────────────────────────────────────────────────────────────

_EXTRACT_PROMPT = """You are a contract redline analyst. The HTML below contains a tracked-changes diff between two contract versions.
<ins> tags mark text the counterparty ADDED. <del> tags mark text that was REMOVED from the original.

Extract all meaningful changes as a JSON array. Ignore whitespace-only changes.
Group the edits by clause: return ONE entry per numbered section that changed (e.g. every edit inside
"3. Payment" is one entry), not one entry per inserted or deleted fragment. For each entry, ourText is the
whole section as it read BEFORE the edits and theirText is the whole section as it reads AFTER them.

Return ONLY valid JSON — no markdown, no explanation:
[
  {{
    "changeId": "<short unique slug, e.g. change_001>",
    "clauseType": "<payment|liability|liquidated_damages|security|indemnification|warranty|insurance|term|termination|confidentiality|ip|dispute_resolution|governing_law|notice|other>",
    "ourText": "<the original text that was removed (del content), or empty string if pure addition>",
    "theirText": "<the new text the counterparty proposed (ins content), or empty string if pure deletion>",
    "context": "<1–2 sentences of surrounding contract text for context>",
    "sectionRef": "<Section X or null>"
  }}
]

Diff HTML:
{diff_html}"""

_SCORE_PROMPT = """You are a contract negotiation specialist. Score each proposed change against the playbook positions below.

Playbook positions (our preferred, acceptable, fallback, and walkaway positions per clause type):
{playbook_json}

Contract type: {contract_type}

For each change, return:
- recommendation: "accept" | "counter" | "reject"
- playbookAlignment: "preferred" | "acceptable" | "fallback" | "walkaway" | "outside_playbook"
- severity: "low" | "medium" | "high" | "critical"
- reasoning: one sentence explaining the decision
- requiresHumanReview: true if walkaway or outside_playbook or critical severity
- likelihood: integer 1-3, how often the event this clause deals with actually happens in contracts of this
  type and industry (for example a contractor finishing late, a supplier defaulting, a dispute reaching
  arbitration): 1 unlikely, 2 possible, 3 likely. This is a property of the event, not of the wording, so rate
  it once per change.
- ourAssessment: our original text (ourText) rated on the three wording factors below
- theirAssessment: the counterparty's text (theirText) rated on the same three factors
- riskReason: one sentence on why the risk moved: the deviation from our position, what we could lose, how
  likely the event is, and how the proposal compares with market practice

Wording factors, each an integer, judged from OUR side:
- deviation 0-3, distance from our playbook position for this clause: 0 matches our preferred position,
  1 within our acceptable position, 2 only within our fallback position, 3 beyond our walkaway position or
  removing a protection the playbook requires. Where no playbook position covers the clause, compare with our
  original text instead: 0 unchanged or better for us, 1 minor, 2 material, 3 fundamental.
- exposure 0-4, what we could lose if the event happens under this wording, relative to this contract's value
  and the wider deal or project: 0 nothing, 1 low, 2 moderate, 3 high, 4 severe (uncapped, more than the
  contract value, or losing all security).
- market 0-3, how the wording compares with market practice for this industry and jurisdiction: 0 market
  standard, 1 slightly off-market, 2 clearly off-market, 3 one-sided or of doubtful enforceability.
Each assessment is an object: {{"deviation": n, "exposure": n, "market": n}}.

Return ONLY a valid JSON array with one object per input change, in the same order, holding its changeId
and the scoring fields above. Do not repeat the clause text.
{changes_json}"""

_COUNTER_PROMPT = """You are a contract drafting specialist. For each change below, write a counter-proposal: a compromise the counterparty could realistically accept, which moves the language to our playbook's "acceptable" position (or "fallback" if acceptable is unrealistic). Do not simply restore our original text.

Contract type: {contract_type}
Playbook positions: {playbook_json}

Changes to counter (recommendation "counter" or "reject"). Each carries ourAssessment and theirAssessment: our
original text and the counterparty's text rated on three wording factors (deviation 0-3 from our playbook
position, exposure 0-4, market 0-3; higher is worse for us):
{counter_changes_json}

For each change, add:
- counterText: the specific replacement language we propose
- counterNote: one sentence explaining the rationale
- counterAssessment: our counterText rated on the same three factors, as an object
  {{"deviation": n, "exposure": n, "market": n}}. Use the same scale as the ourAssessment and theirAssessment
  you were given: where the counter restores our original wording, give it ourAssessment's ratings; a
  compromise sits between ourAssessment and theirAssessment.

Return ONLY valid JSON array of the same changes with counterText, counterNote and counterAssessment added."""


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _parse_json(text: str) -> Any:
    """Extract and parse the first JSON array or object from LLM output."""
    text = text.strip()
    # Strip markdown code fences
    text = re.sub(r'^```(?:json)?\s*', '', text)
    text = re.sub(r'\s*```$', '', text)
    try:
        return loads_lenient(text)
    except json.JSONDecodeError:
        # Try extracting from first [ or {
        for start_char, end_char in [('[', ']'), ('{', '}')]:
            start = text.find(start_char)
            end = text.rfind(end_char)
            if start != -1 and end != -1:
                try:
                    return json.loads(text[start:end + 1])
                except json.JSONDecodeError:
                    pass
        return None


# ─── Steps ────────────────────────────────────────────────────────────────────

async def step_extract_changes(state: RedlineState) -> RedlineState:
    """Step 1: Parse ins/del HTML into structured ChangeItem list."""
    resolved = await resolve_llm(
        "default",
        org_id=state.get("org_id"),
        streaming=True,
        trace_name="redline.extract_changes",
    )
    # The diff is counterparty-authored. Truncate the RAW html FIRST, then wrap —
    # slicing after wrapping could sever the closing sentinel and leave the model
    # with an unterminated data block.
    prompt = _EXTRACT_PROMPT.format(
        diff_html=wrap_untrusted_document(
            state["diff_html"][:80_000],
            source="contract diff HTML (counterparty tracked changes)",
        )
    )

    try:
        response = await resolved.llm.ainvoke([
            SystemMessage(content="You extract structured changes from HTML diffs. Return only valid JSON." + PII_TOKEN_RULE),
            HumanMessage(content=prompt),
        ], config={"callbacks": resolved.callbacks})
        changes = _parse_json(response.content)
        if not isinstance(changes, list):
            changes = []
        logger.info("[redline] step1: extracted %d changes", len(changes))
        return {**state, "changes": changes}
    except Exception as e:
        logger.error("[redline] step1 error: %s", e)
        return {**state, "changes": [], "error": str(e)}


async def step_score_changes(state: RedlineState) -> RedlineState:
    """Step 2: Score each change against playbook positions."""
    if not state["changes"]:
        return {**state, "scored_changes": [], "requires_human_gate": False, "confidence": 1.0}

    resolved = await resolve_llm(
        "reasoning",
        org_id=state.get("org_id"),
        streaming=True,
        trace_name="redline.score_changes",
    )
    # playbook_json is OUR position library — trusted, left unwrapped.
    # changes_json carries verbatim counterparty language (ourText/theirText/
    # context) lifted straight out of the diff, so it stays untrusted on this
    # second pass. This is the call that sets requires_human_gate.
    playbook_json = json.dumps(state["playbook_positions"], indent=2)
    changes_json = wrap_untrusted_document(
        json.dumps(state["changes"], indent=2),
        source="changes extracted verbatim from the counterparty redline",
    )
    prompt = _SCORE_PROMPT.format(
        playbook_json=playbook_json,
        contract_type=state["contract_type"],
        changes_json=changes_json,
    )

    try:
        response = await resolved.llm.ainvoke([
            SystemMessage(content="You are a contract negotiation specialist. Return only valid JSON." + PII_TOKEN_RULE),
            HumanMessage(content=prompt),
        ], config={"callbacks": resolved.callbacks})
        scored = _merge_scores(state["changes"], _parse_json(response.content))

        requires_gate = any(
            c.get("playbookAlignment") in ("walkaway", "outside_playbook") or
            c.get("severity") == "critical"
            for c in scored
        )

        # Confidence: fraction of changes with acceptable alignment
        acceptable_count = sum(
            1 for c in scored
            if c.get("playbookAlignment") in ("preferred", "acceptable", "fallback")
        )
        confidence = acceptable_count / len(scored) if scored else 1.0

        logger.info("[redline] step2: scored %d changes, gate=%s, confidence=%.2f",
                    len(scored), requires_gate, confidence)
        return {**state, "scored_changes": scored, "requires_human_gate": requires_gate, "confidence": round(confidence, 2)}
    except Exception as e:
        logger.error("[redline] step2 error: %s", e)
        return {**state, "scored_changes": state["changes"], "requires_human_gate": False, "confidence": 0.5, "error": str(e)}


_SCORE_KEYS = ("recommendation", "playbookAlignment", "severity", "reasoning",
               "requiresHumanReview", "likelihood", "ourAssessment", "theirAssessment", "riskReason")


def _merge_scores(changes: list[dict], parsed: Any) -> list[dict]:
    """Merge step 2's scores onto the extracted changes. The model is asked for
    scores only, and even when it echoes whole changes it drops fields, so the
    change text always comes from step 1. Scores match by changeId, or by
    position when the model returned one score per change."""
    scores = [s for s in parsed if isinstance(s, dict)] if isinstance(parsed, list) else []
    by_id = {s["changeId"]: s for s in scores if s.get("changeId")}
    same_length = len(scores) == len(changes)
    scored = []
    for i, change in enumerate(changes):
        s = by_id.get(change.get("changeId")) or (scores[i] if same_length else {})
        merged = {**change, **{k: s[k] for k in _SCORE_KEYS if k in s}}
        rec = str(merged.get("recommendation", "")).lower()
        if rec not in ("accept", "counter", "reject"):
            merged["recommendation"] = "accept" if rec.startswith("accept") else "counter"
        scored.append(merged)
    return scored


# ─── Risk scoring ─────────────────────────────────────────────────────────────
# The model rates each wording (ours, theirs, our counter) on three factors and
# the clause's event once; the score is computed here, so the same ratings
# always give the same number and every number traces back to its factors:
#   deviation   0-3  distance from our playbook position (or from our original
#                    text where the playbook has no position for the clause)
#   exposure    0-4  what we could lose under this wording, relative to the
#                    contract and the deal
#   market      0-3  how far the wording sits from market practice
#   likelihood  1-3  how often the clause's event happens in contracts of this
#                    type and industry; one rating per change, shared by all
#                    three wordings, because wording changes what we lose, not
#                    whether the event happens
# risk = 100 × (0.45 × deviation/3 + 0.35 × exposure×likelihood/12 + 0.20 × market/3)
_FACTOR_RANGES = {"deviation": (0, 3), "exposure": (0, 4), "likelihood": (1, 3), "market": (0, 3)}
_DEVIATION_WORDS  = {0: "matches our standard", 1: "within our acceptable position", 2: "needs our fallback position", 3: "beyond our walkaway position"}
_EXPOSURE_WORDS   = {0: "no exposure", 1: "low exposure", 2: "moderate exposure", 3: "high exposure", 4: "severe exposure"}
_LIKELIHOOD_WORDS = {1: "unlikely", 2: "possible", 3: "likely"}
_MARKET_WORDS     = {0: "market standard", 1: "slightly off-market", 2: "clearly off-market", 3: "one-sided or of doubtful enforceability"}


def _factors(assessment: Any, likelihood: Any = None) -> dict[str, int] | None:
    """A wording's factor ratings plus the change's likelihood, clamped to their
    ranges, or None if any is missing."""
    if not isinstance(assessment, dict):
        return None
    ratings = {**assessment, **({"likelihood": likelihood} if likelihood is not None else {})}
    out: dict[str, int] = {}
    for key, (lo, hi) in _FACTOR_RANGES.items():
        try:
            out[key] = max(lo, min(hi, round(float(ratings.get(key)))))
        except (TypeError, ValueError):
            return None
    return out


def _risk_score(f: dict[str, int] | None) -> int | None:
    if f is None:
        return None
    return round(100 * (0.45 * f["deviation"] / 3
                        + 0.35 * f["exposure"] * f["likelihood"] / 12
                        + 0.20 * f["market"] / 3))


def _factor_words(f: dict[str, int]) -> str:
    """'beyond our walkaway position; severe exposure, likely; clearly off-market'"""
    return (f"{_DEVIATION_WORDS[f['deviation']]}; {_EXPOSURE_WORDS[f['exposure']]}, "
            f"{_LIKELIHOOD_WORDS[f['likelihood']]}; {_MARKET_WORDS[f['market']]}")


def _with_risk_text(change: dict) -> dict:
    """Score our text, theirs and our counter from their factor ratings, and put
    the result where the redline panel already shows text: the reasoning line
    (always visible) and the counter-proposal note."""
    likelihood = change.get("likelihood")
    ours, theirs, counter = (_factors(change.get(k), likelihood) for k in ("ourAssessment", "theirAssessment", "counterAssessment"))
    before, after, revised = _risk_score(ours), _risk_score(theirs), _risk_score(counter)
    # A counter is a compromise between our wording (the baseline) and theirs, so
    # its risk sits between the two. The counter is rated in a separate model
    # call; this keeps it on the same footing as the other two ratings.
    if None not in (before, after, revised) and before <= after:
        if revised < before:
            revised, counter = before, ours
        elif revised > after:
            revised, counter = after, theirs
    out = {**change, "ourAssessment": ours, "theirAssessment": theirs, "counterAssessment": counter,
           "riskBefore": before, "riskAfter": after, "riskRevised": revised}
    if before is not None and after is not None:
        why = change.get("riskReason") or change.get("reasoning") or ""
        out["riskDelta"] = after - before
        out["reasoning"] = f"Risk {before} → {after} ({after - before:+d}): {_factor_words(theirs)}. {why}".strip()
    if revised is not None and change.get("counterText"):
        base = f"Revised risk if they accept: {revised}"
        if after is not None:
            base += f" (from {after}, {revised - after:+d})"
        out["counterNote"] = f"{base}: {_factor_words(counter)}. {change.get('counterNote') or ''}".strip()
    return out


def _risk_summary(changes: list[dict]) -> str:
    """One line on how the counterparty's changes move our risk, averaged over the changed clauses."""
    def avg(key: str, rows: list[dict]) -> int | None:
        vals = [c[key] for c in rows if isinstance(c.get(key), int)]
        return round(sum(vals) / len(vals)) if vals else None
    scored = [c for c in changes if isinstance(c.get("riskBefore"), int) and isinstance(c.get("riskAfter"), int)]
    if not scored:
        return ""
    before, after = avg("riskBefore", scored), avg("riskAfter", scored)
    line = f" Average risk across the {len(scored)} changed clauses: {before} in our standard, {after} as proposed"
    # With our counters where we made one, their text where we accept it.
    landed = [c["riskRevised"] if isinstance(c.get("riskRevised"), int) else c["riskAfter"] for c in scored]
    return line + f", {round(sum(landed) / len(landed))} with our counter-proposals."


async def step_generate_counters(state: RedlineState) -> RedlineState:
    """Step 3: Generate counter-proposals for changes marked 'counter' or 'reject'.

    A rejected change still gets a compromise, so every change we don't accept
    shows alternative wording and the risk it would leave us with."""
    counter_changes = [c for c in state["scored_changes"] if c.get("recommendation") in ("counter", "reject")]

    final_changes = list(state["scored_changes"])  # copy

    if counter_changes:
        resolved = await resolve_llm(
            "reasoning",
            org_id=state.get("org_id"),
            streaming=True,
            trace_name="redline.generate_counters",
        )
        playbook_json = json.dumps(state["playbook_positions"], indent=2)
        # Same verbatim counterparty language as step 2, narrowed to the
        # changes we intend to counter.
        counter_json = wrap_untrusted_document(
            json.dumps(counter_changes, indent=2),
            source="changes extracted verbatim from the counterparty redline",
        )
        prompt = _COUNTER_PROMPT.format(
            contract_type=state["contract_type"],
            playbook_json=playbook_json,
            counter_changes_json=counter_json,
        )

        try:
            response = await resolved.llm.ainvoke([
                SystemMessage(content="You draft contract counter-proposals. Return only valid JSON." + PII_TOKEN_RULE),
                HumanMessage(content=prompt),
            ], config={"callbacks": resolved.callbacks})
            countered = _parse_json(response.content)
            if isinstance(countered, list):
                # Merge counter proposals back into final_changes by changeId
                counter_map = {c["changeId"]: c for c in countered if "changeId" in c}
                for i, change in enumerate(final_changes):
                    cid = change.get("changeId")
                    if cid in counter_map:
                        final_changes[i] = {**change, **{
                            k: v for k, v in counter_map[cid].items()
                            if k in ("counterText", "counterNote", "counterAssessment")
                        }}
        except Exception as e:
            logger.error("[redline] step3 error: %s", e)

    final_changes = [_with_risk_text(c) for c in final_changes]

    # Determine overall recommended action
    recommendations = [c.get("recommendation", "counter") for c in final_changes]
    if all(r == "accept" for r in recommendations):
        recommended_action = "accept_all"
    elif any(r == "reject" for r in recommendations):
        recommended_action = "reject"
    else:
        recommended_action = "counter"

    # Build summary
    accept_n = recommendations.count("accept")
    counter_n = recommendations.count("counter")
    reject_n = recommendations.count("reject")
    summary = (f"Analyzed {len(final_changes)} changes: "
               f"{accept_n} acceptable, {counter_n} need countering, {reject_n} should be rejected."
               + _risk_summary(final_changes))

    logger.info("[redline] step3: final_changes=%d action=%s", len(final_changes), recommended_action)
    return {**state, "final_changes": final_changes, "summary": summary, "recommended_action": recommended_action}


# ─── Graph ────────────────────────────────────────────────────────────────────

def _build_graph():
    graph = StateGraph(RedlineState)
    graph.add_node("extract_changes", step_extract_changes)
    graph.add_node("score_changes", step_score_changes)
    graph.add_node("generate_counters", step_generate_counters)

    graph.set_entry_point("extract_changes")
    graph.add_edge("extract_changes", "score_changes")
    graph.add_edge("score_changes", "generate_counters")
    graph.add_edge("generate_counters", END)
    return graph.compile()


_graph = _build_graph()


# ─── Public API ───────────────────────────────────────────────────────────────

async def run_redline(
    diff_html: str,
    contract_type: str = "general commercial",
    playbook_positions: list[dict] | None = None,
    org_id: str | None = None,
) -> dict:
    """Run the 3-step redline analysis pipeline."""
    initial: RedlineState = {
        "org_id":             org_id,
        "diff_html":          diff_html,
        "contract_type":      contract_type,
        "playbook_positions": playbook_positions or [],
        "changes":            [],
        "scored_changes":     [],
        "final_changes":      [],
        "summary":            "",
        "recommended_action": "counter",
        "requires_human_gate": False,
        "confidence":         0.5,
        "error":              None,
    }

    result = await _graph.ainvoke(initial)
    return {
        "changes":           result["final_changes"],
        "summary":           result["summary"],
        "recommendedAction": result["recommended_action"],
        "requiresHumanGate": result["requires_human_gate"],
        "confidence":        result["confidence"],
        "error":             result.get("error"),
    }
