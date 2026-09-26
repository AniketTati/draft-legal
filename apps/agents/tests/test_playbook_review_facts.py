"""DD1 — the playbook review is given each clause's caps, measured from its
words by the API, and told to use them: it had reasoned that a 2x cap
"could exceed 3x annual value depending on payment schedule"."""
import asyncio
import json
from types import SimpleNamespace

from app.agents import playbook_review_agent as agent


def test_the_review_is_given_the_measured_caps(monkeypatch):
    sent: list[str] = []

    class FakeLlm:
        async def ainvoke(self, messages, config=None):
            sent.append(messages[-1].content)
            return SimpleNamespace(content="[]")

    async def fake_resolve(*_args, **_kwargs):
        return SimpleNamespace(llm=FakeLlm(), callbacks=[])

    monkeypatch.setattr(agent, "resolve_llm", fake_resolve)
    fact = "Each party's cap: 2 × the fees of the 12 months before the claim = 24 months of fees, 2 times a year's fees."
    asyncio.run(agent.run_playbook_review(
        clauses=[
            {"id": "c1", "clauseType": "limitation_of_liability", "content": "Each party's aggregate liability shall not exceed two (2) times the fees.", "facts": [fact]},
            {"id": "c2", "clauseType": "payment", "content": "Customer shall pay within 60 days."},
        ],
        playbook_positions=[{"clauseType": "Limitation of Liability", "positionType": "preferred", "content": "2x annual fees"}],
        contract_type="MSA",
    ))
    prompt = sent[0]
    assert "Do not work out a cap's size yourself" in prompt
    # As the clause list is sent: JSON, with "×" escaped.
    assert json.dumps(fact)[1:-1] in prompt
    # A clause without caps carries no facts field.
    assert prompt.count('"facts": [') == 1
