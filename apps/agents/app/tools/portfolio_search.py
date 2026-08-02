"""
portfolio_search tool (P3.2 / docs/30 D.5.7)

Hybrid RAG across the org's contract portfolio. Reciprocal-Rank
Fusion (RRF) of:
  • pgvector cosine similarity on clause embeddings (semantic)
  • Elasticsearch BM25 on contract metadata (lexical)

Returns clause-granularity hits so the agent can cite specific
clauses like "Acme MSA §9.2 caps at $500k" rather than just naming
contracts. The right tool when the user asks a portfolio-scoped
question: "which MSAs have uncapped liability?", "show me every
contract that auto-renews next quarter", "compare our termination
clauses across the portfolio".

Return shape:
  {
    query, total,
    hits: [
      { contractId, contractTitle, contractType, contractStatus,
        counterpartyName, value, currency,
        clauseId, clauseType, sectionRef, excerpt,
        page, bbox, fusedScore, denseRank, bm25Rank }
    ],
    sources: { dense: bool, bm25: bool }
  }
"""
from __future__ import annotations

import logging

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..config import settings

log = logging.getLogger(__name__)


class PortfolioSearchArgs(BaseModel):
    query: str = Field(
        ...,
        description=(
            "Natural-language portfolio query — e.g. 'which MSAs have "
            "uncapped liability?', 'termination clauses in our vendor "
            "agreements', 'contracts with arbitration in New York'. "
            "Matches against clause embeddings + contract metadata."
        ),
    )
    top_k: int = Field(
        10, ge=1, le=30,
        description="Max number of clause-level hits to return.",
    )
    contract_type: str | None = Field(
        None,
        description=(
            "Optional filter to a specific type (NDA / MSA / SOW / SLA "
            "/ DPA / LICENSE / EMPLOYMENT / ORDER_FORM / PARTNERSHIP / "
            "VENDOR_AGREEMENT / OTHER). Use only when the user asks "
            "about a specific type."
        ),
    )
    status: str | None = Field(
        None,
        description="Optional filter on contract status.",
    )
    counterparty_name: str | None = Field(
        None,
        description=(
            "Optional filter on counterparty name (fuzzy match). Use "
            "when the user mentions a specific party."
        ),
    )


def build_portfolio_search(org_id: str) -> StructuredTool:

    async def _arun(
        query: str,
        top_k: int = 10,
        contract_type: str | None = None,
        status: str | None = None,
        counterparty_name: str | None = None,
    ) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/portfolio_search"
        headers = {
            "x-internal-secret": settings.internal_service_secret,
            "x-internal-service": "agents",
            "content-type":      "application/json",
        }
        payload: dict = {
            "orgId": org_id, "query": query, "topK": top_k,
        }
        if contract_type:     payload["contractType"]    = contract_type
        if status:            payload["status"]          = status
        if counterparty_name: payload["counterpartyName"] = counterparty_name
        async with httpx.AsyncClient(timeout=httpx.Timeout(20.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            log.warning("[portfolio_search] Node %s: %s", r.status_code, r.text[:200])
            return '{"error":"portfolio_search_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(query: str, top_k: int = 10, contract_type=None, status=None, counterparty_name=None):
        import asyncio
        return asyncio.run(_arun(query, top_k, contract_type, status, counterparty_name))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="portfolio_search",
        description=(
            "Hybrid RAG across the org's entire contract portfolio — "
            "BM25 + dense embeddings merged via Reciprocal Rank Fusion. "
            "Returns CLAUSE-level hits (not just contract cards) so "
            "you can cite specific passages across many contracts. "
            "Use this for portfolio questions: 'which MSAs have "
            "uncapped liability?', 'find every contract auto-renewing "
            "next quarter', 'compare termination clauses across the "
            "portfolio'. PREFER over contract_search when the user's "
            "question is about clause content, not just contract "
            "metadata. Scoped by contract type / status / counterparty "
            "when specified."
        ),
        args_schema=PortfolioSearchArgs,
    )
