"""
Approval Agent — Phase 06
3-step LangGraph pipeline that generates an executive summary for approvers:
  Step 1 — Summarize (fast model): 3-5 sentence plain-language summary of the contract
  Step 2 — Flag Risks (smart model): identify non-standard/unfavorable terms from extracted clauses
  Step 3 — Recommend (smart model): approve / review_required / reject_advised based on risk profile

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

from ..router import RouterRefusal, resolve_llm

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
    # outputs
    executive_summary:    str
    key_risks:            list[dict]   # [{title, description, severity}]
    non_standard_terms:   list[str]
    approval_recommendation: str       # "approve" | "review_required" | "reject_advised"
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

_FLAG_RISKS_PROMPT = """You are a contract risk analyst. Identify non-standard or unfavorable terms that a business approver should be aware of.

Contract type: {contract_type}
AI risk score: {risk_score} (0 = no risk, 1 = high risk)
AI-identified risk factors: {risk_factors_json}

Extracted clauses with risk ratings:
{clauses_json}

Return ONLY valid JSON with two keys:
{{
  "keyRisks": [
    {{
      "title": "Short risk title (5-10 words)",
      "description": "One sentence explanation of why this is a concern",
      "severity": "low|medium|high|critical"
    }}
  ],
  "nonStandardTerms": [
    "Short description of a non-standard term"
  ]
}}

Focus on: uncapped liability, missing limitation clauses, auto-renewal without notice, unusual IP assignment,
one-sided termination rights, penalties/liquidated damages, unusual arbitration clauses.
Return at most 5 keyRisks and 5 nonStandardTerms. If there are none, return empty arrays."""

_RECOMMEND_PROMPT = """You are a contract approval advisor. Based on the risk analysis below, provide an approval recommendation.

Contract type: {contract_type}
Value: {value}
AI risk score: {risk_score} (0 = no risk, 1 = high risk)
Key risks identified: {key_risks_json}
Executive summary: {executive_summary}

Rules for recommendation:
- "approve": risk_score < 0.35 AND no high/critical severity risks AND standard contract type
- "review_required": risk_score 0.35–0.67 OR any medium severity risks OR unusual terms present
- "reject_advised": risk_score > 0.67 OR any critical severity risks OR missing standard protections

Return ONLY valid JSON:
{{
  "recommendation": "approve|review_required|reject_advised",
  "rationale": "One sentence explaining the recommendation"
}}"""


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
            [SystemMessage(content="You are a legal analyst."), HumanMessage(content=prompt)],
            config={"callbacks": resolved.callbacks},
        )
        summary = response.content.strip() if hasattr(response, 'content') else str(response).strip()
        return {'executive_summary': summary, 'error': None}
    except RouterRefusal:
        # A refusal is not a model failure. Degrading here would write a
        # confident wrong answer for a call that never reached a provider.
        raise
    except Exception as e:
        logger.error('step_summarize failed: %s', e)
        return {'executive_summary': f'Summary unavailable ({type(e).__name__})', 'error': str(e)}


async def step_flag_risks(state: ApprovalState) -> dict:
    """Step 2: identify non-standard and unfavorable terms (smart model)."""
    if state.get('error') and not state.get('executive_summary'):
        return {'key_risks': [], 'non_standard_terms': []}
    try:
        resolved = await resolve_llm(
            'reasoning',
            org_id=state.get('org_id'),
            trace_name='approval.flag_risks',
        )
        # Only send unfavorable/unusual clauses to keep prompt concise
        risky_clauses = [c for c in state['clauses'] if c.get('riskRating') in ('unfavorable', 'unusual', 'high')]
        all_clauses = risky_clauses if risky_clauses else state['clauses'][:10]

        prompt = _FLAG_RISKS_PROMPT.format(
            contract_type=state['contract_type'],
            risk_score=state['risk_score'] or 0,
            risk_factors_json=json.dumps(state['risk_factors'][:10]),
            clauses_json=json.dumps(all_clauses[:10], indent=2)[:4000],
        )
        response = await resolved.llm.ainvoke(
            [SystemMessage(content="You are a contract risk analyst."), HumanMessage(content=prompt)],
            config={"callbacks": resolved.callbacks},
        )
        raw = response.content if hasattr(response, 'content') else str(response)
        parsed = _safe_json(raw)
        if parsed and isinstance(parsed, dict):
            return {
                'key_risks': parsed.get('keyRisks', [])[:5],
                'non_standard_terms': parsed.get('nonStandardTerms', [])[:5],
            }
        return {'key_risks': [], 'non_standard_terms': []}
    except RouterRefusal:
        # A refusal is not a model failure. Degrading here would write a
        # confident wrong answer for a call that never reached a provider.
        raise
    except Exception as e:
        logger.error('step_flag_risks failed: %s', e)
        return {'key_risks': [], 'non_standard_terms': [], 'error': str(e)}


async def step_recommend(state: ApprovalState) -> dict:
    """Step 3: produce approval recommendation (smart model)."""
    try:
        resolved = await resolve_llm(
            'reasoning',
            org_id=state.get('org_id'),
            trace_name='approval.recommend',
        )
        value_str = f"${state['contract_value']:,.2f}" if state['contract_value'] else "Not specified"
        prompt = _RECOMMEND_PROMPT.format(
            contract_type=state['contract_type'],
            value=value_str,
            risk_score=state['risk_score'] or 0,
            key_risks_json=json.dumps(state['key_risks'][:5], indent=2),
            executive_summary=state['executive_summary'],
        )
        response = await resolved.llm.ainvoke(
            [SystemMessage(content="You are a contract approval advisor."), HumanMessage(content=prompt)],
            config={"callbacks": resolved.callbacks},
        )
        raw = response.content if hasattr(response, 'content') else str(response)
        parsed = _safe_json(raw)
        if parsed and isinstance(parsed, dict):
            rec = parsed.get('recommendation', 'review_required')
            rationale = parsed.get('rationale', '')
            if rec not in ('approve', 'review_required', 'reject_advised'):
                rec = 'review_required'
            return {'approval_recommendation': rec, 'executive_summary': f"{state['executive_summary']}\n\n{rationale}".strip()}
        return {'approval_recommendation': 'review_required'}
    except RouterRefusal:
        # A refusal is not a model failure. Degrading here would write a
        # confident wrong answer for a call that never reached a provider.
        raise
    except Exception as e:
        logger.error('step_recommend failed: %s', e)
        return {'approval_recommendation': 'review_required', 'error': str(e)}


# ─── Graph construction ───────────────────────────────────────────────────────

def _build_graph() -> StateGraph:
    g = StateGraph(ApprovalState)
    g.add_node('summarize',  step_summarize)
    g.add_node('flag_risks', step_flag_risks)
    g.add_node('recommend',  step_recommend)
    g.set_entry_point('summarize')
    g.add_edge('summarize',  'flag_risks')
    g.add_edge('flag_risks', 'recommend')
    g.add_edge('recommend',  END)
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
) -> dict:
    """Run the 3-step approval summary pipeline. Returns structured result dict."""
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
        # outputs — filled by graph nodes
        'executive_summary':    '',
        'key_risks':            [],
        'non_standard_terms':   [],
        'approval_recommendation': 'review_required',
        'error':                None,
    }
    final_state = await _graph.ainvoke(initial_state)
    return {
        'executiveSummary':       final_state.get('executive_summary', ''),
        'keyRisks':               final_state.get('key_risks', []),
        'nonStandardTerms':       final_state.get('non_standard_terms', []),
        'approvalRecommendation': final_state.get('approval_recommendation', 'review_required'),
        'error':                  final_state.get('error'),
    }
