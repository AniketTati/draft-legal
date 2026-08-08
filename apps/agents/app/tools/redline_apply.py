"""redline_apply — write tool (plan-then-execute).

Applies a proposed clause rewrite as a new ContractVersion. Returns an
awaiting-confirmation payload; on Apply the thread RPC dispatches to
/api/internal/ai/tools/redline_apply (orgId/userId enforced from the JWT),
which splices the new text into the version body and records
`metadata.redline` so the change can be undone for 15 minutes.

Every Node layer for this has existed since P1.5 — the WRITE_TOOLS allowlist
entry, the user-field mapping, the reversible flag, the undo adapter and the
endpoint — driven by the "Apply variant" button in RedlinePreview. What did not
exist was a way for the MODEL to propose it, while `redline_propose`'s own
description told the model to "use redline_apply". Being told a verb exists
while having no way to call it is how an agent ends up narrating a change it
never made; this repo has already been bitten by exactly that on drafting.

The args mirror what RedlinePreview already sends, because the same apply route
validates both.
"""
from __future__ import annotations

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field


class RedlineApplyArgs(BaseModel):
    contract_id: str = Field(..., description="Contract CUID the clause belongs to.")
    clause_id: str = Field(..., description="ContractClause CUID being rewritten — take it from a redline_propose result, never invent one.")
    proposed_text: str = Field(
        ...,
        description="The full replacement clause text, verbatim from the variant you chose in redline_propose. Do not paraphrase it here.",
    )
    aggression: str | None = Field(
        None,
        description="Which variant was chosen: 'conservative' | 'moderate' | 'aggressive'.",
    )
    rationale: str | None = Field(None, max_length=2000, description="Why this rewrite, in one sentence, for the audit trail.")


def build_redline_apply(_org_id: str, _user_id: str | None = None) -> StructuredTool:
    async def _arun(
        contract_id: str,
        clause_id: str,
        proposed_text: str,
        aggression: str | None = None,
        rationale: str | None = None,
    ) -> dict:
        args: dict = {
            "contractId":   contract_id,
            "clauseId":     clause_id,
            "proposedText": proposed_text,
        }
        if aggression:
            args["aggression"] = aggression
        if rationale:
            args["rationale"] = rationale

        which = f"{aggression} " if aggression else ""
        return {
            "awaitingConfirmation": True,
            "args": args,
            "preview": {
                "summary": f"Apply the {which}rewrite to this clause as a new version",
                "contractId": contract_id,
                "clauseId": clause_id,
            },
            "reversible": True,
        }

    def _run(
        contract_id: str,
        clause_id: str,
        proposed_text: str,
        aggression: str | None = None,
        rationale: str | None = None,
    ) -> dict:
        import asyncio
        return asyncio.run(_arun(contract_id, clause_id, proposed_text, aggression, rationale))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="redline_apply",
        description=(
            "Propose applying a clause rewrite as a new contract version. The "
            "user confirms via an Apply card before anything changes, and it "
            "stays undoable for 15 minutes. Call redline_propose FIRST and pass "
            "one of its variants verbatim — never compose the replacement text "
            "yourself. If the apply comes back CLAUSE_TEXT_NOT_FOUND the "
            "clause has changed since it was proposed: re-run redline_propose "
            "and offer a fresh variant rather than retrying the same text."
        ),
        args_schema=RedlineApplyArgs,
    )
