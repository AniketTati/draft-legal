"""contract_create_from_template — plan a draft, then create it on confirm.

Tool name kept as `contract_create_from_template` so the existing apply
path (agent-threads.ts WRITE_TOOLS → /tools/contract_create_from_template →
undo) and the Doc-artifact handler (artifact-from-tool.ts) work unchanged.

C12 — this tool used to POST /tools/contract_draft, which created the
contract mid-stream: no confirmation card, no undo, no permission check at
apply time, and California law / a 2-year term / today's date whatever the
user asked. Now /tools/contract_draft only PLANS (template choice + the
user's stated terms mapped onto that template's variables, rendered). This
tool returns the plan as an `awaitingConfirmation` card like the other write
tools; the contract is created only when the user clicks Apply, and stays
undoable.
"""
from __future__ import annotations
import logging, httpx
from typing import Optional
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field
from ..config import settings

log = logging.getLogger(__name__)

# How the confirmation card names a contract type ("a draft vendor agreement",
# not "a draft VENDOR_AGREEMENT").
_TYPE_LABELS = {
    "NDA": "NDA", "MSA": "MSA", "SOW": "SOW", "SLA": "SLA",
    "VENDOR_AGREEMENT": "vendor agreement", "LICENSE": "license agreement",
    "EMPLOYMENT": "employment agreement", "DATA_PROCESSING": "data processing agreement",
    "ORDER_FORM": "order form", "PARTNERSHIP": "partnership agreement", "OTHER": "agreement",
}


class ContractCreateFromTemplateArgs(BaseModel):
    user_message: str = Field(
        ...,
        description=(
            "What the user asked for, in their words — used to tell the contract "
            "type when contract_type/template_id aren't given."
        ),
    )
    contract_type: Optional[str] = Field(
        None,
        description=(
            "The kind of agreement, worked out from what it is for: NDA (sharing "
            "confidential information), MSA (a framework for ongoing services), SOW "
            "(one project under an MSA), VENDOR_AGREEMENT (buying from or supplying "
            "to a vendor or supplier — goods, products or raw materials; a purchase, "
            "supply or procurement), LICENSE (licensing software or IP), EMPLOYMENT "
            "(hiring someone), DATA_PROCESSING (processing personal data, a DPA)."
        ),
    )
    template_id: Optional[str] = Field(
        None,
        description="A specific template's id from template_list. Use it when the user names a template, or when a previous call returned NO_TEMPLATE_MATCH with a list of templates.",
    )
    counterparty_name: Optional[str] = Field(None, description="The other party's company name, if the user gave it.")
    title: Optional[str] = Field(None, description="A short title that says what it is, e.g. 'Acme — Supply Agreement'; defaults to '<counterparty> — <type>'.")
    governing_law: Optional[str] = Field(None, description="Governing law / jurisdiction ONLY if the user stated it, e.g. 'New York'. Never guess.")
    term: Optional[str] = Field(None, description="Contract term ONLY if the user stated it, e.g. '3 years'. Never guess.")
    effective_date: Optional[str] = Field(None, description="Effective date ONLY if the user stated it (YYYY-MM-DD). Never guess.")
    terms: Optional[dict[str, str]] = Field(
        None,
        description=(
            "Any other terms the user stated, keyed by the template's variable name "
            "(a previous call's unfilledVariables lists them), e.g. {'payment_terms': 'net 45'}."
        ),
    )


def build_contract_create_from_template(org_id: str, user_id: str | None = None) -> StructuredTool:
    async def _arun(
        user_message: str,
        contract_type: Optional[str] = None,
        template_id: Optional[str] = None,
        counterparty_name: Optional[str] = None,
        title: Optional[str] = None,
        governing_law: Optional[str] = None,
        term: Optional[str] = None,
        effective_date: Optional[str] = None,
        terms: Optional[dict[str, str]] = None,
    ) -> dict | str:
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
        for key, value in (
            ("contractType", contract_type), ("templateId", template_id),
            ("counterpartyName", counterparty_name), ("title", title),
            ("governingLaw", governing_law), ("term", term),
            ("effectiveDate", effective_date), ("terms", terms),
        ):
            if value:
                payload[key] = value
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            log.warning("[contract_create_from_template] plan failed %s: %s", r.status_code, r.text[:200])
            return r.text  # structured errors (NO_TEMPLATE_MATCH + templates, CONTRACT_TYPE_AMBIGUOUS …)

        plan = r.json()
        unfilled: list[str] = plan.get("unfilledVariables") or []
        who = f" for {plan['counterpartyName']}" if plan.get("counterpartyName") else ""
        ctype = plan["contractType"]
        # Template labels ('BAA', 'Order Form') read fine as they are; codes don't.
        kind = _TYPE_LABELS.get(ctype) or (ctype.replace("_", " ").lower() if "_" in ctype else ctype)
        summary = f"Create a draft {kind}{who} from the template \"{plan['templateName']}\""
        if unfilled:
            shown = ", ".join(unfilled[:6]) + ("…" if len(unfilled) > 6 else "")
            summary += f" — {len(unfilled)} term(s) left blank to fill in: {shown}"
        open_slots = [sl.get("familyName") for sl in (plan.get("slots") or []) if sl.get("decidedBy") == "unresolved"]
        if open_slots:
            summary += f" — {len(open_slots)} clause choice(s) to make: {', '.join(n for n in open_slots if n)}"

        # The args are exactly what /tools/contract_create_from_template takes;
        # the apply RPC injects userId (from the JWT) and records the ToolCall.
        args: dict = {
            "templateId":   plan["templateId"],
            "variables":    plan.get("variables") or {},
            "title":        plan["title"],
            "contractType": plan["contractType"],
        }
        if plan.get("counterpartyName"):
            args["counterpartyName"] = plan["counterpartyName"]
        # docs/41 Part 1 — the variant each clause slot uses and why, so Apply
        # drafts exactly what the card shows and records how it was decided.
        for key in ("slotChoices", "slotDecisions", "variableSources"):
            if plan.get(key):
                args[key] = plan[key]
        return {
            "awaitingConfirmation": True,
            "args": args,
            "preview": {
                "summary":           summary,
                "templateName":      plan["templateName"],
                "contractType":      plan["contractType"],
                "unfilledVariables": unfilled,
                "html":              (plan.get("html") or "")[:20_000],
            },
            "reversible": True,
        }

    def _run(user_message: str, contract_type: Optional[str] = None, template_id: Optional[str] = None,
             counterparty_name: Optional[str] = None, title: Optional[str] = None,
             governing_law: Optional[str] = None, term: Optional[str] = None,
             effective_date: Optional[str] = None, terms: Optional[dict[str, str]] = None):
        import asyncio
        return asyncio.run(_arun(user_message, contract_type, template_id, counterparty_name, title,
                                 governing_law, term, effective_date, terms))

    return StructuredTool.from_function(
        coroutine=_arun, func=_run,
        name="contract_create_from_template",
        description=(
            "Draft a new contract from one of the org's templates. This PREPARES "
            "the draft and shows it to the user on a confirmation card; the "
            "contract is created only when they click Apply, and it can be undone.\n\n"
            "Pass only terms the user actually stated (governing_law, term, "
            "effective_date, counterparty_name, and anything else in `terms`). "
            "Unstated terms use the template's own defaults or are left blank — "
            "never invent them. The card lists the blank ones; tell the user.\n\n"
            "USE THIS TOOL when the user asks to draft / create an NDA, MSA, SOW, "
            "order form, etc. It is the ONLY way to produce a draft — never say a "
            "draft exists unless this tool returned a card and the user applied it.\n\n"
            "If it returns NO_TEMPLATE_MATCH with a `templates` list, offer those "
            "or call again with template_id; if the org has none, say so."
        ),
        args_schema=ContractCreateFromTemplateArgs,
    )
