"""docs/41 Part 13 — new words for an amendment, one clause at a time.

A lawyer picks a clause of the agreement and says what should change ("make
payment 45 days"). The model writes the replacement words for that section,
and quotes the words of the agreement it changes. The quote is checked here
against the clause: a quote the clause doesn't contain is dropped, and the
caller shows the whole clause as the evidence instead. The operative
sentence ("Section 5 is deleted and replaced with…") is written by the API,
deterministically; the model writes only the new words.
"""
from __future__ import annotations

import asyncio
import os
import re

from fastapi import APIRouter, Header, HTTPException
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from app.jsonish import loads_lenient
from app.pii_tokens import PII_TOKEN_RULE
from app.router import resolve_llm

router = APIRouter()
INTERNAL_SECRET = os.getenv("INTERNAL_SERVICE_SECRET", "")


class AmendmentClause(BaseModel):
    clauseId: str
    clauseText: str = Field(max_length=12000)
    clauseType: str = "other"
    sectionRef: str | None = None
    instruction: str = Field(min_length=1, max_length=2000)


class AmendmentLanguageRequest(BaseModel):
    items: list[AmendmentClause] = Field(min_length=1, max_length=10)
    contractType: str = "general commercial"
    orgId: str | None = None


_SYSTEM = (
    "You draft amendments to signed commercial contracts. For one section of "
    "the agreement, write the complete new wording of that section as it "
    "should read after the amendment, following the lawyer's instruction. "
    "Keep the agreement's defined terms, style and numbering; change only what "
    "the instruction asks. Do not write the amendment's operative sentence "
    "(\"Section 5 is deleted and replaced…\"): only the section's new words.\n"
    "Reply with JSON only: {\"proposedText\": \"<the section's new words>\", "
    "\"rationale\": \"<one sentence: what changed and why>\", "
    "\"quote\": \"<the words of the section that change, copied exactly>\"}"
)


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.replace("“", '"').replace("”", '"').replace("’", "'")).strip().lower()


def ground_quote(quote: object, clause_text: str) -> str | None:
    """The quote, when the clause holds it (spacing and curly quotes aside); else None."""
    if not isinstance(quote, str) or len(quote.strip()) < 3:
        return None
    return quote.strip() if _norm(quote) in _norm(clause_text) else None


def shape_draft(item: AmendmentClause, raw: dict) -> dict:
    """What the API gets back for one clause: the new words, and the quote only when grounded."""
    proposed = raw.get("proposedText") if isinstance(raw, dict) else None
    proposed = proposed.strip() if isinstance(proposed, str) else ""
    base = {"clauseId": item.clauseId, "quote": None, "rationale": None}
    if not proposed:
        return {**base, "proposedText": None, "error": "No new words came back"}
    rationale = raw.get("rationale")
    return {
        **base,
        "proposedText": proposed,
        "rationale": rationale.strip()[:500] if isinstance(rationale, str) else None,
        "quote": ground_quote(raw.get("quote"), item.clauseText),
        "error": None,
    }


async def _draft_one(llm, callbacks, item: AmendmentClause, contract_type: str) -> dict:
    where = f"Section {item.sectionRef}" if item.sectionRef else f"The {item.clauseType.replace('_', ' ')} clause"
    user = (
        f"Contract type: {contract_type}\n{where} currently reads:\n\"\"\"\n{item.clauseText[:6000]}\n\"\"\"\n\n"
        f"Lawyer's instruction: {item.instruction.strip()}\n\nWrite the JSON now."
    )
    try:
        response = await llm.ainvoke([SystemMessage(content=_SYSTEM + PII_TOKEN_RULE), HumanMessage(content=user)],
                                     config={"callbacks": callbacks})
        content = response.content if isinstance(response.content, str) else str(response.content)
        content = content.strip()
        if content.startswith("```"):
            content = content.split("```", 2)[1]
            if content.startswith("json"):
                content = content[4:]
        return shape_draft(item, loads_lenient(content))
    except Exception as e:  # noqa: BLE001 — one clause failing leaves the others
        return {"clauseId": item.clauseId, "proposedText": None, "rationale": None, "quote": None,
                "error": f"{type(e).__name__}: {str(e)[:180]}"}


@router.post("/amendment_language")
async def amendment_language(req: AmendmentLanguageRequest, x_internal_secret: str = Header(default="")):
    if INTERNAL_SECRET and x_internal_secret != INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")
    resolved = await resolve_llm("reasoning", org_id=req.orgId, streaming=False, trace_name="assist.amendment_language")
    drafts = await asyncio.gather(*[_draft_one(resolved.llm, resolved.callbacks, it, req.contractType) for it in req.items])
    return {"drafts": list(drafts), "model": resolved.model, "provider": resolved.provider}
