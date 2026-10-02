"""
docs/39 E3 — an organisation's own clause types: the extraction is told of
them (tagged like the listed ones), and /find-clause finds one in a contract,
keeping only passages that are in it word for word, each once.
"""
from __future__ import annotations

import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.agents import clause_finder
from app.agents.review_agent import _custom_clause_types_note
from app.routes.review import ReviewRequest

CONTRACT = (
    "1. SERVICES. Supplier shall provide the services in Schedule A. "
    "2. DATA RESIDENCY. Supplier shall store and process Customer Data only in data centres located in the European Union, "
    "and shall not transfer Customer Data outside the EU without Customer's prior written consent. "
    "3. FEES. Customer shall pay each invoice within thirty (30) days."
)
RESIDENCY = {
    "key": "custom_data_residency", "label": "Data residency",
    "description": "Where the supplier may store or process the customer's data.",
    "examples": ["All Customer Data shall be hosted in the United Kingdom."],
}


class ReviewIsToldOfThem(unittest.TestCase):
    def test_the_note_lists_the_orgs_types_only(self):
        note = _custom_clause_types_note([RESIDENCY, {"key": "payment", "label": "Payment"}, "junk"])
        self.assertIn("THE ORGANISATION'S OWN CLAUSE TYPES", note)
        listed = json.loads(note[note.index("["):])
        self.assertEqual([t["clauseType"] for t in listed], ["custom_data_residency"])
        self.assertEqual(listed[0]["examples"], ["All Customer Data shall be hosted in the United Kingdom."])

    def test_no_types_no_note(self):
        self.assertEqual(_custom_clause_types_note([]), "")
        self.assertEqual(_custom_clause_types_note(None), "")

    def test_the_review_request_takes_them(self):
        body = ReviewRequest(contractId="c", versionId="v", plainText="x", customClauseTypes=[RESIDENCY])
        self.assertEqual(body.customClauseTypes[0].key, "custom_data_residency")


class FindingOne(unittest.TestCase):
    def test_keeps_passages_in_the_contract_word_for_word_each_once(self):
        seen: list[str] = []
        clause = "DATA RESIDENCY. Supplier shall store and process Customer Data only in data centres located in the European Union"
        kept = clause_finder.checked([
            {"content": clause, "startsWith": "DATA RESIDENCY. Supplier shall", "sectionRef": "2"},
            {"content": clause},  # the same again
            {"content": "Supplier keeps all data in Europe."},  # a paraphrase
            "junk",
        ], CONTRACT, seen)
        self.assertEqual([k["sectionRef"] for k in kept], ["2"])

    def test_reads_the_contract_and_returns_what_it_found(self):
        answer = {"clauses": [{"content": "Supplier shall store and process Customer Data only in data centres located in the European Union", "sectionRef": "2"}]}
        calls: list[str] = []

        class FakeLlm:
            async def ainvoke(self, messages, config=None):
                calls.append(messages[0].content)
                return SimpleNamespace(content=json.dumps(answer))

        async def fake_resolve(*_a, **_k):
            return SimpleNamespace(llm=FakeLlm(), callbacks=[])

        with patch.object(clause_finder, "resolve_llm", fake_resolve):
            found, chunks = asyncio.run(clause_finder.find_clause(CONTRACT, RESIDENCY, org_id="org"))
        self.assertEqual(chunks, 1)
        self.assertEqual(len(found), 1)
        self.assertIn('"name": "Data residency"', calls[0])
        self.assertIn("United Kingdom", calls[0])

    def test_nothing_to_read_asks_nothing(self):
        async def fail(*_a, **_k):
            raise AssertionError("no model call for an empty contract")
        with patch.object(clause_finder, "resolve_llm", fail):
            self.assertEqual(asyncio.run(clause_finder.find_clause("  ", RESIDENCY)), ([], 0))


if __name__ == "__main__":
    unittest.main()
