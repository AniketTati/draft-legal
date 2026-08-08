"""
redline_propose tool (P1.4 / D.5.2)

Generate THREE aggression-variant rewrites (least / moderate / aggressive)
of a target clause in a single call. Grounded in the matching playbook
position + rules. Read-only — picking a variant and turning it into a
new ContractVersion is redline_apply's job (P1.5).

Returns:
  {
    contract: {id, title, type},
    clause:   {id, clauseType, sectionRef, originalText},
    category: {id, name} | null,
    hasPlaybook: bool,
    variants: [
      { aggression: 'least'|'moderate'|'aggressive',
        proposedText: str,
        rationale: str,
        changes: [{before, after, reason}] }
    ]
  }
"""
from __future__ import annotations

import logging

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..config import settings

log = logging.getLogger(__name__)


class RedlineProposeArgs(BaseModel):
    contract_id: str = Field(
        ...,
        description="The CUID of the contract containing the clause to redline.",
    )
    clause_type: str | None = Field(
        None,
        description=(
            "Extractor clauseType to target (e.g. 'limitation_of_liability', "
            "'confidentiality'). Use when you want the first clause of that "
            "type; for a specific row, pass clause_id instead."
        ),
    )
    clause_id: str | None = Field(
        None,
        description="The CUID of a specific ContractClause row.",
    )
    instructions: str | None = Field(
        None,
        description=(
            "Optional user direction (e.g. 'make the cap 6 months', 'add a "
            "carve-out for willful misconduct'). Passed verbatim to the "
            "redline LLM alongside the playbook rules."
        ),
    )


def build_redline_propose(org_id: str) -> StructuredTool:

    async def _arun(
        contract_id: str,
        clause_type: str | None = None,
        clause_id:   str | None = None,
        instructions: str | None = None,
    ) -> str:
        url = f"{settings.api_url.rstrip('/')}/api/internal/ai/tools/redline_propose"
        headers = {
            "x-internal-secret": settings.internal_service_secret,
            "x-internal-service": "agents",
            "content-type":      "application/json",
        }
        # Zod's .optional() rejects explicit null — only send keys that are
        # actually set so the Node endpoint's schema validates cleanly.
        #
        # This is not a style preference. clauseId and clauseType are documented
        # below as ALTERNATIVES to each other, so the model correctly supplies
        # one and leaves the other None; sending that None as JSON null made
        # RedlineProposeSchema reject essentially every call the tool's own
        # description told the model to make. Same convention as
        # contract_search.py, which carries the same comment.
        payload: dict = {"orgId": org_id, "contractId": contract_id}
        if clause_type  is not None: payload["clauseType"]   = clause_type
        if clause_id    is not None: payload["clauseId"]     = clause_id
        if instructions is not None: payload["instructions"] = instructions
        async with httpx.AsyncClient(timeout=httpx.Timeout(45.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            log.warning("[redline_propose] Node %s: %s", r.status_code, r.text[:200])
            return '{"error":"redline_propose_failed","status":' + str(r.status_code) + ',"detail":' + r.text[:300] + "}"
        return r.text

    def _run(contract_id: str, clause_type=None, clause_id=None, instructions=None):
        import asyncio
        return asyncio.run(_arun(contract_id, clause_type, clause_id, instructions))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="redline_propose",
        description=(
            "Generate THREE aggression-variant rewrites (least / moderate "
            "/ aggressive) of a specific clause in a contract. Grounded "
            "in the org's playbook position for that clause category + "
            "any structured rules. Use when the user says 'redline this', "
            "'propose changes to §X', or 'how would you rewrite this "
            "liability cap'. Read-only: it proposes, it does not write. "
            "Pass one of its variants to redline_apply to turn it into a new "
            "ContractVersion, or let the user pick from the redline card."
        ),
        args_schema=RedlineProposeArgs,
    )
