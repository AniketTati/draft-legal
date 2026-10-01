"""docs/41 P0.4 — a draft never says Delaware unless someone chose it."""
from app.agents.draft_agent import resolve_legal_choices, is_legal_choice

LAW = {"key": "governingLaw", "label": "Governing Law", "type": "enum", "defaultValue": "Delaware",
       "options": ["Delaware", "New York", "California", "England and Wales"]}
VENUE = {"key": "venueLocation", "label": "Venue Location", "type": "string", "defaultValue": "Wilmington, Delaware"}
NAME = {"key": "customerName", "label": "Customer Name", "type": "string"}


def test_which_variables_are_legal_choices():
    assert is_legal_choice(LAW) and is_legal_choice(VENUE)
    assert is_legal_choice({"key": "jurisdiction", "label": "Jurisdiction"})
    assert not is_legal_choice(NAME)


def test_request_value_wins_and_takes_the_templates_spelling():
    values, sources = resolve_legal_choices([LAW, VENUE, NAME], {"governingLaw": "Delaware", "customerName": "Acme"},
                                           "NDA with Acme", {"governingLaw": "new york"})
    assert values["governingLaw"] == "New York"
    assert sources["governingLaw"] == "request_value"
    assert values["customerName"] == "Acme"  # not a legal choice: left as the model filled it


def test_no_law_and_no_org_default_is_unresolved_not_delaware():
    values, sources = resolve_legal_choices([LAW, VENUE], {"governingLaw": "Delaware", "venueLocation": "Wilmington, Delaware"},
                                           "Draft an NDA with Acme", None)
    assert values["governingLaw"] is None and values["venueLocation"] is None
    assert sources == {"governingLaw": "unresolved", "venueLocation": "unresolved"}


def test_the_requests_own_words_keep_the_models_value():
    values, sources = resolve_legal_choices([VENUE], {"venueLocation": "Austin, Texas"}, "NDA, courts in Austin, Texas", None)
    assert values["venueLocation"] == "Austin, Texas" and sources["venueLocation"] == "request_text"


def test_an_org_default_fills_it():
    chosen = {**LAW, "orgDefault": True}
    values, sources = resolve_legal_choices([chosen], {}, "Draft an NDA", None)
    assert values["governingLaw"] == "Delaware" and sources["governingLaw"] == "org_default"


def test_a_venue_goes_with_the_law_its_default_was_written_for():
    values, sources = resolve_legal_choices([LAW, VENUE], {}, "NDA", {"governingLaw": "Delaware"})
    assert values == {"governingLaw": "Delaware", "venueLocation": "Wilmington, Delaware"}
    values, _ = resolve_legal_choices([LAW, VENUE], {}, "NDA", {"governingLaw": "New York"})
    assert values["venueLocation"] is None
