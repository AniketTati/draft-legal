"""counterparty_get tool (P4.5)"""
from __future__ import annotations
import logging, httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field
from ..config import settings

log = logging.getLogger(__name__)


class CounterpartyGetArgs(BaseModel):
    name: str | None = Field(
        None,
        description="Fuzzy name match ('Acme' matches 'Acme Corp' / 'Acme LLC'). Up to 10 matches.",
    )
    id:   str | None = Field(
        None,
        description="Exact counterparty CUID. Use when you already have the id from a prior tool call.",
    )


def build_counterparty_get(org_id: str) -> StructuredTool:
    async def _arun(name: str | None = None, id: str | None = None) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/counterparty_get"
        headers = {"x-internal-secret": settings.internal_service_secret, "x-internal-service": "agents", "content-type": "application/json"}
        payload: dict = {"orgId": org_id}
        if name: payload["name"] = name
        if id:   payload["id"]   = id
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code == 404:
            return '{"items":[],"total":0,"note":"no counterparty matched"}'
        if r.status_code >= 400:
            log.warning("[counterparty_get] Node %s: %s", r.status_code, r.text[:200])
            return '{"error":"counterparty_get_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(name=None, id=None):
        import asyncio
        return asyncio.run(_arun(name, id))

    return StructuredTool.from_function(
        coroutine=_arun, func=_run, name="counterparty_get",
        description=(
            "Look up a counterparty by name (fuzzy) or id. Returns contacts, "
            "contractCount, legal name, website, and contact-list JSON. Use "
            "when the user asks 'who do we contact at Acme?' or 'how many "
            "deals do we have with Globex?'."
        ),
        args_schema=CounterpartyGetArgs,
    )
