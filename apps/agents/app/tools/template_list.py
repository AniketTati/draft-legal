"""template_list — read tool (L9).

Answers "what can I draft from?", which the agent previously answered from
memory or not at all: GET /api/v1/templates is JWT- and permission-gated, so
the agents service could not reach it.

Section HTML is NOT returned. This tool answers the question; it is not the
path that feeds an id into drafting — contract_create_from_template posts free
text and the pipeline picks the template itself.
"""
from __future__ import annotations

import logging

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..config import settings

log = logging.getLogger(__name__)


class TemplateListArgs(BaseModel):
    query: str | None = Field(
        None, description="Optional name/description fragment to filter by. Case-insensitive."
    )
    contract_type: str | None = Field(
        None, description="Optional exact contract type filter (NDA, MSA, SOW, ...)."
    )
    published_only: bool = Field(
        False, description="Only templates published for use. Default false (list drafts too)."
    )
    limit: int = Field(20, ge=1, le=50, description="Max templates to return.")


def build_template_list(org_id: str) -> StructuredTool:

    async def _arun(
        query: str | None = None,
        contract_type: str | None = None,
        published_only: bool = False,
        limit: int = 20,
    ) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/template_list"
        headers = {
            "x-internal-secret": settings.internal_service_secret,
            "x-internal-service": "agents",
            "content-type": "application/json",
        }
        payload: dict = {"orgId": org_id, "limit": limit, "publishedOnly": published_only}
        if query:
            payload["query"] = query
        if contract_type:
            payload["contractType"] = contract_type
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            log.warning("[template_list] Node returned %s: %s", r.status_code, r.text[:200])
            return '{"error":"template_list_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(
        query: str | None = None,
        contract_type: str | None = None,
        published_only: bool = False,
        limit: int = 20,
    ) -> str:
        import asyncio
        return asyncio.run(_arun(query, contract_type, published_only, limit))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="template_list",
        description=(
            "List the contract templates this organisation can draft from, "
            "with their type, publication state and how often each is used. "
            "Use for 'what can I draft from?', 'do we have an NDA template?', "
            "'which templates exist for MSAs?'. Returns metadata only — no "
            "template body. To actually draft, use "
            "contract_create_from_template and describe what is needed in "
            "plain language."
        ),
        args_schema=TemplateListArgs,
    )
