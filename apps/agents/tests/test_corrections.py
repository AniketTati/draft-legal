"""docs/39 I2 — what the org's reviewers corrected earlier readings of a field
to reaches the extraction, as patterns to follow and never values to copy.

Run: `python -m unittest discover -s tests -t .` in apps/agents.
"""
from __future__ import annotations

import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.agents import review_agent as ra
from app.routes.review import ReviewRequest

CORRECTIONS = [{
    "key": "governingLaw", "label": "Governing law",
    "examples": [
        {"read": "State of Delaware", "corrected": "Delaware", "quote": "governed by the laws of the State of Delaware"},
        {"read": "Commonwealth of Massachusetts", "corrected": "Massachusetts"},
    ],
}]


class _Llm:
    def __init__(self, reply: dict):
        self.reply = reply
        self.systems: list[str] = []

    async def ainvoke(self, messages, config=None):  # noqa: ARG002
        self.systems.append(messages[0].content)
        return SimpleNamespace(content=json.dumps(self.reply))


def _state(**over):
    state = {
        "plain_text": "This Agreement is governed by the laws of the State of New York.",
        "contract_type": "NDA", "custom_fields": [], "org_id": "org-1", "language": None, "date_order": None,
        "corrections": CORRECTIONS, "clause_segments": [], "raw_fields": {}, "clause_flags": {}, "custom_extracted": {},
        "validated_fields": {}, "error": None,
    }
    state.update(over)
    return state


class Note(unittest.TestCase):
    def test_lists_the_fields_with_their_corrections(self):
        note = ra._corrections_note(CORRECTIONS)
        self.assertIn("CORRECTIONS THE ORGANISATION'S REVIEWERS MADE", note)
        self.assertIn("never from an example", note)
        body = json.loads(note.split(":\n", 1)[1])
        self.assertEqual(body[0]["label"], "Governing law")
        self.assertEqual(body[0]["corrections"][0], {"read": "State of Delaware", "corrected": "Delaware", "quote": "governed by the laws of the State of Delaware"})
        self.assertEqual(body[0]["corrections"][1], {"read": "Commonwealth of Massachusetts", "corrected": "Massachusetts"})

    def test_says_nothing_without_corrections(self):
        self.assertEqual(ra._corrections_note(None), "")
        self.assertEqual(ra._corrections_note([{"key": "x", "examples": [{"read": "a"}]}]), "")


class Prompts(unittest.TestCase):
    def test_extraction_and_validation_are_told(self):
        llm = _Llm({"clauseSegments": [], "rawFields": {"governingLaw": {"value": "New York", "quote": "laws of the State of New York"}}, "clauseFlags": {}})

        async def resolve(*_a, **_k):
            return SimpleNamespace(llm=llm, provider="fake", model="fake", callbacks=[])

        with patch.object(ra, "resolve_llm", resolve):
            state = asyncio.run(ra._extract(_state()))
            llm.reply = {"validatedFields": {"governingLaw": {"value": "New York", "confidence": 0.9}}}
            asyncio.run(ra._validate(state))
        self.assertIn("CORRECTIONS THE ORGANISATION'S REVIEWERS MADE", llm.systems[0])
        self.assertIn("CORRECTIONS THE ORGANISATION'S REVIEWERS MADE", llm.systems[-1])

    def test_the_request_carries_them(self):
        body = ReviewRequest(contractId="c1", versionId="v1", plainText="…", corrections=CORRECTIONS)
        self.assertEqual(body.corrections[0].examples[0].corrected, "Delaware")
        self.assertEqual(ReviewRequest(contractId="c1", versionId="v1", plainText="…").corrections, [])


class CustomFields(unittest.TestCase):
    def test_a_custom_field_carries_its_corrections_into_the_pass(self):
        from app.agents.custom_fields import _SYSTEM, field_specs
        specs = field_specs([{
            "fieldKey": "po_number", "fieldLabel": "PO number", "fieldType": "text",
            "corrections": [{"read": "PO", "corrected": "PO-4417", "quote": "Purchase Order: PO-4417"}, {"read": "x"}],
        }])
        self.assertEqual(specs[0]["corrections"], [{"read": "PO", "corrected": "PO-4417", "quote": "Purchase Order: PO-4417"}])
        self.assertIn("Where a field has corrections", _SYSTEM)
        body = ReviewRequest(contractId="c1", versionId="v1", plainText="…", customFields=[{
            "fieldKey": "po_number", "fieldLabel": "PO number", "fieldType": "text",
            "corrections": [{"read": "PO", "corrected": "PO-4417"}],
        }])
        self.assertEqual(body.customFields[0].model_dump()["corrections"], [{"read": "PO", "corrected": "PO-4417", "quote": None}])


if __name__ == "__main__":
    unittest.main()
