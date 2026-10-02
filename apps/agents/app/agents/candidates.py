"""docs/39 A6 — every reading of a field, not the first one found.

A contract longer than one chunk is read a chunk at a time, and each chunk
says what it says about each field. The first reading used to win and the
rest were thrown away, so a contract that states a term twice — a fee in the
body and another in a schedule, a notice period a later clause changes —
showed one of them as if it were the only one; and an early chunk's empty
answer ("", or "no" with nothing to show for it) kept a later chunk's real
one out.

Now every chunk's reading is kept. The field's value is the first reading
whose words are in the document (document order: the body before the
exhibits appended to it); when another chunk reads something else, every
distinct reading goes with it, each with its words, for a person to choose
the one that governs.
"""
from __future__ import annotations

import json
import re
from typing import Any

#: At most this many readings of one field go back (the value's first).
MAX_CANDIDATES = 5

_EMPTY_WORDS = {"null", "none", "n/a", "na", "not stated", "not specified", "unknown", "-"}
_DURATION = re.compile(
    r"(\d+(?:\.\d+)?)\s*\)?\s*(business\s+days?|working\s+days?|calendar\s+days?|days?|weeks?|months?|years?)\b",
    re.I,
)
_CURRENCY = re.compile(r"^(?:[A-Z]{3}\s*|[$€£¥₹]\s*)?(-?[\d,]+(?:\.\d+)?)(?:\s*[A-Z]{3})?$")


def _quote(entry: dict) -> str | None:
    q = entry.get("quote")
    return q.strip() if isinstance(q, str) and q.strip() else None


def is_reading(entry: Any) -> bool:
    """A chunk's answer that says something: a value — and for a bare "no", the words that say it."""
    if not isinstance(entry, dict):
        return False
    v = entry.get("value")
    if v is None or v == "" or v == [] or v == {}:
        return False
    if isinstance(v, str) and v.strip().lower() in _EMPTY_WORDS:
        return False
    # A chunk that never mentions renewal answers "false" as readily as one that rules it out.
    if v is False or (isinstance(v, str) and v.strip().lower() == "false"):
        return _quote(entry) is not None
    return True


def _number(s: str) -> float | None:
    m = _CURRENCY.match(s.strip())
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", ""))
    except ValueError:
        return None


def _unit(word: str) -> str:
    w = re.sub(r"\s+", " ", word.lower()).rstrip("s")
    return "day" if w in ("day", "calendar day") else w


def _text(s: str) -> str:
    s = s.lower().translate(str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'", "–": "-", "—": "-", " ": " "}))
    s = re.sub(r"[^\w\s%.-]", " ", s)
    return re.sub(r"\s+", " ", s).strip(" .-")


def comparable(value: Any) -> str:
    """A reading as it's compared with another: the same term however it's written."""
    if isinstance(value, bool):
        return f"b:{value}"
    if isinstance(value, (int, float)):
        return f"n:{float(value):g}"
    if isinstance(value, str):
        low = value.strip().lower()
        if low in ("true", "yes"):
            return "b:True"
        if low in ("false", "no"):
            return "b:False"
        n = _number(value)
        if n is not None:
            return f"n:{n:g}"
        m = _DURATION.search(value)
        if m:
            return f"d:{float(m.group(1)):g} {_unit(m.group(2))}"
        return "t:" + _text(value)
    return "j:" + json.dumps(value, sort_keys=True, default=str)


def same(a: Any, b: Any) -> bool:
    """Two readings of one term: equal once written alike, or one name inside the other ("Delaware", "the State of Delaware")."""
    ca, cb = comparable(a), comparable(b)
    if ca == cb:
        return True
    if ca.startswith("t:") and cb.startswith("t:"):
        x, y = ca[2:], cb[2:]
        return min(len(x), len(y)) >= 3 and (x in y or y in x)
    return False


class Readings:
    """What each chunk read for each field, in the order the chunks were read."""

    def __init__(self) -> None:
        self.by_key: dict[str, list[dict]] = {}

    def add(self, key: str, entry: Any, chunk: int) -> None:
        if is_reading(entry):
            self.by_key.setdefault(key, []).append({"value": entry.get("value"), "quote": _quote(entry), "chunk": chunk, "entry": entry})

    def settle(self, key: str, document: str) -> tuple[dict | None, list[dict] | None]:
        """The chunk's answer the field takes, and — when the chunks read it differently — every distinct reading, that one first.

        The value is the first reading (in the document's order) whose words
        are in the document, else the first. Another reading counts only with words that are: an answer
        a chunk made up to fill a gap is no disagreement.
        """
        from .custom_fields import quote_in  # custom_fields keeps its readings here too

        # In the document's order, however the chunks were read (the custom pass reads the likeliest first).
        readings = sorted(self.by_key.get(key) or [], key=lambda r: r["chunk"])
        if not readings:
            return None, None
        grounded = [r for r in readings if r["quote"] and quote_in(r["quote"], document)]
        primary = grounded[0] if grounded else readings[0]
        distinct = [primary]
        for r in grounded:
            if not any(same(r["value"], d["value"]) for d in distinct):
                distinct.append(r)
        if len(distinct) < 2:
            return primary["entry"], None
        return primary["entry"], [{"value": r["value"], "quote": r["quote"]} for r in distinct[:MAX_CANDIDATES]]
