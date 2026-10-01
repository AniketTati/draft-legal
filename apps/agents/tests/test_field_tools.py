"""docs/39 C5 — the assistant sets a field or adds one, on an Apply card, never silently.

Run: `python -m unittest discover -s tests -t .` in apps/agents.
"""
from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import patch

from app.tools.contract_field_set import build_contract_field_set
from app.tools.field_create import build_field_create


class _Response:
    def __init__(self, body: dict, status: int = 200):
        self.status_code = status
        self._body = body
        self.text = json.dumps(body)

    def json(self):
        return self._body


def _preview(body: dict):
    sent = {}

    async def post(self, url, json=None, headers=None):  # noqa: A002 — httpx's own name
        sent.update(url=url, body=json)
        return _Response(body)

    return post, sent


PLAN = {
    "ok": True, "contractId": "c1", "contractTitle": "Acme MSA",
    "field": {"key": "paymentTermsDays", "label": "Payment terms", "type": "number"},
    "display": "45 days", "before": {"display": "30 days", "source": "ai", "checked": False, "by": None},
}


class FieldSet(unittest.TestCase):
    def test_offers_a_card_saying_the_value_now_and_the_new_one(self):
        post, sent = _preview(PLAN)
        with patch("httpx.AsyncClient.post", post):
            card = asyncio.run(build_contract_field_set("org-1", "user-1").coroutine(contract_id="c1", field="payment terms", value="45 days"))
        self.assertTrue(sent["url"].endswith("/api/internal/ai/tools/contract_field_preview"))
        self.assertEqual(sent["body"], {"orgId": "org-1", "userId": "user-1", "contractId": "c1", "field": "payment terms", "value": "45 days"})
        self.assertTrue(card["awaitingConfirmation"])
        self.assertTrue(card["reversible"])
        self.assertEqual(card["args"], {"contractId": "c1", "field": "paymentTermsDays", "value": "45 days"})
        self.assertEqual(card["preview"]["summary"], "Set Payment terms on Acme MSA to 45 days (now 30 days, read by the AI)")
        self.assertEqual(card["preview"]["diff"], [{"field": "Payment terms", "before": "30 days", "after": "45 days"}])

    def test_names_the_person_whose_value_it_would_replace(self):
        plan = {**PLAN, "before": {"display": "60 days", "source": "user", "checked": True, "by": "Maya Chen"}}
        post, _ = _preview(plan)
        with patch("httpx.AsyncClient.post", post):
            card = asyncio.run(build_contract_field_set("org-1", "user-1").coroutine(contract_id="c1", field="payment terms", value="45 days"))
        self.assertIn("(now 60 days, set by Maya Chen)", card["preview"]["summary"])

    def test_hands_back_what_it_cannot_do_without_a_card(self):
        post, _ = _preview({"error": "unknown_field", "note": 'No field called "PO". Fields with a similar name: PO number (po_number).'})
        with patch("httpx.AsyncClient.post", post):
            out = asyncio.run(build_contract_field_set("org-1", "user-1").coroutine(contract_id="c1", field="PO", value="4417"))
        self.assertEqual(out["error"], "unknown_field")
        self.assertIn("PO number (po_number)", out["note"])
        self.assertNotIn("awaitingConfirmation", out)


class FieldCreate(unittest.TestCase):
    def test_offers_a_card_for_the_new_field(self):
        card = asyncio.run(build_field_create("org-1").coroutine(label="PO number", type="text", contract_type="SOW", description="The customer PO"))
        self.assertEqual(card["args"], {"label": "PO number", "fieldType": "text", "contractType": "SOW", "helpText": "The customer PO"})
        self.assertEqual(card["preview"]["summary"], 'Add a field "PO number" (text) on SOW contracts')
        self.assertTrue(card["reversible"])

    def test_asks_for_the_choices_of_a_choice(self):
        out = asyncio.run(build_field_create("org-1").coroutine(label="Region", type="select"))
        self.assertEqual(out["error"], "missing_options")


class Registered(unittest.TestCase):
    def test_both_are_offered_and_the_prompt_says_when_to_use_them(self):
        from app.orchestrator import AGENT_SYSTEM_PROMPT
        from app.tools import get_read_tools

        names = {t.name for t in get_read_tools("org-1", "user-1")}
        self.assertTrue({"contract_field_set", "field_create"} <= names)
        self.assertIn("contract_field_set", AGENT_SYSTEM_PROMPT)
        self.assertIn("field_create", AGENT_SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
