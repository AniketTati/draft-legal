"""docs/39 A6 — a long contract's chunks each read every field: all their
readings are kept, the field takes the first with its words in the document,
and when chunks read it differently every reading goes back with it.

Run: `python -m unittest discover -s tests -t .` in apps/agents.
"""
from __future__ import annotations

import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.agents import custom_fields as cf
from app.agents import review_agent as ra
from app.agents.candidates import Readings, is_reading, same
from app.routes.review import build_payloads

FILLER = "The parties shall cooperate in good faith in all matters under this Agreement. " * 800  # ~64K characters
BODY = "12.1 Either party may terminate this Agreement for convenience on thirty (30) days' written notice."
SCHEDULE = "Schedule 4, paragraph 2: Either party may terminate for convenience on sixty (60) days' prior written notice."
RENEWS = "3.2 This Agreement renews automatically for successive one-year terms."
LONG = f"{FILLER}{BODY} {RENEWS} {FILLER}{FILLER}{SCHEDULE} {FILLER}"


class Readings_(unittest.TestCase):
    def test_an_answer_that_says_nothing_is_no_reading(self):
        for empty in (None, {"value": None}, {"value": ""}, {"value": []}, {"value": "N/A"}, {"value": "null"}, {"value": False}, {"value": "false"}):
            self.assertFalse(is_reading(empty), empty)
        self.assertTrue(is_reading({"value": False, "quote": "shall not renew automatically"}))
        self.assertTrue(is_reading({"value": "30 days"}))

    def test_the_same_term_however_it_is_written(self):
        self.assertTrue(same("30 days", "thirty (30) days"))
        self.assertTrue(same("120,000", "USD 120000"))
        self.assertTrue(same(120000, "$120,000.00"))
        self.assertTrue(same("Delaware", "the State of Delaware"))
        self.assertTrue(same(True, "yes"))
        self.assertFalse(same("30 days", "30 business days"))
        self.assertFalse(same("30 days", "60 days"))
        self.assertFalse(same("Delaware", "New York"))
        self.assertFalse(same("2025-01-15", "2025-02-01"))
        # A name inside another counts only when it's a word or more.
        self.assertFalse(same("A", "Annual"))

    def test_settles_on_the_first_reading_with_its_words_in_the_document(self):
        doc = f"{BODY} {SCHEDULE}"
        r = Readings()
        body = {"value": "30 days", "quote": "terminate this Agreement for convenience on thirty (30) days' written notice"}
        overlap = {"value": "thirty (30) days", "quote": "for convenience on thirty (30) days' written notice"}
        r.add("terminationNotice", body, 0)
        r.add("terminationNotice", overlap, 1)
        self.assertEqual(r.settle("terminationNotice", doc), (body, None))
        # A different reading with its words in the document is a disagreement.
        schedule = {"value": "60 days", "quote": "terminate for convenience on sixty (60) days' prior written notice"}
        r.add("terminationNotice", schedule, 1)
        primary, candidates = r.settle("terminationNotice", doc)
        self.assertIs(primary, body)
        self.assertEqual([c["value"] for c in candidates], ["30 days", "60 days"])
        self.assertEqual(candidates[1]["quote"], schedule["quote"])
        # One whose words aren't there is no disagreement; a first one whose words aren't there loses to one whose are.
        r2 = Readings()
        r2.add("x", {"value": "45 days", "quote": "forty-five days, as agreed on the phone"}, 0)
        r2.add("x", {"value": "30 days", "quote": "thirty (30) days' written notice"}, 1)
        r2.add("x", {"value": "90 days"}, 1)
        primary, candidates = r2.settle("x", doc)
        self.assertEqual(primary["value"], "30 days")
        self.assertIsNone(candidates)


class Merge(unittest.TestCase):
    def test_an_empty_answer_never_keeps_a_later_real_one_out(self):
        merged = ra._merge_raw_fields({}, {"autoRenew": {"value": False, "quote": None}, "currency": {"value": ""}, "governingLaw": {"value": "Delaware"}})
        merged = ra._merge_raw_fields(merged, {"autoRenew": {"value": True, "quote": RENEWS}, "currency": {"value": "USD"}, "governingLaw": {"value": "New York"}})
        self.assertEqual(merged["autoRenew"]["value"], True)
        self.assertEqual(merged["currency"]["value"], "USD")
        # A real first reading still wins the merge (which one governs is settled after).
        self.assertEqual(merged["governingLaw"]["value"], "Delaware")


def _state(text: str, **over) -> dict:
    state = {
        "plain_text": text, "contract_type": "MSA", "custom_fields": [], "org_id": "org-1", "language": None,
        "date_order": None, "corrections": [], "custom_clause_types": [], "clause_segments": [], "raw_fields": {},
        "field_candidates": {}, "clause_flags": {}, "custom_extracted": {}, "validated_fields": {}, "error": None,
    }
    state.update(over)
    return state


class _ChunkLlm:
    """Answers each chunk from what that chunk says."""

    def __init__(self) -> None:
        self.calls = 0

    async def ainvoke(self, messages, config=None):  # noqa: ARG002
        self.calls += 1
        chunk = messages[1].content
        raw: dict = {"governingLaw": {"value": "Delaware", "quote": None}}
        types: dict = {}
        if BODY in chunk:
            raw["terminationNotice"] = {"value": "30 days", "quote": "terminate this Agreement for convenience on thirty (30) days' written notice"}
            raw["autoRenew"] = {"value": True, "quote": "renews automatically for successive one-year terms"}
            types["liabilityCapMultiple"] = {"value": 1, "confidence": 0.8, "quote": "cooperate in good faith"}
        if SCHEDULE in chunk:
            raw["terminationNotice"] = {"value": "60 days", "quote": "terminate for convenience on sixty (60) days' prior written notice"}
            # A chunk that never mentions renewal says "false" without words to show: no reading.
            raw["autoRenew"] = {"value": False, "quote": None}
            types["liabilityCapMultiple"] = {"value": 2, "confidence": 0.7, "quote": "Schedule 4, paragraph 2"}
        return SimpleNamespace(content=json.dumps({"clauseSegments": [], "rawFields": raw, "typeFields": types, "clauseFlags": {}}))


class Extract(unittest.TestCase):
    def run_extract(self, text: str):
        llm = _ChunkLlm()

        async def resolve(*_a, **_k):
            return SimpleNamespace(llm=llm, provider="fake", model="fake", callbacks=[])

        with patch.object(ra, "resolve_llm", resolve):
            return asyncio.run(ra._extract(_state(text))), llm

    def test_a_long_contract_keeps_every_chunks_reading(self):
        self.assertGreater(len(ra._chunk_text(LONG)), 1)
        state, _ = self.run_extract(LONG)
        # The body's reading is the value; the schedule's goes with it.
        self.assertEqual(state["raw_fields"]["terminationNotice"]["value"], "30 days")
        self.assertEqual([c["value"] for c in state["field_candidates"]["terminationNotice"]], ["30 days", "60 days"])
        # The same reading in every chunk (the law), or a chunk's empty "false", is no disagreement.
        self.assertNotIn("governingLaw", state["field_candidates"])
        self.assertNotIn("autoRenew", state["field_candidates"])
        self.assertEqual(state["raw_fields"]["autoRenew"]["value"], True)
        cap = state["custom_extracted"]["typeFields"]["liabilityCapMultiple"]
        self.assertEqual(cap["value"], 1)
        self.assertEqual([c["value"] for c in cap["candidates"]], [1, 2])

    def test_a_contract_read_in_one_go_has_one_reading(self):
        state, _ = self.run_extract(f"{BODY} {SCHEDULE}")
        self.assertEqual(state["field_candidates"], {})
        self.assertNotIn("candidates", state["custom_extracted"]["typeFields"]["liabilityCapMultiple"])

    def test_run_review_sends_the_readings_with_the_field(self):
        final = _state(LONG, validated_fields={"terminationNotice": {"value": "30 days", "confidence": 0.9, "quote": "…", "section": "12.1", "issue": None}},
                       field_candidates={"terminationNotice": [{"value": "30 days", "quote": "a"}, {"value": "60 days", "quote": "b"}]},
                       summary="", contract_type_out="MSA", risk_score=None, risk_factors=[], overall_confidence=0.8)

        class Graph:
            async def ainvoke(self, _state):
                return final

        with patch.object(ra, "get_review_graph", lambda: Graph()):
            result = asyncio.run(ra.run_review(LONG))
        self.assertEqual(result["fieldConfidence"]["terminationNotice"]["candidates"], final["field_candidates"]["terminationNotice"])


class CustomPass(unittest.TestCase):
    def test_keeps_what_the_chunks_it_reads_say_about_a_field_already_answered(self):
        fields = [
            {"fieldKey": "notice_days", "fieldLabel": "Convenience notice", "fieldType": "duration"},
            {"fieldKey": "renewal", "fieldLabel": "Renewal", "fieldType": "text"},
        ]
        asked: list[str] = []

        class LLM:
            async def ainvoke(self, messages, config=None):  # noqa: ARG002
                chunk = messages[1].content
                asked.append(chunk)
                answers = {}
                if BODY in chunk:
                    answers["notice_days"] = {"value": "30 days", "confidence": 0.9, "quote": "thirty (30) days' written notice"}
                    answers["renewal"] = {"value": "one-year terms", "confidence": 0.8, "quote": "successive one-year terms"}
                if SCHEDULE in chunk:
                    answers["notice_days"] = {"value": "60 days", "confidence": 0.9, "quote": "sixty (60) days' prior written notice"}
                return SimpleNamespace(content=json.dumps({"customFields": answers}))

        async def resolve(*_a, **_k):
            return SimpleNamespace(llm=LLM(), provider="fake", model="fake", callbacks=[])

        # Two chunks: the body's, then the schedule's — which mentions the
        # fields' words most, so it's read first, and answers one field; the
        # body's is read for the other, and answers both.
        text = f"{FILLER}{BODY} {RENEWS} {FILLER}{SCHEDULE} {SCHEDULE} {SCHEDULE} {FILLER[:10_000]}"
        self.assertEqual(len(ra._chunk_text(text)), 2)
        with patch.object(cf, "resolve_llm", resolve):
            out, read, total = asyncio.run(cf.extract_custom_fields(text, fields))
        self.assertEqual((read, total), (2, 2))
        self.assertIn(SCHEDULE, asked[0])
        # The value is the reading first in the document; the schedule's goes with it.
        self.assertEqual(out["notice_days"]["value"], "30 days")
        self.assertEqual([c["value"] for c in out["notice_days"]["candidates"]], ["30 days", "60 days"])
        self.assertNotIn("candidates", out["renewal"])


class Payload(unittest.TestCase):
    def test_the_readings_reach_the_type_and_custom_fields(self):
        cands = [{"value": "30 days", "quote": "a"}, {"value": "60 days", "quote": "b"}]
        result = {
            "summary": "s", "contractType": "MSA", "keyTerms": {"terminationNotice": "30 days"},
            "fieldConfidence": {"terminationNotice": {"confidence": 0.9, "quote": "a", "candidates": cands}},
            "customExtracted": {
                "typeFields": {"liabilityCapMultiple": {"value": 1, "confidence": 0.8, "quote": "x", "candidates": [{"value": 1, "quote": "x"}, {"value": 2, "quote": "y"}]}},
                "customFields": {"notice_days": {"value": "30 days", "confidence": 0.9, "quote": "a", "candidates": cands}},
            },
        }
        contract, _ = build_payloads(result, None, [{"fieldKey": "notice_days"}])
        self.assertEqual(contract["fieldConfidence"]["terminationNotice"]["candidates"], cands)
        self.assertEqual(contract["metadata"]["_typeFields"]["liabilityCapMultiple"]["candidates"][1]["value"], 2)
        self.assertEqual(contract["metadata"]["_customFieldEvidence"]["notice_days"]["candidates"], cands)


if __name__ == "__main__":
    unittest.main()
