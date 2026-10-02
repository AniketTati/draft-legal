"""
docs/39 A5 — the organisation's own fields, read in a pass of their own.

They used to ride along at the end of the main extraction prompt, after some
forty standard fields, and whatever came back was stored. Now they are asked
for on their own, with how people filled each one in on other contracts as
examples, the parts of a long document that mention them read first, and
every answer checked before it goes back: a quote that isn't in the document
word for word is flagged and trusted less, and a choice is matched to the
field's own options. (Values the field can't hold are refused by the API's
field store, which has the parsers.)

Used by the review run (review_agent._extract) and by /extract-fields (the
field preview, fill-in and re-check, and a diligence room's questions —
docs/39 D6: a field whose meaning is a question asked of every document).
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from ..jsonish import loads_lenient
from ..pii_tokens import PII_TOKEN_RULE
from ..router import resolve_llm
from ..untrusted import wrap_untrusted_document

logger = logging.getLogger(__name__)

_SYSTEM = """You are a contract data extraction specialist. Read the organisation's own fields, listed below, from the contract text.

Return ONLY valid JSON: {"customFields": {"<key>": {"value": <the value, or null>, "confidence": <0.0-1.0>, "quote": "<the exact words it comes from, copied from the contract, or null>"}}}
Include every key listed. Use null when the contract does not state the field; never guess.
Values, by type: currency → "<3-letter code> <amount>" (e.g. "USD 250000"); duration → "<number> <days|weeks|months|years>"; percentage → a number (5 for 5%); number → a number; date → YYYY-MM-DD; boolean → true or false; select → exactly one of the field's options; multiselect → a list of the field's options; text → the words as the contract states them.
Copy the quote word for word from the contract; do not paraphrase it or join separate passages.
Where a field has a question, its value is this contract's answer to that question, in the field's type (a text answer in a few words, as the contract puts it); the quote is the words the answer rests on. Use null when the contract doesn't answer it.
Where a field has examples, they show how people filled it in on other contracts: read this contract the same way, but take the value from this contract, never from an example.
Where a field has corrections, people corrected earlier readings of it on other contracts (read → corrected, with the words it was read from): read this contract the way the corrections show, never copying a value.

Fields:
"""

_STOPWORDS = {
    "that", "this", "with", "from", "have", "shall", "will", "which", "their", "there", "these", "those",
    "other", "party", "parties", "agreement", "contract", "under", "such", "each", "within", "after",
    "before", "must", "what", "when", "where", "does", "value", "field", "the",
}


def field_specs(fields: list[dict]) -> list[dict]:
    """The fields as the prompt lists them, each with up to five examples."""
    specs = []
    for f in fields:
        spec = {
            "key": f.get("fieldKey"),
            "label": f.get("fieldLabel"),
            "type": f.get("fieldType"),
            "options": f.get("options") or [],
            "hint": f.get("helpText") or "",
        }
        # docs/39 D6 — a diligence room's question, asked of this contract.
        if f.get("question"):
            spec["question"] = f.get("question")
        examples = [e for e in (f.get("examples") or []) if isinstance(e, dict) and e.get("value")][:5]
        if examples:
            spec["examples"] = [{"value": e.get("value"), "quote": e.get("quote")} for e in examples]
        # docs/39 I2 — what people corrected earlier readings of it to.
        corrections = [
            {k: c.get(k) for k in ("read", "corrected", "quote") if c.get(k)}
            for c in (f.get("corrections") or [])[:3]
            if isinstance(c, dict) and c.get("read") and c.get("corrected")
        ]
        if corrections:
            spec["corrections"] = corrections
        specs.append(spec)
    return specs


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z][a-z-]{3,}", (text or "").lower()) if w not in _STOPWORDS}


def rank_chunks(chunks: list[str], specs: list[dict]) -> list[int]:
    """Chunk indexes, the ones that mention the fields' words most first (the document's order otherwise)."""
    if len(chunks) <= 1:
        return list(range(len(chunks)))
    vocab: set[str] = set()
    for s in specs:
        vocab |= _words(f"{s.get('label', '')} {s.get('hint', '')} {s.get('question', '')}")
        for e in s.get("examples") or []:
            vocab |= _words(str(e.get("quote") or ""))
    scores = []
    for i, chunk in enumerate(chunks):
        lower = chunk.lower()
        scores.append((-sum(lower.count(w) for w in vocab), i))
    return [i for _, i in sorted(scores)]


def _norm(text: str) -> str:
    text = (text or "").lower()
    text = text.translate(str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'", "–": "-", "—": "-", " ": " "}))
    return re.sub(r"\s+", " ", text).strip()


def quote_in(quote: str, document: str) -> bool:
    """The quote is in the document word for word (spacing, case and curly quotes aside; an ellipsis joins parts that each are)."""
    doc = _norm(document)
    parts = [p.strip(" .,;:") for p in re.split(r"\.\.\.|…", _norm(quote))]
    parts = [p for p in parts if len(p) >= 12] or [_norm(quote)]
    return all(p in doc for p in parts)


def _match_option(value: Any, options: list[str]) -> Any:
    if not isinstance(value, str):
        return value
    for o in options:
        if o.lower() == value.strip().lower():
            return o
    return value


def check(found: dict[str, dict], specs: list[dict], document: str) -> dict[str, dict]:
    """Each answer, checked: its quote against the document, its choice against the field's options."""
    by_key = {s["key"]: s for s in specs}
    out: dict[str, dict] = {}
    for key, v in found.items():
        spec = by_key.get(key)
        if spec is None or not isinstance(v, dict):
            continue
        value = v.get("value")
        try:
            confidence = float(v.get("confidence", 0.5))
        except (TypeError, ValueError):
            confidence = 0.5
        quote = v.get("quote") if isinstance(v.get("quote"), str) and v.get("quote").strip() else None
        issue = None
        if value is not None and quote and not quote_in(quote, document):
            confidence = min(confidence, 0.5)
            issue = "Its quote isn't in the document word for word: check the value against the contract."
        options = spec.get("options") or []
        if options and spec.get("type") == "select":
            value = _match_option(value, options)
        elif options and spec.get("type") == "multiselect" and value is not None:
            items = value if isinstance(value, list) else re.split(r"\s*[,;]\s*", str(value))
            value = [_match_option(x, options) for x in items if str(x).strip()]
        entry = {"value": value, "confidence": confidence, "quote": quote}
        if issue:
            entry["issue"] = issue
        out[key] = entry
    return out


def _text(content: Any) -> str:
    if isinstance(content, list):
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    return str(content)


async def extract_custom_fields(
    plain_text: str,
    fields: list[dict],
    *,
    contract_type: str | None = None,
    org_id: str | None = None,
    reading_note: str = "",
    trace_name: str = "custom_fields",
) -> tuple[dict[str, dict], int, int]:
    """The fields' values from the contract, checked: ({key: {value, confidence, quote, issue?}}, chunks read, chunks).

    Reads the most relevant chunk first and stops once every field has a value.
    A field the contract doesn't state is absent from the result.
    """
    from .review_agent import _chunk_text  # the review agent imports this module

    specs = field_specs(fields)
    wanted = {s["key"] for s in specs if s.get("key")}
    if not wanted or not plain_text.strip():
        return {}, 0, 0
    system = _SYSTEM + json.dumps(specs, indent=2)
    if contract_type:
        system += f"\n\nThis is a {contract_type} contract."
    system += reading_note + PII_TOKEN_RULE

    from .candidates import Readings

    resolved = await resolve_llm("default", org_id=org_id, streaming=False, trace_name=trace_name)
    chunks = _chunk_text(plain_text)
    found: dict[str, dict] = {}
    # docs/39 A6 — what the other chunks read for a field already answered.
    # No chunk is read for that alone (the pass still stops once every field
    # has a value): these are answers a chunk read for the others gave anyway.
    readings = Readings()
    read = 0
    for n, i in enumerate(rank_chunks(chunks, specs)):
        read = n + 1
        resp = await resolved.llm.ainvoke(
            [
                SystemMessage(content=system),
                # Counterparty-authored text: framed as data, never instructions.
                HumanMessage(content=wrap_untrusted_document(chunks[i], source=f"contract body (chunk {i + 1} of {len(chunks)})")),
            ],
            config={"callbacks": resolved.callbacks},
        )
        data = loads_lenient(_text(resp.content))
        if isinstance(data, list):
            data = next((d for d in data if isinstance(d, dict)), {})
        answers = data.get("customFields") if isinstance(data, dict) else None
        if isinstance(answers, dict):
            for key, v in answers.items():
                if key in wanted and isinstance(v, dict) and v.get("value") is not None:
                    readings.add(key, v, i)
                    if key not in found:
                        found[key] = v
        if wanted <= found.keys():
            break
    # The first answer whose words are in the document, and every reading when they differ.
    settled = {key: readings.settle(key, plain_text) for key in found}
    out = check({key: primary or found[key] for key, (primary, _) in settled.items()}, specs, plain_text)
    for key, entry in out.items():
        candidates = settled.get(key, (None, None))[1]
        if candidates and entry.get("value") is not None:
            entry["candidates"] = candidates
    return out, read, len(chunks)
