"""A2 (docs/39) — the second-pass recovery asks only for required fields the
first pass really left empty, under the names the first pass writes.

Standard library only: `python -m unittest discover -s tests -t .` in apps/agents.
"""
import re
import unittest

from app.agents.review_agent import (
    _EXTRACT_PROMPT, _REQUIRED_FIELD_HINTS, _merge_recovered_fields, _missing_required_fields,
)


def raw_field_keys() -> list[str]:
    """The rawFields keys the first-pass prompt asks for."""
    block = _EXTRACT_PROMPT.split('"rawFields": {', 1)[1].split('"clauseFlags"', 1)[0]
    return re.findall(r'^\s*"([A-Za-z]+)":', block, re.M)


class MissingRequiredFields(unittest.TestCase):
    def test_asks_only_for_names_the_first_pass_writes(self):
        keys = set(raw_field_keys())
        self.assertIn("governingLaw", keys)
        for k in _REQUIRED_FIELD_HINTS:
            self.assertIn(k, keys, f"{k} is not a rawFields key, so a recovered value would be dropped")

    def test_nothing_missing_means_no_second_call(self):
        fields = {
            "parties": [{"role": "Client", "name": "Acme"}],
            "effectiveDate": {"value": "2025-01-01"},
            "governingLaw": {"value": "New York"},
        }
        self.assertEqual(_missing_required_fields(fields, "NDA"), [])

    def test_price_is_required_only_where_contracts_state_one(self):
        fields = {
            "parties": [{"role": "Client", "name": "Acme"}],
            "effectiveDate": {"value": "2025-01-01"},
            "governingLaw": {"value": "New York"},
            "value": {"value": None},
        }
        self.assertEqual(_missing_required_fields(fields, "NDA"), [])
        self.assertEqual(_missing_required_fields(fields, "MSA"), [])
        self.assertEqual(_missing_required_fields(fields, "ORDER_FORM"), ["value"])

    def test_empty_shapes_count_as_missing(self):
        fields = {"parties": [], "effectiveDate": {"value": ""}, "governingLaw": None}
        self.assertEqual(_missing_required_fields(fields, None), ["parties", "effectiveDate", "governingLaw"])


class MergeRecoveredFields(unittest.TestCase):
    def test_fills_missing_keys_under_their_own_names(self):
        merged = _merge_recovered_fields(
            {"governingLaw": {"value": None}},
            {"governingLaw": {"value": "Delaware", "quote": "governed by Delaware law"}},
            ["governingLaw"],
        )
        self.assertEqual(merged["governingLaw"]["value"], "Delaware")
        self.assertNotIn("governing_law", merged)

    def test_never_overwrites_a_hit_or_adds_unasked_keys(self):
        merged = _merge_recovered_fields(
            {"effectiveDate": {"value": "2025-01-01"}},
            {"effectiveDate": {"value": "2030-01-01"}, "term_length": {"value": "3 years"}},
            [],
        )
        self.assertEqual(merged, {"effectiveDate": {"value": "2025-01-01"}})

    def test_keeps_parties_as_a_list(self):
        merged = _merge_recovered_fields(
            {"parties": []},
            {"parties": {"value": [{"role": "Vendor", "name": "Initech"}, {"role": "Client"}]}},
            ["parties"],
        )
        self.assertEqual(merged["parties"], [{"role": "Vendor", "name": "Initech"}])

    def test_ignores_a_reply_that_is_not_an_object(self):
        self.assertEqual(_merge_recovered_fields({"a": 1}, ["x"], ["a"]), {"a": 1})


class NoticeFieldsAreSplit(unittest.TestCase):
    def test_first_pass_asks_for_each_notice_by_purpose(self):
        keys = raw_field_keys()
        self.assertIn("nonRenewalNotice", keys)
        self.assertIn("terminationNotice", keys)
        self.assertNotIn("noticePeriodDays", keys)


if __name__ == "__main__":
    unittest.main()
