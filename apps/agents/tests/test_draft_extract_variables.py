"""docs/41 Part 1 — the request path's agent only reads quoted values."""
from app.agents.draft_agent import keep_quoted

REQUEST = "Please draft an NDA with Acme GmbH (Berlin). It should be governed by New York law."


def test_keeps_values_whose_quote_is_in_the_request():
    out = keep_quoted([{"key": "governingLaw", "value": "New York", "quote": "governed by New York law"}], REQUEST, {"governingLaw"})
    assert out == [{"key": "governingLaw", "value": "New York", "quote": "governed by New York law"}]


def test_drops_a_value_with_no_quote_or_a_quote_not_in_the_request():
    values = [
        {"key": "governingLaw", "value": "Delaware", "quote": "governed by Delaware law"},
        {"key": "governingLaw", "value": "Delaware"},
        {"key": "governingLaw", "value": "Delaware", "quote": "  "},
    ]
    assert keep_quoted(values, REQUEST, {"governingLaw"}) == []


def test_drops_keys_the_template_does_not_have():
    out = keep_quoted([{"key": "price", "value": "10", "quote": "Acme GmbH"}], REQUEST, {"governingLaw"})
    assert out == []


def test_quote_matching_ignores_case_spacing_and_curly_quotes():
    out = keep_quoted([{"key": "counterpartyCountry", "value": "DE", "quote": "acme  GMBH (berlin)"}], REQUEST, {"counterpartyCountry"})
    assert out[0]["value"] == "DE"
