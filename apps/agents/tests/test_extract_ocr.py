"""
docs/39 A7 — a scan read a few pages at a time: `ocr=none` reports a scan
without reading it; a batch's pages are numbered where they sit in the whole
document; each page says how sure the OCR engine was of it and where its
text starts.
"""
from __future__ import annotations

import asyncio
import io
import unittest
from unittest.mock import patch

import fitz
from starlette.datastructures import UploadFile

from app.routes import extract


def blank_pdf(pages: int) -> bytes:
    """A scan as far as the text layer goes: pages with no text on them."""
    doc = fitz.open()
    for _ in range(pages):
        doc.new_page()
    return doc.tobytes()


def upload(content: bytes) -> UploadFile:
    return UploadFile(file=io.BytesIO(content), filename="scan.pdf")


class FakeOcr:
    """Reads each page as two lines, and is less sure of page 3 of the document."""

    def __init__(self, offset: int = 0):
        self.calls = 0
        self.offset = offset

    def __call__(self, _img):
        self.calls += 1
        n = self.offset + self.calls
        return [f"Page {n} heading", f"Page {n} body text"], (0.41 if n == 3 else 0.96)


class TesseractLines(unittest.TestCase):
    def test_lines_in_reading_order_and_how_sure(self):
        data = {
            "text":      ["", "Payment", "is", "due", "", "within", "30", "days."],
            "conf":      ["-1", "96", "95", "90", "-1", "40", "35", "60"],
            "block_num": [1, 1, 1, 1, 1, 1, 1, 1],
            "par_num":   [1, 1, 1, 1, 1, 1, 1, 1],
            "line_num":  [0, 1, 1, 1, 0, 2, 2, 2],
        }
        lines, confidence = extract._tesseract_lines(data)
        self.assertEqual(lines, ["Payment is due", "within 30 days."])
        # Weighted by length: the long, sure words count for more.
        self.assertAlmostEqual(confidence, 0.697, places=3)

    def test_no_words_says_nothing(self):
        lines, confidence = extract._tesseract_lines({"text": ["", " "], "conf": ["-1", "-1"], "block_num": [1, 1], "par_num": [1, 1], "line_num": [1, 1]})
        self.assertEqual(lines, [])
        self.assertIsNone(confidence)


class OcrPdf(unittest.TestCase):
    def test_pages_numbered_in_the_whole_document_with_quality_and_starts(self):
        doc = fitz.open(stream=blank_pdf(2), filetype="pdf")
        with patch.object(extract, "_ocr_available", True), \
             patch.object(extract, "_render_page", lambda page: page), \
             patch.object(extract, "_ocr_page", FakeOcr(offset=16)):
            html, plain, pages, quality, starts = extract._ocr_pdf(doc, page_offset=16)
        self.assertEqual(pages, 2)
        self.assertIn("<!-- page 17 -->", html)
        self.assertIn("<!-- page 18 -->", html)
        self.assertEqual([q["page"] for q in quality], [17, 18])
        self.assertEqual(plain[starts[1]["start"]:].split(" ")[:2], ["Page", "18"])
        self.assertEqual(starts[0], {"page": 17, "start": 0})

    def test_a_page_the_engine_fails_on_is_said_so_and_the_rest_read(self):
        doc = fitz.open(stream=blank_pdf(3), filetype="pdf")
        calls = {"n": 0}

        def flaky(_img):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("engine crashed")
            return [f"Page {calls['n']}"], 0.9

        with patch.object(extract, "_ocr_available", True), \
             patch.object(extract, "_render_page", lambda page: page), \
             patch.object(extract, "_ocr_page", flaky):
            _html, plain, pages, quality, _starts = extract._ocr_pdf(doc)
        self.assertEqual(pages, 2)
        self.assertEqual(quality[1], {"page": 2, "confidence": None, "failed": True})
        self.assertEqual(plain, "Page 1\n\nPage 3")


class ExtractRoute(unittest.TestCase):
    def test_ocr_none_reports_a_scan_without_reading_it(self):
        ocr = FakeOcr()
        with patch.object(extract, "_ocr_available", True), \
             patch.object(extract, "_render_page", lambda page: page), \
             patch.object(extract, "_ocr_page", ocr), \
             patch.object(extract, "INTERNAL_SECRET", ""):
            out = asyncio.run(extract.extract_pdf(file=upload(blank_pdf(3)), ocr="none", pageOffset=0, x_internal_secret=""))
        self.assertTrue(out["scanned"])
        self.assertFalse(out["ocrApplied"])
        self.assertEqual(ocr.calls, 0)
        self.assertEqual(out["pageCount"], 3)

    def test_a_batch_is_read_with_its_place_in_the_document(self):
        with patch.object(extract, "_ocr_available", True), \
             patch.object(extract, "_ocrmac_available", False), \
             patch.object(extract, "_render_page", lambda page: page), \
             patch.object(extract, "_ocr_page", FakeOcr(offset=2)), \
             patch.object(extract, "INTERNAL_SECRET", ""):
            out = asyncio.run(extract.extract_pdf(file=upload(blank_pdf(2)), ocr="auto", pageOffset=2, x_internal_secret=""))
        self.assertTrue(out["ocrApplied"])
        self.assertEqual(out["ocrPages"], 2)
        self.assertEqual(out["ocrQuality"], [{"page": 3, "confidence": 0.41}, {"page": 4, "confidence": 0.96}])
        self.assertEqual([s["page"] for s in out["pageStarts"]], [3, 4])
        self.assertIn("Page 3 heading", out["plainText"])


if __name__ == "__main__":
    unittest.main()
