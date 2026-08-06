"""
Draft Agent — Phase 4.2
5-step LangGraph pipeline:
  Step 1 — Understand (Haiku): parse intent, extract contract type, parties, key terms
  Step 2 — Select Template (Haiku): choose best template from available templates
  Step 3 — Fill Variables (Sonnet): populate template variables from intent + context
  Step 4 — Assemble: call Node API template-engine to generate HTML
  Step 5 — Review Draft (Haiku): self-review for completeness + obvious errors

CHAT-001: "Draft an NDA for Acme Corp" → full end-to-end generation
"""
from __future__ import annotations

import json
from ..jsonish import loads_lenient
import logging
import os
from typing import Any

import httpx
from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import StateGraph, END
from typing_extensions import TypedDict

from ..router import resolve_llm
from ..config import settings

logger = logging.getLogger(__name__)

# P61 audit (2026-05-02). draft_agent was using os.getenv() directly,
# but the rest of the agents load INTERNAL_SERVICE_SECRET via the
# settings module (pydantic-settings reads ../../.env). os.getenv()
# returns empty string when uvicorn starts without that env var
# exported, which made every Node-API call 401. Use the same
# settings.internal_service_secret all other tools use.
NODE_API_URL = os.getenv("NODE_API_URL") or settings.api_url or "http://localhost:3001"
INTERNAL_SECRET = settings.internal_service_secret


# ─── State ────────────────────────────────────────────────────────────────────

class DraftState(TypedDict):
    user_message: str
    org_id: str
    user_id: str
    # Optional context passed in (e.g. from a ContractRequest)
    context: dict[str, Any]
    # Step 1 output
    contract_type: str
    parties: list[dict]
    key_terms: dict[str, Any]
    intent_summary: str
    # Step 2 output
    selected_template_id: str
    selected_template_name: str
    available_templates: list[dict]
    # Step 3 output
    variable_values: dict[str, Any]
    # Step 4 output
    draft_html: str
    sections_included: int
    unfilled_variables: list[str]
    # Step 5 output
    completeness_score: float
    missing_fields: list[str]
    review_notes: str
    # Final
    error: str | None


# ─── Prompts ──────────────────────────────────────────────────────────────────

_UNDERSTAND_PROMPT = """You are a contract drafting assistant. Analyze the user's request and extract structured information.

Return ONLY valid JSON — no markdown, no explanation:
{{
  "contract_type": "<NDA|MSA|SOW|SLA|VENDOR_AGREEMENT|EMPLOYMENT|PARTNERSHIP|LICENSE|ORDER_FORM|OTHER>",
  "parties": [
    {{ "role": "<our_company|counterparty|third_party>", "name": "<party name if mentioned, else null>" }}
  ],
  "key_terms": {{
    "deal_value": "<number or null>",
    "currency": "<USD|EUR|GBP|null>",
    "term_months": "<integer or null>",
    "governing_law": "<state/jurisdiction or null>",
    "purpose": "<brief description of the contract's purpose>",
    "special_provisions": ["<any special terms mentioned>"]
  }},
  "intent_summary": "<one sentence describing what the user wants to create>"
}}

User request: {user_message}"""

_SELECT_TEMPLATE_PROMPT = """You are a legal template selection assistant. Choose the best template for this contract from the available options.

User's intent: {intent_summary}
Contract type needed: {contract_type}

Available templates:
{templates_json}

Return ONLY valid JSON:
{{
  "selected_template_id": "<id of the best matching template, or null if none match>",
  "reasoning": "<one sentence explaining the choice>"
}}

If no template matches the contract type, set selected_template_id to null."""

_FILL_VARIABLES_PROMPT = """You are a contract variable population specialist. Fill in the template variables based on the user's request and context.

User's request: {user_message}
Extracted information: {extracted_info}

Template variables to fill:
{variable_defs}

Additional context: {context_json}

Return ONLY valid JSON mapping variable keys to values. Use null for variables you cannot determine from the available information:
{{
  "variable_key": "value or null",
  ...
}}

Rules:
- For dates, use ISO format (YYYY-MM-DD)
- For numbers, use numeric values (no currency symbols)
- For text, be specific and professional
- If a party name was mentioned in the request, use it
- For governing_law, default to "Delaware" if not specified
- Infer reasonable values from context where possible"""

_REVIEW_PROMPT = """You are a contract quality reviewer. Assess this draft contract for completeness and obvious issues.

Draft HTML (first 3000 chars): {draft_preview}
Unfilled variables: {unfilled_variables}
Contract type: {contract_type}

Return ONLY valid JSON:
{{
  "completeness_score": <0.0 to 1.0 — 1.0 means fully complete>,
  "missing_fields": ["<list of critical missing information>"],
  "review_notes": "<one or two sentences of quality feedback>"
}}"""


# ─── Pipeline Steps ───────────────────────────────────────────────────────────

async def step_understand(state: DraftState) -> DraftState:
    """Step 1: Parse user intent → contract type, parties, key terms."""
    resolved = await resolve_llm(
        "default",
        org_id=state.get("org_id"),
        trace_name="draft.understand",
    )

    prompt = _UNDERSTAND_PROMPT.format(user_message=state["user_message"])
    response = await resolved.llm.ainvoke([
        SystemMessage(content="You are a legal assistant. Extract structured information from contract requests."),
        HumanMessage(content=prompt),
    ], config={"callbacks": resolved.callbacks})

    try:
        parsed = loads_lenient(response.content)
        return {
            **state,
            "contract_type": parsed.get("contract_type", "OTHER"),
            "parties": parsed.get("parties", []),
            "key_terms": parsed.get("key_terms", {}),
            "intent_summary": parsed.get("intent_summary", state["user_message"]),
        }
    except json.JSONDecodeError:
        logger.warning("step_understand: JSON parse failed, using fallback")
        return {
            **state,
            "contract_type": "OTHER",
            "parties": [],
            "key_terms": {},
            "intent_summary": state["user_message"],
        }


async def step_select_template(state: DraftState) -> DraftState:
    """Step 2: Fetch available templates and pick the best match.

    P61 audit (2026-05-02). If the user explicitly chose a template
    in the UI, context will carry `template_id` — honor it as-is and
    skip the LLM-driven matching path. The contractType filter
    excluded org-authored templates without a contractType set, so
    this also fixes that gap.
    """
    explicit_id = (state.get("context") or {}).get("template_id")

    if explicit_id:
        # Fetch ALL published templates (no contractType filter) so
        # we can resolve the explicit choice even when its contractType
        # is null / mismatched.
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"{NODE_API_URL}/api/v1/templates",
                    params={"published": "true"},
                    headers={
                        "x-internal-service": "agents",
                        "x-internal-secret": INTERNAL_SECRET,
                        "x-org-id": state["org_id"],
                    },
                )
                all_templates = resp.json().get("data", []) if resp.status_code == 200 else []
            picked = next((t for t in all_templates if t["id"] == explicit_id), None)
            if picked:
                logger.info(f"step_select_template: honoring explicit template_id={explicit_id} ({picked['name']})")
                return {
                    **state,
                    "available_templates": all_templates,
                    "selected_template_id": picked["id"],
                    "selected_template_name": picked["name"],
                }
            logger.warning(f"step_select_template: explicit template_id={explicit_id} not found, falling back to auto-select")
        except Exception as e:
            logger.warning(f"step_select_template: error fetching for explicit id: {e}")

    # Fetch templates from Node API
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{NODE_API_URL}/api/v1/templates",
                params={"contractType": state["contract_type"], "published": "true"},
                headers={
                    "x-internal-service": "agents",
                    "x-internal-secret": INTERNAL_SECRET,
                    "x-org-id": state["org_id"],
                },
            )
            templates_data = resp.json().get("data", []) if resp.status_code == 200 else []
    except Exception as e:
        logger.warning(f"step_select_template: could not fetch templates: {e}")
        templates_data = []

    state["available_templates"] = templates_data

    if not templates_data:
        logger.info("step_select_template: no published templates found")
        return {**state, "selected_template_id": "", "selected_template_name": ""}

    # If only one matches, just use it
    if len(templates_data) == 1:
        t = templates_data[0]
        return {**state, "selected_template_id": t["id"], "selected_template_name": t["name"]}

    # Otherwise ask LLM to choose
    resolved = await resolve_llm(
        "default",
        org_id=state.get("org_id"),
        trace_name="draft.select_template",
    )
    templates_summary = [{"id": t["id"], "name": t["name"], "description": t.get("description", ""), "contractType": t.get("contractType")} for t in templates_data]
    prompt = _SELECT_TEMPLATE_PROMPT.format(
        intent_summary=state["intent_summary"],
        contract_type=state["contract_type"],
        templates_json=json.dumps(templates_summary, indent=2),
    )

    response = await resolved.llm.ainvoke([
        SystemMessage(content="You are a legal template selection assistant."),
        HumanMessage(content=prompt),
    ], config={"callbacks": resolved.callbacks})

    try:
        parsed = loads_lenient(response.content)
        selected_id = parsed.get("selected_template_id")
        selected = next((t for t in templates_data if t["id"] == selected_id), None)
        return {
            **state,
            "selected_template_id": selected_id or "",
            "selected_template_name": selected["name"] if selected else "",
        }
    except (json.JSONDecodeError, StopIteration):
        fallback = templates_data[0]
        return {**state, "selected_template_id": fallback["id"], "selected_template_name": fallback["name"]}


async def step_fill_variables(state: DraftState) -> DraftState:
    """Step 3: Populate template variables from intent + context."""
    if not state.get("selected_template_id"):
        return {**state, "variable_values": {}}

    # Fetch template variable definitions
    template = next(
        (t for t in state.get("available_templates", []) if t["id"] == state["selected_template_id"]),
        None,
    )

    variable_defs = template.get("variables", []) if template else []
    if not variable_defs:
        return {**state, "variable_values": {}}

    resolved = await resolve_llm(
        "reasoning",
        org_id=state.get("org_id"),
        trace_name="draft.fill_variables",
    )
    extracted_info = {
        "contract_type": state["contract_type"],
        "parties": state["parties"],
        "key_terms": state["key_terms"],
        "intent_summary": state["intent_summary"],
    }

    prompt = _FILL_VARIABLES_PROMPT.format(
        user_message=state["user_message"],
        extracted_info=json.dumps(extracted_info, indent=2),
        variable_defs=json.dumps(variable_defs, indent=2),
        context_json=json.dumps(state.get("context", {}), indent=2),
    )

    response = await resolved.llm.ainvoke([
        SystemMessage(content="You are a legal contract drafting assistant. Populate template variables with appropriate values."),
        HumanMessage(content=prompt),
    ], config={"callbacks": resolved.callbacks})

    try:
        variable_values = loads_lenient(response.content)
        return {**state, "variable_values": variable_values}
    except json.JSONDecodeError:
        logger.warning("step_fill_variables: JSON parse failed, returning empty variables")
        return {**state, "variable_values": {}}


async def step_assemble(state: DraftState) -> DraftState:
    """Step 4: Call template-engine via Node API to generate HTML.

    If Step 2 didn't find a matching template, surface a typed error so the
    caller can reject the request — never write an error message into
    `draft_html`, because that string ends up saved as the contract's body
    and the editor renders it as content. See A.1 in
    docs/25-CONTRACT-FLOW-FIX-PLAN.md.
    """
    if not state.get("selected_template_id"):
        return {
            **state,
            "draft_html": "",
            "sections_included": 0,
            "unfilled_variables": [],
            "error": "NO_TEMPLATE_MATCH",
        }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{NODE_API_URL}/api/v1/templates/{state['selected_template_id']}/generate",
                json={"variables": state.get("variable_values", {})},
                headers={
                    "Content-Type": "application/json",
                    "x-internal-service": "agents",
                    "x-internal-secret": INTERNAL_SECRET,
                    "x-org-id": state["org_id"],
                },
            )

            if resp.status_code == 200:
                result = resp.json()
                return {
                    **state,
                    "draft_html": result.get("html", ""),
                    "sections_included": result.get("sectionsIncluded", 0),
                    "unfilled_variables": result.get("unfilledVariables", []),
                }
            else:
                logger.error(f"step_assemble: template generate failed: {resp.status_code} {resp.text}")
                return {**state, "draft_html": "", "sections_included": 0, "unfilled_variables": [], "error": f"Template generation failed: {resp.status_code}"}
    except Exception as e:
        logger.error(f"step_assemble: exception: {e}")
        return {**state, "draft_html": "", "sections_included": 0, "unfilled_variables": [], "error": str(e)}


async def step_review(state: DraftState) -> DraftState:
    """Step 5: Self-review for completeness and obvious issues."""
    if not state.get("draft_html"):
        return {**state, "completeness_score": 0.0, "missing_fields": [], "review_notes": "Draft generation failed"}

    resolved = await resolve_llm(
        "default",
        org_id=state.get("org_id"),
        trace_name="draft.review",
    )
    draft_preview = state["draft_html"][:3000]

    prompt = _REVIEW_PROMPT.format(
        draft_preview=draft_preview,
        unfilled_variables=json.dumps(state.get("unfilled_variables", [])),
        contract_type=state.get("contract_type", "UNKNOWN"),
    )

    response = await resolved.llm.ainvoke([
        SystemMessage(content="You are a contract quality reviewer."),
        HumanMessage(content=prompt),
    ], config={"callbacks": resolved.callbacks})

    try:
        review = loads_lenient(response.content)
        return {
            **state,
            "completeness_score": float(review.get("completeness_score", 0.7)),
            "missing_fields": review.get("missing_fields", []),
            "review_notes": review.get("review_notes", ""),
        }
    except (json.JSONDecodeError, ValueError):
        return {**state, "completeness_score": 0.7, "missing_fields": state.get("unfilled_variables", []), "review_notes": "Review could not be completed"}


# ─── Graph ────────────────────────────────────────────────────────────────────

def _build_graph() -> Any:
    graph = StateGraph(DraftState)

    graph.add_node("understand", step_understand)
    graph.add_node("select_template", step_select_template)
    graph.add_node("fill_variables", step_fill_variables)
    graph.add_node("assemble", step_assemble)
    graph.add_node("review", step_review)

    graph.set_entry_point("understand")
    graph.add_edge("understand", "select_template")
    graph.add_edge("select_template", "fill_variables")
    graph.add_edge("fill_variables", "assemble")
    graph.add_edge("assemble", "review")
    graph.add_edge("review", END)

    return graph.compile()


_draft_graph = _build_graph()


# ─── Public API ───────────────────────────────────────────────────────────────

async def run_draft(
    user_message: str,
    org_id: str,
    user_id: str,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run the draft pipeline and return the result."""
    initial_state: DraftState = {
        "user_message": user_message,
        "org_id": org_id,
        "user_id": user_id,
        "context": context or {},
        "contract_type": "",
        "parties": [],
        "key_terms": {},
        "intent_summary": "",
        "selected_template_id": "",
        "selected_template_name": "",
        "available_templates": [],
        "variable_values": {},
        "draft_html": "",
        "sections_included": 0,
        "unfilled_variables": [],
        "completeness_score": 0.0,
        "missing_fields": [],
        "review_notes": "",
        "error": None,
    }

    final_state = await _draft_graph.ainvoke(initial_state)

    return {
        "html": final_state["draft_html"],
        "usedTemplateId": final_state["selected_template_id"],
        "usedTemplateName": final_state["selected_template_name"],
        "contractType": final_state["contract_type"],
        "variableValues": final_state["variable_values"],
        "completenessScore": final_state["completeness_score"],
        "missingFields": final_state["missing_fields"],
        "reviewNotes": final_state["review_notes"],
        "sectionsIncluded": final_state["sections_included"],
        "unfilledVariables": final_state["unfilled_variables"],
        "error": final_state.get("error"),
    }
