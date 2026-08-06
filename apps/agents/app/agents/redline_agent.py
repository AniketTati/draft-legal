"""
Redline Agent — Phase 5.2
3-step LangGraph pipeline for AI-powered counterparty redline analysis:
  Step 1 — Extract Changes (fast model): parse ins/del HTML → ChangeItem[]
  Step 2 — Score vs Playbook (smart model): recommendation + playbook alignment + severity
  Step 3 — Counter-Proposals (smart model): generate counter text for rejected changes

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

Return ONLY valid JSON — no markdown, no explanation:
[
  {
    "changeId": "<short unique slug, e.g. change_001>",
    "clauseType": "<payment|liability|indemnification|term|termination|confidentiality|ip|governing_law|notice|other>",
    "ourText": "<the original text that was removed (del content), or empty string if pure addition>",
    "theirText": "<the new text the counterparty proposed (ins content), or empty string if pure deletion>",
    "context": "<1–2 sentences of surrounding contract text for context>",
    "sectionRef": "<Section X or null>"
  }
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

Return ONLY valid JSON array matching the input changes, adding the scoring fields:
{changes_json}"""

_COUNTER_PROMPT = """You are a contract drafting specialist. For each change marked for countering, write a counter-proposal that moves the language closer to our playbook's "acceptable" position while still being commercially reasonable.

Contract type: {contract_type}
Playbook positions: {playbook_json}

Changes to counter (only those with recommendation="counter"):
{counter_changes_json}

For each change, add:
- counterText: the specific replacement language we propose
- counterNote: one sentence explaining the rationale

Return ONLY valid JSON array of the same changes with counterText and counterNote added."""


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
            SystemMessage(content="You extract structured changes from HTML diffs. Return only valid JSON."),
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
            SystemMessage(content="You are a contract negotiation specialist. Return only valid JSON."),
            HumanMessage(content=prompt),
        ], config={"callbacks": resolved.callbacks})
        scored = _parse_json(response.content)
        if not isinstance(scored, list):
            scored = state["changes"]

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


async def step_generate_counters(state: RedlineState) -> RedlineState:
    """Step 3: Generate counter-proposals for changes marked 'counter'."""
    counter_changes = [c for c in state["scored_changes"] if c.get("recommendation") == "counter"]

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
                SystemMessage(content="You draft contract counter-proposals. Return only valid JSON."),
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
                            if k in ("counterText", "counterNote")
                        }}
        except Exception as e:
            logger.error("[redline] step3 error: %s", e)

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
               f"{accept_n} acceptable, {counter_n} need countering, {reject_n} should be rejected.")

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
