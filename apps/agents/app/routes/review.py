"""
The Review Agent's routes: the 3-step extraction (extract → validate → score)
of a contract, and what of it the API saves.

POST /review/run      — docs/39 A1: run it and RETURN what to save, with the
                        run's real token use (A15). The API's extract job calls
                        this inside its queued job, so a restart retries the
                        job, a failed save is retried without a new run, and a
                        failure names its step.
POST /review          — the fire-and-forget form it replaces: run in a
                        background task and PATCH the result back. Kept for an
                        API worker older than /review/run during a deploy.
POST /review/preview  — I1: the output, unsaved, for the eval harness.
"""
from __future__ import annotations

import asyncio
import json
import httpx
import logging
from typing import List, Optional
from fastapi import APIRouter, BackgroundTasks
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..agents.review_agent import run_review, TYPE_SCHEMAS
from ..company_names import is_one_of
from ..config import settings
from ..usage_meter import metering

router = APIRouter()
logger = logging.getLogger(__name__)


class CustomFieldExample(BaseModel):
    value: str
    quote: Optional[str] = None


class CorrectionExample(BaseModel):
    read:      str
    corrected: str
    quote:     Optional[str] = None


class CustomFieldDef(BaseModel):
    fieldKey:   str
    fieldLabel: str
    fieldType:  str   # text | number | date | boolean | select | multiselect
    options:    List[str] = []
    helpText:   Optional[str] = None
    # docs/39 A5 — how people filled it in on other contracts, for the custom-field pass.
    examples:   List[CustomFieldExample] = []
    # docs/39 I2 — earlier readings of it that people corrected (read → corrected).
    corrections: List[CorrectionExample] = []


class FieldCorrections(BaseModel):
    """docs/39 I2 — a field people corrected more than once, with a few of the corrections."""
    key:      str
    label:    str
    examples: List[CorrectionExample] = []


class CustomClauseType(BaseModel):
    """docs/39 E3 — a clause type the organisation added: its key (custom_…), name, what it is, passages that are one."""
    key:         str
    label:       str
    description: str = ""
    examples:    List[str] = []


class ReviewRequest(BaseModel):
    contractId:    str
    versionId:     str
    plainText:     str
    orgId:         Optional[str] = None
    # Wave E.3 — the user's own org name, so the counterparty picker can
    # disambiguate "us" vs "them". Without this the extractor saves our
    # org as the counterparty in ~40% of contracts.
    orgName:       Optional[str] = None
    # docs/39 A8 — the other names the org signs as (Settings › Our entities):
    # subsidiaries, former and trading names. Never the counterparty either.
    ourEntities:   List[str] = []
    contractType:  Optional[str] = None   # user-corrected type injected into prompt
    # docs/39 A13 — a person set the type: the review keeps it and says nothing
    # of its own. Otherwise (the classifier's type) it says when it reads the
    # whole contract as another type.
    typeLocked:    bool = False
    customFields:  List[CustomFieldDef] = []
    # docs/39 A11 — the contract's language (when detected) and how the org
    # writes dates with numbers ("MDY" | "DMY").
    language:      Optional[str] = None
    dateOrder:     Optional[str] = None
    # docs/39 I2 — what the org's reviewers corrected earlier readings of these fields to.
    corrections:   List[FieldCorrections] = []
    # docs/39 E3 — the org's own clause types, tagged like the listed ones.
    customClauseTypes: List[CustomClauseType] = []


def pick_counterparty(parties: object, org_name: str | None, our_entities: list[str] | None = None) -> str | None:
    """The other party to the contract (Wave E.3), in priority order:

      (1) If we know the names we sign as — the org's name and its other
          entities (docs/39 A8) — any party that is none of them (the same
          company whatever the spelling or legal form: company_names). The
          strongest signal: "the counterparty is the other party, not us."
      (2) Else a role-based filter (skip client/buyer/licensor/seller) —
          which fails when our org IS the client/buyer/licensor (about half
          the cases).
      (3) Last resort: the first party in the list.

    Evidence from the Wave E audit: without (1) the extractor saved "Demo Org,
    Inc." as the counterparty in 5/12 cases. Shared by /review, which saves
    it, and /review/preview, which the eval harness scores (docs/39 I1).
    """
    if not parties or not isinstance(parties, list):
        return None

    ours = [n for n in [org_name, *(our_entities or [])] if n]

    def _is_us(party: dict) -> bool:
        return bool(ours) and is_one_of(party.get("name"), ours)

    counterparty = next((p.get("name") for p in parties if isinstance(p, dict) and p.get("name") and not _is_us(p)), None)
    # Every party is one of ours (an intercompany agreement) or none is named
    # as such: still a value to start from — the contract's page says when the
    # counterparty is one of our own companies.
    if not counterparty:
        counterparty = next(
            (p.get("name") for p in parties if isinstance(p, dict)
             and str(p.get("role") or "").lower() not in ("client", "buyer", "licensor", "seller")),
            None,
        )
    if not counterparty:
        first = parties[0]
        counterparty = first.get("name") if isinstance(first, dict) else None
    return counterparty or None


def party_fields(parties: object, counterparty: str | None) -> dict:
    """docs/39 F3 — the counterparty's address and who signed for each party.

    The extractor records an address and a signatory per party (it can't tell
    which party is us); once the counterparty is picked, these become the
    counterpartyAddress and signatories fields.
    """
    out: dict = {}
    if not isinstance(parties, list):
        return out
    cp = next((p for p in parties if isinstance(p, dict) and counterparty and p.get("name") == counterparty), None)
    if cp and cp.get("address"):
        out["counterpartyAddress"] = str(cp["address"]).strip()
    signers = [
        f"{str(p['signatory']).strip()} ({p.get('name')})" if p.get("name") else str(p["signatory"]).strip()
        for p in parties if isinstance(p, dict) and p.get("signatory")
    ]
    if signers:
        out["signatories"] = "; ".join(signers)
    return out


def build_payloads(result: dict, org_name: str | None, custom_fields: list[dict], our_entities: list[str] | None = None) -> tuple[dict, dict]:
    """What a run saves: the contract's fields (PATCH /contracts/:id) and the
    version's clauses (POST …/versions/:versionId/clauses). Shared by /review,
    which saves them itself, and /review/run, which returns them."""
    contract_payload: dict = {}
    version_payload: dict = {}

    # ── Contract-level fields ──────────────────────────────────────────────
    has_error  = bool(result.get("error"))
    has_output = bool(result.get("summary") or result.get("contractType"))
    contract_payload["analysisStatus"] = "FAILED" if (has_error and not has_output) else "DONE"

    if result.get("summary"):
        contract_payload["summary"] = result["summary"]
    if result.get("keyTerms"):
        contract_payload["keyTerms"] = result["keyTerms"]
    if result.get("riskScore") is not None:
        contract_payload["riskScore"] = result["riskScore"]
    if result.get("contractType"):
        contract_payload["type"] = result["contractType"]
    if result.get("fieldConfidence"):
        contract_payload["fieldConfidence"] = result["fieldConfidence"]
    # B.6.8 — never overwrite the user's filename-based title with a
    # placeholder string. The LLM sometimes emits "Unnamed Contract -
    # No Identified Parties" or "Unidentified Contract - Missing Party
    # Details" when extraction fails; those leak into the contracts
    # list and make successful uploads look broken. If the suggested
    # title matches any of these patterns we keep the original title
    # (which ContractsPage falls back to — usually the filename).
    _BAD_TITLE_PATTERNS = (
        "unnamed contract",
        "unidentified contract",
        "no identified parties",
        "missing party",
        "untitled contract",
        "unknown contract",
    )
    _suggested_title = (result.get("suggestedTitle") or "").strip()
    if _suggested_title and not any(
        p in _suggested_title.lower() for p in _BAD_TITLE_PATTERNS
    ):
        contract_payload["title"] = _suggested_title
    elif _suggested_title:
        logger.info(
            "[review] dropping placeholder title=%r "
            "(keeping the upload's filename-derived title)",
            _suggested_title,
        )
    if result.get("riskFactors"):
        contract_payload["riskFactors"] = result["riskFactors"]
    if result.get("overallConfidence") is not None:
        contract_payload["overallConfidence"] = float(result["overallConfidence"])

    # Promote key fields to dedicated DB columns
    kt = result.get("keyTerms") or {}

    if kt.get("governingLaw"):
        contract_payload["jurisdiction"] = str(kt["governingLaw"])
    def _to_iso(val: str) -> str | None:
        """Convert 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SSZ' to full ISO datetime string."""
        if not val or not isinstance(val, str):
            return None
        s = val.strip()
        if len(s) == 10:  # date-only: YYYY-MM-DD
            return s + "T00:00:00.000Z"
        if "T" in s and not s.endswith("Z") and "+" not in s:
            return s + "Z"
        return s

    if kt.get("effectiveDate"):
        iso = _to_iso(kt["effectiveDate"])
        if iso:
            contract_payload["effectiveDate"] = iso
    if kt.get("expiryDate"):
        iso = _to_iso(kt["expiryDate"])
        if iso:
            contract_payload["expiryDate"] = iso
    if kt.get("value") is not None:
        try:
            contract_payload["value"] = float(kt["value"])
        except (TypeError, ValueError):
            pass
    if kt.get("currency"):
        contract_payload["currency"] = str(kt["currency"])

    # Promote counterparty from parties array (Wave E.3): see pick_counterparty.
    counterparty = pick_counterparty(kt.get("parties"), org_name, our_entities)
    if counterparty:
        contract_payload.setdefault("counterpartyName", counterparty)
    # docs/39 F3 — the counterparty's address and who signed, from the parties.
    party_extra = party_fields(kt.get("parties"), counterparty)
    if party_extra:
        contract_payload["keyTerms"] = {**(contract_payload.get("keyTerms") or {}), **party_extra}
        parties_ev = (result.get("fieldConfidence") or {}).get("parties") or {}
        fc = dict(contract_payload.get("fieldConfidence") or {})
        for k in party_extra:
            fc.setdefault(k, {"confidence": parties_ev.get("confidence", 0.8), "quote": parties_ev.get("quote"), "section": parties_ev.get("section")})
        contract_payload["fieldConfidence"] = fc

    # Map custom extracted fields → contract.metadata
    custom_extracted = result.get("customExtracted") or {}
    custom_field_values = custom_extracted.get("customFields") or {}
    type_fields_raw = custom_extracted.get("typeFields") or {}
    open_ended = custom_extracted.get("openEndedFindings") or []

    metadata_update: dict = {}
    # docs/39 A13 — the type the whole contract reads as, when it isn't the
    # one it was read as (the classifier's, from its opening); cleared when
    # they agree, so an old disagreement doesn't linger after a re-analysis.
    if "typeOpinion" in result:
        metadata_update["_typeOpinion"] = {"type": result["typeOpinion"]} if result["typeOpinion"] else None

    # Type-specific fields — stored as _typeFields with label included for UI rendering
    resolved_type = result.get("contractType") or ""
    type_schema_lookup = {f["key"]: f for f in TYPE_SCHEMAS.get(resolved_type, [])}
    type_fields_out: dict = {}
    for field_key, extraction in type_fields_raw.items():
        if isinstance(extraction, dict) and extraction.get("value") is not None:
            type_fields_out[field_key] = {
                "value":      extraction["value"],
                "confidence": extraction.get("confidence", 0.5),
                "quote":      extraction.get("quote"),
                "label":      type_schema_lookup.get(field_key, {}).get("label", field_key),
                # docs/39 A6 — the contract says different things: every reading.
                **({"candidates": extraction["candidates"]} if extraction.get("candidates") else {}),
            }
    if type_fields_out:
        metadata_update["_typeFields"] = type_fields_out

    # Org-defined custom fields — stored flat by fieldKey (what search and the
    # UI read). X2 — their confidence and source quote were dropped; they go
    # beside the values, in _customFieldEvidence, as _typeFields keeps them.
    custom_evidence: dict = {}
    # X26 follow-up — only the org's own fields. The model's output follows
    # the document it read, and any other key written here (`_splitInto`, a
    # forged report) would be trusted as the server's own state.
    wanted_fields = {f.get("fieldKey") for f in custom_fields if isinstance(f, dict)}
    for field_key, extraction in custom_field_values.items():
        if field_key not in wanted_fields:
            continue
        if isinstance(extraction, dict) and extraction.get("value") is not None:
            metadata_update[field_key] = extraction["value"]
            custom_evidence[field_key] = {
                "confidence": extraction.get("confidence", 0.5),
                "quote":      extraction.get("quote"),
                # A5 — the custom pass says when its quote isn't in the document.
                **({"issue": extraction["issue"]} if extraction.get("issue") else {}),
                # docs/39 A6 — the contract says different things: every reading.
                **({"candidates": extraction["candidates"]} if extraction.get("candidates") else {}),
            }
    if custom_evidence:
        metadata_update["_customFieldEvidence"] = custom_evidence

    if open_ended:
        metadata_update["_aiFindings"] = open_ended
    # The API merges metadata (C4), so other jobs' reports (_compliance,
    # _playbookReview, binder markers, …) survive a re-analysis. This run's
    # own outputs must still refresh: send None (= delete) for any it did not
    # produce this time, so a stale value from the last run can't linger —
    # but only when this run produced output; a failed run keeps the last one.
    if not (has_error and not has_output):
        metadata_update.setdefault("_typeFields", None)
        metadata_update.setdefault("_aiFindings", None)
        metadata_update.setdefault("_customFieldEvidence", None)
    if metadata_update:
        contract_payload["metadata"] = metadata_update

    # ── Version-level fields ───────────────────────────────────────────────
    if result.get("clauseSegments"):
        version_payload["clauseSegments"] = result["clauseSegments"]
    if result.get("clauseFlags"):
        version_payload["clauseFlags"] = result["clauseFlags"]

    return contract_payload, version_payload


def run_failed(result: dict) -> bool:
    """An error and nothing to show for it: worth another attempt, not a save."""
    return bool(result.get("error")) and not (result.get("summary") or result.get("contractType"))


async def _process_and_update(
    contract_id:   str,
    version_id:    str,
    plain_text:    str,
    org_id:        str | None,
    contract_type: str | None,
    custom_fields: list[dict],
    org_name:      str | None = None,
    our_entities:  list[str] | None = None,
) -> None:
    logger.info("[review] START contractId=%s versionId=%s text_chars=%d customFields=%d",
                contract_id, version_id, len(plain_text), len(custom_fields))

    result = await run_review(
        plain_text,
        contract_type=contract_type,
        custom_fields=custom_fields,
        org_id=org_id,
    )

    if not result:
        logger.error("[review] run_review returned None for contractId=%s", contract_id)
        return

    if result.get("error"):
        logger.warning("[review] pipeline error contractId=%s error=%s", contract_id, result["error"])

    logger.info("[review] DONE contractId=%s type=%s title=%r risk=%s summary_len=%d",
                contract_id, result.get("contractType"), result.get("suggestedTitle"),
                result.get("riskScore"), len(result.get("summary") or ""))

    api_url = settings.api_url
    contract_payload, version_payload = build_payloads(result, org_name, custom_fields, our_entities)

    headers = {
        "x-internal-service": "agents",
        "x-internal-secret": settings.internal_service_secret,
    }

    async with httpx.AsyncClient() as client:
        # PATCH contract
        if contract_payload:
            try:
                r = await client.patch(
                    f"{api_url}/api/v1/contracts/{contract_id}",
                    json=contract_payload,
                    # X23 — the API restores PII tokens against the version read.
                    params={"versionId": version_id},
                    headers=headers,
                    timeout=10,
                )
                logger.info("[review] PATCH contract status=%d keys=%s",
                            r.status_code, list(contract_payload.keys()))
                # Wave E.4 — do NOT overwrite with {analysisStatus: FAILED}
                # on a non-2xx PATCH. That behaviour silently wiped summary /
                # riskScore / fieldConfidence whenever a single Zod rejection
                # happened (e.g. an unrecognised enum value), making the
                # contract look "done" but empty in the UI.
                #
                # Today the right escalation is: log loudly and let the
                # chunk-and-index worker path decide final status. If no
                # clauses arrive, the contract stays in EXTRACTING until a
                # retry; the operator sees the log + audit and can intervene.
                if r.status_code >= 400:
                    logger.error("[review] PATCH failed body=%s", r.text[:500])
            except Exception as e:
                logger.error("[review] PATCH contract EXCEPTION: %s", e)

        # POST clause segments to version
        if version_payload:
            try:
                r = await client.post(
                    f"{api_url}/api/v1/contracts/{contract_id}/versions/{version_id}/clauses",
                    json=version_payload,
                    headers=headers,
                    timeout=15,
                )
                logger.info("[review] POST clauses status=%d segments=%d",
                            r.status_code, len(version_payload.get("clauseSegments", [])))
                if r.status_code >= 400:
                    logger.error("[review] POST clauses failed body=%s", r.text[:500])
            except Exception as e:
                logger.error("[review] POST clauses EXCEPTION: %s", e)

        # Signal API to start chunk-and-index (Service 3)
        if version_payload.get("clauseSegments"):
            try:
                r = await client.post(
                    f"{api_url}/api/v1/contracts/{contract_id}/versions/{version_id}/chunk",
                    headers=headers,
                    timeout=5,
                )
                logger.info("[review] POST /chunk status=%d", r.status_code)
            except Exception as e:
                logger.warning("[review] POST /chunk EXCEPTION (non-fatal): %s", e)


class PreviewRequest(BaseModel):
    plainText:    str
    orgId:        Optional[str] = None
    orgName:      Optional[str] = None
    ourEntities:  List[str] = []
    contractType: Optional[str] = None
    customFields: List[CustomFieldDef] = []
    language:     Optional[str] = None
    dateOrder:    Optional[str] = None
    corrections:  List[FieldCorrections] = []


@router.post("/review/preview")
async def preview_review(body: PreviewRequest) -> dict:
    """I1 (docs/39) — the extraction's output without saving it.

    The same pipeline as /review, returned instead of written back, so the
    eval harness can score it field by field (scripts/evals/langfuse,
    target `review`). No contract is read or changed.
    """
    result = await run_review(
        body.plainText,
        contract_type=body.contractType,
        custom_fields=[f.model_dump() for f in body.customFields],
        org_id=body.orgId,
        language=body.language,
        date_order=body.dateOrder,
        corrections=[c.model_dump() for c in body.corrections],
    )
    result = result or {}
    key_terms = dict(result.get("keyTerms") or {})
    # What /review would save as the counterparty column, scored with the rest.
    key_terms["counterpartyName"] = pick_counterparty(key_terms.get("parties"), body.orgName, body.ourEntities)
    key_terms.update(party_fields(key_terms.get("parties"), key_terms["counterpartyName"]))
    return {
        "contractType":      result.get("contractType"),
        "keyTerms":          key_terms,
        "fieldConfidence":   result.get("fieldConfidence") or {},
        "clauseFlags":       result.get("clauseFlags") or {},
        "clauseTypes":       [s.get("clauseType") for s in (result.get("clauseSegments") or []) if isinstance(s, dict)],
        "customExtracted":   result.get("customExtracted") or {},
        "overallConfidence": result.get("overallConfidence"),
        "error":             result.get("error"),
    }


async def run_extraction(body: ReviewRequest) -> dict:
    """docs/39 A1 — run the extraction and return what to save.

    The API's extract job calls this (through /review/run) and saves the
    result through its own routes, so the job's retries cover both a crashed
    run and a failed save. `failed` says the run produced nothing (an error
    and no output): the job retries it rather than saving a FAILED analysis
    over the last good one. `usage` is the run's real token use, by model (A15).
    """
    logger.info("[review/run] START contractId=%s versionId=%s text_chars=%d customFields=%d",
                body.contractId, body.versionId, len(body.plainText), len(body.customFields))
    custom_fields = [f.model_dump() for f in body.customFields]
    with metering() as meter:
        try:
            result = await run_review(
                body.plainText,
                contract_type=body.contractType,
                custom_fields=custom_fields,
                org_id=body.orgId,
                language=body.language,
                date_order=body.dateOrder,
                corrections=[c.model_dump() for c in body.corrections],
                type_locked=body.typeLocked,
                custom_clause_types=[t.model_dump() for t in body.customClauseTypes],
            )
        except Exception as e:  # the answer is already under way: say it failed, don't cut it off
            logger.exception("[review/run] run failed contractId=%s", body.contractId)
            result = {"error": f"{type(e).__name__}: {e}"}
    result = result or {"error": "The extraction returned nothing"}
    contract_payload, version_payload = build_payloads(result, body.orgName, custom_fields, body.ourEntities)
    usage = meter.summary()
    logger.info("[review/run] DONE contractId=%s failed=%s calls=%d in=%d out=%d",
                body.contractId, run_failed(result), usage["calls"], usage["inputTokens"], usage["outputTokens"])
    return {
        "contract": contract_payload,
        "version":  version_payload,
        "failed":   run_failed(result),
        "error":    result.get("error"),
        "usage":    usage,
    }


# A space every few seconds while the run goes on: the API's fetch gives up on
# an answer whose headers or next bytes take five minutes, and a long
# contract's three passes can. JSON ignores the leading whitespace.
_HEARTBEAT_SECONDS = 15


@router.post("/review/run")
async def run_review_route(body: ReviewRequest) -> StreamingResponse:
    async def produce():
        task = asyncio.create_task(run_extraction(body))
        while True:
            done, _ = await asyncio.wait({task}, timeout=_HEARTBEAT_SECONDS)
            if done:
                break
            yield b" "
        yield json.dumps(task.result()).encode()

    return StreamingResponse(produce(), media_type="application/json")


@router.post("/review")
async def review_contract(body: ReviewRequest, background: BackgroundTasks):
    """Fire-and-forget: run 3-step review pipeline in background (see /review/run)."""
    background.add_task(
        _process_and_update,
        body.contractId,
        body.versionId,
        body.plainText,
        body.orgId,
        body.contractType,
        [f.model_dump() for f in body.customFields],
        body.orgName,
        body.ourEntities,
    )
    return {"status": "queued", "contractId": body.contractId}
