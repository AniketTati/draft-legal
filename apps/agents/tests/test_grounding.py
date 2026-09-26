"""Y6 — the model can't present what no tool returned (app/grounding.py).

Standard library only: `python -m unittest discover -s tests -t .` in apps/agents.
"""
import json
import unittest

from app.grounding import (
    classify_result, model_content, nothing_found_note, record_ids, ungrounded_ids, ungrounded_notice,
)

FRAME = "<<<UNTRUSTED_TOOL_DATA>>>\n{}\n<<<END_UNTRUSTED_TOOL_DATA>>>"
CUID = "cmsl8z3ba002mpiwrysshxlgj"
INVENTED = "cm4x9k2b10000clause8abcd1"
UUID = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f"


class ClassifyResult(unittest.TestCase):
    def test_empty_results(self):
        for result in [
            "", "[]", "null",
            json.dumps({"results": [], "total": 0, "totalMatching": 0, "facets": {"type": []}}),
            json.dumps({"items": [], "total": 0}),
            json.dumps({"results": [], "coverage": {"returned": 0, "totalMatching": 0, "complete": True}}),
            json.dumps({"count": 0}),
        ]:
            with self.subTest(result=result):
                self.assertEqual(classify_result(result), "empty")

    def test_not_found_results(self):
        # X78: redline_propose on a version with no extracted clauses.
        x78 = '{"error":"redline_propose_failed","status":404,"detail":{"detail":"This version has no extracted clauses yet","clauses":[]}}'
        for result in [
            x78,
            json.dumps({"found": False, "reason": "no counterparty by that name"}),
            json.dumps({"error": "Clause not found", "clauses": [{"id": CUID}]}),
            json.dumps({"error": "NOT_FOUND"}),
            "Tool error: 404 Not Found",
        ]:
            with self.subTest(result=result):
                self.assertEqual(classify_result(result), "not_found")

    def test_ordinary_results_are_found(self):
        for result in [
            json.dumps({"results": [{"id": CUID, "title": "Acme MSA"}], "total": 1, "totalMatching": 1}),
            json.dumps({"contract": {"id": CUID}, "clauses": []}),
            json.dumps({"id": CUID, "title": "Acme MSA", "obligations": []}),
            json.dumps([{"id": CUID}]),
            json.dumps({"error": "rate_limited", "detail": "try again"}),   # an error, not a miss
            json.dumps({"ok": True}),
            "The clause says the notice was not found in the annex, so the parties agreed to extend the term by one year and review it at the next renewal.",
        ]:
            with self.subTest(result=result):
                self.assertEqual(classify_result(result), "found")


class ModelContent(unittest.TestCase):
    def test_every_empty_or_not_found_result_carries_the_note_outside_the_frame(self):
        for tool, result in [("contract_search", '{"results": [], "total": 0}'), ("redline_propose", '{"error":"x","status":404}')]:
            with self.subTest(tool=tool):
                framed = FRAME.format(result)
                content = model_content(tool, result, framed)
                self.assertTrue(content.startswith(framed))
                note = content[len(framed):]
                self.assertIn(f"`{tool}`", note)
                self.assertIn("Do NOT supply ids, names, clauses, figures or quotes that no tool returned", note)
                self.assertNotIn("UNTRUSTED", note)

    def test_a_result_with_something_in_it_carries_none(self):
        result = json.dumps({"results": [{"id": CUID}], "total": 1})
        framed = FRAME.format(result)
        self.assertEqual(model_content("contract_search", result, framed), framed)

    def test_the_note_says_which_kind_of_nothing(self):
        self.assertIn("found nothing", nothing_found_note("t", "empty"))
        self.assertIn("found no such record", nothing_found_note("t", "not_found"))


class Grounding(unittest.TestCase):
    def test_record_ids_are_cuids_and_uuids(self):
        text = f"See {CUID} and {UUID}; not characterisationsxyzabcd, v2, or {CUID}x."
        self.assertEqual(record_ids(text), [CUID, UUID])

    def test_an_id_no_tool_returned_is_flagged(self):
        known = [json.dumps({"results": [{"id": CUID, "title": "Acme SOW"}]}), "user: redline section 8"]
        answer = f"Section 8 of Acme SOW ({CUID}) is clause {INVENTED}."
        self.assertEqual(ungrounded_ids(answer, known), [INVENTED])
        notice = ungrounded_notice([INVENTED])
        self.assertIn(f"`{INVENTED}`", notice)
        self.assertIn("no tool returned", notice)

    def test_ids_the_tools_or_the_user_gave_are_not(self):
        known = [json.dumps({"id": CUID}), f"The user is looking at contract {UUID}"]
        self.assertEqual(ungrounded_ids(f"Contract {CUID}, see also {UUID}.", known), [])
        self.assertEqual(ungrounded_ids("No ids here.", known), [])

    def test_the_notice_names_at_most_three(self):
        ids = [f"c{str(i) * 24}"[:25] for i in range(1, 6)]
        self.assertIn("and 2 more", ungrounded_notice(ids))


if __name__ == "__main__":
    unittest.main()
