"""
Assist Agent — Phase 4.2
Single-step Sonnet agent for inline contract text improvements.

Supported actions:
  - rewrite:            Rewrite the clause while preserving legal intent
  - simplify:           Plain-English rewrite, reduce legalese
  - expand:             Add detail, make the clause more comprehensive
  - check_compliance:   Identify compliance gaps or regulatory issues
  - suggest_alternative: Propose alternative clause language

Used by the TipTap editor AI Assist context menu (SCR-006).
"""
from __future__ import annotations

import logging
import re
from typing import Literal

from langchain_core.messages import HumanMessage, SystemMessage

from ..router import resolve_llm

logger = logging.getLogger(__name__)

AssistAction = Literal["rewrite", "simplify", "expand", "check_compliance", "suggest_alternative", "fix_layout", "rewrite_document"]

# Actions that take full HTML in and must return full HTML out (no EXPLANATION section)
_HTML_ACTIONS = {"fix_layout", "rewrite_document"}

# ─── Prompts ──────────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = """You are a senior contract attorney helping to improve contract language.
Your revisions must be:
- Legally precise and enforceable
- Clear and unambiguous
- Consistent with standard commercial contract practice
- Appropriate for a {contract_type} agreement

The input clause is provided as HTML. Your output must also be HTML.
CRITICAL formatting rules:
- Preserve ALL inline HTML tags exactly as they appear in the input: <strong>, <em>, <u>, <s>, and any style= attributes.
- Do not add new block-level tags (<p>, <div>, <h1> etc.) — return only the inner content with inline tags intact.
- No surrounding quotes, no markdown fences, no preamble.

Output format — two parts, in this exact order:
1. The revised clause as HTML (inline tags preserved, no extra block wrappers).
2. A blank line, then the word EXPLANATION: followed by one sentence explaining what you changed and why.

Example input: <strong>8.2 Limitation of Liability:</strong> Vendor shall not be liable for any damages.
Example output: <strong>8.2 Limitation of Liability:</strong> Vendor shall not be liable for any indirect, incidental, or consequential damages arising out of or related to this Agreement.

EXPLANATION: Added specific damage categories to make the liability cap more precise and enforceable."""

_DOCUMENT_SYSTEM_PROMPT = """You are a senior contract attorney and document formatter.
Process the contract HTML document as instructed and return ONLY valid HTML.
Rules:
- No markdown code fences (no backticks), no preamble, no explanation text outside the HTML.
- Semantic tags: <h1> for the document title, <h2> for numbered article headings (e.g. "1. DEFINITIONS"), <h3> for sub-clause headings (e.g. "1.1 Definitions"), <p> for body paragraphs, <ul>/<li> for bullet lists, <ol>/<li> for numbered lists.
- Tables: preserve ALL <table>, <thead>, <tbody>, <tr>, <th>, <td> elements with their content intact. Never flatten a table into paragraphs or lists.
- Style attributes: preserve every inline style attribute exactly as-is, especially text-align (e.g. style="text-align: center", style="text-align: right"). Never remove or modify any style= attribute.
- Preserve every legal obligation, right, definition, party name, dollar amount, and date exactly as written."""

_ACTION_PROMPTS: dict[str, str] = {
    "rewrite": """Rewrite the following contract clause (provided as HTML). Keep the legal intent, all obligations, and all defined terms intact — improve only the clarity and precision of the language. Preserve all inline HTML formatting tags (<strong>, <em>, etc.) in your output.

Clause to rewrite:
{selected_text}""",

    "simplify": """Rewrite the following contract clause (provided as HTML) in plain English. Remove unnecessary legalese and complex sentence structures while preserving every legal obligation, right, and defined term. Preserve all inline HTML formatting tags (<strong>, <em>, etc.) in your output.

Clause to simplify:
{selected_text}""",

    "expand": """Expand the following contract clause (provided as HTML) to be more comprehensive. Add relevant protections, specify any missing timeframes or thresholds, and address common edge cases. Keep the original obligations intact. Preserve all inline HTML formatting tags (<strong>, <em>, etc.) in your output.

Clause to expand:
{selected_text}""",

    "check_compliance": """You are reviewing a contract clause (provided as HTML) for compliance issues.

Step 1 — Write an improved version of the clause that addresses all compliance concerns. Preserve all inline HTML formatting tags (<strong>, <em>, etc.). This improved clause HTML is the first thing you output.

Step 2 — After a blank line, write EXPLANATION: followed by a concise summary of the compliance issues you found and what you changed to fix them.

Context: Contract type is {contract_type}, governing law is {governing_law}.

Clause to review:
{selected_text}""",

    "suggest_alternative": """Propose an alternative version of the following contract clause (provided as HTML). The alternative should be commercially reasonable and balanced for both parties, while being more precise and enforceable than the original. Preserve all inline HTML formatting tags (<strong>, <em>, etc.) in your output.

Clause to improve:
{selected_text}""",

    "fix_layout": """The following HTML was extracted from a PDF and may contain formatting artifacts: merged paragraphs, missing or incorrect heading tags, broken or missing tables, excessive whitespace, or inconsistent clause numbering. Fix the HTML structure while following these rules:
- Preserve every word of legal content exactly — do not rephrase, summarise, or remove any text.
- Preserve all inline style attributes exactly (e.g. style="text-align: center", style="text-align: right", style="text-align: left"). Never alter or remove style= attributes.
- Preserve all tables as <table>/<tr>/<th>/<td> elements.
- Return valid HTML only — no markdown code fences, no explanatory text outside the HTML.

Document HTML:
{selected_text}""",

    "rewrite_document": """Rewrite the following contract document to improve its structure and readability while preserving all legal meaning. Specifically:
- Preserve every legal right, obligation, definition, party name, dollar amount, and date — do not add or remove substantive content.
- Improve heading hierarchy using <h1> (title), <h2> (numbered articles), <h3> (sub-clauses).
- Standardise clause numbering if inconsistent.
- Break up run-on paragraphs for readability.
- Preserve all tables as <table>/<tr>/<th>/<td> elements.
- Preserve all inline style attributes exactly (e.g. style="text-align: center"). Never alter or remove style= attributes.
- Return clean HTML only — no markdown code fences, no text outside the HTML.

Document HTML:
{selected_text}""",
}


# ─── Public API ───────────────────────────────────────────────────────────────

def _strip_markdown_fences(text: str) -> str:
    """Remove ```html / ``` markdown fences that LLMs sometimes emit."""
    text = re.sub(r'^```[a-z]*\s*\n?', '', text, flags=re.MULTILINE)
    text = text.replace('```', '')
    return text.strip()


async def run_assist(
    selected_text: str,
    action: AssistAction,
    contract_type: str = "general commercial",
    governing_law: str = "Delaware",
    provider: str | None = None,
    model_id: str | None = None,
    org_id: str | None = None,
) -> dict[str, str]:
    """Run the assist pipeline and return revised text + explanation."""
    if not selected_text.strip():
        return {
            "revisedText": "",
            "explanation": "No text selected",
            "action": action,
        }

    # A caller-pinned provider/model rides through the router too — it keeps
    # the org's BYOK key + Langfuse tracing and only swaps which model is built.
    resolved = await resolve_llm(
        "reasoning",
        org_id=org_id,
        streaming=True,
        trace_name=f"assist.{action}",
        provider_override=provider or None,
        model_override=model_id or None,
    )
    llm = resolved.llm
    callbacks = resolved.callbacks

    action_prompt = _ACTION_PROMPTS.get(action, _ACTION_PROMPTS["rewrite"])
    user_content = action_prompt.format(
        selected_text=selected_text,
        contract_type=contract_type,
        governing_law=governing_law,
    )

    # Document-level HTML actions use a different system prompt and skip EXPLANATION parsing
    if action in _HTML_ACTIONS:
        system_content = _DOCUMENT_SYSTEM_PROMPT
        response = await llm.ainvoke([
            SystemMessage(content=system_content),
            HumanMessage(content=user_content),
        ], config={"callbacks": callbacks})
        raw = response.content.strip()
        revised_html = _strip_markdown_fences(raw)
        logger.info("[assist] %s — returned %d HTML chars", action, len(revised_html))
        return {
            "revisedText": revised_html,
            "explanation": f"Document {action.replace('_', ' ')} applied successfully.",
            "action": action,
        }

    # Clause-level text actions: use standard prompt + EXPLANATION parsing
    system_content = _SYSTEM_PROMPT.format(contract_type=contract_type)

    response = await llm.ainvoke([
        SystemMessage(content=system_content),
        HumanMessage(content=user_content),
    ], config={"callbacks": callbacks})

    raw = _strip_markdown_fences(response.content.strip())

    # Parse out the EXPLANATION section
    if "EXPLANATION:" in raw:
        parts = raw.split("EXPLANATION:", 1)
        revised_text = parts[0].strip()
        explanation = parts[1].strip()
    else:
        revised_text = raw
        explanation = f"Applied {action} to the selected clause."

    return {
        "revisedText": revised_text,
        "explanation": explanation,
        "action": action,
    }
