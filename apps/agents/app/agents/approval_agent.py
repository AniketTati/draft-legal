"""
Approval Agent — Phase 06, reworked for docs/41 P1 (Part 7)
LangGraph pipeline that writes the summary an approver reads:
  Step 1 — Summarize (fast model): 3-5 sentence plain-language summary of the contract
  Step 2 — Risks from findings (no model): the review's open findings, as key risks
  Step 3 — Explain (smart model): why the review found what it found, quoting the clauses

The model never chooses the recommendation. The API's policy over the review
findings does (recommendation-guard.ts), and stores it whatever this sends;
this pipeline sends none. It used to: a model read a risk score of null as 0
and said Approve after Governing Law was deleted.

Output is stored on ApprovalInstance via PATCH /api/v1/approvals/:instanceId/summary.
"""
from __future__ import annotations

import json
from ..jsonish import loads_lenient
import logging
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import StateGraph, END
from typing_extensions import TypedDict

from ..router import resolve_llm
from ..pii_tokens import PII_TOKEN_RULE

logger = logging.getLogger(__name__)


# ─── State ────────────────────────────────────────────────────────────────────

class ApprovalState(TypedDict):
    org_id:               str | None
    contract_plain_text:  str
    contract_type:        str
    contract_value:       float | None
    contract_title:       str
    counterparty_name:    str | None
    clauses:              list[dict]   # [{clauseType, content, interpretation, riskRating}]
    key_terms:            dict
    risk_factors:         list[str]
    risk_score:           float | None
    # docs/41 P1 — the review's open findings: [{kind, severity, title, explanation, evidence: {quote, baselineQuote}}]
    findings:             list[dict]
    recommendation:       str | None   # the API's label, to explain (never chosen here)
    # outputs
    executive_summary:    str
    key_risks:            list[dict]   # [{title, description, severity}]
    non_standard_terms:   list[str]
    error:                str | None


# ─── Prompts ──────────────────────────────────────────────────────────────────

_SUMMARIZE_PROMPT = """You are a legal analyst writing a brief summary for a business approver (not a lawyer).

Contract: "{title}"
Counterparty: {counterparty}
Type: {contract_type}
Value: {value}
Key Terms: {key_terms_json}

Contract text (first 8000 characters):
{text_excerpt}

Write a 3-5 sentence plain-language executive summary. Focus on:
1. What does this contract commit our company to?
2. What are the key financial terms (value, payment schedule, duration)?
3. Who is the counterparty and what do they provide?

Use plain language. Avoid legal jargon. No markdown, no bullet points.
Return ONLY the summary text, nothing else."""

_EXPLAIN_PROMPT = """You are writing for a business approver (not a lawyer) why a contract's review found what it found.

The review's recommendation is: {recommendation}. It was decided by fixed rules from the findings below; do not change it, argue with it, or give your own.

Findings (each with the contract's own words as evidence):
{findings_json}

Write 2-4 plain sentences: what the approver needs to look at first and why, quoting the contract's words (in quotation marks) from the evidence above. Only say what the findings and their quotes show. Do not judge anything against "the market" or "common practice".
Return ONLY the sentences, nothing else."""

_LABEL_WORDS = {
    "ready_to_approve": "Ready to approve",
    "review": "Review",
    "needs_exception": "Needs exception",
    "escalate": "Escalate",
    "cant_recommend": "Can't recommend",
}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _safe_json(text: str) -> Any:
    """Extract and parse the first JSON object or array from an LLM response."""
    text = text.strip()
    # Strip markdown code fences if present
    if text.startswith('```'):
        lines = text.split('\n')
        text = '\n'.join(lines[1:-1] if lines[-1].strip() == '```' else lines[1:])
    try:
        return loads_lenient(text)
    except json.JSONDecodeError:
        # Try to find JSON within the text
        import re
        match = re.search(r'\{[\s\S]*\}|\[[\s\S]*\]', text)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
    return None


def _risk_text(score: float | None) -> str:
    """docs/41 P0.2 — a score nobody computed is unknown, never 0 (it was
    read as 0, so a never-analysed contract looked risk-free)."""
    return "unknown" if score is None else f"{score:.2f}"


def unscored(state: dict) -> bool:
    """Nothing to judge from: no risk score, or no clauses read. The API's
    guard holds the label back in this case too; the model is not asked."""
    return state.get('risk_score') is None or not state.get('clauses')


# ─── Graph nodes ──────────────────────────────────────────────────────────────

async def step_summarize(state: ApprovalState) -> dict:
    """Step 1: generate plain-language executive summary (fast model)."""
    try:
        resolved = await resolve_llm(
            'default',
            org_id=state.get('org_id'),
            trace_name='approval.summarize',
        )
        value_str = f"${state['contract_value']:,.2f}" if state['contract_value'] else "Not specified"
        prompt = _SUMMARIZE_PROMPT.format(
            title=state['contract_title'],
            counterparty=state['counterparty_name'] or 'Unknown',
            contract_type=state['contract_type'],
            value=value_str,
            key_terms_json=json.dumps(state['key_terms'], indent=2)[:2000],
            text_excerpt=state['contract_plain_text'][:8000],
        )
        response = await resolved.llm.ainvoke(
            [SystemMessage(content="You are a legal analyst." + PII_TOKEN_RULE), HumanMessage(content=prompt)],
            config={"callbacks": resolved.callbacks},
        )
        summary = response.content.strip() if hasattr(response, 'content') else str(response).strip()
        return {'executive_summary': summary, 'error': None}
    except Exception as e:
        logger.error('step_summarize failed: %s', e)
        return {'executive_summary': f'Summary unavailable ({type(e).__name__})', 'error': str(e)}


_SEVERITY = {"critical": "critical", "high": "high", "medium": "medium", "low": "low"}


def risks_from_findings(findings: list[dict]) -> dict:
    """Step 2 — the review's open findings, as the key risks an approver sees.
    No model: each is a finding with its evidence, not an opinion."""
    open_ = [f for f in findings if f.get("status", "open") in ("open", "exception_requested", "exception_declined")]
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    open_.sort(key=lambda f: order.get(f.get("severity", "low"), 3))
    key_risks = [
        {"title": f.get("title", ""), "description": f.get("explanation", ""), "severity": _SEVERITY.get(f.get("severity", "low"), "low")}
        for f in open_[:5]
    ]
    non_standard = [f.get("title", "") for f in open_ if f.get("kind") in ("modified", "added", "position_not_met", "position_fallback", "needs_approval_position", "material_cut")][:5]
    return {"key_risks": key_risks, "non_standard_terms": non_standard}


async def step_flag_risks(state: ApprovalState) -> dict:
    return risks_from_findings(state.get("findings") or [])


async def step_explain(state: ApprovalState) -> dict:
    """Step 3: explain the findings, quoting the contract (smart model). Never a label."""
    findings = [f for f in (state.get("findings") or []) if f.get("status", "open") in ("open", "exception_requested", "exception_declined")]
    label = _LABEL_WORDS.get(state.get("recommendation") or "", "Review")
    if not findings:
        # Nothing to explain: the model is not asked.
        return {}
    try:
        resolved = await resolve_llm(
            'reasoning',
            org_id=state.get('org_id'),
            trace_name='approval.explain',
        )
        slim = [
            {
                "title": f.get("title"),
                "severity": f.get("severity"),
                "explanation": f.get("explanation"),
                "quote": ((f.get("evidence") or {}).get("quote") or "")[:400],
                "before": ((f.get("evidence") or {}).get("baselineQuote") or "")[:400],
            }
            for f in findings[:12]
        ]
        prompt = _EXPLAIN_PROMPT.format(recommendation=label, findings_json=json.dumps(slim, indent=2)[:12_000])
        response = await resolved.llm.ainvoke(
            [SystemMessage(content="You explain contract review findings to a business approver." + PII_TOKEN_RULE), HumanMessage(content=prompt)],
            config={"callbacks": resolved.callbacks},
        )
        why = (response.content if hasattr(response, 'content') else str(response)).strip()
        return {'executive_summary': f"{state['executive_summary']}\n\n{why}".strip()}
    except Exception as e:
        logger.error('step_explain failed: %s', e)
        return {'error': str(e)}


# ─── Graph construction ───────────────────────────────────────────────────────

def _build_graph() -> StateGraph:
    g = StateGraph(ApprovalState)
    g.add_node('summarize',  step_summarize)
    g.add_node('flag_risks', step_flag_risks)
    g.add_node('explain',    step_explain)
    g.set_entry_point('summarize')
    g.add_edge('summarize',  'flag_risks')
    g.add_edge('flag_risks', 'explain')
    g.add_edge('explain',    END)
    return g.compile()


_graph = _build_graph()


# ─── Public API ───────────────────────────────────────────────────────────────

async def run_approval_summary(
    plain_text:       str,
    contract_type:    str,
    contract_value:   float | None,
    contract_title:   str,
    counterparty_name: str | None,
    clauses:          list[dict],
    key_terms:        dict,
    risk_factors:     list[str],
    risk_score:       float | None,
    org_id:           str | None = None,
    findings:         list[dict] | None = None,
    recommendation:   str | None = None,
) -> dict:
    """Run the approval summary pipeline. Returns structured result dict, with no recommendation of its own."""
    initial_state: ApprovalState = {
        'org_id':               org_id,
        'contract_plain_text':  plain_text,
        'contract_type':        contract_type,
        'contract_value':       contract_value,
        'contract_title':       contract_title,
        'counterparty_name':    counterparty_name,
        'clauses':              clauses,
        'key_terms':            key_terms,
        'risk_factors':         risk_factors,
        'risk_score':           risk_score,
        'findings':             findings or [],
        'recommendation':       recommendation,
        # outputs — filled by graph nodes
        'executive_summary':    '',
        'key_risks':            [],
        'non_standard_terms':   [],
        'error':                None,
    }
    final_state = await _graph.ainvoke(initial_state)
    return {
        'executiveSummary':       final_state.get('executive_summary', ''),
        'keyRisks':               final_state.get('key_risks', []),
        'nonStandardTerms':       final_state.get('non_standard_terms', []),
        'error':                  final_state.get('error'),
    }
