"""docs/39 A1/A15 — /review/run returns what to save and the run's real token use.

Run: `python -m unittest discover -s tests -t .` in apps/agents.
"""
from __future__ import annotations

import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.routes import review
from app.usage_meter import UsageMeter, current_meter, metering


def _response(pairs):
    """A LangChain LLMResult-like object: one generation per (input, output) pair."""
    gens = [[SimpleNamespace(message=SimpleNamespace(usage_metadata={"input_tokens": i, "output_tokens": o}))] for i, o in pairs]
    return SimpleNamespace(generations=gens, llm_output=None)


class Meter(unittest.TestCase):
    def test_totals_each_call_by_the_model_that_ran(self):
        meter = UsageMeter()
        flash = meter.handler("gemini", "gemini-2.5-flash", "platform")
        byok = meter.handler("anthropic", "claude-sonnet-4-5", "byok")
        asyncio.run(flash.on_llm_end(_response([(1200, 300)])))
        asyncio.run(flash.on_llm_end(_response([(800, 100)])))
        asyncio.run(byok.on_llm_end(SimpleNamespace(generations=[], llm_output={"token_usage": {"prompt_tokens": 50, "completion_tokens": 7}})))
        s = meter.summary()
        self.assertEqual((s["calls"], s["inputTokens"], s["outputTokens"]), (3, 2050, 407))
        by = {m["model"]: m for m in s["byModel"]}
        self.assertEqual(by["gemini-2.5-flash"], {"provider": "gemini", "model": "gemini-2.5-flash", "source": "platform", "calls": 2, "inputTokens": 2000, "outputTokens": 400})
        self.assertEqual(by["claude-sonnet-4-5"]["source"], "byok")

    def test_is_open_only_inside_its_block(self):
        self.assertIsNone(current_meter())
        with metering() as meter:
            self.assertIs(current_meter(), meter)
        self.assertIsNone(current_meter())


class Payloads(unittest.TestCase):
    def test_a_run_with_an_error_and_no_output_failed(self):
        failed = {"error": "model timed out"}
        self.assertTrue(review.run_failed(failed))
        contract, version = review.build_payloads(failed, None, [])
        self.assertEqual(contract["analysisStatus"], "FAILED")
        self.assertEqual(version, {})
        self.assertFalse(review.run_failed({"error": "validate step skipped", "summary": "An NDA."}))

    def test_a_run_becomes_the_contract_and_version_payloads(self):
        result = {
            "summary": "A supply agreement.", "contractType": "MSA", "suggestedTitle": "Unnamed Contract",
            "keyTerms": {"governingLaw": "Delaware", "effectiveDate": "2025-01-01",
                         "parties": [{"name": "Our Org Inc", "role": "Customer"}, {"name": "Initech LLC", "role": "Vendor", "address": "1 Main St"}]},
            "fieldConfidence": {"parties": {"confidence": 0.9, "quote": "between Our Org Inc and Initech LLC"}},
            "clauseSegments": [{"clauseType": "payment", "content": "Fees are due in 30 days.", "sortOrder": 0}],
            "customExtracted": {"customFields": {"po_number": {"value": "PO-1", "confidence": 0.8}, "_forged": {"value": "x"}}},
        }
        contract, version = review.build_payloads(result, "Our Org", [{"fieldKey": "po_number"}])
        self.assertEqual(contract["analysisStatus"], "DONE")
        self.assertNotIn("title", contract)  # a placeholder title is dropped
        self.assertEqual(contract["counterpartyName"], "Initech LLC")
        self.assertEqual(contract["effectiveDate"], "2025-01-01T00:00:00.000Z")
        self.assertEqual(contract["keyTerms"]["counterpartyAddress"], "1 Main St")
        self.assertEqual(contract["metadata"]["po_number"], "PO-1")
        self.assertNotIn("_forged", contract["metadata"])
        self.assertEqual(version["clauseSegments"][0]["clauseType"], "payment")


class RunRoute(unittest.TestCase):
    def test_streams_heartbeats_then_the_answer(self):
        async def slow_run(text, **kwargs):
            await asyncio.sleep(0.05)
            return {"summary": "An NDA.", "contractType": "NDA"}

        async def answer(req):
            resp = await review.run_review_route(req)
            return b"".join([chunk async for chunk in resp.body_iterator])

        req = review.ReviewRequest(contractId="c1", versionId="v1", plainText="...")
        with patch.object(review, "run_review", slow_run), patch.object(review, "_HEARTBEAT_SECONDS", 0.01):
            raw = asyncio.run(answer(req))
        self.assertTrue(raw.startswith(b" "))
        self.assertEqual(json.loads(raw)["contract"]["type"], "NDA")

    def test_an_exception_is_a_failed_answer(self):
        async def boom(text, **kwargs):
            raise RuntimeError("provider down")

        req = review.ReviewRequest(contractId="c1", versionId="v1", plainText="...")
        with patch.object(review, "run_review", boom):
            out = asyncio.run(review.run_extraction(req))
        self.assertTrue(out["failed"])
        self.assertIn("provider down", out["error"])

    def test_returns_what_to_save_and_the_use_it_took(self):
        async def fake_run_review(text, **kwargs):
            meter = current_meter()
            meter.add("gemini", "gemini-2.5-flash", "platform", 5000, 900)
            return {"summary": "An NDA.", "contractType": "NDA", "keyTerms": {"governingLaw": "New York"}}

        body = review.ReviewRequest(contractId="c1", versionId="v1", plainText="This NDA…", orgName="Our Org")
        with patch.object(review, "run_review", fake_run_review):
            out = asyncio.run(review.run_extraction(body))
        self.assertFalse(out["failed"])
        self.assertEqual(out["contract"]["jurisdiction"], "New York")
        self.assertEqual(out["usage"]["inputTokens"], 5000)
        self.assertEqual(out["usage"]["byModel"][0]["model"], "gemini-2.5-flash")

    def test_a_run_that_produced_nothing_says_so(self):
        async def fake_run_review(text, **kwargs):
            return {"error": "rate limited"}

        body = review.ReviewRequest(contractId="c1", versionId="v1", plainText="…")
        with patch.object(review, "run_review", fake_run_review):
            out = asyncio.run(review.run_extraction(body))
        self.assertTrue(out["failed"])
        self.assertEqual(out["error"], "rate limited")


class ReadingNote(unittest.TestCase):
    def test_tells_the_model_the_language_and_the_date_order(self):
        from app.agents.review_agent import _reading_note
        note = _reading_note("fr", "DMY")
        self.assertIn("written in French", note)
        self.assertIn("03/04/2025 is 3 April 2025", note)
        self.assertIn("month first: 03/04/2025 is 4 March 2025", _reading_note(None, "MDY"))
        self.assertEqual(_reading_note("en", None), "")

    def test_the_run_route_passes_them_on(self):
        seen = {}

        async def fake_run_review(text, **kwargs):
            seen.update(kwargs)
            return {"summary": "Un contrat.", "contractType": "NDA"}

        body = review.ReviewRequest(contractId="c1", versionId="v1", plainText="Le contrat", language="fr", dateOrder="DMY")
        with patch.object(review, "run_review", fake_run_review):
            asyncio.run(review.run_extraction(body))
        self.assertEqual((seen["language"], seen["date_order"]), ("fr", "DMY"))


if __name__ == "__main__":
    unittest.main()
