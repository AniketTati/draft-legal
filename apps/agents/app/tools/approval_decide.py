"""approval_decide — write tool (plan-then-execute), L9.

Proposes approving, rejecting or delegating an approval step. Returns an
awaiting-confirmation payload; on Apply the thread RPC dispatches to
/api/internal/ai/tools/approval_decide with orgId/userId enforced from the
JWT — which matters more here than for any other write tool, because the
endpoint matches the step's `approverId` against that userId. The agent can
only decide steps assigned to the person it is acting for.

reversible=False and no undo adapter. advanceWorkflow may already have closed
the instance and fired notifications by the time an undo arrives, and that
cannot be unwound inside the 15-minute window.

Chaining works today: approval_list returns both stepId and instanceId.
"""
from __future__ import annotations

from typing import Literal

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field


class ApprovalDecideArgs(BaseModel):
    instance_id: str = Field(..., description="Approval instance CUID (from approval_list's instanceId).")
    step_id: str = Field(..., description="Approval step CUID (from approval_list's stepId). Must be a PENDING step assigned to the current user.")
    decision: Literal["APPROVED", "REJECTED", "DELEGATED"] = Field(
        ..., description="The decision to record."
    )
    comment: str | None = Field(
        None, max_length=2000,
        description="Note for the record. REQUIRED when rejecting.",
    )
    delegate_to: str | None = Field(
        None,
        description="User CUID to delegate to. REQUIRED when delegating — resolve a name with user_search first.",
    )


def build_approval_decide(_org_id: str, _user_id: str | None = None) -> StructuredTool:
    async def _arun(
        instance_id: str,
        step_id: str,
        decision: str,
        comment: str | None = None,
        delegate_to: str | None = None,
    ) -> dict:
        args: dict = {"instanceId": instance_id, "stepId": step_id, "decision": decision}
        if comment:
            args["comment"] = comment
        if delegate_to:
            args["delegateTo"] = delegate_to

        verb = {
            "APPROVED": "Approve",
            "REJECTED": "Reject",
            "DELEGATED": "Delegate",
        }.get(decision, decision)
        tail = f" to {delegate_to}" if decision == "DELEGATED" and delegate_to else ""
        return {
            "awaitingConfirmation": True,
            "args": args,
            "preview": {
                "summary": f"{verb} this approval step{tail}",
                "stepId": step_id,
                "instanceId": instance_id,
                "decision": decision,
                "comment": comment,
            },
            # advanceWorkflow may close the instance and fire notifications the
            # moment this applies. There is nothing to undo it with.
            "reversible": False,
        }

    def _run(
        instance_id: str,
        step_id: str,
        decision: str,
        comment: str | None = None,
        delegate_to: str | None = None,
    ) -> dict:
        import asyncio
        return asyncio.run(_arun(instance_id, step_id, decision, comment, delegate_to))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="approval_decide",
        description=(
            "Propose approving, rejecting or delegating an approval step that "
            "is assigned to the current user. The user confirms via an Apply "
            "card before anything changes. Use for 'approve it', 'reject this "
            "with a reason', 'delegate this to Priya'. Get stepId and "
            "instanceId from approval_list first. A rejection MUST carry a "
            "comment. This action cannot be undone once applied — the "
            "workflow advances and notifies immediately."
        ),
        args_schema=ApprovalDecideArgs,
    )
