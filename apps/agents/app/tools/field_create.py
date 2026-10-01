"""field_create — write tool (plan-then-execute), docs/39 C5.

"Start tracking PO numbers on our SOWs." Returns an awaiting-confirmation
card; the user's Apply adds the custom field
(/agent/threads/:id/actions/apply → /api/internal/ai/tools/field_create,
which needs configure:contract), undoably while it holds no values. The
model then offers contract_field_set for this contract's value, and the
field can be filled in on the rest from Settings.
"""
from __future__ import annotations

from typing import Literal, Optional

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

_TYPE_WORDS = {
    "text": "text", "longtext": "long text", "number": "a number", "currency": "an amount of money",
    "duration": "a length of time", "percentage": "a percentage", "date": "a date", "boolean": "yes / no",
    "select": "one of a list", "multiselect": "some of a list",
}


class FieldCreateArgs(BaseModel):
    label: str = Field(..., min_length=1, max_length=128, description="The field's name as people will read it: 'PO number', 'Confidentiality period'.")
    type: Literal["text", "longtext", "number", "currency", "duration", "percentage", "date", "boolean", "select", "multiselect"] = Field(
        ..., description="What it holds: a length of time is 'duration', money is 'currency', a choice is 'select'.",
    )
    contract_type: Optional[str] = Field(
        None, description="Only on this contract type (e.g. 'SOW'); omit for every contract. Only when the user says which.",
    )
    options: Optional[list[str]] = Field(None, description="The choices, for 'select' or 'multiselect'.")
    description: Optional[str] = Field(
        None, max_length=512, description="What the AI should look for when it reads contracts for this field.",
    )


def build_field_create(_org_id: str, _user_id: str | None = None) -> StructuredTool:
    async def _arun(
        label: str,
        type: str,
        contract_type: Optional[str] = None,
        options: Optional[list[str]] = None,
        description: Optional[str] = None,
    ) -> dict:
        if type in ("select", "multiselect") and not options:
            return {"error": "missing_options", "note": f"A {type} field needs its choices: ask the user for them."}
        args: dict = {"label": label.strip(), "fieldType": type}
        if contract_type:
            args["contractType"] = contract_type
        if options:
            args["options"] = [o.strip() for o in options if o.strip()]
        if description:
            args["helpText"] = description.strip()
        scope = f"{contract_type.replace('_', ' ')} contracts" if contract_type else "every contract"
        return {
            "awaitingConfirmation": True,
            # Exactly what /tools/field_create takes; the apply RPC adds orgId and userId.
            "args": args,
            "preview": {
                "summary": f'Add a field "{label.strip()}" ({_TYPE_WORDS.get(type, type)}) on {scope}'
                           + (f" — choices: {', '.join(args['options'])}" if args.get("options") else ""),
                "target": "Custom fields",
            },
            "reversible": True,
        }

    def _run(label: str, type: str, contract_type: Optional[str] = None,
             options: Optional[list[str]] = None, description: Optional[str] = None) -> dict:
        import asyncio
        return asyncio.run(_arun(label, type, contract_type, options, description))

    return StructuredTool.from_function(
        coroutine=_arun,
        func=_run,
        name="field_create",
        description=(
            "Propose adding a custom field the organisation will track on its contracts (or one contract type), "
            "when the user asks to start tracking a term the fields don't have ('track PO numbers on SOWs'). "
            "The user applies it on a card. Afterwards offer contract_field_set for the value on the contract in "
            "front of them; filling it in on existing contracts is done from Settings › Custom Fields."
        ),
        args_schema=FieldCreateArgs,
    )
