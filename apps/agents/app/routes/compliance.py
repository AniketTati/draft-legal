"""
Compliance Agent (Phase 10)

POST /check_compliance — given a contract's plainText, runs regulatory
clause checks against one or more compliance frameworks (GDPR, HIPAA,
SOX, CCPA) and returns a structured per-framework report:

  • applicability   — does this framework even apply to this contract?
  • checks          — required clause present / partial / missing / risky,
                      each grounded in a verbatim quote + section ref
  • score + status  — roll-up per framework (compliant / gaps / non_compliant)

Single LLM call. Node side persists the result onto
Contract.metadata._compliance so the rail section + agent tools can
read it without re-running the pass.

POST /compliance/facts (docs/41 Part 9) — reads the FACTS that decide
which frameworks apply (personal data? whose? health data? card data?…),
each with a verbatim quote and a confidence. One fast-tier call. Whether a
framework applies is then decided by the API from these facts and the org's
policy (lib/compliance-policy.ts), not by a model.
"""
from __future__ import annotations

import json
import re
from ..jsonish import loads_lenient
import logging

from fastapi import APIRouter
from pydantic import BaseModel

from app.router import resolve_llm
from langchain_core.messages import HumanMessage, SystemMessage

logger = logging.getLogger("compliance")
router = APIRouter()

VALID_FRAMEWORKS = ["GDPR", "UK_GDPR", "HIPAA", "SOX", "CCPA", "PCI_DSS"]

# Per-framework requirement catalogs injected into the prompt. Keeping
# these in code (not the LLM's head) pins WHAT we check; the LLM only
# judges WHETHER the contract text satisfies each requirement.
_FRAMEWORK_CATALOG = """\
GDPR (EU General Data Protection Regulation) — applies when the contract \
involves processing EU personal data:
  gdpr_processing_scope    — defined subject-matter, duration, nature & purpose of processing (Art. 28(3))
  gdpr_documented_instructions — processor acts only on documented controller instructions
  gdpr_confidentiality     — persons processing data are bound to confidentiality
  gdpr_security_measures   — appropriate technical & organisational measures (Art. 32)
  gdpr_subprocessor_consent — prior authorisation / notification for sub-processors + flow-down
  gdpr_data_subject_rights — processor assists controller with data subject requests
  gdpr_breach_notification — personal data breach notice without undue delay (72h benchmark)
  gdpr_deletion_return     — delete or return personal data at end of services
  gdpr_audit_rights        — controller audit / inspection rights
  gdpr_international_transfers — lawful transfer mechanism (SCCs / adequacy) if data leaves the EEA

HIPAA (US Health Insurance Portability and Accountability Act) — applies \
when the contract involves Protected Health Information (PHI):
  hipaa_permitted_uses     — permitted uses & disclosures of PHI defined
  hipaa_safeguards         — administrative / physical / technical safeguards for PHI
  hipaa_breach_notification — report breaches of unsecured PHI to covered entity
  hipaa_subcontractor_flowdown — subcontractors bound by same restrictions (BAA flow-down)
  hipaa_minimum_necessary  — minimum-necessary standard for PHI access
  hipaa_individual_rights  — support access / amendment / accounting of disclosures
  hipaa_termination_return — return or destroy PHI on termination
  hipaa_hhs_access         — books & records available to HHS

SOX (US Sarbanes-Oxley Act) — applies when the contract affects financial \
reporting, audit, or internal controls of a public company:
  sox_audit_rights         — audit / inspection rights over relevant records
  sox_records_retention    — records retention aligned with audit requirements (7-year benchmark)
  sox_internal_controls    — service provider maintains internal controls (e.g. SOC reports)
  sox_financial_accuracy   — accurate books & records / no off-the-books arrangements
  sox_whistleblower_nonretaliation — nothing restricting reports to regulators

CCPA (California Consumer Privacy Act / CPRA) — applies when the contract \
involves personal information of California residents:
  ccpa_no_sale             — prohibition on selling / sharing personal information
  ccpa_purpose_limitation  — processing limited to specified business purposes
  ccpa_consumer_rights     — assistance with consumer requests (access / deletion / opt-out)
  ccpa_subcontractor_flowdown — service-provider obligations flow down to subcontractors
  ccpa_compliance_certification — certification of understanding & compliance

UK_GDPR (UK GDPR and Data Protection Act 2018) — applies when the contract \
involves personal data of people in the UK or a UK-established party:
  ukgdpr_processing_scope  — subject-matter, duration, nature & purpose of processing (Art. 28(3))
  ukgdpr_documented_instructions — processor acts only on documented controller instructions
  ukgdpr_security_measures — appropriate technical & organisational measures (Art. 32)
  ukgdpr_subprocessor_consent — prior authorisation for sub-processors + flow-down
  ukgdpr_breach_notification — personal data breach notice without undue delay
  ukgdpr_deletion_return   — delete or return personal data at end of services
  ukgdpr_audit_rights      — controller audit / inspection rights
  ukgdpr_international_transfers — restricted transfers covered (IDTA / UK Addendum to the SCCs / adequacy)

PCI_DSS (Payment Card Industry Data Security Standard) — applies when a \
party stores, processes or transmits payment card data:
  pci_compliance_maintained — service provider maintains PCI DSS compliance for the whole term
  pci_responsibility_for_cardholder_data — written acknowledgement of responsibility for the security of cardholder data (Req. 12.8.2)
  pci_attestation          — annual Attestation of Compliance (AOC) provided on request
  pci_breach_notification  — prompt notice of any compromise of cardholder data
  pci_responsibility_matrix — which PCI DSS requirements each party manages
  pci_return_destroy       — cardholder data returned or securely destroyed at end of term"""

_SYSTEM = f"""You are a regulatory compliance specialist reviewing a \
commercial contract. For each requested framework, first decide whether \
it APPLIES to this contract at all, then check the contract text against \
that framework's requirement catalog below. Findings MUST be evidenced \
by verbatim quotes from the text — never invent clause language.

Requirement catalogs:

{_FRAMEWORK_CATALOG}

Return ONLY this JSON shape:

{{
  "frameworks": [
    {{
      "framework": "GDPR|UK_GDPR|HIPAA|SOX|CCPA|PCI_DSS",
      "applicable": true|false,
      "applicabilityReason": "<one sentence — why this framework does or doesn't apply to THIS contract>",
      "status": "compliant|gaps|non_compliant|not_applicable",
      "score": 0-100,
      "checks": [
        {{
          "id": "<requirement id from the catalog, e.g. gdpr_breach_notification>",
          "requirement": "<short human-readable requirement name>",
          "status": "present|partial|missing|risky",
          "severity": "low|medium|high|critical",
          "finding": "<one sentence — what the contract says or fails to say>",
          "quote": "<verbatim excerpt ≤200 chars that grounds this finding, or null when status=missing>",
          "sectionRef": "<section ref like '9.2' or null>",
          "recommendation": "<one sentence — concrete fix, or null when status=present>"
        }}
      ]
    }}
  ],
  "overall": {{
    "status": "compliant|gaps|non_compliant|not_applicable",
    "summary": "<2-3 sentence executive summary of the compliance posture>",
    "criticalCount": <number of critical-severity findings across frameworks>
  }}
}}

Rules:
 • applicable=false → status="not_applicable", checks=[], score=100. Do \
NOT flag a pure commercial supply contract as a GDPR failure just because \
it lacks a DPA — explain non-applicability instead.
 • "partial" = clause exists but is weaker than the requirement (e.g. \
breach notice with no timeframe). "risky" = language actively conflicts \
with the requirement (e.g. unrestricted sub-processing).
 • severity reflects regulatory exposure: critical = likely violation \
with fine exposure; high = material gap; medium = weak/ambiguous; low = \
hygiene.
 • score per framework: 100 = all checks present; subtract proportionally \
to severity of gaps.
 • Check IDs must come from the catalog — do not invent new ones.
 • Keep every quote ≤200 chars and verbatim."""


class CheckComplianceRequest(BaseModel):
    plainText:    str
    contractType: str = "general commercial"
    frameworks:   list[str] | None = None  # default: assess all, gate by applicability
    jurisdiction: str | None = None
    orgId:        str | None = None  # Wave 3.5 — enables per-org BYOK key
    # docs/41 Part 9 — the API already decided these frameworks apply (from
    # facts and the org's policy): check the requirements, don't re-judge.
    applicabilityDecided: bool = False


@router.post("/check_compliance")
async def check_compliance(req: CheckComplianceRequest):
    text = (req.plainText or "").strip()
    if not text:
        return {
            "frameworks": [],
            "overall": {"status": "not_applicable", "summary": "Empty contract text — nothing to check.", "criticalCount": 0},
        }

    requested = [f for f in (req.frameworks or VALID_FRAMEWORKS) if f in VALID_FRAMEWORKS] or VALID_FRAMEWORKS

    # Resolve through the router so the org's own key (BYOK), its tier
    # override, and Langfuse callbacks all apply. No build_llm fallback — see
    # the note in obligations.py.
    resolved = await resolve_llm(
        "default",
        org_id=req.orgId,
        streaming=False,
        trace_name="compliance.check",
    )
    llm = resolved.llm
    callbacks = resolved.callbacks
    provider = resolved.provider
    model = resolved.model

    juris = f"\nGoverning law / jurisdiction: {req.jurisdiction}" if req.jurisdiction else ""
    decided = (
        "\nThese frameworks have already been determined to APPLY to this contract. "
        "Set applicable=true for each and check every requirement; do not re-judge applicability."
        if req.applicabilityDecided else ""
    )
    user = f"""Contract type: {req.contractType}{juris}
Frameworks to assess: {", ".join(requested)}{decided}

Contract text (truncated if very long):
\"\"\"
{text[:60000]}
\"\"\"

Run the compliance checks now. JSON only."""

    try:
        response = await llm.ainvoke(
            [
                SystemMessage(content=_SYSTEM),
                HumanMessage(content=user),
            ],
            config={"callbacks": callbacks} if callbacks else None,
        )
        content = response.content if isinstance(response.content, str) else str(response.content)
        content = content.strip()
        if content.startswith("```"):
            content = content.split("```", 2)[1]
            if content.startswith("json"):
                content = content[4:]
        parsed = loads_lenient(content)
        frameworks = _normalise_frameworks(parsed.get("frameworks") or [], requested, req.applicabilityDecided)
        overall = parsed.get("overall") or {}
        critical = sum(
            1
            for fw in frameworks
            for c in fw["checks"]
            if c["severity"] == "critical" and c["status"] in ("missing", "risky", "partial")
        )
        return {
            "frameworks": frameworks,
            "overall": {
                "status":        str(overall.get("status") or _rollup_status(frameworks)),
                "summary":       str(overall.get("summary") or ""),
                "criticalCount": critical,
            },
            "model":    model,
            "provider": provider,
        }
    except (json.JSONDecodeError, Exception) as e:  # noqa: BLE001
        logger.exception("[check_compliance] LLM call / parse failed")
        return {
            "frameworks": [],
            "overall": {"status": "unknown", "summary": "", "criticalCount": 0},
            "error": f"compliance_failed: {type(e).__name__}: {str(e)[:180]}",
        }


_CHECK_STATUSES = {"present", "partial", "missing", "risky"}
_SEVERITIES = {"low", "medium", "high", "critical"}
_FW_STATUSES = {"compliant", "gaps", "non_compliant", "not_applicable"}


def _normalise_frameworks(raw: list, requested: list[str], decided: bool = False) -> list[dict]:
    """Coerce LLM output to the expected keys + types so downstream code
    never has to defensive-check. `decided`: applicability was settled by
    the API, so a model's "not applicable" doesn't stand."""
    out: list[dict] = []
    for fw in raw:
        if not isinstance(fw, dict):
            continue
        name = str(fw.get("framework") or "").upper()
        if name not in requested:
            continue
        checks = []
        for c in (fw.get("checks") or [])[:20]:
            if not isinstance(c, dict):
                continue
            status = str(c.get("status") or "missing").lower()
            sev = str(c.get("severity") or "medium").lower()
            checks.append({
                "id":             str(c.get("id") or f"chk_{len(checks)}"),
                "requirement":    str(c.get("requirement") or "").strip()[:200],
                "status":         status if status in _CHECK_STATUSES else "missing",
                "severity":       sev if sev in _SEVERITIES else "medium",
                "finding":        str(c.get("finding") or "").strip()[:500],
                "quote":          (str(c.get("quote"))[:240] if c.get("quote") else None),
                "sectionRef":     (str(c.get("sectionRef")) if c.get("sectionRef") else None),
                "recommendation": (str(c.get("recommendation"))[:500] if c.get("recommendation") else None),
            })
        if decided:
            fw["applicable"] = True
        fw_status = str(fw.get("status") or "gaps").lower()
        if decided and fw_status == "not_applicable":
            fw_status = "gaps"
        try:
            score = max(0, min(100, int(fw.get("score", 0))))
        except (TypeError, ValueError):
            score = 0
        out.append({
            "framework":           name,
            "applicable":          bool(fw.get("applicable", True)),
            "applicabilityReason": str(fw.get("applicabilityReason") or "").strip()[:500],
            "status":              fw_status if fw_status in _FW_STATUSES else "gaps",
            "score":               score if fw.get("applicable", True) else 100,
            "checks":              checks,
        })
    return out


def _rollup_status(frameworks: list[dict]) -> str:
    applicable = [fw for fw in frameworks if fw["applicable"]]
    if not applicable:
        return "not_applicable"
    if any(fw["status"] == "non_compliant" for fw in applicable):
        return "non_compliant"
    if any(fw["status"] == "gaps" for fw in applicable):
        return "gaps"
    return "compliant"


# ─── /compliance/facts (docs/41 Part 9) ─────────────────────────────────────

# key → kind. Mirrors COMPLIANCE_FACT_KEYS in packages/types/src/compliance.ts.
FACT_KINDS: dict[str, str] = {
    "personal_data": "boolean",
    "personal_data_categories": "list",
    "data_subject_regions": "list",
    "health_data": "boolean",
    "hipaa_covered_entity": "boolean",
    "payment_card_data": "boolean",
    "financial_reporting_impact": "boolean",
    "public_company": "boolean",
    "party_jurisdictions": "list",
    "processing_role": "choice",
    "cross_border_transfer": "boolean",
    "industry": "choice",
}
_ROLES = {"controller", "processor", "joint", "none"}
MAX_FACT_QUOTE = 240
# A quote the text doesn't contain can't be trusted: its fact is kept, but
# below the API's threshold (0.6), so the user is asked instead.
UNGROUNDED_CONFIDENCE_CAP = 0.4

_FACTS_SYSTEM = """You read a commercial contract and report FACTS that decide \
which data-protection and financial regulations apply. You do NOT decide \
whether a regulation applies. Every fact you report as present must be \
backed by a verbatim quote from the text.

Facts (key: type — meaning):
  personal_data: boolean — will either party process information about identifiable people (employees, customers, end users, patients…) under this agreement? Contact details of the signatories alone do NOT count.
  personal_data_categories: list of short strings — e.g. ["employee data", "customer contact details"]
  data_subject_regions: list of codes — where the people whose data it is are. ISO 3166 alpha-2 country codes (DE, FR, GB, IN…), "EU" for the EU in general, "US-CA" for California residents, "US" for elsewhere in the US.
  health_data: boolean — health, medical or patient information (PHI)
  hipaa_covered_entity: boolean — is a party a US healthcare provider, health plan or clearinghouse, or acting as a business associate of one?
  payment_card_data: boolean — will a party store, process or transmit payment card numbers?
  financial_reporting_impact: boolean — does the agreement affect financial reporting, accounting records or internal financial controls (e.g. outsourced finance, billing systems, audit services)?
  public_company: boolean — is a party publicly listed (stock exchange, "NYSE", "Nasdaq", "listed company")?
  party_jurisdictions: list of codes — where the parties are incorporated or based (same codes as above)
  processing_role: one of controller | processor | joint | none — the role of the party providing the services with respect to personal data
  cross_border_transfer: boolean — will personal data be transferred between countries?
  industry: one short lowercase word — e.g. healthcare, finance, retail, technology, logistics, manufacturing

Return ONLY this JSON:
{"facts": [{"key": "<fact key>", "value": <boolean | list | string | null>, "quote": "<verbatim excerpt ≤240 chars, or null>", "confidence": 0.0-1.0}]}

Rules:
 • Report every key. Use value null when the text says nothing either way.
 • A true / non-empty value needs a verbatim quote. A false value may have quote null when the text is simply silent — then give confidence for how sure you are it is absent (a pure supply NDA with no data processing: personal_data false, confidence 0.8).
 • Never invent quotes. Copy them exactly, including punctuation."""


def _norm_ws(s: str) -> str:
    s = s.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    return re.sub(r"\s+", " ", s).strip().lower()


def _coerce_value(kind: str, raw):
    if raw is None:
        return None
    if kind == "boolean":
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, str) and raw.strip().lower() in ("true", "yes"):
            return True
        if isinstance(raw, str) and raw.strip().lower() in ("false", "no"):
            return False
        return None
    if kind == "list":
        items = raw if isinstance(raw, list) else [raw]
        out = []
        for item in items[:20]:
            if isinstance(item, str) and item.strip():
                out.append(item.strip()[:60])
        return out
    # choice
    if not isinstance(raw, str) or not raw.strip():
        return None
    return raw.strip().lower()[:40]


def parse_facts_response(content: str, text: str) -> list[dict]:
    """The model's facts, coerced to known keys and types, each quote checked
    against the contract text. Never raises on a malformed item: it is dropped."""
    parsed = loads_lenient(content)
    raw = parsed.get("facts") if isinstance(parsed, dict) else None
    haystack = _norm_ws(text)
    seen: set[str] = set()
    out: list[dict] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "")
        kind = FACT_KINDS.get(key)
        if not kind or key in seen:
            continue
        seen.add(key)
        value = _coerce_value(kind, item.get("value"))
        if key == "processing_role" and value not in _ROLES:
            value = None
        quote = item.get("quote")
        quote = str(quote).strip()[:MAX_FACT_QUOTE] if quote else None
        try:
            confidence = max(0.0, min(1.0, float(item.get("confidence", 0.5))))
        except (TypeError, ValueError):
            confidence = 0.5
        if quote and _norm_ws(quote) not in haystack:
            quote = None
            confidence = min(confidence, UNGROUNDED_CONFIDENCE_CAP)
        # A fact that something IS there needs its quote.
        if quote is None and (value is True or (isinstance(value, list) and value) or (kind == "choice" and value not in (None, "none"))):
            confidence = min(confidence, UNGROUNDED_CONFIDENCE_CAP)
        out.append({"key": key, "value": value, "quote": quote, "confidence": round(confidence, 3)})
    return out


class ComplianceFactsRequest(BaseModel):
    plainText:    str
    contractType: str = "general commercial"
    jurisdiction: str | None = None
    orgId:        str | None = None


@router.post("/compliance/facts")
async def compliance_facts(req: ComplianceFactsRequest):
    text = (req.plainText or "").strip()
    if not text:
        return {"facts": []}
    resolved = await resolve_llm(
        "fast",
        org_id=req.orgId,
        streaming=False,
        trace_name="compliance.facts",
    )
    juris = f"\nGoverning law / jurisdiction: {req.jurisdiction}" if req.jurisdiction else ""
    user = f"""Contract type: {req.contractType}{juris}

Contract text (truncated if very long):
\"\"\"
{text[:60000]}
\"\"\"

Report the facts now. JSON only."""
    try:
        response = await resolved.llm.ainvoke(
            [SystemMessage(content=_FACTS_SYSTEM), HumanMessage(content=user)],
            config={"callbacks": resolved.callbacks} if resolved.callbacks else None,
        )
        content = response.content if isinstance(response.content, str) else str(response.content)
        return {
            "facts":    parse_facts_response(content, text[:60000]),
            "model":    resolved.model,
            "provider": resolved.provider,
        }
    except Exception as e:  # noqa: BLE001
        logger.exception("[compliance_facts] LLM call / parse failed")
        return {"facts": [], "error": f"facts_failed: {type(e).__name__}: {str(e)[:180]}"}
