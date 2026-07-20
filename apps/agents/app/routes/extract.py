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
"""
import logging
import re
import statistics
from fastapi import APIRouter, UploadFile, File, HTTPException, Header

from app.config import settings

logger = logging.getLogger("extract")
router = APIRouter()
INTERNAL_SECRET = settings.internal_service_secret

try:
    import fitz
    _fitz_available = True
except ImportError:
    _fitz_available = False

# P2.1 — scanned-PDF heuristic + OCR handoff. Works with whichever OCR
# backend is available at runtime; on macOS we use ocrmac (Apple Vision).
# Threshold: < 30 chars per page on average = likely scanned.
_SCANNED_CHARS_PER_PAGE = 30
_OCR_MAX_PAGES          = 40   # safety cap; huge binders are a P2.3 concern

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


def _ocr_page_lines(img) -> list[str]:
    """OCR one rendered page image into reading-order text lines. Prefers
    ocrmac (macOS); falls back to pytesseract (Linux/prod)."""
    if _ocrmac_available:
        # ocrmac returns (text, confidence, [x, y, w, h]) with Y inverted
        # (bottom-left origin) — sort by Y then X for top-down reading order.
        rows = _ocrmac.OCR(img).recognize()
        sorted_rows = sorted(rows, key=lambda r: (-(r[2][1] + r[2][3]), r[2][0]))
        return [t for t in ((text or "").strip() for text, _c, _b in sorted_rows) if t]
    # pytesseract yields reading-order plain text directly.
    raw = _pytesseract.image_to_string(img)
    return [ln.strip() for ln in raw.splitlines() if ln.strip()]


def _ocr_pdf(doc) -> tuple[str, str, int]:
    """Render each page as a PIL image at 200 DPI + pass through the available
    OCR backend. Returns (html, plain, pages_ocrd). Stops at _OCR_MAX_PAGES.
    """
    if not _ocr_available:
        return "", "", 0
    html_parts: list[str] = []
    plain_parts: list[str] = []
    pages_ocrd = 0
    for page_num, page in enumerate(doc):
        if page_num >= _OCR_MAX_PAGES:
            break
        # 200 DPI gives the OCR engine enough detail without blowing up
        # memory on huge contracts.
        pix = page.get_pixmap(dpi=200, alpha=False)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        try:
            page_lines = _ocr_page_lines(img)
        except Exception as e:  # noqa: BLE001
            logger.warning("[extract] OCR page %d failed: %s", page_num + 1, e)
            continue
        pages_ocrd += 1
        if page_lines:
            page_plain = " ".join(page_lines)
            plain_parts.append(page_plain)
            html_parts.append(
                f"<!-- page {page_num + 1} --><p>" + "</p>\n<p>".join(page_lines) + "</p>"
            )
    return "\n".join(html_parts), "\n\n".join(plain_parts), pages_ocrd

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
        t = raw
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
            html_parts.append(f"<h{heading_level}>{plain}</h{heading_level}>")
            emitted = True
        elif first_line_size >= body_size * 1.5:  html_parts.append(f"<h1>{plain}</h1>"); emitted = True
        elif first_line_size >= body_size * 1.2:  html_parts.append(f"<h2>{plain}</h2>"); emitted = True
        elif first_line_size >= body_size * 1.05: html_parts.append(f"<h3>{plain}</h3>"); emitted = True
        elif is_caps:                              html_parts.append(f"<h2>{plain}</h2>"); emitted = True
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
    for page_num, page in enumerate(doc, start=1):
        lines = _all_lines(page)

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

            y0 = line["bbox"][1]

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
    return re.sub(r"<[^>]+>", "", s or "").strip()


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

    # P2.1 — OCR fallback for scanned PDFs. We detect by character-density
    # (< 30 chars/page) rather than by trying to inspect the PDF structure,
    # because stamped/signed digital PDFs often have mixed content and the
    # density heuristic catches both pure-scan and mostly-scan cases.
    if _doc is not None and _is_likely_scanned(plain_text, page_count):
        if _ocr_available:
            backend_name = "ocrmac" if _ocrmac_available else "tesseract"
            logger.info(
                "[extract] scanned PDF detected (pages=%d, digital_chars=%d) — running OCR via %s",
                page_count, len(plain_text), backend_name,
            )
            ocr_html, ocr_plain, ocr_pages = _ocr_pdf(_doc)
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
        # P2.2 — section tree + flat-nav view. Tree preserves parent-child
        # nesting for section-aware tooling; nav is the easy-render form
        # for a TOC sidebar.
        "structure": {
            "sections": structure_tree,
            "nav":      structure_nav,
        },
    }
