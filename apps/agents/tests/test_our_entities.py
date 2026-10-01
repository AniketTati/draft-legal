"""docs/39 A8 — the counterparty is never one of the companies the org signs as.

Run: `python -m unittest discover -s tests -t .` in apps/agents.
"""
from __future__ import annotations

import unittest

from app.company_names import company_key, is_one_of
from app.routes.review import ReviewRequest, build_payloads, pick_counterparty


class CompanyKey(unittest.TestCase):
    def test_reads_names_as_the_api_does(self):
        # The same cases as apps/api/src/lib/company-names.test.ts: the two must agree.
        self.assertEqual(company_key("ACME CORPORATION, INC."), "acme")
        self.assertEqual(company_key("The Acme Corporation"), "acme")
        self.assertEqual(company_key("Helix Systems L.L.C."), "helix systems")
        self.assertEqual(company_key("Acme Holdings Private Limited"), "acme holdings")
        self.assertEqual(company_key("Müller GmbH & Co. KG"), "muller")
        self.assertEqual(company_key("Acme Corporation (“Acme” or the “Supplier”)"), "acme")
        self.assertEqual(company_key("Globex Inc., a Delaware corporation"), "globex")
        self.assertEqual(company_key("Procter & Gamble Co."), "procter and gamble")
        self.assertEqual(company_key("Limited"), "limited")

    def test_one_of_ours_whatever_the_spelling(self):
        ours = ["Demo Org, Inc.", "Acme UK Ltd"]
        self.assertTrue(is_one_of("ACME UK LIMITED", ours))
        self.assertTrue(is_one_of("Demo Org", ours))
        self.assertTrue(is_one_of("Demo Org Holdings", ours))  # contains our name, as the picker always allowed
        self.assertFalse(is_one_of("Globex", ours))
        self.assertFalse(is_one_of("", ours))
        # A short name inside another means nothing.
        self.assertFalse(is_one_of("ABC Corp", ["AB"]))


class Picker(unittest.TestCase):
    PARTIES = [
        {"name": "Acme UK Limited", "role": "supplier", "address": "1 Fleet St, London"},
        {"name": "Globex GmbH", "role": "customer", "address": "Hauptstr. 5, Berlin"},
    ]

    def test_an_entity_the_org_listed_is_not_the_counterparty(self):
        # Without the list the supplier — our own subsidiary — was taken.
        self.assertEqual(pick_counterparty(self.PARTIES, "Demo Org, Inc."), "Acme UK Limited")
        self.assertEqual(pick_counterparty(self.PARTIES, "Demo Org, Inc.", ["Acme UK Ltd"]), "Globex GmbH")

    def test_the_other_partys_address_comes_with_it(self):
        result = {"summary": "s", "keyTerms": {"parties": self.PARTIES}, "fieldConfidence": {"parties": {"confidence": 0.9}}}
        contract, _ = build_payloads(result, "Demo Org, Inc.", [], ["Acme UK Ltd"])
        self.assertEqual(contract["counterpartyName"], "Globex GmbH")
        self.assertEqual(contract["keyTerms"]["counterpartyAddress"], "Hauptstr. 5, Berlin")

    def test_an_intercompany_agreement_still_names_a_party(self):
        parties = [{"name": "Demo Org, Inc.", "role": "licensor"}, {"name": "Acme UK Ltd", "role": "licensee"}]
        self.assertEqual(pick_counterparty(parties, "Demo Org, Inc.", ["Acme UK Ltd"]), "Acme UK Ltd")

    def test_the_request_carries_the_list(self):
        body = ReviewRequest(contractId="c1", versionId="v1", plainText="…", orgName="Demo Org", ourEntities=["Acme UK Ltd"])
        self.assertEqual(body.ourEntities, ["Acme UK Ltd"])
        self.assertEqual(ReviewRequest(contractId="c1", versionId="v1", plainText="…").ourEntities, [])


if __name__ == "__main__":
    unittest.main()
