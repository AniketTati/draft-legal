"""docs/39 D3 — contract_search filters, sorts and shows any captured field.

Run: `python -m unittest discover -s tests -t .` in apps/agents.
"""
from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import patch

from app.tools.contract_search import build_contract_search


class _Response:
    status_code = 200
    text = '{"results": [], "totalMatching": 0}'


class FieldSearch(unittest.TestCase):
    def test_sends_field_conditions_fields_and_a_field_sort(self):
        sent = {}

        async def post(self, url, json=None, headers=None):  # noqa: A002 — httpx's own name
            sent.update(json)
            return _Response()

        tool = build_contract_search("org-1", "user-1")
        with patch("httpx.AsyncClient.post", post):
            out = asyncio.run(tool.coroutine(
                type="SOW",
                field_conditions=["confidentiality period >= 3 years", "region in EMEA, APAC"],
                fields=["payment terms"],
                sort_by_field="confidentiality period",
                sort_order="asc",
            ))
        self.assertEqual(json.loads(out)["totalMatching"], 0)
        self.assertEqual(sent["fieldConditions"], ["confidentiality period >= 3 years", "region in EMEA, APAC"])
        self.assertEqual(sent["fields"], ["payment terms"])
        self.assertEqual(sent["sortByField"], "confidentiality period")
        self.assertEqual((sent["type"], sent["sortOrder"]), ("SOW", "asc"))

    def test_leaves_them_out_when_unused(self):
        sent = {}

        async def post(self, url, json=None, headers=None):  # noqa: A002
            sent.update(json)
            return _Response()

        with patch("httpx.AsyncClient.post", post):
            asyncio.run(build_contract_search("org-1").coroutine(query="Acme"))
        self.assertNotIn("fieldConditions", sent)
        self.assertNotIn("fields", sent)
        self.assertNotIn("sortByField", sent)

    def test_conditions_are_plain_strings_for_every_model_provider(self):
        schema = build_contract_search("org-1").args_schema.model_json_schema()
        prop = schema["properties"]["field_conditions"]
        items = next(s for s in prop.get("anyOf", [prop]) if s.get("type") == "array")["items"]
        self.assertEqual(items, {"type": "string"})


if __name__ == "__main__":
    unittest.main()
