"""Golden tests for the deterministic half of obligation extraction.

The LLM half varies run to run and cannot be regression-tested. Everything
downstream of it — fence stripping, lenient parsing, key coercion, the caps —
must not vary at all, and a silent change there corrupts every obligation the
product stores. Before this file, the only thing standing between a change to
that layer and a production regression was the TypeScript compiler, which does
not read Python.

These are GOLDEN tests: each case pins the exact output for an exact input. A
diff here is not automatically a bug — it is a change someone has to look at
and either fix or accept by updating the expectation. That is the point.

Run:  cd apps/agents && python -m pytest tests/ -q
"""
from __future__ import annotations

import json

import pytest

from app.jsonish import loads_lenient
from app.routes.obligations import (
    _SYSTEM,
    MAX_OBLIGATIONS,
    MAX_QUOTE_CHARS,
    parse_obligations_response,
)

# ── The full-fidelity case ──────────────────────────────────────────────────

WELL_FORMED = json.dumps({
    "obligations": [
        {
            "id": "pay-monthly",
            "type": "payment",
            "description": "  Pay $50,000 monthly on the 15th  ",
            "owner": "customer",
            "dueDate": "2026-09-15",
            "recurrence": "monthly",
            "trigger": "invoice receipt",
            "quote": "Customer shall pay $50,000 on the 15th of each month.",
            "severity": "high",
            "sectionRef": "4.1",
        },
    ],
    "summary": "1 obligation extracted covering payment.",
})


def test_well_formed_payload_round_trips():
    assert parse_obligations_response(WELL_FORMED) == {
        "obligations": [
            {
                "id": "pay-monthly",
                "type": "payment",
                # description is the ONLY field that gets stripped.
                "description": "Pay $50,000 monthly on the 15th",
                "owner": "customer",
                "dueDate": "2026-09-15",
                "recurrence": "monthly",
                "trigger": "invoice receipt",
                "quote": "Customer shall pay $50,000 on the 15th of each month.",
                "severity": "high",
                "sectionRef": "4.1",
            },
        ],
        "summary": "1 obligation extracted covering payment.",
    }


# ── Defaults: what a sparse model response becomes ──────────────────────────

def test_missing_fields_take_their_documented_defaults():
    out = parse_obligations_response('{"obligations": [{}]}')
    assert out["obligations"] == [{
        "id": "o_0",              # positional, not random
        "type": "other",
        "description": "",
        "owner": "unknown",
        "dueDate": None,
        "recurrence": "unknown",
        "trigger": None,
        "quote": "",
        "severity": "medium",     # NOT low — an unlabelled obligation is medium
        "sectionRef": None,
    }]
    assert out["summary"] == ""


def test_falsy_values_fall_back_rather_than_persisting():
    """`or` semantics, pinned deliberately.

    Empty string and 0 are falsy, so they take the default rather than being
    stored. That is the current behaviour and it is load-bearing for dueDate:
    an empty-string date must become None, or `toDate` on the Node side would
    receive "" and store an invalid timestamp.
    """
    out = parse_obligations_response(json.dumps({
        "obligations": [{"id": "", "type": "", "dueDate": "", "severity": None, "sectionRef": ""}],
    }))
    o = out["obligations"][0]
    assert o["id"] == "o_0"
    assert o["type"] == "other"
    assert o["dueDate"] is None
    assert o["severity"] == "medium"
    assert o["sectionRef"] is None


def test_non_string_scalars_are_coerced_to_strings():
    """A model returning a number for `type` must not reach the database as one."""
    out = parse_obligations_response(json.dumps({
        "obligations": [{"id": 7, "type": 12, "description": 3.5, "severity": True}],
    }))
    o = out["obligations"][0]
    assert o == {
        "id": "7", "type": "12", "description": "3.5", "owner": "unknown",
        "dueDate": None, "recurrence": "unknown", "trigger": None,
        "quote": "", "severity": "True", "sectionRef": None,
    }


# ── Caps ────────────────────────────────────────────────────────────────────

def test_the_caps_are_the_values_the_prompt_promises():
    """Literal, on purpose.

    Every other cap assertion below is written against these constants, so on
    its own it would move WITH a change to them and catch nothing. Verified by
    mutation: raising MAX_OBLIGATIONS to 50 left the whole file green until
    this literal existed. The prompt tells the model "cap the list at 25"; if
    that number moves, _SYSTEM has to move with it.
    """
    assert MAX_OBLIGATIONS == 25
    assert MAX_QUOTE_CHARS == 240
    assert "Cap the list at 25 obligations" in _SYSTEM


def test_obligation_list_is_capped():
    many = {"obligations": [{"id": f"x{i}"} for i in range(35)]}
    out = parse_obligations_response(json.dumps(many))
    assert len(out["obligations"]) == 25
    # The cap takes the FIRST N, not a sample — the prompt asks the model to
    # rank by severity, so order carries meaning and must not be shuffled.
    assert out["obligations"][0]["id"] == "x0"
    assert out["obligations"][-1]["id"] == "x24"


def test_quote_is_truncated_at_the_documented_boundary():
    out = parse_obligations_response(json.dumps({"obligations": [{"quote": "z" * 290}]}))
    assert len(out["obligations"][0]["quote"]) == 240


def test_quote_cap_is_tighter_than_the_node_side():
    """Documents a real asymmetry rather than pretending it is not there.

    Python truncates the quote to 240 chars; obligation-extract.ts slices to
    4000 when it persists. The Node bound can therefore never bind, and a quote
    is already lossy before it reaches the database. Pinned so that anyone
    raising one bound sees that the other exists.
    """
    assert MAX_QUOTE_CHARS == 240


# ── Shapes that must not crash ──────────────────────────────────────────────

def test_non_dict_entries_are_skipped_without_shifting_ids():
    """A junk entry is dropped, and the positional id counts SURVIVORS.

    `o_{len(cleaned)}` is computed from the cleaned list, so ids stay dense.
    Pinned because a refactor to `enumerate(obligations)` would silently
    renumber every id after a dropped entry.
    """
    out = parse_obligations_response(json.dumps({
        "obligations": [{"description": "first"}, "not a dict", 42, {"description": "second"}],
    }))
    assert [o["id"] for o in out["obligations"]] == ["o_0", "o_1"]
    assert [o["description"] for o in out["obligations"]] == ["first", "second"]


@pytest.mark.parametrize("payload", [
    '{"summary": "nothing actionable"}',      # key absent
    '{"obligations": null, "summary": "x"}',  # key null
    '{"obligations": [], "summary": "x"}',    # key empty
])
def test_absent_or_empty_obligations_yield_an_empty_list(payload):
    assert parse_obligations_response(payload)["obligations"] == []


# ── Fence handling ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("wrapped", [
    '```json\n{"obligations": [{"id": "a"}], "summary": "s"}\n```',
    '```\n{"obligations": [{"id": "a"}], "summary": "s"}\n```',
    '  \n```json\n{"obligations": [{"id": "a"}], "summary": "s"}\n```  \n',
    'Here you go:\n```json\n{"obligations": [{"id": "a"}], "summary": "s"}\n```',
    '```json\n{"obligations": [{"id": "a"}], "summary": "s"}',   # never closed
])
def test_code_fences_are_stripped(wrapped):
    """Gemini fences JSON even when told not to — the reason jsonish exists."""
    out = parse_obligations_response(wrapped)
    assert out["obligations"][0]["id"] == "a"
    assert out["summary"] == "s"


def test_the_manual_fence_strip_is_redundant_with_loads_lenient():
    """Mutation finding, recorded rather than assumed.

    Disabling the `text.startswith("```")` block in parse_obligations_response
    left every test above green: loads_lenient already handles fences, prose
    preambles and unterminated fences. The manual strip earns nothing on any
    input the route actually sees.
    """
    for wrapped in [
        '```json\n{"obligations": [], "summary": "s"}\n```',
        '```\n{"obligations": [], "summary": "s"}\n```',
        'Here you go:\n```json\n{"obligations": [], "summary": "s"}\n```',
    ]:
        assert loads_lenient(wrapped) == {"obligations": [], "summary": "s"}


@pytest.mark.xfail(
    reason="KNOWN DEFECT: the manual fence-strip breaks input loads_lenient handles. "
           "A ``` inside a quoted string makes split('```', 2)[1] cut mid-value, so "
           "extraction returns zero obligations for a contract that has some — silent "
           "data loss, not a visible error. Deleting the four-line strip fixes it; "
           "left in place here so the fix is a deliberate change with this test flipping "
           "to pass as its evidence.",
    strict=True,
)
def test_fence_inside_a_string_value_should_survive():
    raw = '```json\n{"obligations": [{"quote": "see ``` block"}], "summary": "s"}\n```'
    # loads_lenient alone gets this right...
    assert loads_lenient(raw)["obligations"][0]["quote"] == "see ``` block"
    # ...and the manual strip in front of it does not.
    out = parse_obligations_response(raw)
    assert out["obligations"][0]["quote"] == "see ``` block"


def test_unparseable_output_raises_for_the_route_to_catch():
    """The route owns the fallback, so this must RAISE rather than return {}.

    Returning an empty payload here would turn "the model produced garbage"
    into "this contract has no obligations", which is the same
    could-not-check/checked-and-fine collapse the eval suite exists to prevent.
    """
    with pytest.raises(json.JSONDecodeError):
        parse_obligations_response("I could not find any obligations, sorry.")


def test_empty_input_raises_rather_than_returning_empty():
    with pytest.raises(json.JSONDecodeError):
        parse_obligations_response("")
