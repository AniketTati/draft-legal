"""user_search — read tool (L9).

Turns a NAME into a user id. This is the blocker behind "assign the Acme MSA
to Alice": contract_update's assign_owner action requires payload.ownerId as a
user CUID, and the endpoint 404s "User not found in this org" for anything
else — so without this tool the flow dead-ends on asking the user to paste a
CUID.

Deliberately narrow. The user-facing GET /api/v1/users has no query parameter
and no limit and returns every org member; an agent needs to look someone up,
not to enumerate the directory.

Emails come back un-redacted on purpose — they are what distinguishes two
people called Alice, and this is internal directory data rather than
counterparty document text.
"""
from __future__ import annotations

import logging

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..config import settings

log = logging.getLogger(__name__)


class UserSearchArgs(BaseModel):
    query: str | None = Field(
        None,
        description=(
            "Name or email fragment to look for (e.g. 'Alice', 'alice@', "
            "'Nakamura'). Case-insensitive, matches either field. Omit to "
            "list the org's members."
        ),
    )
    limit: int = Field(20, ge=1, le=50, description="Max people to return.")


def build_user_search(org_id: str) -> StructuredTool:

    async def _arun(query: str | None = None, limit: int = 20) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/user_search"
        headers = {
            "x-internal-secret": settings.internal_service_secret,
            "x-internal-service": "agents",
            "content-type": "application/json",
        }
        payload: dict = {"orgId": org_id, "limit": limit}
        if query:
            payload["query"] = query
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            log.warning("[user_search] Node returned %s: %s", r.status_code, r.text[:200])
            return '{"error":"user_search_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(query: str | None = None, limit: int = 20) -> str:
        import asyncio
        return asyncio.run(_arun(query, limit))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="user_search",
        description=(
            "Find people in this organisation by name or email, and get their "
            "user id. Call this FIRST whenever the user refers to a colleague "
            "by name and you need an id — assigning an owner, delegating an "
            "approval, or naming a requester. If the result has "
            "\"ambiguous\": true, more than one person matched: ask the user "
            "which one they mean and list the candidates with their emails. "
            "Never pick one yourself."
        ),
        args_schema=UserSearchArgs,
    )
