"""docs/39 A13 — the type from the document's structure, and the whole
contract's own reading when it isn't the type it was read as.

Run: `python -m unittest discover -s tests -t .` in apps/agents.
"""
from __future__ import annotations

import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.agents import review_agent as ra
from app.routes.classify import MAX_CHARS, structure_sample
from app.routes.review import ReviewRequest, build_payloads


class Structure(unittest.TestCase):
    def test_a_long_document_is_read_by_its_opening_and_its_headings(self):
        body = "\n".join(f"The Supplier shall do thing number {i} as described." for i in range(400))
        text = "MASTER SERVICES AGREEMENT\n" + body[:4000] + "\n1. DEFINITIONS\n" + body + "\nARTICLE 7 STATEMENTS OF WORK\n" + body + "\nSCHEDULE A – SERVICE LEVELS\n"
        sample = structure_sample(text)
        self.assertTrue(sample.startswith("MASTER SERVICES AGREEMENT"))
        self.assertIn("HEADINGS FROM THE REST OF THE DOCUMENT", sample)
        self.assertIn("ARTICLE 7 STATEMENTS OF WORK", sample)
        self.assertIn("SCHEDULE A – SERVICE LEVELS", sample)
        self.assertLessEqual(len(sample), MAX_CHARS + 400)

    def test_a_short_document_is_read_whole(self):
        self.assertEqual(structure_sample("A short NDA."), "A short NDA.")


def _score_with(model_type: str, given: str, locked: bool) -> dict:
    reply = {"contractType": model_type, "suggestedTitle": "t", "summary": "s", "riskScore": 0.2, "riskFactors": [], "overallConfidence": 0.8}

    class _Llm:
        async def ainvoke(self, messages, config=None):  # noqa: ARG002
            return SimpleNamespace(content=json.dumps(reply))

    async def resolve(*_a, **_k):
        return SimpleNamespace(llm=_Llm(), provider="fake", model="fake", callbacks=[])

    state = {
        "plain_text": "x", "contract_type": given, "custom_fields": [], "org_id": None, "validated_fields": {},
        "type_locked": locked, "type_opinion": None, "error": None, "clause_flags": {}, "clause_segments": [],
    }
    with patch.object(ra, "resolve_llm", resolve):
        return asyncio.run(ra._score(state))


class Opinion(unittest.TestCase):
    def test_the_whole_contract_read_as_another_type_says_so_and_keeps_the_type(self):
        state = _score_with("MSA", "SOW", locked=False)
        self.assertEqual(state["contract_type_out"], "SOW")
        self.assertEqual(state["type_opinion"], "MSA")

    def test_no_opinion_on_a_persons_type_or_when_they_agree(self):
        self.assertIsNone(_score_with("MSA", "SOW", locked=True)["type_opinion"])
        self.assertIsNone(_score_with("SOW", "SOW", locked=False)["type_opinion"])
        self.assertIsNone(_score_with("OTHER", "SOW", locked=False)["type_opinion"])

    def test_the_opinion_is_saved_and_cleared_with_the_analysis(self):
        contract, _ = build_payloads({"summary": "s", "typeOpinion": "MSA"}, None, [])
        self.assertEqual(contract["metadata"]["_typeOpinion"], {"type": "MSA"})
        contract, _ = build_payloads({"summary": "s", "typeOpinion": None}, None, [])
        self.assertIsNone(contract["metadata"]["_typeOpinion"])

    def test_the_request_says_whether_a_person_set_the_type(self):
        self.assertFalse(ReviewRequest(contractId="c", versionId="v", plainText="x").typeLocked)
        self.assertTrue(ReviewRequest(contractId="c", versionId="v", plainText="x", typeLocked=True).typeLocked)


if __name__ == "__main__":
    unittest.main()
