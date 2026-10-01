"""docs/39 A5 — the org's own fields, read in a pass of their own and checked.

Run: `python -m unittest discover -s tests -t .` in apps/agents.
"""
from __future__ import annotations

import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.agents import custom_fields as cf

FIELDS = [
    {"fieldKey": "confidentiality_period", "fieldLabel": "Confidentiality period", "fieldType": "duration",
     "helpText": "How long confidentiality lasts after termination",
     "examples": [{"value": "5 years", "quote": "shall survive for five (5) years after termination"}] * 7},
    {"fieldKey": "region", "fieldLabel": "Region", "fieldType": "select", "options": ["EMEA", "Americas", "APAC"]},
    {"fieldKey": "services", "fieldLabel": "Services", "fieldType": "multiselect", "options": ["Hosting", "Support"]},
]

DOC = (
    "1. Services. Provider will host and support the Platform for the Customer in Europe.\n"
    "7. Confidentiality. The obligations in this Section 7 shall survive for three (3) years after termination.\n"
)


class Specs(unittest.TestCase):
    def test_lists_each_field_with_at_most_five_examples(self):
        specs = cf.field_specs(FIELDS)
        self.assertEqual(specs[0]["key"], "confidentiality_period")
        self.assertEqual(len(specs[0]["examples"]), 5)
        self.assertNotIn("examples", specs[1])

    def test_reads_the_chunk_that_mentions_the_fields_first(self):
        chunks = ["Definitions and parties.", "Payment is due in 30 days.", "Confidentiality survives termination for years."]
        self.assertEqual(cf.rank_chunks(chunks, cf.field_specs(FIELDS))[0], 2)
        self.assertEqual(cf.rank_chunks(["only one"], []), [0])


class Checks(unittest.TestCase):
    def test_a_quote_counts_when_it_is_in_the_document_word_for_word(self):
        self.assertTrue(cf.quote_in("shall  SURVIVE for three (3) years", DOC))
        self.assertTrue(cf.quote_in("The obligations in this Section 7 … three (3) years after termination", DOC))
        self.assertFalse(cf.quote_in("shall survive for five (5) years", DOC))

    def test_trusts_less_a_value_whose_quote_is_not_in_the_document(self):
        out = cf.check({"confidentiality_period": {"value": "5 years", "confidence": 0.95, "quote": "survive for five (5) years"}}, cf.field_specs(FIELDS), DOC)
        self.assertEqual(out["confidentiality_period"]["confidence"], 0.5)
        self.assertIn("isn't in the document", out["confidentiality_period"]["issue"])
        grounded = cf.check({"confidentiality_period": {"value": "3 years", "confidence": 0.9, "quote": "survive for three (3) years"}}, cf.field_specs(FIELDS), DOC)
        self.assertEqual(grounded["confidentiality_period"], {"value": "3 years", "confidence": 0.9, "quote": "survive for three (3) years"})

    def test_matches_choices_to_the_fields_own_options(self):
        out = cf.check({
            "region": {"value": "emea", "confidence": 0.8, "quote": None},
            "services": {"value": "hosting; SUPPORT", "confidence": 0.8, "quote": None},
        }, cf.field_specs(FIELDS), DOC)
        self.assertEqual(out["region"]["value"], "EMEA")
        self.assertEqual(out["services"]["value"], ["Hosting", "Support"])

    def test_drops_keys_it_did_not_ask_for(self):
        self.assertEqual(cf.check({"_splitInto": {"value": "x"}}, cf.field_specs(FIELDS), DOC), {})


class Pass(unittest.TestCase):
    def test_asks_with_examples_and_returns_checked_answers(self):
        seen = {}

        class LLM:
            async def ainvoke(self, messages, config=None):
                seen["system"] = messages[0].content
                return SimpleNamespace(content=json.dumps({"customFields": {
                    "confidentiality_period": {"value": "3 years", "confidence": 0.9, "quote": "shall survive for three (3) years after termination"},
                    "region": {"value": "emea", "confidence": 0.7, "quote": "in Europe"},
                    "services": {"value": ["hosting", "support"], "confidence": 0.7, "quote": "host and support the Platform"},
                    "not_asked": {"value": "x"},
                }}))

        async def fake_resolve(*a, **k):
            return SimpleNamespace(llm=LLM(), callbacks=[])

        with patch.object(cf, "resolve_llm", fake_resolve):
            found, read, total = asyncio.run(cf.extract_custom_fields(DOC, FIELDS, contract_type="SOW", org_id="org-1"))
        self.assertEqual((read, total), (1, 1))
        self.assertIn("five (5) years", seen["system"])  # the example
        self.assertIn("never from an example", seen["system"])
        self.assertIn("This is a SOW contract.", seen["system"])
        self.assertEqual(found["confidentiality_period"]["value"], "3 years")
        self.assertEqual(found["region"]["value"], "EMEA")
        self.assertEqual(found["services"]["value"], ["Hosting", "Support"])
        self.assertNotIn("not_asked", found)

    def test_asks_nothing_without_fields_or_text(self):
        async def boom(*a, **k):
            raise AssertionError("no model call expected")

        with patch.object(cf, "resolve_llm", boom):
            self.assertEqual(asyncio.run(cf.extract_custom_fields("", FIELDS)), ({}, 0, 0))
            self.assertEqual(asyncio.run(cf.extract_custom_fields(DOC, [])), ({}, 0, 0))


class Questions(unittest.TestCase):
    """docs/39 D6 — a diligence room's question, asked as a field whose meaning is the question."""

    QUESTION = {
        "fieldKey": "question_ab12", "fieldLabel": "Assign without consent?", "fieldType": "boolean",
        "question": "Can the Provider assign this agreement without the Customer's consent?",
    }
    ASSIGN_DOC = (
        "1. Services. Provider will host the Platform.\n"
        "12. Assignment. Neither party may assign this Agreement without the prior written consent of the other party.\n"
    )

    def test_the_spec_carries_the_question_and_the_prompt_says_how_to_answer_it(self):
        spec = cf.field_specs([self.QUESTION])[0]
        self.assertEqual(spec["question"], self.QUESTION["question"])
        self.assertNotIn("question", cf.field_specs(FIELDS)[0])
        self.assertIn("this contract's answer to that question", cf._SYSTEM)

    def test_reads_the_chunk_the_question_is_about_first(self):
        chunks = ["Definitions and parties.", "Fees are due monthly.", "Neither party may assign without consent of the other."]
        spec = cf.field_specs([{**self.QUESTION, "fieldLabel": "Q1"}])
        self.assertEqual(cf.rank_chunks(chunks, spec)[0], 2)

    def test_asks_the_question_and_checks_the_answer_like_any_field(self):
        seen = {}

        class LLM:
            async def ainvoke(self, messages, config=None):
                seen["system"] = messages[0].content
                return SimpleNamespace(content=json.dumps({"customFields": {
                    "question_ab12": {"value": False, "confidence": 0.9, "quote": "Neither party may assign this Agreement without the prior written consent of the other party."},
                }}))

        async def fake_resolve(*a, **k):
            return SimpleNamespace(llm=LLM(), callbacks=[])

        with patch.object(cf, "resolve_llm", fake_resolve):
            found, _, _ = asyncio.run(cf.extract_custom_fields(self.ASSIGN_DOC, [self.QUESTION]))
        self.assertIn(self.QUESTION["question"], seen["system"])
        self.assertIs(found["question_ab12"]["value"], False)
        self.assertEqual(found["question_ab12"]["confidence"], 0.9)
        self.assertNotIn("issue", found["question_ab12"])

    def test_the_route_takes_a_question(self):
        from app.routes.extract_fields import ExtractFieldsRequest

        req = ExtractFieldsRequest(plainText=self.ASSIGN_DOC, fields=[self.QUESTION])
        self.assertEqual(req.fields[0].model_dump()["question"], self.QUESTION["question"])
        plain = ExtractFieldsRequest(plainText="x", fields=[FIELDS[1]])
        self.assertIsNone(plain.fields[0].question)


class OpenEnded(unittest.TestCase):
    def test_names_the_fields_the_org_tracks_so_findings_dont_repeat_them(self):
        from app.agents.review_agent import _build_custom_fields_prompt

        prompt = _build_custom_fields_prompt("SOW", ["PO number", "Expense approver"])
        self.assertIn("do not report them as open-ended findings: PO number; Expense approver.", prompt)
        self.assertNotIn("customFields", prompt)  # A5: asked for in their own pass
        self.assertNotIn("already tracks", _build_custom_fields_prompt("SOW", []))


if __name__ == "__main__":
    unittest.main()
