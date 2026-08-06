"""
Assist API — Phase 4.2
POST /assist — inline AI rewrite/simplify/expand for TipTap editor
POST /compare — compare clause text to playbook positions
"""
from fastapi import APIRouter, HTTPException, Header
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Any, Literal
import json
from ..jsonish import loads_lenient
import os

from app.agents.assist_agent import run_assist, AssistAction
from app.router import resolve_llm
from langchain_core.messages import HumanMessage, SystemMessage

router = APIRouter()
INTERNAL_SECRET = os.getenv("INTERNAL_SERVICE_SECRET", "")


class AssistRequest(BaseModel):
    selected_text: str
    action: AssistAction
    contract_type: str = "general commercial"
    governing_law: str = "Delaware"
    provider: str = ""
    model_id: str = ""
    orgId: str | None = None  # enables per-org BYOK key + Langfuse tracing


class CompareRequest(BaseModel):
    clauseText: str
    positions: list[dict[str, Any]]
    orgId: str | None = None  # enables per-org BYOK key + Langfuse tracing


# P1.3 — two-stage compare. Accepts a clause + the structured rules from
# a playbook position (must_have / must_not / bounds) and returns a
# strictly-typed judgment so the Node evaluator can overlay passed/
# extracted_value onto each rule. Bounds are the main event here —
# without LLM extraction we can't tell "12 months of fees" from "24x
# annual", and the substring evaluator in Node can't do it either.
class PlaybookJudgeRequest(BaseModel):
    clauseText:     str
    positionType:   str | None = None  # e.g. 'preferred' — picks the judge's voice
    rules:          dict[str, Any]     # PlaybookRules shape from docs/28 C.2.1
    provider:       str = ""
    model_id:       str = ""
    orgId:          str | None = None  # enables per-org BYOK key + Langfuse tracing


# P1.4 — redline_propose. Three aggression variants in one call to keep
# LLM cost within a single round-trip (Ironclad's "wedge" pattern). Each
# variant targets the same playbook position but differs in how much of
# the original language we keep vs rewrite.
class RedlineProposeRequest(BaseModel):
    clauseText:         str
    clauseType:         str | None = None   # e.g. 'limitation_of_liability'
    category:           str | None = None   # e.g. 'Limitation of Liability'
    preferredContent:   str | None = None   # the playbook's preferred prose
    rules:              dict[str, Any] | None = None
    contractType:       str = "general commercial"
    instructions:       str | None = None   # user-supplied direction
    provider:           str = ""
    model_id:           str = ""
    orgId:              str | None = None   # enables per-org BYOK key + Langfuse tracing


# P6.2 — Background clause classifier. For each visible paragraph in
# the editor, returns a "margin badge" verdict: category + market
# position + one-line reasoning. Called at a higher rate than
# /complete (one per paragraph) so we MUST stick to the fast tier
# and return short JSON.
class ClassifyClauseRequest(BaseModel):
    clauseText:   str
    contractType: str = "general commercial"
    sectionHint:  str | None = None    # optional — "Section 9.2" or the nearest H2 heading
    orgId:        str | None = None    # enables per-org BYOK key + Langfuse tracing


_CLASSIFY_SYSTEM = """You are a senior contracts lawyer triaging clauses as \
an author types them. For the given paragraph, return a strict JSON \
badge describing what KIND of clause it is and HOW AGGRESSIVE it is \
relative to common market practice. If the paragraph is boilerplate / \
recitals / signature block / whitespace, mark it "skip" so the UI \
suppresses a badge.

Return ONLY this JSON shape:

{
  "category": "<short label, e.g. 'liability', 'payment', 'termination', 'confidentiality', 'ip', 'sla', 'indemnity', 'warranty', 'governing_law', 'definitions', 'skip'>",
  "position": "<market | aggressive | weak | off | skip>",
  "reasoning": "<one sentence, plain English>",
  "keyTerm":   "<optional — one bolded key phrase, e.g. '12 months of fees'>"
}

Rules:
 • "market" = in line with common/fair market terms.
 • "aggressive" = heavily favors one party (usually our customer — the drafter).
 • "weak"     = materially weaker than market (exposes us).
 • "off"      = clause is clearly NOT in the playbook's standard set.
 • "skip"     = boilerplate / recitals / headings / nothing to classify.
 • reasoning: ≤20 words. No markdown. No hedging ("it appears", "likely")."""


@router.post("/classify_clause")
async def classify_clause(req: ClassifyClauseRequest, x_internal_secret: str = Header(default="")):
    if INTERNAL_SECRET and x_internal_secret != INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")
    text = (req.clauseText or "").strip()
    if len(text) < 30:
        return {"category": "skip", "position": "skip", "reasoning": "", "keyTerm": ""}

    hint = f"\nSection: {req.sectionHint}" if req.sectionHint else ""
    user = f"""Contract type: {req.contractType}{hint}

Paragraph:
\"\"\"
{text[:2400]}
\"\"\"

Classify now. JSON only."""

    try:
        resolved = await resolve_llm(
            "fast",
            org_id=req.orgId,
            streaming=False,
            trace_name="assist.classify_clause",
        )
        llm = resolved.llm
        provider = resolved.provider
        model = resolved.model
        response = await llm.ainvoke([
            SystemMessage(content=_CLASSIFY_SYSTEM),
            HumanMessage(content=user),
        ], config={"callbacks": resolved.callbacks})
        raw = response.content if isinstance(response.content, str) else str(response.content)
        raw = raw.strip()
        if raw.startswith("```"):
            raw = raw.split("```", 2)[1]
            if raw.startswith("json"):
                raw = raw[4:]
        parsed = loads_lenient(raw)
        cat = str(parsed.get("category") or "skip").lower().strip()
        pos = str(parsed.get("position") or "skip").lower().strip()
        if pos not in ("market", "aggressive", "weak", "off", "skip"):
            pos = "skip"
        return {
            "category":  cat,
            "position":  pos,
            "reasoning": str(parsed.get("reasoning") or "")[:200],
            "keyTerm":   str(parsed.get("keyTerm") or "")[:80],
            "model":     model,
            "provider":  provider,
        }
    except Exception as e:  # noqa: BLE001
        return {"category": "skip", "position": "skip", "reasoning": "", "error": f"{type(e).__name__}: {str(e)[:160]}"}


# P6.1 — Ghost-text completion (Copilot-style). Called while the
# user types in the TipTap editor and pauses mid-sentence. Returns
# 1-2 sentences of continuation using the fast model tier. Low-latency
# first-class citizen; the orchestrator does NOT gate this.
class CompleteRequest(BaseModel):
    contextBefore:  str                     # last ~500 chars before cursor
    contextAfter:   str = ""                # up to ~100 chars after cursor (for style cue)
    contractType:   str = "general commercial"
    maxChars:       int = 160
    orgId:          str | None = None       # enables per-org BYOK key + Langfuse tracing


@router.post("/complete")
async def complete(req: CompleteRequest, x_internal_secret: str = Header(default="")):
    if INTERNAL_SECRET and x_internal_secret != INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")

    ctx = (req.contextBefore or "").rstrip()
    if len(ctx) < 10:
        return {"completion": "", "reason": "too_short"}

    system = (
        "You are a contracts drafting copilot. Continue the text from "
        "where the author stopped typing. Match the document's tone + "
        "defined terms exactly. Reply with ONLY the continuation text — "
        "no quotes, no preamble, no Markdown fences. Return 1 sentence "
        "(2 at most) and stop. If the cursor is clearly at a heading, "
        "section break, or the author just finished a complete sentence, "
        "return an empty string. Never re-state what's already written."
    )
    user = (
        f"Contract type: {req.contractType}\n"
        f"Maximum output: {max(40, min(req.maxChars, 320))} characters.\n\n"
        f"Text so far (continue directly after the last character):\n"
        f"\"\"\"\n{ctx[-1400:]}\n\"\"\"\n"
    )
    if req.contextAfter.strip():
        user += f"\nText that follows the cursor (don't duplicate or contradict):\n\"\"\"\n{req.contextAfter[:400]}\n\"\"\"\n"

    try:
        # Fast tier — ghost-text must return in <1s; the user feels keystrokes.
        resolved = await resolve_llm(
            "fast",
            org_id=req.orgId,
            streaming=False,
            trace_name="assist.complete",
        )
        llm = resolved.llm
        provider = resolved.provider
        model = resolved.model
        response = await llm.ainvoke([
            SystemMessage(content=system),
            HumanMessage(content=user),
        ], config={"callbacks": resolved.callbacks})
        raw = response.content if isinstance(response.content, str) else str(response.content)
        out = raw.strip()
        # Strip accidental quote wrappers + markdown fences
        if out.startswith('"') and out.endswith('"') and len(out) > 2:
            out = out[1:-1]
        if out.startswith('```'):
            out = out.split('```', 2)[1]
        out = out.strip()

        # Safety cap so the ghost doesn't wander off the page.
        cap = max(40, min(req.maxChars, 320))
        if len(out) > cap:
            # Truncate to last sentence boundary inside the cap
            cut = out[:cap]
            for sep in ('. ', '.\n', '? ', '! '):
                if sep in cut:
                    cut = cut[:cut.rfind(sep) + 1]
                    break
            out = cut.rstrip()

        return {"completion": out, "model": model, "provider": provider}
    except Exception as e:  # noqa: BLE001
        return {"completion": "", "error": f"{type(e).__name__}: {str(e)[:180]}"}


@router.post("/assist")
async def assist(req: AssistRequest, x_internal_secret: str = Header(default="")):
    if INTERNAL_SECRET and x_internal_secret != INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")

    if not req.selected_text.strip():
        raise HTTPException(status_code=400, detail="selected_text is required")

    result = await run_assist(
        selected_text=req.selected_text,
        action=req.action,
        contract_type=req.contract_type,
        governing_law=req.governing_law,
        provider=req.provider or None,
        model_id=req.model_id or None,
        org_id=req.orgId,
    )

    return result


_COMPARE_SYSTEM = """You are a contract negotiation specialist analyzing clause language against established playbook positions.

For each playbook position (preferred → acceptable → fallback → walkaway), assess how well the submitted clause matches.

Return ONLY valid JSON:
{
  "bestMatch": "<preferred|acceptable|fallback|walkaway>",
  "score": <0.0 to 1.0 — 1.0 means perfect match to preferred>,
  "explanation": "<2-3 sentences explaining the match and key deviations>",
  "deviations": [
    {
      "positionType": "<preferred|acceptable|fallback|walkaway>",
      "deviation": "<specific language difference>",
      "severity": "<low|medium|high>"
    }
  ]
}"""


@router.post("/compare")
async def compare_to_playbook(req: CompareRequest, x_internal_secret: str = Header(default="")):
    if INTERNAL_SECRET and x_internal_secret != INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")

    if not req.clauseText.strip():
        raise HTTPException(status_code=400, detail="clauseText is required")

    if not req.positions:
        raise HTTPException(status_code=400, detail="positions are required")

    resolved = await resolve_llm(
        "fast",
        org_id=req.orgId,
        streaming=False,
        trace_name="assist.compare",
    )
    llm = resolved.llm

    positions_summary = [
        {
            "positionType": p.get("positionType"),
            "content": (p.get("content", "")[:500] if p.get("content") else ""),
            "riskThreshold": p.get("riskThreshold", 0.5),
        }
        for p in req.positions
    ]

    user_content = f"""Submitted clause:
{req.clauseText[:2000]}

Playbook positions (from most to least preferred):
{json.dumps(positions_summary, indent=2)}

Analyze how well the submitted clause matches each position."""

    response = await llm.ainvoke([
        SystemMessage(content=_COMPARE_SYSTEM),
        HumanMessage(content=user_content),
    ], config={"callbacks": resolved.callbacks})

    try:
        result = loads_lenient(response.content)
        return {
            "clauseText": req.clauseText,
            "positions": req.positions,
            **result,
        }
    except json.JSONDecodeError:
        return {
            "clauseText": req.clauseText,
            "positions": req.positions,
            "bestMatch": "acceptable",
            "score": 0.5,
            "explanation": "Comparison could not be fully analyzed.",
            "deviations": [],
        }


_JUDGE_SYSTEM = """You are a contract judge evaluating whether a clause \
satisfies a set of structured playbook rules. Return ONLY valid JSON \
with this exact shape:

{
  "bestMatchPositionType": "preferred|acceptable|fallback|walkaway|none",
  "confidence": 0.0,
  "mustHave":   [{"id": "<rule id>", "passed": true|false, "evidence": "<≤120-char quote from clause>"}],
  "mustNot":    [{"id": "<rule id>", "passed": true|false, "evidence": "<≤120-char quote or empty>"}],
  "bounds":     [{"key": "<bound key>", "extracted_value": <number or null>, "extracted_unit": "<string or null>", "passed": true|false|null, "reason": "<short>"}]
}

Rules of judgment:
 • "passed" for must_have = clause satisfies the rule
 • "passed" for must_not  = clause DOES NOT contain the forbidden content
 • For bounds: if you cannot extract a value from the clause, set \
extracted_value=null and passed=null (not false) — partial match is \
OK.
 • Evidence must be verbatim from the clause (no paraphrase).
 • Be conservative — if unsure, passed=null."""


@router.post("/playbook_judge")
async def playbook_judge(req: PlaybookJudgeRequest, x_internal_secret: str = Header(default="")):
    if INTERNAL_SECRET and x_internal_secret != INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")
    if not req.clauseText.strip():
        raise HTTPException(status_code=400, detail="clauseText is required")

    # A caller-pinned provider/model rides through the router too — it keeps
    # the org's BYOK key + Langfuse tracing and only swaps which model is built.
    resolved = await resolve_llm(
        "fast",
        org_id=req.orgId,
        streaming=False,
        trace_name="assist.playbook_judge",
        provider_override=req.provider or None,
        model_override=req.model_id or None,
    )
    llm = resolved.llm
    callbacks = resolved.callbacks

    # Trim rule payload — only send what the judge needs. Strip `content`
    # from positions; the judge operates on rules + the clause only.
    rules_payload = {
        "must_have": req.rules.get("must_have", []),
        "must_not":  req.rules.get("must_not", []),
        "bounds":    req.rules.get("bounds", {}),
    }
    user_content = f"""Clause (position: {req.positionType or "unknown"}):
\"\"\"
{req.clauseText[:2000]}
\"\"\"

Playbook rules to evaluate:
{json.dumps(rules_payload, indent=2)}

Judge this clause against the rules and return the JSON now."""

    try:
        response = await llm.ainvoke([
            SystemMessage(content=_JUDGE_SYSTEM),
            HumanMessage(content=user_content),
        ], config={"callbacks": callbacks})
        content = response.content if isinstance(response.content, str) else str(response.content)
        # Strip accidental markdown fences
        content = content.strip()
        if content.startswith("```"):
            content = content.split("```", 2)[1]
            if content.startswith("json"):
                content = content[4:]
        result = loads_lenient(content)
        return result
    except (json.JSONDecodeError, Exception) as e:  # noqa: BLE001
        return {
            "bestMatchPositionType": "none",
            "confidence": 0.0,
            "mustHave": [],
            "mustNot": [],
            "bounds": [],
            "error": f"judge_failed: {type(e).__name__}: {str(e)[:120]}",
        }


_REDLINE_SYSTEM = """You are a contract negotiation attorney proposing \
redlines for a single clause. You propose THREE variants in one \
response — least aggressive, moderate, most aggressive — so the user \
can pick their position by conservatism.

Return ONLY valid JSON with this exact shape:

{
  "variants": [
    {
      "aggression": "least",
      "proposedText": "<full rewritten clause text>",
      "rationale": "<≤2 sentences: why this version, what risk it addresses>",
      "changes": [
        {"before": "<verbatim excerpt from original>", "after": "<replacement text>", "reason": "<1 sentence>"}
      ]
    },
    { "aggression": "moderate", ... },
    { "aggression": "aggressive", ... }
  ]
}

Variant spec:
 • "least"      — minimal edits; preserves the counterparty's language \
wherever safe. Typical use: deal is strategic, legal is compromising.
 • "moderate"   — balanced rewrite; our playbook's "acceptable" position. \
Typical use: standard negotiation.
 • "aggressive" — full rewrite to our playbook's "preferred" position. \
Typical use: high-value deal or we have leverage.

Rules:
 • changes[].before MUST be a verbatim substring of the original clause \
text. If nothing clean to quote, skip that change entry.
 • proposedText must be a complete, self-contained rewrite (not a diff).
 • Don't fabricate facts, numbers, or entity names — keep the ones from \
the original clause unless the playbook's rules explicitly say otherwise.
 • Stay in the domain/register of the original clause (if it's formal \
contract English, stay formal)."""


@router.post("/redline_propose")
async def redline_propose(req: RedlineProposeRequest, x_internal_secret: str = Header(default="")):
    if INTERNAL_SECRET and x_internal_secret != INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")
    if not req.clauseText.strip():
        raise HTTPException(status_code=400, detail="clauseText is required")

    # Use the smart model tier — redlines are the quality-critical path.
    # A caller-pinned provider/model rides through the router too — it keeps
    # the org's BYOK key + Langfuse tracing and only swaps which model is built.
    resolved = await resolve_llm(
        "reasoning",
        org_id=req.orgId,
        streaming=False,
        trace_name="assist.redline_propose",
        provider_override=req.provider or None,
        model_override=req.model_id or None,
    )
    llm = resolved.llm
    callbacks = resolved.callbacks
    provider = resolved.provider
    model_id = resolved.model

    rules_block = ""
    if req.rules:
        rules_block = f"\n\nPlaybook rules to respect:\n{json.dumps(req.rules, indent=2)}"

    preferred_block = ""
    if req.preferredContent:
        # Strip HTML tags from the playbook's stored position content so
        # the LLM sees clean prose.
        clean_preferred = req.preferredContent
        for tag in ("<p>", "</p>", "<strong>", "</strong>", "<em>", "</em>", "<br/>", "<br>"):
            clean_preferred = clean_preferred.replace(tag, "")
        preferred_block = f"\n\nOur playbook's preferred position:\n{clean_preferred.strip()}"

    instructions_block = ""
    if req.instructions and req.instructions.strip():
        instructions_block = f"\n\nUser direction: {req.instructions.strip()}"

    category_line = (
        f" (category: {req.category})" if req.category else ""
    )

    user_content = f"""Clause to redline{category_line}:
\"\"\"
{req.clauseText[:3000]}
\"\"\"{preferred_block}{rules_block}{instructions_block}

Contract type: {req.contractType}

Produce the three-variant redline now."""

    try:
        response = await llm.ainvoke([
            SystemMessage(content=_REDLINE_SYSTEM),
            HumanMessage(content=user_content),
        ], config={"callbacks": callbacks})
        content = response.content if isinstance(response.content, str) else str(response.content)
        content = content.strip()
        if content.startswith("```"):
            content = content.split("```", 2)[1]
            if content.startswith("json"):
                content = content[4:]
        result = loads_lenient(content)
        # Validate variants shape — we want all three + basic fields.
        variants = result.get("variants") or []
        by_aggression = {v.get("aggression"): v for v in variants if isinstance(v, dict)}
        # If the model skipped a variant, fill in a placeholder so the
        # UI doesn't break on missing keys.
        filled = []
        for aggression in ("least", "moderate", "aggressive"):
            v = by_aggression.get(aggression)
            if v:
                filled.append({
                    "aggression": aggression,
                    "proposedText": v.get("proposedText", "").strip(),
                    "rationale":    v.get("rationale", "").strip(),
                    "changes":      v.get("changes", []),
                })
            else:
                filled.append({
                    "aggression": aggression,
                    "proposedText": req.clauseText,
                    "rationale":    f"(Model did not produce a '{aggression}' variant — original kept.)",
                    "changes":      [],
                })
        return {
            "clauseType": req.clauseType,
            "category":   req.category,
            "variants":   filled,
            "model":      model_id,
            "provider":   provider,
        }
    except (json.JSONDecodeError, Exception) as e:  # noqa: BLE001
        return {
            "clauseType": req.clauseType,
            "category":   req.category,
            "variants":   [],
            "error":      f"redline_failed: {type(e).__name__}: {str(e)[:120]}",
        }


# ─── P6.3 — Streaming assist for the bubble menu ─────────────────────────────
# A token-streaming variant of /assist. The bubble-menu AI popover
# consumes this as a newline-delimited stream (NDJSON) so the user
# sees text appear as the model generates it — the "editor feels
# alive" moment. Chunks are plain strings; the client concatenates.

class StreamAssistRequest(BaseModel):
    selected_text: str
    action:        AssistAction
    contract_type: str = "general commercial"
    governing_law: str = "Delaware"
    provider:      str = ""
    model_id:      str = ""
    orgId:         str | None = None  # enables per-org BYOK key + Langfuse tracing


# Prompt tuned for short plain-text output — the bubble popover doesn't
# render HTML and the stream should be instantly readable. Kept
# deliberately tight so a two-sentence clause streams in <1s.
_STREAM_SYSTEM = """You are a senior contracts lawyer. Rewrite the \
provided clause according to the action. Output plain text only — NO \
HTML tags, NO markdown, NO preamble, NO quotation marks. Keep the \
same level of detail as the input unless the action says otherwise. \
One to four sentences max."""


_ACTION_INSTRUCTIONS: dict[str, str] = {
    "rewrite":             "Rewrite the clause for clarity while preserving its legal meaning.",
    "simplify":            "Rewrite in plain English with no legalese. Shorter is better.",
    "expand":              "Add missing detail (who, what, when, how measured) to make it more precise.",
    "check_compliance":    "List any compliance / regulatory gaps as a short numbered list (max 4 items). No preamble.",
    "suggest_alternative": "Propose an alternative formulation that shifts slightly in the customer's favour without going off-market.",
    "fix_layout":          "Normalize whitespace + section-number style without changing meaning.",
    "rewrite_document":    "Make it read cleanly end-to-end.",
}


@router.post("/assist_stream")
async def assist_stream(req: StreamAssistRequest, x_internal_secret: str = Header(default="")):
    if INTERNAL_SECRET and x_internal_secret != INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")
    text = (req.selected_text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="selected_text is required")

    instruction = _ACTION_INSTRUCTIONS.get(req.action, _ACTION_INSTRUCTIONS["rewrite"])

    user = (
        f"Contract type: {req.contract_type}\n"
        f"Governing law: {req.governing_law}\n"
        f"Action: {req.action} — {instruction}\n\n"
        f"Clause to transform:\n\"\"\"\n{text[:6000]}\n\"\"\""
    )

    async def gen():
        # NDJSON stream — one JSON object per line.
        try:
            # Fast tier — streaming must feel instant. A caller-pinned
            # provider/model rides through the router too — it keeps the org's
            # BYOK key + Langfuse tracing and only swaps which model is built.
            resolved = await resolve_llm(
                "fast",
                org_id=req.orgId,
                streaming=True,
                trace_name="assist.stream",
                provider_override=req.provider or None,
                model_override=req.model_id or None,
            )
            llm = resolved.llm
            callbacks = resolved.callbacks
            provider = resolved.provider
            model = resolved.model
            # yield a start event so the client can show "typing…"
            yield json.dumps({"type": "start", "action": req.action, "model": model, "provider": provider}) + "\n"
            async for chunk in llm.astream([
                SystemMessage(content=_STREAM_SYSTEM),
                HumanMessage(content=user),
            ], config={"callbacks": callbacks}):
                piece = chunk.content if isinstance(chunk.content, str) else (
                    "".join(getattr(b, "text", "") for b in (chunk.content or [])) if chunk.content else ""
                )
                if not piece:
                    continue
                yield json.dumps({"type": "delta", "text": piece}) + "\n"
            yield json.dumps({"type": "done"}) + "\n"
        except Exception as e:  # noqa: BLE001
            yield json.dumps({"type": "error", "message": f"{type(e).__name__}: {str(e)[:180]}"}) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")
