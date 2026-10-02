"""
docs/39 A10 — a table on a PDF page is read as a table: in the HTML a
<table>, in the text a row to a line with its cells split by " | ", at its
place among the paragraphs, and its words not also in them.
"""
from __future__ import annotations

import unittest

import fitz

from app.routes import extract


def pricing_pdf() -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 80), "2. FEES AND PAYMENT", fontsize=11)
    page.insert_text((72, 100), "Customer shall pay the fees in the table below within thirty (30) days of invoice.", fontsize=10)
    # A ruled 3 x 3 table: header, then two plans.
    rows = [("Plan", "Annual fee", "Seats"), ("Starter", "USD 12,000", "50"), ("Enterprise", "USD 120,000", "500")]
    x = [72, 222, 372, 522]
    y = [130, 155, 180, 205]
    for yy in y:
        page.draw_line((x[0], yy), (x[-1], yy))
    for xx in x:
        page.draw_line((xx, y[0]), (xx, y[-1]))
    for r, row in enumerate(rows):
        for c, cell in enumerate(row):
            page.insert_text((x[c] + 6, y[r] + 16), cell, fontsize=10)
    page.insert_text((72, 240), "3. TERM. This Agreement continues for one (1) year.", fontsize=10)
    return doc.tobytes()


class TablesInPdf(unittest.TestCase):
    def test_a_table_is_read_as_one_in_its_place(self):
        html, plain, _anchors = extract._pdf_to_html(pricing_pdf())
        self.assertIn("<table>", html)
        self.assertIn("<th>Plan</th><th>Annual fee</th><th>Seats</th>", html)
        self.assertIn("<td>Enterprise</td><td>USD 120,000</td><td>500</td>", html)
        # Each row a line, its cells apart.
        self.assertIn("Starter | USD 12,000 | 50\nEnterprise | USD 120,000 | 500", plain)
        # In its place: after the paragraph above it, before the one below.
        self.assertLess(plain.index("within thirty (30) days"), plain.index("Plan | Annual fee"))
        self.assertLess(plain.index("Enterprise | USD 120,000"), plain.index("3. TERM"))
        # Its words once, as the table's.
        self.assertEqual(plain.count("USD 120,000"), 1)

    def test_a_page_without_a_table_reads_as_before(self):
        doc = fitz.open()
        page = doc.new_page()
        page.insert_text((72, 80), "This Agreement is governed by the laws of Delaware.", fontsize=10)
        html, plain, _ = extract._pdf_to_html(doc.tobytes())
        self.assertNotIn("<table>", html)
        self.assertIn("governed by the laws of Delaware", plain)

    def test_a_ruled_box_around_one_line_is_not_a_table(self):
        doc = fitz.open()
        page = doc.new_page()
        page.draw_rect(fitz.Rect(70, 60, 520, 100))
        page.insert_text((80, 85), "NOTICE: this box holds one line of text.", fontsize=10)
        self.assertEqual(extract._page_tables(doc[0]), [])


if __name__ == "__main__":
    unittest.main()
