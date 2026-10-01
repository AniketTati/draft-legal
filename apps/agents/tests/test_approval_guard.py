"""docs/41 P0.2 / P1 — a null risk score is unknown, never 0; and the approval
summary explains the review's findings without ever choosing the
recommendation (the API's policy does)."""
import asyncio
from types import SimpleNamespace

from app.agents import approval_agent
from app.agents.approval_agent import _risk_text, unscored, risks_from_findings, step_explain


def test_null_risk_is_unknown_not_zero():
    assert _risk_text(None) == "unknown"
    assert _risk_text(0.0) == "0.00"
    assert _risk_text(0.42) == "0.42"


def test_unscored_without_score_or_clauses():
    assert unscored({"risk_score": None, "clauses": [{"clauseType": "x"}]})
    assert unscored({"risk_score": 0.1, "clauses": []})
    assert not unscored({"risk_score": 0.1, "clauses": [{"clauseType": "x"}]})


FINDINGS = [
    {"kind": "modified", "severity": "medium", "status": "open", "title": "Confidentiality — changed since v1", "explanation": "The words changed.", "evidence": {"quote": "two years", "baselineQuote": "five years"}},
    {"kind": "deleted", "severity": "high", "status": "open", "title": "Governing Law — deleted since v1 (required)", "explanation": "Gone.", "evidence": {"baselineQuote": "laws of New York"}},
    {"kind": "added", "severity": "low", "status": "accepted", "title": "Accepted one", "explanation": "", "evidence": {}},
]


def test_key_risks_are_the_open_findings_worst_first():
    out = risks_from_findings(FINDINGS)
    assert [r["title"] for r in out["key_risks"]] == ["Governing Law — deleted since v1 (required)", "Confidentiality — changed since v1"]
    assert out["non_standard_terms"] == ["Confidentiality — changed since v1"]


def test_explain_quotes_the_findings_and_is_told_the_label(monkeypatch):
    sent: list[str] = []

    class FakeLlm:
        async def ainvoke(self, messages, config=None):
            sent.append(messages[-1].content)
            return SimpleNamespace(content='Governing law was removed ("laws of New York").')

    async def fake_resolve(*_a, **_k):
        return SimpleNamespace(llm=FakeLlm(), callbacks=[])

    monkeypatch.setattr(approval_agent, "resolve_llm", fake_resolve)
    out = asyncio.run(step_explain({"org_id": "o", "findings": FINDINGS, "recommendation": "review", "executive_summary": "An NDA."}))
    assert out["executive_summary"].startswith("An NDA.\n\nGoverning law was removed")
    assert "approval_recommendation" not in out
    assert "The review's recommendation is: Review" in sent[0]
    assert "laws of New York" in sent[0]
    assert "Accepted one" not in sent[0]


def test_nothing_open_asks_no_model(monkeypatch):
    async def boom(*_a, **_k):
        raise AssertionError("resolve_llm called with nothing to explain")
    monkeypatch.setattr(approval_agent, "resolve_llm", boom)
    assert asyncio.run(step_explain({"org_id": "o", "findings": [], "recommendation": "ready_to_approve", "executive_summary": "x"})) == {}


def test_the_pipeline_returns_no_recommendation(monkeypatch):
    class FakeLlm:
        async def ainvoke(self, messages, config=None):
            return SimpleNamespace(content="Summary.")

    async def fake_resolve(*_a, **_k):
        return SimpleNamespace(llm=FakeLlm(), callbacks=[])

    monkeypatch.setattr(approval_agent, "resolve_llm", fake_resolve)
    out = asyncio.run(approval_agent.run_approval_summary(
        plain_text="x", contract_type="NDA", contract_value=None, contract_title="NDA", counterparty_name=None,
        clauses=[], key_terms={}, risk_factors=[], risk_score=None, findings=FINDINGS, recommendation="review",
    ))
    assert "approvalRecommendation" not in out
    assert out["keyRisks"][0]["severity"] == "high"
