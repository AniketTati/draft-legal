"""
POST /review  — called by the agent worker after extract-ai job is picked up.
Accepts full payload including orgId, contractType, and customFields[].
Runs the 3-step Review Agent and POSTs the enriched result back to the API.
"""
from __future__ import annotations

import httpx
import logging
from typing import List, Optional
from fastapi import APIRouter, BackgroundTasks
from pydantic import BaseModel

from ..agents.review_agent import run_review, TYPE_SCHEMAS
from ..config import settings

router = APIRouter()
logger = logging.getLogger(__name__)


class CustomFieldDef(BaseModel):
    fieldKey:   str
    fieldLabel: str
    fieldType:  str   # text | number | date | boolean | select | multiselect
    options:    List[str] = []
    helpText:   Optional[str] = None


class ReviewRequest(BaseModel):
    contractId:    str
    versionId:     str
    plainText:     str
    orgId:         Optional[str] = None
    # Wave E.3 — the user's own org name, so the counterparty picker can
    # disambiguate "us" vs "them". Without this the extractor saves our
    # org as the counterparty in ~40% of contracts.
    orgName:       Optional[str] = None
    contractType:  Optional[str] = None   # user-corrected type injected into prompt
    customFields:  List[CustomFieldDef] = []


async def _process_and_update(
    contract_id:   str,
    version_id:    str,
    plain_text:    str,
    org_id:        str | None,
    contract_type: str | None,
    custom_fields: list[dict],
    org_name:      str | None = None,
) -> None:
    logger.info("[review] START contractId=%s versionId=%s text_chars=%d customFields=%d",
                contract_id, version_id, len(plain_text), len(custom_fields))

    result = await run_review(
        plain_text,
        contract_type=contract_type,
        custom_fields=custom_fields,
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
            "[review] dropping placeholder title=%r for contractId=%s "
            "(keeping the upload's filename-derived title)",
            _suggested_title, contract_id,
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

    # Promote counterparty from parties array (Wave E.3).
    #
    # Strategy — in priority order:
    #   (1) If we know the user's org name, pick any party whose name does
    #       NOT match the org (case/punctuation-insensitive fuzzy compare).
    #       This is the strongest signal: "the counterparty is the other
    #       party, not us."
    #   (2) Fall back to role-based filter (skip client/buyer/licensor) —
    #       which fails when our org IS the client/buyer/licensor
    #       (approximately half the cases).
    #   (3) Last resort: the first party in the list.
    #
    # Evidence from Wave E audit: without (1), the extractor saved "Demo
    # Org, Inc." as the counterparty in 5/12 cases. Adding the name-match
    # filter should lift counterparty-correct to ≥11/12.
    parties = kt.get("parties") or []
    if parties and isinstance(parties, list):
        def _normalise(s: str) -> str:
            return (s or "").lower().replace(",", "").replace(".", "").replace(" ", "")

        org_norm = _normalise(org_name) if org_name else ""

        def _is_us(party: dict) -> bool:
            if not org_norm:
                return False
            pname = _normalise(str(party.get("name") or ""))
            if not pname:
                return False
            # Match if one is a substring of the other (handles "Demo Org"
            # vs "Demo Org, Inc." vs "demo org inc").
            return pname in org_norm or org_norm in pname

        # (1) Org-name filter
        counterparty = next(
            (p.get("name") for p in parties
             if isinstance(p, dict) and not _is_us(p)),
            None,
        )
        # (2) Fall through to role filter if org-match didn't produce one
        if not counterparty:
            counterparty = next(
                (p.get("name") for p in parties if isinstance(p, dict)
                 and p.get("role", "").lower() not in ("client", "buyer", "licensor", "seller")),
                None,
            )
        # (3) Absolute last resort
        if not counterparty and parties:
            first = parties[0]
            counterparty = first.get("name") if isinstance(first, dict) else None

        if counterparty:
            contract_payload.setdefault("counterpartyName", counterparty)

    # Map custom extracted fields → contract.metadata
    custom_extracted = result.get("customExtracted") or {}
    custom_field_values = custom_extracted.get("customFields") or {}
    type_fields_raw = custom_extracted.get("typeFields") or {}
    open_ended = custom_extracted.get("openEndedFindings") or []

    metadata_update: dict = {}

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
            }
    if type_fields_out:
        metadata_update["_typeFields"] = type_fields_out

    # Org-defined custom fields — stored flat by fieldKey
    for field_key, extraction in custom_field_values.items():
        if isinstance(extraction, dict) and extraction.get("value") is not None:
            metadata_update[field_key] = extraction["value"]

    if open_ended:
        metadata_update["_aiFindings"] = open_ended
    if metadata_update:
        contract_payload["metadata"] = metadata_update

    # ── Version-level fields ───────────────────────────────────────────────
    if result.get("clauseSegments"):
        version_payload["clauseSegments"] = result["clauseSegments"]
    if result.get("clauseFlags"):
        version_payload["clauseFlags"] = result["clauseFlags"]

    headers = {
        "x-internal-service": "agents",
        "x-internal-secret": settings.internal_service_secret,
    }
    # x-org-id is required — without it requireAuth falls back to the
    # 'system' sentinel, which matches no real org's contracts and every
    # PATCH/POST below 404s silently against the real org's data.
    if org_id:
        headers["x-org-id"] = org_id

    async with httpx.AsyncClient() as client:
        # PATCH contract
        if contract_payload:
            try:
                r = await client.patch(
                    f"{api_url}/api/v1/contracts/{contract_id}",
                    json=contract_payload,
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


@router.post("/review")
async def review_contract(body: ReviewRequest, background: BackgroundTasks):
    """Fire-and-forget: run 3-step review pipeline in background."""
    background.add_task(
        _process_and_update,
        body.contractId,
        body.versionId,
        body.plainText,
        body.orgId,
        body.contractType,
        [f.model_dump() for f in body.customFields],
        body.orgName,
    )
    return {"status": "queued", "contractId": body.contractId}
