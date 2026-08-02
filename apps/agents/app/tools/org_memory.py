"""org_memory tool (P4.4 / docs/30 D.7.5)"""
from __future__ import annotations
import logging, httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field
from ..config import settings

log = logging.getLogger(__name__)


class OrgMemoryArgs(BaseModel):
    topic: str = Field(
        ...,
        description=(
            "The legal topic to query the org's institutional memory for "
            "(e.g. 'liability cap', 'auto-renewal', 'confidentiality "
            "term'). Matches against playbook category names + clause "
            "library tags + signed-contract clause types."
        ),
    )
    contract_type: str | None = Field(
        None,
        description="Narrow to a specific contract type (NDA / MSA / SOW / …).",
    )
    clause_type: str | None = Field(
        None,
        description=(
            "Override the inferred clauseType when querying past deals. "
            "Normally derived from the topic."
        ),
    )
    limit: int = Field(8, ge=1, le=20)


def build_org_memory(org_id: str) -> StructuredTool:
    async def _arun(topic: str, contract_type=None, clause_type=None, limit: int = 8) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/org_memory"
        headers = {"x-internal-secret": settings.internal_service_secret, "x-internal-service": "agents", "content-type": "application/json"}
        payload: dict = {"orgId": org_id, "topic": topic, "limit": limit}
        if contract_type: payload["contractType"] = contract_type
        if clause_type:   payload["clauseType"]   = clause_type
        async with httpx.AsyncClient(timeout=httpx.Timeout(12.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            log.warning("[org_memory] Node %s: %s", r.status_code, r.text[:200])
            return '{"error":"org_memory_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(topic: str, contract_type=None, clause_type=None, limit: int = 8):
        import asyncio
        return asyncio.run(_arun(topic, contract_type, clause_type, limit))

    return StructuredTool.from_function(
        coroutine=_arun, func=_run, name="org_memory",
        description=(
            "One-stop retrieval over the org's institutional memory — "
            "playbook positions + approved clause library + representative "
            "excerpts from signed deals — for a specific topic. Answers "
            "'what's our typical position on X?' natively. USE BEFORE "
            "answering questions like 'what's our standard liability cap?', "
            "'how do we handle auto-renewal?', 'what's our confidentiality "
            "term?'. Returns {playbook, clauseLibrary, pastDeals, summary}."
        ),
        args_schema=OrgMemoryArgs,
    )
