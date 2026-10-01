"""docs/41 P0.2 — a null risk score is unknown, never 0, and never yields "approve"."""
import asyncio

from app.agents import approval_agent
from app.agents.approval_agent import _risk_text, step_recommend, unscored


def test_null_risk_is_unknown_not_zero():
    assert _risk_text(None) == "unknown"
    assert _risk_text(0.0) == "0.00"
    assert _risk_text(0.42) == "0.42"


def test_unscored_without_score_or_clauses():
    assert unscored({"risk_score": None, "clauses": [{"clauseType": "x"}]})
    assert unscored({"risk_score": 0.1, "clauses": []})
    assert not unscored({"risk_score": 0.1, "clauses": [{"clauseType": "x"}]})


def test_recommend_never_approves_an_unscored_contract(monkeypatch):
    async def boom(*_a, **_k):  # the model must not be asked
        raise AssertionError("resolve_llm called for an unscored contract")
    monkeypatch.setattr(approval_agent, "resolve_llm", boom)
    state = {
        "org_id": "o", "contract_type": "NDA", "contract_value": None, "risk_score": None,
        "clauses": [], "key_risks": [], "executive_summary": "An NDA.",
    }
    out = asyncio.run(step_recommend(state))
    assert out["approval_recommendation"] == "review_required"
