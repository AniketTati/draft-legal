"""docs/41 Part 13 — the amendment drafter's deterministic half: a quote the
clause doesn't hold is dropped, and an empty draft says so.

Run:  cd apps/agents && python -m pytest tests/test_amendment_language.py -q
"""
from __future__ import annotations

from app.routes.amendment_language import AmendmentClause, ground_quote, shape_draft

CLAUSE = "Payment is due within thirty (30) days of the date of invoice.”"
ITEM = AmendmentClause(clauseId="c5", clauseText=CLAUSE, sectionRef="5", instruction="45 days")


def test_quote_held_by_the_clause_is_kept_despite_spacing():
    assert ground_quote("within  thirty (30)\ndays", CLAUSE) == "within  thirty (30)\ndays"


def test_quote_not_in_the_clause_is_dropped():
    assert ground_quote("within sixty (60) days", CLAUSE) is None
    assert ground_quote(None, CLAUSE) is None
    assert ground_quote("a", CLAUSE) is None


def test_shape_keeps_grounded_quote_and_words():
    out = shape_draft(ITEM, {"proposedText": " Payment is due within forty-five (45) days. ", "rationale": "As asked.", "quote": "thirty (30) days"})
    assert out == {"clauseId": "c5", "proposedText": "Payment is due within forty-five (45) days.", "rationale": "As asked.",
                   "quote": "thirty (30) days", "error": None}


def test_shape_reports_an_empty_draft():
    out = shape_draft(ITEM, {"proposedText": "  "})
    assert out["proposedText"] is None and out["error"]
