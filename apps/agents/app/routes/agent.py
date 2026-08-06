"""
Agent routes — Phase 2.1

POST /agent/portfolio-query  — NL → ES filters → answer
POST /agent/ask              — RAG Q&A with pre-retrieved clauses
"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from ..agents.portfolio_agent import run_portfolio_query
from ..agents.ask_agent import run_ask

router = APIRouter()


class PortfolioQueryRequest(BaseModel):
    query: str
    orgId: str
    userId: str | None = None


class AskRequest(BaseModel):
    question: str
    orgId: str
    contractId: str | None = None
    clauseMatches: list[dict]


@router.post("/agent/portfolio-query")
async def portfolio_query(body: PortfolioQueryRequest):
    result = await run_portfolio_query(body.query, body.orgId)
    return result


@router.post("/agent/ask")
async def ask_contract(body: AskRequest):
    result = await run_ask(body.question, body.clauseMatches, body.contractId, org_id=body.orgId)
    return result
