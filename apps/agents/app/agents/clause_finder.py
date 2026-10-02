"""
docs/39 E3 — an organisation's own clause type, found in a contract.

The extraction tags clauses from a fixed list. An organisation adds its own:
a name, what it is, and passages that are one. Here one such type is looked
for across a contract a chunk at a time; every passage found is checked to be
in the document word for word (a paraphrase is dropped) and returned with its
first and last words, for the API to place it in the contract's text.

Used by /find-clause: the API's "Try it on a contract", and the run that finds
a new type in the contracts read before it existed.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from ..jsonish import loads_lenient
from ..pii_tokens import PII_TOKEN_RULE
from ..router import resolve_llm
from ..untrusted import wrap_untrusted_document
from .custom_fields import quote_in

logger = logging.getLogger(__name__)

_SYSTEM = """You find one kind of clause in a contract, for an organisation that defined it.

Return ONLY valid JSON: {"clauses": [{"startsWith": "<the clause's first 10-15 words, copied exactly>", "endsWith": "<its last 10-15 words, copied exactly>", "content": "<the clause's text copied exactly; if it is longer than 800 characters, its first 800>", "sectionRef": "<e.g. Section 5.2, or null>", "interpretation": "<what it means for each party, in one or two sentences>"}]}
Return every passage in the text that is this kind of clause, and nothing that isn't. If there is none: {"clauses": []}.
Copy word for word from the contract; never paraphrase, and never join separate passages.
The examples show what this clause looks like in other contracts: find it by what it does, not by matching their wording.

The clause type:
"""

MAX_EXAMPLES = 20


def clause_spec(clause_type: dict) -> dict:
    """The type as the prompt describes it: its name, what it is, and its examples."""
    return {
        "name": clause_type.get("label") or clause_type.get("key"),
        "what it is": str(clause_type.get("description") or "")[:1000],
        "examples": [str(e)[:600] for e in (clause_type.get("examples") or [])[:MAX_EXAMPLES] if str(e).strip()],
    }


def _text(content: Any) -> str:
    if isinstance(content, list):
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    return str(content)


def checked(items: Any, document: str, seen: list[str]) -> list[dict]:
    """The model's clauses that are in the document word for word, each once."""
    out: list[dict] = []
    for c in items if isinstance(items, list) else []:
        if not isinstance(c, dict):
            continue
        content = " ".join(str(c.get("content") or "").split())
        # Word for word — its opening, at least: a long clause comes cut at 800 characters.
        if len(content) < 12 or not quote_in(content[:300], document):
            continue
        if any(content[:120] == s[:120] for s in seen):
            continue
        seen.append(content)
        out.append({
            "content": content,
            "startsWith": c.get("startsWith") or None,
            "endsWith": c.get("endsWith") or None,
            "sectionRef": c.get("sectionRef") or None,
            "interpretation": c.get("interpretation") or None,
        })
    return out


async def find_clause(
    plain_text: str,
    clause_type: dict,
    *,
    org_id: str | None = None,
    trace_name: str = "find_clause",
) -> tuple[list[dict], int]:
    """Every passage of the contract that is this kind of clause, checked: (clauses, chunks read)."""
    from .review_agent import _chunk_text  # the review agent imports custom_fields, which this imports

    if not plain_text.strip():
        return [], 0
    system = _SYSTEM + json.dumps(clause_spec(clause_type), ensure_ascii=False, indent=2) + PII_TOKEN_RULE
    resolved = await resolve_llm("default", org_id=org_id, streaming=False, trace_name=trace_name)
    chunks = _chunk_text(plain_text)
    found: list[dict] = []
    seen: list[str] = []
    for i, chunk in enumerate(chunks):
        resp = await resolved.llm.ainvoke(
            [
                SystemMessage(content=system),
                # Counterparty-authored text: framed as data, never instructions.
                HumanMessage(content=wrap_untrusted_document(chunk, source=f"contract body (chunk {i + 1} of {len(chunks)})")),
            ],
            config={"callbacks": resolved.callbacks},
        )
        data = loads_lenient(_text(resp.content))
        items = data.get("clauses") if isinstance(data, dict) else data
        found.extend(checked(items, plain_text, seen))
    return found, len(chunks)
