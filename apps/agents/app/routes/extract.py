"""
PDF extraction using PyMuPDF (MuPDF engine).
POST /extract — accepts PDF bytes, returns { htmlContent, plainText, ocrApplied, pageCount }

Paragraph detection uses adaptive Y-GAP between consecutive lines (not MuPDF block boundaries).
MuPDF can put an entire page into one block; treating blocks as paragraphs produces blobs.

P2.1 (Wave F.1) adds an OCR fallback: when the digital extractor returns
too little text relative to page count, we rasterise each page and run
ocrmac (Apple Vision OCR, native on macOS — no binary dependency). In
production this should ship with a tesseract or Textract backend behind
the same interface; the detector + handoff are what matter.

docs/39 A7 — a long scan is read a few pages at a time: the API asks first
with `ocr=none` (the digital text, and whether it's a scan), then sends the
scan's pages in small batches, each with its `pageOffset`, so no request
runs long and no page limit of this service's cuts it short. Each OCR'd page
says how sure the engine was of it (`ocrQuality`) and where it starts in the
text (`pageStarts`).
"""
import logging
import os
import re
import statistics
# X11 — PDF text is data, not markup. Built into HTML unescaped, a PDF whose
# text reads `<iframe src=…>` was stored as live HTML in htmlContent.
from html import escape as _escape_html, unescape as _unescape_html
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Header

logger = logging.getLogger("extract")
router = APIRouter()
INTERNAL_SECRET = os.getenv("INTERNAL_SERVICE_SECRET", "")

try:
    import fitz
    _fitz_available = True
except ImportError:
    _fitz_available = False

# P2.1 — scanned-PDF heuristic + OCR handoff. Works with whichever OCR
# backend is available at runtime; on macOS we use ocrmac (Apple Vision).
# Threshold: < 30 chars per page on average = likely scanned.
_SCANNED_CHARS_PER_PAGE = 30
_OCR_MAX_PAGES          = 40   # per request: the API reads a longer scan in batches (A7)

try:
    from PIL import Image
    _pil_available = True
except ImportError:
    _pil_available = False

# macOS dev OCR backend — ocrmac (Apple Vision, no binary dependency).
try:
    from ocrmac import ocrmac as _ocrmac
    _ocrmac_available = _pil_available
except ImportError:
    _ocrmac_available = False

# Linux/prod OCR backend — pytesseract over the tesseract-ocr binary, which the
# agents Docker image installs via apt. Wave 4: previously the only backend was
# ocrmac, so scanned PDFs silently yielded empty text in the Linux container.
try:
    import pytesseract as _pytesseract
    _tesseract_available = _pil_available
except ImportError:
    _tesseract_available = False

_ocr_available = _ocrmac_available or _tesseract_available


def _is_likely_scanned(plain_text: str, page_count: int) -> bool:
    """Very simple heuristic — proven surprisingly reliable because digital
    PDFs usually yield 500+ chars per page and scanned ones yield 0-20 of
    stray OCR-like garbage (page numbers, stamps).
    """
    if page_count <= 0:
        return False
    avg = len(plain_text.strip()) / page_count
    return avg < _SCANNED_CHARS_PER_PAGE


def _weighted(pairs: list[tuple[str, float]]) -> float | None:
    """How sure the engine was of a page: its readings' confidence, weighted by length."""
    total = sum(len(t) * c for t, c in pairs)
    weight = sum(len(t) for t, _ in pairs)
    return round(total / weight, 3) if weight else None


def _tesseract_lines(data: dict) -> tuple[list[str], float | None]:
    """Reading-order lines from tesseract's word table, and how sure it was of them (0-1)."""
    lines: dict[tuple, list[str]] = {}
    scored: list[tuple[str, float]] = []
    for i, word in enumerate(data.get("text") or []):
        w = (word or "").strip()
        if not w:
            continue
        lines.setdefault((data["block_num"][i], data["par_num"][i], data["line_num"][i]), []).append(w)
        try:
            conf = float(data["conf"][i])
        except (TypeError, ValueError, KeyError, IndexError):
            conf = -1.0
        if conf >= 0:
            scored.append((w, conf / 100))
    return [" ".join(ws) for ws in lines.values()], _weighted(scored)


def _ocr_page(img) -> tuple[list[str], float | None]:
    """OCR one rendered page image into reading-order text lines, and how
    sure the engine was of them (0-1; None when it doesn't say). Prefers
    ocrmac (macOS); falls back to pytesseract (Linux/prod)."""
    if _ocrmac_available:
        # ocrmac returns (text, confidence, [x, y, w, h]) with Y inverted
        # (bottom-left origin) — sort by Y then X for top-down reading order.
        rows = _ocrmac.OCR(img).recognize()
        sorted_rows = sorted(rows, key=lambda r: (-(r[2][1] + r[2][3]), r[2][0]))
        read = [((text or "").strip(), c) for text, c, _b in sorted_rows]
        read = [(t, c) for t, c in read if t]
        return [t for t, _ in read], _weighted([(t, float(c)) for t, c in read if isinstance(c, (int, float))])
    # pytesseract's word table: the lines, and a confidence for each word.
    return _tesseract_lines(_pytesseract.image_to_data(img, output_type=_pytesseract.Output.DICT))


def _render_page(page):
    """A page as an image for the OCR engine: 200 DPI gives it enough detail
    without blowing up memory on huge contracts."""
    pix = page.get_pixmap(dpi=200, alpha=False)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def _ocr_pdf(doc, page_offset: int = 0) -> tuple[str, str, int, list[dict], list[dict]]:
    """OCR each page through the available backend, at most _OCR_MAX_PAGES.
    Returns (html, plain, pages_ocrd, quality, page_starts): how sure the
    engine was of each page, and where each page's text starts in `plain`.
    Pages are numbered from `page_offset` + 1 — their place in the whole
    document when this is a batch of it (A7).
    """
    if not _ocr_available:
        return "", "", 0, [], []
    html_parts: list[str] = []
    plain_parts: list[str] = []
    quality: list[dict] = []
    page_starts: list[dict] = []
    plain_len = 0
    pages_ocrd = 0
    for page_num, page in enumerate(doc):
        if page_num >= _OCR_MAX_PAGES:
            break
        n = page_offset + page_num + 1
        try:
            page_lines, confidence = _ocr_page(_render_page(page))
        except Exception as e:  # noqa: BLE001
            logger.warning("[extract] OCR page %d failed: %s", n, e)
            quality.append({"page": n, "confidence": None, "failed": True})
            continue
        pages_ocrd += 1
        quality.append({"page": n, "confidence": confidence})
        if page_lines:
            page_plain = " ".join(page_lines)
            if plain_parts:
                plain_len += 2  # the "\n\n" between pages
            page_starts.append({"page": n, "start": plain_len})
            plain_parts.append(page_plain)
            plain_len += len(page_plain)
            html_parts.append(
                f"<!-- page {n} --><p>"
                + "</p>\n<p>".join(_escape_html(l, quote=False) for l in page_lines) + "</p>"
            )
    return "\n".join(html_parts), "\n\n".join(plain_parts), pages_ocrd, quality, page_starts

_WORD_GAP_PT    = 1.5   # gap (pts) between spans to insert a word space
_INDENT_STEP    = 30.0  # pts per indent level
_PARA_RATIO     = 1.5   # gap > median_gap * PARA_RATIO → paragraph break
_MIN_LINE_CHARS = 3     # ignore lines shorter than this (page noise)


def _join_spans(line: dict) -> tuple[str, str, float]:
    """(plain, html, avg_size) for one line.

    Gap-based space insertion handles split-glyph runs (e.g. "C"+"HANNEL" → "CHANNEL").
    """
    plain_parts: list[str] = []
    html_parts:  list[str] = []
    sizes:       list[float] = []
    prev_x1: float | None = None

    for span in line["spans"]:
        raw = span["text"]
        if not raw:
            continue
        x0, x1 = span["bbox"][0], span["bbox"][2]
        if prev_x1 is not None and (x0 - prev_x1) > _WORD_GAP_PT:
            if plain_parts and not plain_parts[-1].endswith(" ") and not raw.startswith(" "):
                plain_parts.append(" ")
                html_parts.append(" ")
        plain_parts.append(raw)
        t = _escape_html(raw, quote=False)
        flags = span["flags"]
        if flags & 2:   t = f"<em>{t}</em>"
        if flags & 16:  t = f"<strong>{t}</strong>"
        html_parts.append(t)
        if raw.strip():
            sizes.append(span["size"])
        prev_x1 = x1

    plain = "".join(plain_parts).strip()
    html  = "".join(html_parts).strip()
    avg   = (sum(sizes) / len(sizes)) if sizes else 0.0
    return plain, html, avg


def _is_caps_heading(plain: str, line_avg_size: float, body_size: float) -> bool:
    """Detect headings by ALL-CAPS content when font size matches body (common in legal PDFs)."""
    stripped = plain.strip()
    if not stripped or len(stripped) > 130:
        return False
    if line_avg_size >= body_size * 1.05:
        return False  # already detected as size-based heading
    alpha = [c for c in stripped if c.isalpha()]
    if not alpha:
        return False
    return sum(1 for c in alpha if c.isupper()) / len(alpha) >= 0.80


# P2.2 — legal documents often put section headings at body font size
# ("Section 9.2. Limitation of Liability" in 10pt). The size + CAPS
# heuristics above miss these, so this third detector fires on explicit
# Section/Article prefixes that sit on their own short line.
_SECTION_HEADING_PATTERN = re.compile(
    r"^\s*(?:Section\s+[0-9IVXLCM]+(?:\.[0-9]+)*|"
    r"Article\s+[0-9IVXLCM]+|"
    r"[0-9]+\.[0-9]+(?:\.[0-9]+)*)\b",
    re.I,
)


def _is_section_prefix_heading(plain: str) -> bool:
    stripped = plain.strip()
    # "Section 9.2. Limitation of Liability" is 40 chars; a whole
    # paragraph body is much longer. This gate is what separates
    # "standalone heading" from "heading-like text inside a paragraph".
    if len(stripped) < 3 or len(stripped) > 140:
        return False
    return bool(_SECTION_HEADING_PATTERN.match(stripped))


# docs/39 A10 — a table on a PDF page was read line by line into the running
# text: "Plan Annual fee Seats Enterprise USD 120,000 500", no telling which
# figure went with which heading. PyMuPDF finds the page's tables; each is
# kept as a table — in the HTML a <table>, in the text its rows one to a line,
# cells split by " | " — at its place among the paragraphs, and its words are
# left out of them.
_TABLE_MIN_ROWS = 2
_TABLE_MIN_COLS = 2


def _page_tables(page) -> list[dict]:
    """The page's tables, top to bottom: each its bbox, its rows of cell text,
    and whether its first row is its header."""
    try:
        found = page.find_tables()
    except Exception as e:  # noqa: BLE001 — finding tables is best-effort; the text reads as before
        logger.warning("[extract] finding tables on page %d failed: %s", page.number + 1, e)
        return []
    out: list[dict] = []
    for t in found.tables:
        rows = [[" ".join((c or "").split()) for c in row] for row in t.extract()]
        rows = [r for r in rows if any(r)]
        cols = max((sum(1 for c in r if c) for r in rows), default=0)
        # Two rows of two filled cells at least: a ruled box around one paragraph isn't a table.
        if len(rows) < _TABLE_MIN_ROWS or cols < _TABLE_MIN_COLS:
            continue
        header = getattr(t, "header", None)
        out.append({"bbox": tuple(t.bbox), "rows": rows, "header": bool(header is not None and not getattr(header, "external", True))})
    return sorted(out, key=lambda t: t["bbox"][1])


def _in_table(line_bbox, tables: list[dict]) -> bool:
    """A line whose middle sits inside one of the tables: its words are the table's."""
    cx, cy = (line_bbox[0] + line_bbox[2]) / 2, (line_bbox[1] + line_bbox[3]) / 2
    return any(b[0] - 1 <= cx <= b[2] + 1 and b[1] - 1 <= cy <= b[3] + 1 for b in (t["bbox"] for t in tables))


def _table_html_plain(table: dict) -> tuple[str, str]:
    """A table as HTML, and as text: a row to a line, its cells split by " | "."""
    html_rows: list[str] = []
    for i, row in enumerate(table["rows"]):
        tag = "th" if i == 0 and table["header"] else "td"
        html_rows.append("<tr>" + "".join(f"<{tag}>{_escape_html(c, quote=False)}</{tag}>" for c in row) + "</tr>")
    plain = "\n".join(" | ".join(c for c in row if c) for row in table["rows"])
    return "<table><tbody>" + "".join(html_rows) + "</tbody></table>", plain


def _all_lines(page) -> list[dict]:
    """Return every text line from every block on the page, sorted top-to-bottom by y0."""
    lines: list[dict] = []
    for block in page.get_text("dict", sort=True)["blocks"]:
        if block["type"] != 0:
            continue
        lines.extend(block["lines"])
    lines.sort(key=lambda l: l["bbox"][1])
    return lines


def _pdf_to_html(content: bytes) -> tuple[str, str, list[dict]]:
    doc = fitz.open(stream=content, filetype="pdf")

    # ── Pass 1: calibrate body_size and median_gap from the whole document ─────
    all_sizes: list[float] = []
    all_gaps:  list[float] = []

    for page in doc:
        lines = _all_lines(page)
        for i, line in enumerate(lines):
            plain, _, size = _join_spans(line)
            if len(plain) >= _MIN_LINE_CHARS and size:
                all_sizes.append(round(size, 1))
            if i > 0:
                # y0-to-y0 advance: always positive, unaffected by bbox leading
                advance = line["bbox"][1] - lines[i - 1]["bbox"][1]
                if 3 < advance < 100:  # ignore same-line noise and page-level jumps
                    all_gaps.append(advance)

    body_size  = statistics.median(all_sizes) if all_sizes else 10.0
    median_gap = statistics.median(all_gaps)  if all_gaps  else body_size * 1.2
    para_break = median_gap * _PARA_RATIO     # advance threshold for a new paragraph

    # ── Pass 2: line-by-line extraction with y-gap paragraph detection ─────────
    html_parts:  list[str] = []
    plain_parts: list[str] = []
    # P2.4 — parallel list of bbox anchors, one entry per emitted HTML
    # token (<p>, <h*>, <li>). Each entry = {page: int, bbox: [x0, y0,
    # x1, y1]}. Section-tree builder uses these to annotate each
    # node with its page + bbox so D.5.8 citations can highlight a
    # specific region of the PDF.
    bbox_parts:  list[dict] = []
    in_list = False

    def flush_para(
        para_plain_lines: list[str],
        para_html_lines:  list[str],
        first_line_size:  float,
        indent_level:     int,
        para_page:        int,
        para_bbox:        list[float] | None,
    ) -> None:
        nonlocal in_list
        if not para_plain_lines:
            return
        plain = " ".join(para_plain_lines)
        inner = " ".join(para_html_lines)
        plain_parts.append(plain)
        heading_html = _escape_html(plain, quote=False)

        is_caps    = _is_caps_heading(plain, first_line_size, body_size)
        # P2.2 — treat explicit "Section 9.2" / "Article IX" prefixes as
        # headings even at body size. This is what actually differentiates
        # contract TOCs from narrative prose.
        is_section = _is_section_prefix_heading(plain)
        is_heading = first_line_size >= body_size * 1.05 or is_caps or is_section

        if in_list and (indent_level == 0 or is_heading):
            html_parts.append("</ul>")
            in_list = False

        # Record bbox anchor alongside the emitted HTML token. Each
        # append below pushes exactly one token, so we push one bbox
        # per flush_para call (a heading/para covers multiple lines
        # but maps to one HTML token).
        anchor = {
            "page": para_page,
            "bbox": para_bbox if para_bbox else None,
        }

        # P2.2 — when the line is a recognised section ref, the nesting
        # depth (dot-count in "9.2.1") is more informative than raw font
        # size. We always route section lines through depth-based h-level
        # so "Section 9" becomes h2 and "9.1" / "9.2" become h3 children.
        emitted = False
        if is_section:
            m = re.search(r"(\d+(?:\.\d+)+|\d+|[IVXLCM]+)", plain)
            ref_str = m.group(1) if m else ""
            depth = ref_str.count(".")
            heading_level = min(6, 2 + depth)
            html_parts.append(f"<h{heading_level}>{heading_html}</h{heading_level}>")
            emitted = True
        elif first_line_size >= body_size * 1.5:  html_parts.append(f"<h1>{heading_html}</h1>"); emitted = True
        elif first_line_size >= body_size * 1.2:  html_parts.append(f"<h2>{heading_html}</h2>"); emitted = True
        elif first_line_size >= body_size * 1.05: html_parts.append(f"<h3>{heading_html}</h3>"); emitted = True
        elif is_caps:                              html_parts.append(f"<h2>{heading_html}</h2>"); emitted = True
        elif indent_level >= 1:
            if not in_list:
                html_parts.append("<ul>")
                in_list = True
                # <ul> isn't captured by _HEADING_OR_BODY so we DON'T
                # push a bbox anchor for it — stays aligned with the
                # regex walker in _build_section_tree.
            margin = f' style="margin-left:{(indent_level - 1) * 1.5}em"' if indent_level > 1 else ""
            html_parts.append(f"<li{margin}>{inner}</li>")
            emitted = True
        else:
            html_parts.append(f"<p>{inner}</p>")
            emitted = True

        # Exactly one bbox entry per emitted HTML token that the section
        # tree builder walks (<h*>, <li>, <p>). The <ul> wrapper above
        # gets its own placeholder so indices stay aligned.
        if emitted:
            bbox_parts.append(anchor)

    # P2.4 — track per-paragraph {page, bbox} so every emitted HTML
    # token carries a PDF-anchor the citations layer can scroll to.
    # bbox is the union of all line bboxes inside the paragraph.
    def emit_table(table: dict) -> None:
        nonlocal in_list
        if in_list:
            html_parts.append("</ul>")
            in_list = False
        html, plain = _table_html_plain(table)
        html_parts.append(html)
        plain_parts.append(plain)

    for page_num, page in enumerate(doc, start=1):
        lines = _all_lines(page)
        # A10 — the page's tables, each emitted where it sits among the paragraphs.
        tables = _page_tables(page)
        pending = list(tables)

        # Left margin = leftmost x0 among lines with substantial text (ignores page labels)
        left_margin = min(
            (l["bbox"][0] for l in lines
             if len("".join(s["text"] for s in l["spans"]).strip()) >= 40),
            default=0.0,
        )

        para_plain:  list[str] = []
        para_html:   list[str] = []
        para_size:   float = body_size
        para_indent: int = 0
        para_page:   int = page_num
        para_bbox:   list[float] | None = None
        prev_y0: float | None = None

        for line in lines:
            plain, html_line, avg_size = _join_spans(line)
            if len(plain) < _MIN_LINE_CHARS:
                continue
            # A10 — its words are a table's, read as the table.
            if tables and _in_table(line["bbox"], tables):
                continue

            y0 = line["bbox"][1]

            # A10 — a table above this line: the paragraph before it ends there, then the table.
            if pending and pending[0]["bbox"][1] <= y0:
                flush_para(para_plain, para_html, para_size, para_indent, para_page, para_bbox)
                para_plain, para_html = [], []
                para_bbox = None
                prev_y0 = None
                while pending and pending[0]["bbox"][1] <= y0:
                    emit_table(pending.pop(0))

            # P2.2 — If this line is clearly a heading, always flush
            # the current paragraph so the heading stands alone. Also
            # flush AFTER emitting the heading so the next line starts
            # a fresh paragraph. This catches section headings that sit
            # close to their body text (small Y-GAP).
            is_section_line = _is_section_prefix_heading(plain)
            is_size_heading = avg_size >= body_size * 1.05
            is_caps_line    = _is_caps_heading(plain, avg_size, body_size)
            is_standalone_heading = is_section_line or is_size_heading or is_caps_line

            if prev_y0 is not None:
                advance = y0 - prev_y0   # y0-to-y0: always positive, immune to bbox leading
                if advance > para_break or is_standalone_heading:
                    flush_para(para_plain, para_html, para_size, para_indent, para_page, para_bbox)
                    para_plain, para_html = [], []
                    para_bbox = None
                    para_page = page_num
                    para_size   = avg_size
                    para_indent = max(0, round((line["bbox"][0] - left_margin) / _INDENT_STEP))

            if not para_plain:  # first line of this paragraph
                para_size   = avg_size
                para_indent = max(0, round((line["bbox"][0] - left_margin) / _INDENT_STEP))
                para_page   = page_num

            # Union this line's bbox into the paragraph bbox.
            lb = line["bbox"]  # (x0, y0, x1, y1) in PDF points
            if para_bbox is None:
                para_bbox = [lb[0], lb[1], lb[2], lb[3]]
            else:
                para_bbox[0] = min(para_bbox[0], lb[0])
                para_bbox[1] = min(para_bbox[1], lb[1])
                para_bbox[2] = max(para_bbox[2], lb[2])
                para_bbox[3] = max(para_bbox[3], lb[3])

            para_plain.append(plain)
            para_html.append(html_line)
            prev_y0 = y0

            # If this IS a standalone heading, flush immediately so the
            # next line starts its own paragraph.
            if is_standalone_heading:
                flush_para(para_plain, para_html, para_size, para_indent, para_page, para_bbox)
                para_plain, para_html = [], []
                para_bbox = None

        flush_para(para_plain, para_html, para_size, para_indent, para_page, para_bbox)
        for table in pending:  # A10 — tables below the page's last paragraph
            emit_table(table)
        prev_y0 = None  # reset between pages

    if in_list:
        html_parts.append("</ul>")

    doc.close()
    return "\n".join(html_parts), " ".join(plain_parts), bbox_parts


# ─── P2.2 — Structural section tree (docs/30 Wave F.2) ──────────────────────
#
# The flat HTML above contains <h1>/<h2>/<h3>/<p>/<ul>. Downstream (clause
# anchoring, citations, section-scoped redlines, TOC nav) wants a nested
# {sections: [{id, ref, title, level, paragraphs, children}]} tree
# instead. This stage walks the flat HTML and folds it into that shape
# — no additional PDF parsing, just a structural re-fold of work we
# already did.

# Section-reference patterns — ordered most-specific first. We strip the
# prefix off the heading text so the stored `title` doesn't duplicate the
# `ref` we hoist out.
#
#  "Section 9.2 — Limitation of Liability"   → ref="9.2",       title="Limitation of Liability"
#  "9.2. Limitation of Liability"             → ref="9.2",       title="Limitation of Liability"
#  "Article IX. Liability"                    → ref="Article IX",title="Liability"
#  "ARTICLE III"                              → ref="Article III"
_SECTION_PATTERNS = [
    # "Section 9.2", "Section IX.2"
    re.compile(r"^\s*Section\s+([0-9]+(?:\.[0-9]+)*|[IVXLCM]+(?:\.[0-9]+)*)[\.\s:—–-]+(.*)$", re.I),
    # "Article 9", "Article IX"
    re.compile(r"^\s*Article\s+([0-9]+|[IVXLCM]+)[\.\s:—–-]*(.*)$", re.I),
    # "9.2 Title", "9.2. Title"
    re.compile(r"^\s*(\d+(?:\.\d+)+)[\.\s:—–-]+(.*)$"),
    # "9. Title" — top-level numeric. Guarded to avoid eating "9 months"
    re.compile(r"^\s*(\d+)[\.\s:—–-]+([A-Z][^.]{3,})$"),
]


def _parse_section_ref(heading_text: str) -> tuple[str, str]:
    """Return (ref, clean_title). If no pattern matches, ref='' and
    clean_title is heading_text unchanged."""
    for pat in _SECTION_PATTERNS:
        m = pat.match(heading_text)
        if m:
            ref = m.group(1).strip()
            # Normalise "Article IX" ref to include the keyword so the UI
            # doesn't confuse "IX" with a section number when rendering.
            if pat.pattern.lower().startswith(r"\s*article"):
                ref = f"Article {ref}"
            title = (m.group(2) or "").strip() or heading_text.strip()
            return ref, title
    return "", heading_text.strip()


_HEADING_OR_BODY = re.compile(
    r"<(h[1-6])[^>]*>(.*?)</\1>"
    r"|<p[^>]*>(.*?)</p>"
    r"|<li[^>]*>(.*?)</li>",
    re.S,
)


def _strip_tags(s: str) -> str:
    # The HTML is escaped (X11), so decode entities back to the text.
    return _unescape_html(re.sub(r"<[^>]+>", "", s or "")).strip()


def _build_section_tree(html: str, anchors: list[dict] | None = None) -> list[dict]:
    """Fold a flat <h{1-3}>/<p>/<li> HTML stream into a nested section
    tree. Top level = list of top sections; each has `children` +
    `paragraphs` + `ref` + `title`.

    Heading level maps to nesting depth. Orphan paragraphs that precede
    the first heading are grouped under a synthetic "(Preamble)"
    section with `ref=""` so no text is lost.

    P2.4 — when `anchors` is provided, each token's {page, bbox} is
    paired by index into the regex walk (anchors were pushed in the
    same order as _HEADING_OR_BODY's capturable tokens). Each section
    gets `page` + `bbox` set from its heading anchor; paragraphs
    become {text, page, bbox} triples instead of plain strings.
    """
    tree: list[dict] = []
    # Stack holds the currently-open ancestor sections (by heading level).
    stack: list[tuple[int, dict]] = []
    preamble: dict | None = None
    auto_id = 0
    anchors = anchors or []

    def mk_section(ref: str, title: str, level: int, anchor: dict | None) -> dict:
        nonlocal auto_id
        auto_id += 1
        return {
            "id":         f"s-{auto_id}",
            "ref":        ref,
            "title":      title,
            "level":      level,
            "paragraphs": [],
            "children":   [],
            # P2.4 — page + bbox for PDF highlight. Null if not anchored.
            "page":       (anchor or {}).get("page"),
            "bbox":       (anchor or {}).get("bbox"),
        }

    def attach(section: dict, level: int) -> None:
        # Pop siblings / deeper nodes off the stack so this section
        # nests under its nearest shallower ancestor.
        while stack and stack[-1][0] >= level:
            stack.pop()
        if stack:
            stack[-1][1]["children"].append(section)
        else:
            tree.append(section)
        stack.append((level, section))

    token_idx = 0
    for match in _HEADING_OR_BODY.finditer(html):
        anchor = anchors[token_idx] if token_idx < len(anchors) else None
        token_idx += 1

        tag = match.group(1)
        if tag:  # heading
            heading_text = _strip_tags(match.group(2))
            if not heading_text:
                continue
            level = int(tag[1])
            ref, title = _parse_section_ref(heading_text)
            sec = mk_section(ref, title, level, anchor)
            attach(sec, level)
            continue
        # body — <p> or <li>
        body_text = _strip_tags(match.group(3) or match.group(4))
        if not body_text:
            continue
        para_entry = {
            "text": body_text,
            "page": (anchor or {}).get("page"),
            "bbox": (anchor or {}).get("bbox"),
        }
        if stack:
            stack[-1][1]["paragraphs"].append(para_entry)
        else:
            if preamble is None:
                preamble = mk_section("", "(Preamble)", 1, None)
                tree.insert(0, preamble)
            preamble["paragraphs"].append(para_entry)

    return tree


def _flatten_sections_for_nav(tree: list[dict]) -> list[dict]:
    """Return a flat [{id, ref, title, level, depth, page, bbox}] list
    for TOC rendering + PDF jump-to. Preserves tree order (document
    order)."""
    out: list[dict] = []

    def walk(nodes: list[dict], depth: int) -> None:
        for n in nodes:
            out.append({
                "id":    n["id"],
                "ref":   n["ref"],
                "title": n["title"],
                "level": n["level"],
                "depth": depth,
                "paragraphCount": len(n["paragraphs"]),
                # P2.4 — PDF anchor surface for the TOC row
                "page":  n.get("page"),
                "bbox":  n.get("bbox"),
            })
            walk(n["children"], depth + 1)

    walk(tree, 0)
    return out


@router.post("/extract")
async def extract_pdf(
    file: UploadFile = File(...),
    # A7 — "none": the digital text only, and whether the file is a scan (the
    # API then sends its pages in batches); "auto": OCR a scan, as before.
    ocr: str = Form("auto"),
    # A7 — where this file's first page sits in the whole document.
    pageOffset: int = Form(0),
    x_internal_secret: str = Header(default=""),
):
    if INTERNAL_SECRET and x_internal_secret != INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")
    if not _fitz_available:
        raise HTTPException(status_code=503, detail="pymupdf not installed — run: pip install pymupdf")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    # Digital extraction first — correct for ~95% of modern PDFs + fast.
    html_content, plain_text, bbox_anchors = _pdf_to_html(content)

    # Page count for the scanned heuristic + response metadata.
    try:
        _doc = fitz.open(stream=content, filetype="pdf")
        page_count = _doc.page_count
    except Exception:  # noqa: BLE001
        page_count = 0
        _doc = None

    ocr_applied    = False
    ocr_pages      = 0
    ocr_backend    = None
    ocr_quality: list[dict] = []
    page_starts: list[dict] = []

    # P2.1 — OCR fallback for scanned PDFs. We detect by character-density
    # (< 30 chars/page) rather than by trying to inspect the PDF structure,
    # because stamped/signed digital PDFs often have mixed content and the
    # density heuristic catches both pure-scan and mostly-scan cases.
    scanned = _doc is not None and _is_likely_scanned(plain_text, page_count)
    if scanned and ocr != "none":
        if _ocr_available:
            backend_name = "ocrmac" if _ocrmac_available else "tesseract"
            logger.info(
                "[extract] scanned PDF detected (pages=%d, digital_chars=%d) — running OCR via %s",
                page_count, len(plain_text), backend_name,
            )
            ocr_html, ocr_plain, ocr_pages, ocr_quality, page_starts = _ocr_pdf(_doc, max(0, pageOffset))
            if ocr_plain:
                html_content = ocr_html
                plain_text   = ocr_plain
                ocr_applied  = True
                ocr_backend  = backend_name
        else:
            logger.warning(
                "[extract] scanned PDF (pages=%d) — no OCR backend available "
                "(install tesseract-ocr + pytesseract)",
                page_count,
            )

    if _doc is not None:
        _doc.close()

    logger.info(
        "[extract] done — paragraphs=%d plain_chars=%d pages=%d ocr=%s",
        html_content.count("<p>") + html_content.count("<h"),
        len(plain_text),
        page_count,
        ocr_backend or "no",
    )
    if not html_content:
        html_content = "<p>(No text could be extracted from this PDF)</p>"

    # P2.2 — fold the flat heading+body HTML into a nested section tree.
    # Cheap re-walk; no extra PDF IO. Downstream persists this on the
    # version so TOC nav, section-anchored comments, and the D.5.8
    # citations layer read the same signal.
    # P2.4 — pass the bbox_anchors collected during pass-2 so the
    # section tree carries {page, bbox} per node + paragraph.
    structure_tree = _build_section_tree(html_content, bbox_anchors)
    structure_nav  = _flatten_sections_for_nav(structure_tree)
    logger.info(
        "[extract] structure — %d top-level sections, %d total",
        len(structure_tree), len(structure_nav),
    )

    return {
        "plainText":   plain_text,
        "htmlContent": html_content,
        # P2.1 — new fields. Node ingestion persists these onto
        # ContractVersion.metadata so downstream (HITL queue, trust badges,
        # re-index) can surface "this contract was OCR'd, treat extraction
        # confidence accordingly".
        "pageCount":   page_count,
        "ocrApplied":  ocr_applied,
        "ocrPages":    ocr_pages,
        "ocrBackend":  ocr_backend,
        # A7 — a scan (read now, or left for the API to send in batches), how
        # sure the engine was of each page it read, and where each starts.
        "scanned":     scanned,
        "ocrQuality":  ocr_quality,
        "pageStarts":  page_starts,
        # P2.2 — section tree + flat-nav view. Tree preserves parent-child
        # nesting for section-aware tooling; nav is the easy-render form
        # for a TOC sidebar.
        "structure": {
            "sections": structure_tree,
            "nav":      structure_nav,
        },
    }
