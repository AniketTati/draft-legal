"""docs/41 Part 9 — /compliance/facts reads facts with quotes; the API decides applicability.

The model is mocked: these pin the parsing (keys, types, quote grounding,
confidence caps) and the route's shape, never a live call.

Run: cd apps/agents && python -m pytest tests/test_compliance_facts.py -q
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import patch

from app.routes import compliance
from app.routes.compliance import (
    FACT_KINDS,
    UNGROUNDED_CONFIDENCE_CAP,
    VALID_FRAMEWORKS,
    _normalise_frameworks,
    parse_facts_response,
)

TEXT = (
    "This Data Processing Agreement is between Acme GmbH, a company registered in Germany, "
    "and Beta Inc., a Delaware corporation. Supplier will process Customer’s employee personal data "
    "(names, work email addresses) on behalf of Customer. Payment is by bank transfer."
)


def _reply(facts):
    return json.dumps({"facts": facts})


def test_keys_types_and_grounded_quotes():
    out = parse_facts_response(_reply([
        {"key": "personal_data", "value": True, "quote": "Supplier will process Customer's employee personal data", "confidence": 0.95},
        {"key": "data_subject_regions", "value": ["DE"], "quote": "a company registered in Germany", "confidence": 0.7},
        {"key": "payment_card_data", "value": False, "quote": None, "confidence": 0.8},
        {"key": "processing_role", "value": "Processor", "quote": "on behalf of Customer", "confidence": 0.9},
        {"key": "health_data", "value": "no", "quote": None, "confidence": 0.85},
    ]), TEXT)
    by = {f["key"]: f for f in out}
    # The curly apostrophe in the text matches the straight one in the quote.
    assert by["personal_data"] == {"key": "personal_data", "value": True, "quote": "Supplier will process Customer's employee personal data", "confidence": 0.95}
    assert by["data_subject_regions"]["value"] == ["DE"]
    assert by["payment_card_data"] == {"key": "payment_card_data", "value": False, "quote": None, "confidence": 0.8}
    assert by["processing_role"]["value"] == "processor"
    assert by["health_data"]["value"] is False


def test_an_invented_quote_is_dropped_and_its_confidence_capped():
    out = parse_facts_response(_reply([
        {"key": "health_data", "value": True, "quote": "Supplier will process patient medical records", "confidence": 0.99},
    ]), TEXT)
    assert out == [{"key": "health_data", "value": True, "quote": None, "confidence": UNGROUNDED_CONFIDENCE_CAP}]


def test_a_present_fact_without_a_quote_is_not_trusted():
    out = parse_facts_response(_reply([{"key": "public_company", "value": True, "quote": None, "confidence": 0.9}]), TEXT)
    assert out[0]["confidence"] == UNGROUNDED_CONFIDENCE_CAP


def test_unknown_keys_duplicates_and_junk_are_dropped():
    out = parse_facts_response(_reply([
        {"key": "is_gdpr", "value": True},
        "junk",
        {"key": "personal_data", "value": True, "quote": "personal data", "confidence": 2},
        {"key": "personal_data", "value": False, "quote": None, "confidence": 0.9},
        {"key": "processing_role", "value": "landlord", "quote": None, "confidence": 0.9},
        {"key": "industry", "value": "Technology", "quote": "Data Processing Agreement", "confidence": "high"},
    ]), TEXT)
    assert [f["key"] for f in out] == ["personal_data", "processing_role", "industry"]
    assert out[0]["confidence"] == 1.0          # clamped
    assert out[1]["value"] is None              # not a known role
    assert out[2] == {"key": "industry", "value": "technology", "quote": "Data Processing Agreement", "confidence": 0.5}


def test_fenced_output_parses():
    content = "```json\n" + _reply([{"key": "cross_border_transfer", "value": None, "quote": None, "confidence": 0.3}]) + "\n```"
    assert parse_facts_response(content, TEXT) == [{"key": "cross_border_transfer", "value": None, "quote": None, "confidence": 0.3}]


def test_fact_kinds_match_the_shared_list():
    assert set(FACT_KINDS) == {
        "personal_data", "personal_data_categories", "data_subject_regions", "health_data", "hipaa_covered_entity",
        "payment_card_data", "financial_reporting_impact", "public_company", "party_jurisdictions",
        "processing_role", "cross_border_transfer", "industry",
    }


class _FakeLlm:
    def __init__(self, content):
        self.content = content
        self.calls = []

    async def ainvoke(self, messages, config=None):
        self.calls.append(messages)
        return SimpleNamespace(content=self.content)


def test_route_makes_one_fast_call_and_returns_parsed_facts():
    llm = _FakeLlm(_reply([{"key": "personal_data", "value": True, "quote": "employee personal data", "confidence": 0.9}]))
    tiers = []

    async def fake_resolve(tier, **kwargs):
        tiers.append(tier)
        return SimpleNamespace(llm=llm, callbacks=[], model="fake-model", provider="fake")

    with patch.object(compliance, "resolve_llm", fake_resolve):
        res = asyncio.run(compliance.compliance_facts(compliance.ComplianceFactsRequest(plainText=TEXT, orgId="org_1")))
    assert tiers == ["fast"]
    assert len(llm.calls) == 1
    assert res == {"facts": [{"key": "personal_data", "value": True, "quote": "employee personal data", "confidence": 0.9}], "model": "fake-model", "provider": "fake"}


def test_route_with_empty_text_makes_no_call():
    async def fail(*a, **k):
        raise AssertionError("no model call for empty text")

    with patch.object(compliance, "resolve_llm", fail):
        assert asyncio.run(compliance.compliance_facts(compliance.ComplianceFactsRequest(plainText="  "))) == {"facts": []}


def test_new_frameworks_and_decided_applicability():
    assert {"UK_GDPR", "PCI_DSS"} <= set(VALID_FRAMEWORKS)
    raw = [{"framework": "PCI_DSS", "applicable": False, "status": "not_applicable", "score": 100, "checks": []}]
    assert _normalise_frameworks(raw, ["PCI_DSS"])[0]["applicable"] is False
    decided = _normalise_frameworks(raw, ["PCI_DSS"], decided=True)[0]
    assert decided["applicable"] is True and decided["status"] == "gaps"
