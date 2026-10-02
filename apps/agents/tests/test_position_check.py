"""docs/41 P1 — the position check: one verdict per clause, against our
positions only, and anything that isn't about a clause or a position we
sent is dropped."""
import asyncio
import json
from types import SimpleNamespace

from app.agents import playbook_review_agent as agent


def _fake(monkeypatch, reply):
    sent: list[str] = []

    class FakeLlm:
        async def ainvoke(self, messages, config=None):
            sent.append(messages[-1].content)
            return SimpleNamespace(content=json.dumps(reply))

    async def fake_resolve(*_args, **_kwargs):
        return SimpleNamespace(llm=FakeLlm(), callbacks=[])

    monkeypatch.setattr(agent, "resolve_llm", fake_resolve)
    return sent


CLAUSES = [
    {"id": "c1", "clauseType": "confidentiality", "content": "Obligations survive for three years."},
    {"id": "c2", "clauseType": "governing_law", "content": "Governed by the laws of Delaware."},
]
POSITIONS = [
    {"id": "p-pref", "clauseType": "Confidentiality", "positionType": "preferred", "content": "Five years."},
    {"id": "p-fb", "clauseType": "Confidentiality", "positionType": "fallback", "content": "Three years."},
]


def test_verdicts_are_checked_against_what_was_sent(monkeypatch):
    sent = _fake(monkeypatch, [
        {"clauseId": "c1", "positionId": "p-fb", "verdict": "meets_fallback", "quote": "three years", "explanation": "Three years is our fallback."},
        {"clauseId": "c2", "positionId": "p-made-up", "verdict": "not_met", "quote": "Delaware", "explanation": "x"},
        {"clauseId": "c9", "positionId": "p-pref", "verdict": "meets_preferred", "quote": "", "explanation": ""},
        {"clauseId": "c1", "positionId": "p-pref", "verdict": "meets_preferred", "quote": "", "explanation": "duplicate"},
        {"clauseId": "c2", "positionId": "p-pref", "verdict": "market", "quote": "", "explanation": ""},
    ])
    out = asyncio.run(agent.run_position_check(CLAUSES, POSITIONS, "NDA"))
    assert out["clausesChecked"] == 2
    assert out["verdicts"] == [
        {"clauseId": "c1", "positionId": "p-fb", "verdict": "meets_fallback", "quote": "three years", "explanation": "Three years is our fallback."},
        # A position we never sent: not a judgement against our playbook.
        {"clauseId": "c2", "positionId": None, "verdict": "not_covered", "quote": "Delaware", "explanation": "x"},
    ]
    prompt = sent[0]
    assert "against OUR positions" in prompt
    assert "market practice" not in prompt


def test_nothing_to_check_calls_no_model(monkeypatch):
    sent = _fake(monkeypatch, [])
    assert asyncio.run(agent.run_position_check([], POSITIONS, "NDA"))["verdicts"] == []
    assert asyncio.run(agent.run_position_check(CLAUSES, [], "NDA"))["verdicts"] == []
    assert sent == []
