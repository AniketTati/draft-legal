"""custom_field_list tool (P4.5)"""
from __future__ import annotations
import logging, httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field
from ..config import settings

log = logging.getLogger(__name__)


class CustomFieldListArgs(BaseModel):
    contract_type: str | None = Field(
        None,
        description="Filter to fields for a specific contract type (NDA / MSA / SOW / …). Null-typed fields apply to all.",
    )


def build_custom_field_list(org_id: str) -> StructuredTool:
    async def _arun(contract_type: str | None = None) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/custom_field_list"
        headers = {"x-internal-secret": settings.internal_service_secret, "x-internal-service": "agents", "content-type": "application/json"}
        payload: dict = {"orgId": org_id}
        if contract_type: payload["contractType"] = contract_type
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            log.warning("[custom_field_list] Node %s: %s", r.status_code, r.text[:200])
            return '{"error":"custom_field_list_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(contract_type=None):
        import asyncio
        return asyncio.run(_arun(contract_type))

    return StructuredTool.from_function(
        coroutine=_arun, func=_run, name="custom_field_list",
        description=(
            "List this org's custom contract field definitions. Each has "
            "{fieldKey, fieldLabel, fieldType, required, options, "
            "contractType}. Use to discover what structured fields the org "
            "tracks beyond the core ones (e.g. 'NDA Term', 'Renewal Notice "
            "Period'), especially when drafting or extracting."
        ),
        args_schema=CustomFieldListArgs,
    )
