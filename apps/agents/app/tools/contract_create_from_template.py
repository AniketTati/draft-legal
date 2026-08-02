"""contract_create_from_template — create a Contract+Version draft.

Tool name kept as `contract_create_from_template` so the existing frontend
Doc-artifact handler (artifact-from-tool.ts line 134) renders the result
without further changes. Backend routes to /tools/contract_draft, which
takes a free-text user_message instead of a templateId+variables.

Before this tool existed the system prompt instructed the agent to call
template_list + contract_create_from_template — neither of which were
registered. The agent fell into a loop hallucinating "I created the draft"
without ever calling a tool that produced one.

This tool wraps the existing /draft pipeline (Python `run_draft` →
template selection → variable substitution → HTML rendering) and the Node
side persists a real Contract + ContractVersion in DRAFT status. Returns
the artifact-shaped payload the frontend Doc artifact handler expects so
the user sees a previewable draft on the right pane.
"""
from __future__ import annotations
import logging, httpx
from typing import Optional
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field
from ..config import settings

log = logging.getLogger(__name__)


class ContractCreateFromTemplateArgs(BaseModel):
    user_message: str = Field(
        ...,
        description=(
            "Free-text description of what to draft. The drafting pipeline "
            "parses this for type + counterparty + intent, so include both "
            "in the message — e.g. 'mutual NDA for Apple, 2-year term, "
            "California governing law' or 'MSA for Snowflake, $2M annual "
            "commitment, NDA-equivalent confidentiality'."
        ),
    )
    contract_type: Optional[str] = Field(
        None,
        description="Hint for the contract type: NDA | MSA | SOW | "
                    "VENDOR_AGREEMENT | LICENSE | EMPLOYMENT | DATA_PROCESSING. "
                    "Used as a fallback when the message is ambiguous.",
    )
    counterparty_name: Optional[str] = Field(
        None,
        description="The other party's company name. Required for the title "
                    "and for matching against prior contracts with that party.",
    )
    title: Optional[str] = Field(
        None,
        description="Optional explicit title for the new contract row. If "
                    "omitted, derived from counterparty + type (e.g. "
                    "'Apple — NDA').",
    )


def build_contract_create_from_template(org_id: str, user_id: str | None = None) -> StructuredTool:
    async def _arun(
        user_message: str,
        contract_type: Optional[str] = None,
        counterparty_name: Optional[str] = None,
        title: Optional[str] = None,
    ) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/contract_draft"
        headers = {
            "x-internal-secret": settings.internal_service_secret,
            "x-internal-service": "agents",
            "content-type": "application/json",
        }
        payload: dict = {
            "orgId":       org_id,
            "userId":      user_id or "system",
            "userMessage": user_message,
        }
        if contract_type:     payload["contractType"]     = contract_type
        if counterparty_name: payload["counterpartyName"] = counterparty_name
        if title:             payload["title"]            = title
        # Drafting takes longer than search — bump timeout to 30s
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            log.warning("[contract_create_from_template] Node %s: %s",
                        r.status_code, r.text[:200])
            return r.text  # pass through structured errors (NO_TEMPLATE_MATCH etc.)
        return r.text

    def _run(user_message: str, contract_type: Optional[str] = None,
             counterparty_name: Optional[str] = None, title: Optional[str] = None):
        import asyncio
        return asyncio.run(_arun(user_message, contract_type, counterparty_name, title))

    return StructuredTool.from_function(
        coroutine=_arun, func=_run,
        name="contract_create_from_template",
        description=(
            "Create a new Contract + ContractVersion in DRAFT status by "
            "rendering an org template with the user's intent. The drafting "
            "pipeline picks the best-fit template, substitutes variables, "
            "and persists the result so the user sees the draft in their "
            "Contracts page AND a previewable artifact on the right pane.\n\n"
            "USE THIS TOOL when the user asks you to 'draft an NDA for X', "
            "'create an MSA with Y', 'send an order form to Z', or any "
            "variant — even (especially) if they've said 'yes' twice. The "
            "ONLY way to actually create a draft is to call this tool. "
            "Promising 'I'll create it' without calling this tool is a "
            "failure mode — never do that.\n\n"
            "Returns the artifact payload (html, title, contractId) plus "
            "metadata. The frontend renders the html as a Doc artifact and "
            "links to /contracts/{contractId} for full editing.\n\n"
            "If the org has no template for the requested type, the tool "
            "returns NO_TEMPLATE_MATCH — relay that back to the user and "
            "suggest they create a template first."
        ),
        args_schema=ContractCreateFromTemplateArgs,
    )
