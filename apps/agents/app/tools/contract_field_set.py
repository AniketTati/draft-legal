"""contract_field_set — write tool (plan-then-execute), docs/39 C5.

"Set payment terms on the Acme MSA to 45 days." Nothing is written when the
model calls it: the tool asks the API what the change would be
(/api/internal/ai/tools/contract_field_preview — the field found by the name
the user said, the value read in the field's own terms, and the value it
would replace, with who set it) and returns an awaiting-confirmation card.
Only the user's Apply writes it, as them, undoably
(/agent/threads/:id/actions/apply → /api/internal/ai/tools/contract_field_set).

A field or value the API can't take comes back as an ordinary result with a
`note`, for the model to tell the user — no card.
"""
from __future__ import annotations

import logging

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..config import settings

log = logging.getLogger(__name__)


class ContractFieldSetArgs(BaseModel):
    contract_id: str = Field(..., description="Contract CUID whose field to set (from contract_search or the page).")
    field: str = Field(
        ...,
        description="The field as the user names it ('payment terms', 'governing law', 'PO number') or its key.",
    )
    value: str = Field(
        ...,
        min_length=1,
        max_length=500,
        description=(
            "The value in plain words, as the user gave it: '45 days', 'USD 120,000', '2027-03-31', "
            "'yes', 'Delaware', 'EMEA'. Never a redacted placeholder — ask the user for the real value."
        ),
    )


def build_contract_field_set(org_id: str, user_id: str | None = None) -> StructuredTool:
    async def _arun(contract_id: str, field: str, value: str) -> dict | str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/contract_field_preview"
        headers = {
            "x-internal-secret": settings.internal_service_secret,
            "x-internal-service": "agents",
            "content-type": "application/json",
        }
        payload: dict = {"orgId": org_id, "contractId": contract_id, "field": field, "value": value}
        if user_id:
            payload["userId"] = user_id
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            log.warning("[contract_field_set] preview failed %s: %s", r.status_code, r.text[:200])
            return r.text
        plan = r.json()
        if not plan.get("ok"):
            # Unknown field, a value it can't hold, a placeholder: the model says so.
            return {"error": plan.get("error", "not_possible"), "note": plan.get("note", "")}

        label = plan["field"]["label"]
        before = plan.get("before")
        summary = f"Set {label} on {plan['contractTitle']} to {plan['display']}"
        if before:
            summary += f" (now {before['display']}"
            # Never silently: a value a person set or checked is named as theirs.
            if before.get("by") and (before.get("checked") or before.get("source") not in ("ai", "calculated")):
                summary += f", set by {before['by']}"
            elif before.get("source") in ("ai", "calculated"):
                summary += ", read by the AI"
            summary += ")"
        return {
            "awaitingConfirmation": True,
            # Exactly what /tools/contract_field_set takes; the apply RPC adds orgId and userId.
            "args": {"contractId": contract_id, "field": plan["field"]["key"], "value": value},
            "preview": {
                "summary": summary,
                "target": plan["contractTitle"],
                "contractId": contract_id,
                "diff": [{"field": label, "before": before["display"] if before else "—", "after": plan["display"]}],
            },
            "reversible": True,
        }

    def _run(contract_id: str, field: str, value: str) -> dict | str:
        import asyncio
        return asyncio.run(_arun(contract_id, field, value))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="contract_field_set",
        description=(
            "Propose setting ONE field's value on ONE contract ('set payment terms on the Acme MSA to 45 days', "
            "'the governing law is actually England and Wales'). The user sees the current value, who set it, "
            "and the new one on an Apply card; nothing changes until they apply it, and it can be undone. "
            "Only when the user asks for the change — never to 'confirm' a value nobody asked to change. "
            "If the reply has an `error`, tell the user its `note`."
        ),
        args_schema=ContractFieldSetArgs,
    )
