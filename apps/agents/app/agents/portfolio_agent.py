"""
Portfolio Query Agent — Phase 2.1

Translates a natural-language question about a contract portfolio into
a structured ES query, fetches contracts from the API, then synthesises
a plain-English answer with citations.

Examples:
  "How many NDAs expire in the next 90 days?"
  "Which vendors have no liability cap?"
  "Show me SaaS contracts with auto-renewal clauses governed by California law"
"""
from __future__ import annotations

import json
from ..jsonish import loads_lenient
from typing import Any

import httpx
from langchain_core.messages import HumanMessage, SystemMessage

from ..config import settings
from ..router import resolve_llm

# ─── Prompts ──────────────────────────────────────────────────────────────────

_PARSE_PROMPT = """\
You are a contract search specialist. Translate the user's natural-language question
into a structured search filter JSON.

Return ONLY valid JSON — no markdown, no explanation:
{
  "q": "<keyword query or null>",
  "type": "<NDA|MSA|SOW|SLA|VENDOR_AGREEMENT|EMPLOYMENT|PARTNERSHIP|LICENSE|OTHER|null>",
  "status": "<DRAFT|ACTIVE|UNDER_REVIEW|EXPIRED|TERMINATED|null>",
  "jurisdiction": "<jurisdiction string or null>",
  "riskScoreMin": <0.0-1.0 or null>,
  "riskScoreMax": <0.0-1.0 or null>,
  "clauseFlags": { "<flagName>": <true|false> } or null,
  "expiryDateFrom": "<ISO date or null>",
  "expiryDateTo": "<ISO date or null>",
  "effectiveDateFrom": "<ISO date or null>",
  "effectiveDateTo": "<ISO date or null>",
  "intent": "<count|list|summarise|compare>"
}

clauseFlags keys: forceMajeure, mfn, changeOfControl, auditRights,
                  assignmentRestriction, limitationOfLiability, indemnification, warrantyDisclaimer

Today's date: {today}
Question: """

_ANSWER_PROMPT = """\
You are a legal contract analyst. A user asked a question about their contract portfolio.
You have access to a list of contracts that match their query. Provide a clear, concise answer.

Rules:
- Lead with the direct answer (count, list, or summary)
- If listing contracts, include: title, counterparty, status, expiry date, risk score
- Use plain English — no legalese
- If the answer is "none" or "zero", say so clearly
- Cite contract titles where relevant
- Maximum 3 paragraphs

User question: {question}

Matching contracts ({count} total):
{contracts}
"""

# ─── Agent ────────────────────────────────────────────────────────────────────

def _parse_json(content: str) -> dict:
    content = content.strip()
    if content.startswith("```"):
        lines = content.split("\n")
        content = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    return loads_lenient(content)


def _clean_filters(raw: dict) -> dict:
    """Remove null values — API ignores missing keys, not null ones."""
    return {k: v for k, v in raw.items() if v is not None and k != "intent"}


async def run_portfolio_query(question: str, org_id: str) -> dict[str, Any]:
    from datetime import date
    parse_llm = await resolve_llm(
        "default",
        org_id=org_id,
        streaming=True,
        trace_name="portfolio.parse_query",
    )

    # Step 1: Parse question → structured filters
    try:
        resp = await parse_llm.llm.ainvoke([
            SystemMessage(content=_PARSE_PROMPT.format(today=date.today().isoformat())),
            HumanMessage(content=question),
        ], config={"callbacks": parse_llm.callbacks})
        raw_filters = _parse_json(resp.content)
        intent = raw_filters.get("intent", "list")
    except Exception as e:
        return {"answer": f"Could not parse question: {e}", "contracts": [], "filters": {}}

    filters = _clean_filters(raw_filters)
    filters["limit"] = 50  # fetch up to 50 for portfolio queries

    # Step 2: Fetch contracts from API
    headers = {
        "x-internal-service": "agents",
        "x-internal-secret": settings.internal_service_secret,
    }
    contracts: list[dict] = []
    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(
                f"{settings.api_url}/api/v1/search/advanced",
                json={**filters, "mode": "keyword"},
                headers=headers,
                timeout=15,
            )
            if res.status_code == 200:
                data = res.json()
                contracts = data.get("data", [])
    except Exception:
        pass

    if not contracts:
        return {
            "answer": "No contracts matched your query.",
            "contracts": [],
            "filters": filters,
            "count": 0,
        }

    # Step 3: Synthesise answer
    contract_summaries = []
    for c in contracts[:20]:  # truncate context to 20 for LLM
        contract_summaries.append(
            f"- {c.get('title', 'Untitled')} | {c.get('counterpartyName', 'N/A')} | "
            f"Status: {c.get('status')} | Risk: {c.get('riskScore', 'N/A')} | "
            f"Expires: {c.get('expiryDate', 'N/A')} | Jurisdiction: {c.get('jurisdiction', 'N/A')}"
        )

    if intent == "count":
        answer = f"There are **{len(contracts)}** contracts matching your query."
        if len(contracts) <= 5:
            answer += "\n\n" + "\n".join(contract_summaries)
    else:
        answer_llm = await resolve_llm(
            "default",
            org_id=org_id,
            streaming=True,
            trace_name="portfolio.answer",
        )
        try:
            ans_resp = await answer_llm.llm.ainvoke([
                SystemMessage(content=_ANSWER_PROMPT.format(
                    question=question,
                    count=len(contracts),
                    contracts="\n".join(contract_summaries),
                )),
                HumanMessage(content="Provide the answer."),
            ], config={"callbacks": answer_llm.callbacks})
            answer = ans_resp.content
        except Exception:
            answer = f"Found {len(contracts)} contracts. " + "; ".join(
                c.get("title", "Untitled") for c in contracts[:5]
            )

    return {
        "answer": answer,
        "contracts": contracts,
        "filters": filters,
        "count": len(contracts),
        "intent": intent,
    }
