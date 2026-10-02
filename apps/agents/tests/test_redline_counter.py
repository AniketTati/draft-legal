"""docs/41 Part 15 — Counter… on one change in the workspace (no live model).

Run:  cd apps/agents && python -m pytest tests/test_redline_counter.py -q
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

from app.agents import redline_agent


class FakeLLM:
    def __init__(self, reply):
        self.reply = reply
        self.prompts = []

    async def ainvoke(self, messages, config=None):
        self.prompts.append(messages[-1].content)
        return SimpleNamespace(content=json.dumps(self.reply))


def test_counter_change_returns_the_model_counter_and_its_rationale(monkeypatch):
    llm = FakeLLM([{"changeId": "change_001", "counterText": "Liability is capped at 12 months of fees.",
                    "counterNote": "Meets them halfway on the cap.", "counterAssessment": {"deviation": 1, "exposure": 1, "market": 0}}])

    async def fake_resolve(*_a, **_k):
        return SimpleNamespace(llm=llm, callbacks=[])

    monkeypatch.setattr(redline_agent, "resolve_llm", fake_resolve)
    out = asyncio.run(redline_agent.counter_change("capped at fees paid", "uncapped", clause_type="liability"))
    assert out == {"counterText": "Liability is capped at 12 months of fees.", "counterNote": "Meets them halfway on the cap."}
    # Their words reach the model as an untrusted document, beside ours.
    assert "uncapped" in llm.prompts[0] and "capped at fees paid" in llm.prompts[0]


def test_counter_change_says_nothing_when_the_model_gave_nothing(monkeypatch):
    async def fake_resolve(*_a, **_k):
        return SimpleNamespace(llm=FakeLLM("not json"), callbacks=[])

    monkeypatch.setattr(redline_agent, "resolve_llm", fake_resolve)
    out = asyncio.run(redline_agent.counter_change("a", "b"))
    assert out == {"counterText": "", "counterNote": ""}
