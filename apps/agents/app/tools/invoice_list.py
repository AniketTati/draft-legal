"""invoice_list tool — what a vendor billed, for renewal prep."""
from __future__ import annotations
import json, logging, httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field
from ..config import settings

log = logging.getLogger(__name__)


class InvoiceListArgs(BaseModel):
    contract_id: str | None = Field(
        None,
        description="A contract's invoices (the EXACT id from a prior tool result). Pass this, or counterparty_name.",
    )
    counterparty_name: str | None = Field(
        None,
        description="The vendor's name, matched against the invoice's vendor and its contract's counterparty.",
    )
    status: str | None = Field(
        None,
        description="PENDING | MATCHED | RECONCILED | DISPUTED. Omit for all.",
    )
    limit: int = Field(50, ge=1, le=100)


def build_invoice_list(org_id: str, user_id: str | None = None) -> StructuredTool:
    async def _arun(contract_id=None, counterparty_name=None, status=None, limit: int = 50) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/invoice_list"
        headers = {"x-internal-secret": settings.internal_service_secret, "x-internal-service": "agents", "content-type": "application/json"}
        payload: dict = {"orgId": org_id, "userId": user_id, "limit": limit}
        if contract_id:       payload["contractId"]       = contract_id
        if counterparty_name: payload["counterpartyName"] = counterparty_name
        if status:            payload["status"]           = status.upper()
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code == 403:
            # As template_list (X9): say why, so the model tells the user rather than guessing.
            try:
                detail = r.json().get("detail")
            except ValueError:
                detail = None
            return json.dumps({"error": "permission_denied", "detail": detail or "The user does not have permission for this."})
        if r.status_code >= 400:
            log.warning("[invoice_list] Node %s: %s", r.status_code, r.text[:200])
            return '{"error":"invoice_list_failed","status":' + str(r.status_code) + "}"
        return r.text

    def _run(contract_id=None, counterparty_name=None, status=None, limit: int = 50):
        import asyncio
        return asyncio.run(_arun(contract_id, counterparty_name, status, limit))

    return StructuredTool.from_function(
        coroutine=_arun, func=_run, name="invoice_list",
        description=(
            "List the invoices billed under a contract (contract_id) or by a "
            "vendor (counterparty_name), oldest first: number, date, amount, "
            "currency, description (often the quantity and unit price billed), "
            "reconciliation status (PENDING / MATCHED / RECONCILED / DISPUTED) "
            "and dispute reason, plus billedTotal and byStatus. Use it to "
            "compare what was billed against the negotiated pricing — read "
            "the prices from the contract and its amendments with contract_get; "
            "the later amendment's price applies from its effective date. "
            "Report each overcharge with the invoice number, the rate billed, "
            "the agreed rate and the difference."
        ),
        args_schema=InvoiceListArgs,
    )
