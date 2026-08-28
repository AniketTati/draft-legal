"""
Review Agent v3 — Phase 2.2
3-step pipeline:
  Step 1 — Extract Agent (Haiku/fast): segment + extract fields + custom fields + open-ended
  Step 2 — Validate Agent (Sonnet): cross-check values, normalise types, flag confidence
  Step 3 — Score & Classify Agent (Sonnet): risk score, contract type, summary

Changes from v2:
  - Chunked extraction for long docs (40K chars, 4K overlap, merge logic)
  - Dynamic custom field injection into extract prompt
  - Open-ended "extract anything else relevant" section
  - contract_type context injected for re-type flows
"""
from __future__ import annotations

import json
from ..jsonish import loads_lenient
import logging
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import StateGraph, END
from typing_extensions import TypedDict

from ..router import RouterRefusal, resolve_llm
from ..untrusted import wrap_untrusted_document

logger = logging.getLogger(__name__)


# ─── Prompts ─────────────────────────────────────────────────────────────────

_EXTRACT_PROMPT = """You are a contract data extraction specialist. Extract structured information from the contract text below.

Return ONLY valid JSON matching this exact schema — no markdown, no explanation:
{
  "clauseSegments": [
    {
      "clauseType": "<type from list below>",
      "content": "<verbatim clause text, max 800 chars — quote directly from the contract>",
      "interpretation": "<plain-English explanation in 1-2 sentences: what does this clause mean, what obligation does it create for each party>",
      "riskRating": "<favorable|unfavorable|neutral|unusual>",
      "sectionRef": "<e.g. Section 5.2 or Article III — null if not identifiable>",
      "sortOrder": <int starting at 0>
    }
  ],
  "rawFields": {
    "parties":            [{ "role": "<Client|Vendor|Licensor|etc>", "name": "<party name>", "quote": "<verbatim text where found>" }],
    "effectiveDate":      { "value": "<ISO date or null>", "quote": "<verbatim text or null>" },
    "expiryDate":         { "value": "<ISO date or null>", "quote": "<verbatim text or null>" },
    "value":              { "value": "<number as string or null>", "quote": "<verbatim text or null>" },
    "currency":           { "value": "<3-letter code or null>", "quote": "<verbatim text or null>" },
    "governingLaw":       { "value": "<jurisdiction string or null>", "quote": "<verbatim text or null>" },
    "noticePeriodDays":   { "value": "<integer as string or null>", "quote": "<verbatim text or null>" },
    "paymentTermsDays":   { "value": "<integer as string or null>", "quote": "<verbatim text or null>" },
    "autoRenew":          { "value": "<true|false|null>", "quote": "<verbatim text or null>" },
    "exclusivity":        { "value": "<true|false|null>", "quote": "<verbatim text or null>" },
    "liabilityCapAmount": { "value": "<amount as string or null>", "quote": "<verbatim text or null>" },
    "ipOwnership":        { "value": "<brief description or null>", "quote": "<verbatim text or null>" },
    "terminationRights":  { "value": "<brief description or null>", "quote": "<verbatim text or null>" },
    "confidentiality":    { "value": "<true|false|null>", "quote": "<verbatim text or null>" }
  },
  "clauseFlags": {
    "forceMajeure":          <true|false>,
    "mfn":                   <true|false>,
    "changeOfControl":       <true|false>,
    "auditRights":           <true|false>,
    "assignmentRestriction": <true|false>,
    "limitationOfLiability": <true|false>,
    "indemnification":       <true|false>,
    "warrantyDisclaimer":    <true|false>
  }
}

Clause types for clauseSegments (use the most specific type that applies):
  limitation_of_liability   — caps on total liability
  uncapped_liability        — provisions that exclude or override liability caps
  indemnification           — obligations to defend/compensate the other party
  liquidated_damages        — pre-agreed compensation amounts for specific breaches
  payment                   — payment obligations, amounts, timing, invoicing
  price_adjustment          — price escalation, CPI indexing, benchmarking, renegotiation rights
  minimum_commitment        — minimum purchase, revenue, or activity obligations
  volume_restriction        — caps on usage, quantity, or throughput
  ip_ownership              — ownership of intellectual property created under the contract
  ip_license_back           — license back to the licensor of improvements or derivatives
  license_grant             — scope of license granted (exclusive/non-exclusive, territory, field)
  joint_ip                  — jointly developed IP ownership and exploitation rights
  source_code_escrow        — escrow arrangements for source code access
  termination               — rights to terminate the contract and consequences
  post_termination_services — transition assistance, data return, wind-down obligations after termination
  confidentiality           — confidentiality and non-disclosure obligations
  confidential_info_definition — what information is and is not considered confidential
  non_compete               — restrictions on competing with the other party
  non_solicitation          — restrictions on soliciting employees or customers
  non_disparagement         — restrictions on making negative public statements
  covenant_not_to_sue       — agreement not to bring legal claims
  governing_law             — choice of governing law and jurisdiction
  dispute_resolution        — arbitration, mediation, or litigation procedures
  notice                    — how formal notices must be given (method, address, timing)
  auto_renewal              — automatic renewal provisions and opt-out requirements
  renewal_term              — renewal terms, conditions, and pricing
  exclusivity               — exclusive dealing or supply obligations
  warranty                  — representations and warranties about capabilities or condition
  warranty_duration         — explicit warranty period and post-warranty support terms
  representations_warranties — general reps and warranties about status, authority, compliance
  force_majeure             — relief from obligations due to unforeseeable events
  assignment                — restrictions on assigning the contract to a third party
  change_of_control         — rights triggered by ownership change of a party
  mfn                       — most favoured nation pricing or terms commitments
  audit_rights              — rights to audit records, compliance, or royalties
  rofr                      — right of first refusal, first offer, or first negotiation
  insurance                 — required insurance coverages and minimums
  acceptance                — acceptance criteria and procedures for deliverables
  data_protection           — data privacy, processing, and security obligations
  third_party_beneficiary   — rights granted to third parties not party to the contract
  general                   — important provisions not covered by any specific type above

Risk rating guidance:
  favorable   — benefits the uploading party: high liability caps, narrow indemnity, strong IP retention, long cure periods, easy termination rights
  unfavorable — burdens the uploading party: uncapped liability, broad indemnity, one-sided IP assignment, auto-renewal with short opt-out, short cure periods
  neutral     — standard boilerplate with balanced obligations
  unusual     — non-standard, unexpected, or bespoke clause for this contract type

IMPORTANT: Extract ALL significant clauses — do not limit to one per type. A contract may have multiple termination provisions (for cause, for convenience), multiple payment clauses, etc. Extract each as a separate entry.

CONTRACT TEXT:"""

_VALIDATE_PROMPT = """You are a contract validation specialist. You will receive extracted contract fields with source quotes.
Your job is to cross-check each extracted value against its quoted source text, normalise types, and assign confidence scores.

Return ONLY valid JSON — no markdown, no explanation:
{
  "validatedFields": {
    "<fieldName>": {
      "value": <correctly typed value or null>,
      "confidence": <0.0-1.0>,
      "section": "<e.g. Section 5.2 or null>",
      "quote": "<verbatim source text or null>",
      "issue": "<describe problem if confidence < 0.7, else null>"
    }
  }
}

Rules:
- Dates → ISO 8601 string (YYYY-MM-DD) or null
- Numbers (value, noticePeriodDays, paymentTermsDays, liabilityCapAmount) → actual number or null. Never keep as string.
- Booleans (autoRenew, exclusivity, confidentiality) → true, false, or null. Never keep as string.
- confidence 0.9+ = value clearly stated in quote; 0.7-0.9 = reasonable inference; <0.7 = uncertain, flag for human review
- If value is null because field genuinely not present, confidence = 1.0 (certain absence)
- parties[] → validate each party has both role and name; confidence = avg of all party extractions

Fields to validate:
"""

_SCORE_PROMPT = """You are a contract risk and classification specialist. Based on the validated contract fields, produce the final analysis.

Return ONLY valid JSON — no markdown, no explanation:
{
  "contractType": "<NDA|MSA|SOW|SLA|VENDOR_AGREEMENT|EMPLOYMENT|PARTNERSHIP|LICENSE|DATA_PROCESSING|ORDER_FORM|OTHER>",
  "suggestedTitle": "<concise human-readable title, e.g. 'India Post Payments Bank – Service Provider MSA' or 'Bravetek Solutions Reseller Agreement'. Max 80 chars. Use party names + contract type.>",
  "summary": "<2-3 sentence plain-English summary of what this contract does, who the parties are, and key terms>",
  "riskScore": <float 0.0-1.0, where 1.0 is highest risk>,
  "riskFactors": ["<brief risk factor>"],
  "overallConfidence": <float 0.0-1.0, average confidence across all extracted fields>
}

─── How to classify contractType ────────────────────────────────────────
Pick the MOST SPECIFIC type that fits. "OTHER" is a last resort — only use
it when none of the specific types apply. Look at the contract's PURPOSE,
not just its title. Use this decision tree:

NDA              — Purpose is SOLELY confidentiality obligations between parties
                   before/around a potential deal. No commercial exchange or
                   service delivery. Typical fields: term, mutual/unilateral,
                   permitted use, liquidated damages.

MSA              — A FRAMEWORK agreement. Governs multiple future engagements
                   (SOWs/Orders). Has general T&Cs (IP, liability, confidentiality,
                   termination, insurance) but no specific deliverables or
                   project scope. Title often includes "Master" / "Framework" /
                   "Master Services Agreement". Prefer MSA over OTHER when the
                   body clearly talks about "SOWs", "change orders", "future
                   engagements", or sets up rules for multiple projects.

SOW              — Tied to a SPECIFIC project with milestones, deliverables,
                   and a fixed fee or T&M cap. Often references a parent MSA.
                   Has dates, phases, named team. Treat multi-milestone
                   consulting engagements as SOW even when labelled
                   "Consulting Agreement" if milestones + deliverables exist.

SLA              — Service levels: uptime % + response/resolution times +
                   service credits. Usually attached to an MSA or Order Form.

VENDOR_AGREEMENT — Ongoing vendor-provided services with a subscription /
                   monthly fee and no specific project (cloud hosting, managed
                   services, data feeds). Different from MSA in that it's
                   SINGLE-SCOPE — there's one thing being delivered
                   repeatedly, not a framework for future projects.

EMPLOYMENT       — Individual PERSON as one party; includes base salary,
                   benefits, role description, at-will/termination terms.

PARTNERSHIP      — Two organizations jointly pursuing a venture: revenue share,
                   joint product development, co-marketing, exclusivity.
                   Prefer PARTNERSHIP over OTHER when there's an explicit
                   "Partners" relationship + mutual contributions.

LICENSE          — Grants usage rights to software, content, or IP in
                   exchange for fees. Has usage restrictions, reverse-
                   engineering prohibition, license scope (users / seats).

DATA_PROCESSING  — A DPA supplementing another agreement. Governs Controller/
                   Processor handling of personal data (GDPR/CCPA). References
                   SCCs, breach notification, sub-processors.

ORDER_FORM       — A specific subscription purchase under a master. Has seat
                   counts, term, total contract value, start/end dates. Often
                   references a governing MSA/MSSA.

OTHER            — Only when NO specific type fits. Examples: amendments (rare
                   — classify under the underlying agreement if clear),
                   settlement agreements, letters of intent, term sheets.

─── Risk factors ────────────────────────────────────────────────────────
Risk factors to consider: unlimited liability, no liability cap, broad
indemnification, IP assignment to counterparty, auto-renewal with short
opt-out window, long notice period, no audit rights, restrictive assignment,
MFN obligations.

Validated fields:
"""


# ─── State ───────────────────────────────────────────────────────────────────

class ReviewState(TypedDict):
    plain_text:       str
    contract_type:    str | None    # user-corrected type — injected into extract prompt
    custom_fields:    list[dict]    # org-defined fields to extract
    org_id:           str | None    # routes LLM calls through the org's BYOK / overrides
    # Step 1 output
    clause_segments:  list[dict]
    raw_fields:       dict
    clause_flags:     dict
    custom_extracted: dict          # { customFields: {...}, openEndedFindings: [...] }
    # Step 2 output
    validated_fields: dict
    # Step 3 output
    contract_type_out: str
    suggested_title:  str
    summary:          str
    risk_score:       float | None
    risk_factors:     list[str]
    overall_confidence: float
    # Error tracking
    error: str | None


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _parse_json(content: str) -> dict:
    content = content.strip()
    if content.startswith("```"):
        lines = content.split("\n")
        content = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    return loads_lenient(content)


def _clamp_risk(val: Any) -> float | None:
    if val is None:
        return None
    try:
        return max(0.0, min(1.0, float(val)))
    except (TypeError, ValueError):
        return None


_VALID_TYPES = {"NDA","MSA","SOW","SLA","VENDOR_AGREEMENT","EMPLOYMENT","PARTNERSHIP","LICENSE","DATA_PROCESSING","ORDER_FORM","OTHER"}

# ─── Type-Specific Extraction Schemas ────────────────────────────────────────
# Each entry: { key, label, type (text|number|boolean|select), hint }
# These are injected into the extraction prompt when the contract type is known.

TYPE_SCHEMAS: dict[str, list[dict]] = {

    "NDA": [
        {"key": "mutual",                  "label": "Mutual / Bilateral",                  "type": "boolean", "hint": "Is this a mutual (bilateral) NDA or one-way (unilateral)? Both parties bound = true."},
        {"key": "permitted_use",           "label": "Permitted Use",                       "type": "text",    "hint": "What specific purposes can the confidential information be used for?"},
        {"key": "carve_outs",              "label": "Confidentiality Carve-Outs",          "type": "text",    "hint": "What information is explicitly excluded from confidentiality obligations (public domain, independently developed, required by law, etc.)?"},
        {"key": "residual_clause",         "label": "Residual Knowledge Clause",           "type": "boolean", "hint": "Can the receiving party use knowledge retained in unaided memory (residuals) without restriction?"},
        {"key": "non_compete",             "label": "Non-Compete Restriction",             "type": "boolean", "hint": "Does the agreement include any non-competition obligations?"},
        {"key": "non_solicitation",        "label": "Non-Solicitation",                    "type": "boolean", "hint": "Does the agreement restrict soliciting or recruiting the other party's employees or customers?"},
        {"key": "return_of_information",   "label": "Return / Destruction of Information", "type": "boolean", "hint": "Must confidential information be returned or destroyed upon request or at contract termination?"},
        {"key": "injunctive_relief",       "label": "Injunctive Relief Available",         "type": "boolean", "hint": "Is equitable or injunctive relief explicitly available without bond or posting security?"},
        {"key": "standard_basis",          "label": "Agreement Basis / Standard Form",     "type": "text",    "hint": "Is this based on a recognised standard form (e.g. MNDA, BVCA, NVCA, or bespoke)?"},
    ],

    "MSA": [
        {"key": "sow_execution_process",   "label": "SOW Execution Process",              "type": "text",    "hint": "How are Statements of Work or project orders formally executed under this MSA?"},
        {"key": "change_order_process",    "label": "Change Order Process",               "type": "text",    "hint": "How are changes to agreed scope requested, approved, and priced?"},
        {"key": "warranty_period_days",    "label": "Warranty Period (Days)",             "type": "number",  "hint": "Length of warranty on delivered services, software, or deliverables in days."},
        {"key": "dispute_resolution",      "label": "Dispute Resolution Mechanism",       "type": "text",    "hint": "Is the primary dispute resolution mechanism arbitration, litigation, mediation, or expert determination?"},
        {"key": "acceptance_process",      "label": "Acceptance Process",                 "type": "text",    "hint": "How are deliverables formally accepted or rejected? Is there a deemed acceptance provision?"},
        {"key": "step_in_rights",          "label": "Step-In Rights",                     "type": "boolean", "hint": "Can the client take over service delivery themselves or appoint a third party if the vendor fails?"},
        {"key": "key_personnel",           "label": "Key Personnel Requirement",          "type": "text",    "hint": "Are specific named individuals required on the engagement? What approval is needed to replace them?"},
        {"key": "benchmarking_rights",     "label": "Benchmarking Rights",                "type": "boolean", "hint": "Can the client benchmark the vendor's pricing against comparable market rates?"},
        {"key": "source_code_escrow",      "label": "Source Code Escrow",                 "type": "boolean", "hint": "Is software source code placed in escrow with a third party for client access if vendor fails?"},
        {"key": "most_favored_nation",     "label": "Most Favoured Nation (MFN)",         "type": "boolean", "hint": "Does the vendor commit to pricing no worse than offered to any other client?"},
        {"key": "data_portability",        "label": "Data Portability on Exit",           "type": "text",    "hint": "How does the client extract and migrate their data at the end of the contract?"},
    ],

    "SOW": [
        {"key": "deliverables",            "label": "Deliverables",                       "type": "text",    "hint": "Specific work products, outputs, or artefacts to be delivered."},
        {"key": "milestones",              "label": "Milestones & Target Dates",          "type": "text",    "hint": "Key project milestones and their target completion dates."},
        {"key": "acceptance_criteria",     "label": "Acceptance Criteria",                "type": "text",    "hint": "Objective criteria used to determine whether deliverables meet requirements."},
        {"key": "payment_model",           "label": "Payment Model",                      "type": "text",    "hint": "Is payment fixed fee, milestone-based, time & materials, retainer, or capped T&M?"},
        {"key": "change_control",          "label": "Change Control Process",             "type": "text",    "hint": "How are scope changes formally requested, evaluated, and authorised?"},
        {"key": "project_manager",         "label": "Named Project Manager",              "type": "text",    "hint": "Named project manager or primary point of contact for delivery."},
        {"key": "work_location",           "label": "Work Location",                      "type": "text",    "hint": "Is work delivered on-site, remotely, or hybrid?"},
        {"key": "travel_expenses",         "label": "Travel Expenses Reimbursable",       "type": "boolean", "hint": "Are contractor travel and expenses reimbursable on top of fees?"},
        {"key": "assumptions",             "label": "Key Assumptions",                    "type": "text",    "hint": "Stated assumptions the SOW is predicated on — if wrong, scope or price may change."},
        {"key": "out_of_scope",            "label": "Out of Scope",                       "type": "text",    "hint": "Items explicitly excluded from this Statement of Work."},
        {"key": "governing_msa",           "label": "Governing MSA / Framework",         "type": "text",    "hint": "Reference to the master agreement or framework contract this SOW sits under."},
    ],

    "SLA": [
        {"key": "uptime_percentage",           "label": "Target Uptime (%)",                    "type": "number",  "hint": "Committed availability target as a percentage, e.g. 99.9 or 99.95."},
        {"key": "response_time_hours",         "label": "P1 Incident Response Time (Hours)",    "type": "number",  "hint": "Maximum time to acknowledge a critical / Priority 1 incident."},
        {"key": "resolution_time_hours",       "label": "P1 Incident Resolution Time (Hours)",  "type": "number",  "hint": "Maximum time to resolve / restore service after a critical incident."},
        {"key": "measurement_period",          "label": "Measurement Period",                   "type": "text",    "hint": "How SLA performance is measured and reported — monthly, quarterly, rolling 12 months?"},
        {"key": "maintenance_exclusions",      "label": "Planned Maintenance Exclusions",       "type": "text",    "hint": "Scheduled maintenance windows excluded from uptime calculations and SLA obligations."},
        {"key": "credit_formula",              "label": "Service Credit Formula",               "type": "text",    "hint": "How service credits are calculated for SLA breaches — percentage of monthly fees, sliding scale, etc."},
        {"key": "max_credit_percentage",       "label": "Maximum Credit Cap (%)",               "type": "number",  "hint": "Cap on total service credits payable as a percentage of monthly or annual fees."},
        {"key": "reporting_frequency",         "label": "SLA Reporting Frequency",              "type": "text",    "hint": "How often SLA performance data and reports are provided to the client."},
        {"key": "escalation_procedure",        "label": "Escalation Procedure",                 "type": "text",    "hint": "Escalation path and timelines for unresolved or repeated SLA failures."},
        {"key": "remediation_plan_required",   "label": "Remediation Plan Required",            "type": "boolean", "hint": "Must the vendor produce a remediation plan following repeated SLA failures?"},
        {"key": "termination_for_sla_failure", "label": "Termination Right for SLA Failure",    "type": "text",    "hint": "Under what SLA failure conditions (frequency, severity, credit cap) does the client have termination rights?"},
    ],

    "EMPLOYMENT": [
        {"key": "job_title",                      "label": "Job Title / Role",                    "type": "text",    "hint": "Official position title and reporting line."},
        {"key": "base_salary",                    "label": "Base Salary",                         "type": "number",  "hint": "Annual base compensation (numeric value only)."},
        {"key": "salary_currency",                "label": "Salary Currency",                     "type": "text",    "hint": "Currency of base salary, e.g. USD, GBP, EUR."},
        {"key": "employment_type",                "label": "Employment Type",                     "type": "text",    "hint": "Full-time, part-time, fixed-term contract, or zero-hours?"},
        {"key": "at_will",                        "label": "At-Will Employment",                  "type": "boolean", "hint": "Can either party terminate employment without cause and without notice beyond the minimum legal requirement?"},
        {"key": "probation_period_days",          "label": "Probation Period (Days)",             "type": "number",  "hint": "Length of the initial probationary period in days."},
        {"key": "bonus_structure",                "label": "Bonus / Commission Structure",        "type": "text",    "hint": "Target bonus percentage, commission plan, or performance-related pay structure."},
        {"key": "equity_grant",                   "label": "Equity / Stock Option Grant",        "type": "text",    "hint": "Share options, RSUs, phantom equity, or equity percentage offered."},
        {"key": "vesting_schedule",               "label": "Vesting Schedule",                    "type": "text",    "hint": "Equity vesting cliff and schedule, e.g. 4-year vest with 1-year cliff."},
        {"key": "non_compete_duration_months",    "label": "Non-Compete Duration (Months)",       "type": "number",  "hint": "Post-termination period during which the employee is restricted from competing."},
        {"key": "non_solicitation_duration_months","label": "Non-Solicitation Duration (Months)", "type": "number",  "hint": "Post-termination period restricting solicitation of employees or customers."},
        {"key": "severance_months",               "label": "Severance Pay (Months of Salary)",   "type": "number",  "hint": "Months of base salary payable on termination without cause."},
        {"key": "garden_leave",                   "label": "Garden Leave",                        "type": "boolean", "hint": "Is the employee placed on paid garden leave during their notice period?"},
        {"key": "ip_assignment",                  "label": "IP Assignment to Employer",           "type": "boolean", "hint": "Does the employee assign all work-related intellectual property to the employer?"},
        {"key": "remote_work_permitted",          "label": "Remote / Hybrid Work Permitted",      "type": "boolean", "hint": "Is the employee authorised to work remotely or on a hybrid basis?"},
        {"key": "relocation_required",            "label": "Relocation Required",                 "type": "boolean", "hint": "Is the employee required to relocate as a condition of employment?"},
    ],

    "VENDOR_AGREEMENT": [
        {"key": "payment_method",              "label": "Payment Method",                     "type": "text",    "hint": "How the vendor is paid — wire transfer, ACH, SWIFT, check, or platform payment."},
        {"key": "delivery_terms",              "label": "Delivery Terms (Incoterms)",         "type": "text",    "hint": "Incoterms or specific delivery conditions — FOB, DDP, CIF, DAP, Ex Works, etc."},
        {"key": "warranty_duration_days",      "label": "Warranty Duration (Days)",           "type": "number",  "hint": "Length of product or service warranty in days."},
        {"key": "return_policy",               "label": "Return & Refund Policy",             "type": "text",    "hint": "Conditions and process for returns, replacements, or refunds."},
        {"key": "quality_standards",           "label": "Quality Standards & Certifications", "type": "text",    "hint": "Required quality certifications (ISO 9001, SOC 2, etc.) or standards the vendor must meet."},
        {"key": "vendor_insurance_required",   "label": "Vendor Insurance Required",          "type": "boolean", "hint": "Is the vendor required to maintain specific insurance coverages?"},
        {"key": "minimum_insurance_coverage",  "label": "Minimum Insurance Coverage",         "type": "text",    "hint": "Required insurance types and minimum coverage amounts (e.g. $5M general liability, $2M E&O)."},
        {"key": "subcontracting_permitted",    "label": "Subcontracting Permitted",           "type": "boolean", "hint": "Can the vendor subcontract any part of the work to third parties?"},
        {"key": "background_check_required",   "label": "Background Checks Required",         "type": "boolean", "hint": "Must vendor personnel undergo background or security screening?"},
        {"key": "volume_discount",             "label": "Volume Discount Tiers",              "type": "text",    "hint": "Volume-based pricing tiers or discount schedule."},
        {"key": "minimum_purchase_commitment", "label": "Minimum Purchase Commitment",        "type": "number",  "hint": "Minimum annual or total contractual purchase obligation."},
        {"key": "price_adjustment_mechanism",  "label": "Price Adjustment Mechanism",         "type": "text",    "hint": "How and when prices can be adjusted — CPI indexation, annual review, benchmarking."},
        {"key": "preferred_supplier_status",   "label": "Preferred / Sole Supplier Status",   "type": "boolean", "hint": "Is this a preferred, approved, or sole-source supplier arrangement?"},
    ],

    "PARTNERSHIP": [
        {"key": "partnership_type",         "label": "Partnership Type",                    "type": "text",    "hint": "Joint venture, strategic alliance, reseller, referral, co-development, or distribution?"},
        {"key": "revenue_split",            "label": "Revenue / Profit Split",             "type": "text",    "hint": "How revenue, gross profit, or net profit is divided between the parties."},
        {"key": "capital_contributions",    "label": "Capital Contributions",              "type": "text",    "hint": "What each party contributes — cash, IP, technology, sales channels, customers, resources."},
        {"key": "decision_making",          "label": "Decision-Making Authority",          "type": "text",    "hint": "Unanimous consent, majority vote, designated lead party, or steering committee?"},
        {"key": "territory",                "label": "Territory / Market Scope",           "type": "text",    "hint": "Geographic regions or market segments covered by this partnership."},
        {"key": "exclusivity",              "label": "Exclusivity",                        "type": "boolean", "hint": "Is either party restricted from working with competitors or entering similar arrangements?"},
        {"key": "branding_rights",          "label": "Co-Branding Rights",                "type": "text",    "hint": "Rights and restrictions on using each other's logos, trademarks, and brand identity."},
        {"key": "jointly_developed_ip",     "label": "Jointly Developed IP Ownership",    "type": "text",    "hint": "Who owns intellectual property created in the course of the partnership?"},
        {"key": "exit_mechanism",           "label": "Exit Mechanism",                     "type": "text",    "hint": "How a party can exit the partnership, buy out the other, or dissolve the arrangement."},
        {"key": "non_compete",              "label": "Non-Compete Between Partners",       "type": "boolean", "hint": "Are partners restricted from competing with each other during or after the partnership?"},
        {"key": "governance_structure",     "label": "Governance Structure",               "type": "text",    "hint": "Steering committee, joint board, or other governance body — membership and voting rules."},
        {"key": "minimum_commitment",       "label": "Minimum Activity Commitment",        "type": "text",    "hint": "Minimum sales targets, referral volumes, marketing spend, or other performance commitments."},
    ],

    "LICENSE": [
        {"key": "license_type",          "label": "License Type",                      "type": "text",    "hint": "Exclusive, non-exclusive, sole, or co-exclusive?"},
        {"key": "license_duration",      "label": "License Duration",                  "type": "text",    "hint": "Perpetual, fixed-term, or subscription-based? Include renewal terms if any."},
        {"key": "territory",             "label": "Licensed Territory",                "type": "text",    "hint": "Geographic scope — worldwide, specific countries, or regions."},
        {"key": "permitted_uses",        "label": "Permitted Uses",                    "type": "text",    "hint": "What the licensee is specifically authorised to do with the licensed IP."},
        {"key": "field_of_use",          "label": "Field of Use Restriction",          "type": "text",    "hint": "Industry, application domain, or sector the license is restricted to."},
        {"key": "sublicensing_allowed",  "label": "Sublicensing Permitted",            "type": "boolean", "hint": "Can the licensee grant sublicenses to third parties?"},
        {"key": "royalty_structure",     "label": "Royalty Structure",                 "type": "text",    "hint": "Royalty rate, basis (% of revenue, per unit, per use, flat fee), and payment frequency."},
        {"key": "minimum_royalty",       "label": "Minimum Annual Royalty",            "type": "number",  "hint": "Minimum royalty payment per year regardless of actual usage or revenue."},
        {"key": "source_code_included",  "label": "Source Code Access",               "type": "boolean", "hint": "Does the license include access to source code?"},
        {"key": "modification_rights",   "label": "Modification / Derivative Works",  "type": "boolean", "hint": "Can the licensee modify the IP or create derivative works?"},
        {"key": "audit_rights",          "label": "Royalty Audit Rights",              "type": "boolean", "hint": "Can the licensor audit the licensee's records to verify royalty calculations?"},
        {"key": "reversion_rights",      "label": "Reversion of Rights",              "type": "text",    "hint": "Under what conditions (e.g. non-use, breach, insolvency) do rights revert to the licensor?"},
        {"key": "improvements_ownership","label": "Improvements Ownership",            "type": "text",    "hint": "Who owns improvements or enhancements made to the licensed technology?"},
    ],

    "DATA_PROCESSING": [
        {"key": "data_controller",             "label": "Data Controller",                        "type": "text",    "hint": "Name and role of the entity acting as data controller."},
        {"key": "data_processor",              "label": "Data Processor",                         "type": "text",    "hint": "Name and role of the entity acting as data processor."},
        {"key": "processing_purposes",         "label": "Processing Purposes & Legal Basis",      "type": "text",    "hint": "Specific lawful purposes for which personal data is processed and the legal basis (consent, contract, legitimate interest, etc.)."},
        {"key": "personal_data_categories",    "label": "Categories of Personal Data",            "type": "text",    "hint": "Types of personal data being processed — names, emails, financial, health, biometric, etc."},
        {"key": "data_subjects",               "label": "Data Subjects",                          "type": "text",    "hint": "Categories of individuals whose data is processed — employees, customers, prospects, etc."},
        {"key": "retention_period",            "label": "Data Retention Period",                  "type": "text",    "hint": "How long personal data is retained and the deletion or anonymisation process at end of retention."},
        {"key": "sub_processors_permitted",    "label": "Sub-Processors Permitted",               "type": "boolean", "hint": "Can the processor engage sub-processors? Is prior written consent required from the controller?"},
        {"key": "transfer_mechanism",          "label": "International Transfer Mechanism",       "type": "text",    "hint": "Mechanism for cross-border data transfers — SCCs, adequacy decision, BCRs, derogations."},
        {"key": "security_measures",           "label": "Required Security Measures",             "type": "text",    "hint": "Specific technical and organisational security measures the processor must implement."},
        {"key": "breach_notification_hours",   "label": "Breach Notification Deadline (Hours)",   "type": "number",  "hint": "Maximum hours within which the processor must notify the controller of a personal data breach."},
        {"key": "dpia_required",               "label": "DPIA Required",                          "type": "boolean", "hint": "Is a Data Protection Impact Assessment required before or during processing?"},
        {"key": "applicable_regulation",       "label": "Applicable Privacy Regulation",          "type": "text",    "hint": "Primary privacy regulation governing this agreement — GDPR, CCPA, LGPD, PIPEDA, etc."},
        {"key": "deletion_on_termination",     "label": "Data Deletion on Termination",           "type": "text",    "hint": "How and within what timeframe personal data is deleted or returned to the controller at contract end."},
    ],

    "ORDER_FORM": [
        {"key": "order_number",          "label": "Order / PO Reference Number",   "type": "text",   "hint": "Purchase order or sales order reference number."},
        {"key": "products_or_services",  "label": "Products / Services Ordered",   "type": "text",   "hint": "Specific items, SKUs, or services being procured."},
        {"key": "quantity",              "label": "Quantity / Licences",            "type": "number", "hint": "Number of units, seats, or licences ordered."},
        {"key": "unit_price",            "label": "Unit / Seat Price",              "type": "number", "hint": "Price per unit, seat, or licence."},
        {"key": "total_order_value",     "label": "Total Order Value",              "type": "number", "hint": "Aggregate value of this order before tax."},
        {"key": "delivery_date",         "label": "Expected Delivery Date",         "type": "text",   "hint": "When products should be delivered or services go live."},
        {"key": "payment_due_date",      "label": "Payment Due Date",               "type": "text",   "hint": "Date by which payment must be received."},
        {"key": "shipping_method",       "label": "Shipping / Delivery Method",     "type": "text",   "hint": "How goods are transported — courier, freight, digital download, or provisioned access."},
        {"key": "billing_contact",       "label": "Billing / AP Contact",           "type": "text",   "hint": "Accounts payable contact name or email for invoicing."},
        {"key": "discount_applied",      "label": "Discounts Applied",              "type": "text",   "hint": "Any negotiated discounts, promotional codes, or credits reflected in pricing."},
        {"key": "governing_agreement",   "label": "Governing Agreement / Terms",    "type": "text",   "hint": "Master agreement, framework, or standard terms this order is subject to."},
    ],
}

# P-fix #1 (2026-05-02). Long-context summarization. Modern smart-tier
# models (gpt-4o, claude-sonnet-4-6, gemini-1.5-pro) all comfortably
# handle 100K+ token context windows. The previous 40K-char chunk
# (~10K tokens) was a 2023-era safety setting that forced ~80% of
# real MSAs into 2-4 chunks and lost cross-clause patterns in the
# merge. 120K chars (~30K tokens) keeps headroom on cheaper fast-tier
# models too while unifying most contracts into a single chunk.
_CHUNK_SIZE = 120_000   # chars per extraction chunk (~30K tokens)
_CHUNK_OVERLAP = 6_000  # 5% overlap to avoid missing clauses at boundaries


def _chunk_text(text: str) -> list[str]:
    """Split text into overlapping windows for long-doc extraction."""
    if len(text) <= _CHUNK_SIZE:
        return [text]
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + _CHUNK_SIZE, len(text))
        chunks.append(text[start:end])
        if end >= len(text):
            break
        start = end - _CHUNK_OVERLAP
    return chunks


def _merge_raw_fields(base: dict, new: dict) -> dict:
    """Merge two rawFields dicts: prefer first non-null value per field. Concatenate parties."""
    merged = dict(base)
    for key, val in new.items():
        if key == "parties":
            # Merge party lists, deduplicate by name
            existing_names = {p.get("name") for p in (merged.get("parties") or []) if isinstance(p, dict)}
            new_parties = [p for p in (val or []) if isinstance(p, dict) and p.get("name") not in existing_names]
            merged["parties"] = (merged.get("parties") or []) + new_parties
        elif key not in merged or merged[key] is None:
            merged[key] = val
        elif isinstance(merged[key], dict) and merged[key].get("value") is None and isinstance(val, dict):
            merged[key] = val
    return merged


def _dedupe_segments(segments: list[dict]) -> list[dict]:
    """Deduplicate by content fingerprint to remove duplicates from overlapping chunks,
    but allow multiple distinct clauses of the same type (e.g. termination for cause +
    termination for convenience are both kept)."""
    seen: set[str] = set()
    result = []
    for seg in segments:
        # Fingerprint = first 120 chars stripped — catches same clause extracted from overlapping windows
        fp = seg.get("content", "")[:120].strip().lower()
        if fp and fp not in seen:
            seen.add(fp)
            result.append(seg)
    # Re-assign sortOrder sequentially
    result.sort(key=lambda s: s.get("sortOrder", 0))
    for i, seg in enumerate(result):
        seg["sortOrder"] = i
    return result


def _merge_clause_flags(base: dict, new: dict) -> dict:
    """OR clause flags: presence in any chunk counts."""
    merged = dict(base)
    for key, val in new.items():
        if val is True:
            merged[key] = True
        elif key not in merged:
            merged[key] = val
    return merged


def _build_custom_fields_prompt(custom_fields: list[dict], contract_type: str | None) -> str:
    """Build the dynamic section appended to _EXTRACT_PROMPT."""
    lines = []

    if contract_type:
        lines.append(
            f"\nNOTE: This is a {contract_type} contract. "
            "Focus your extraction on terms and clauses most relevant to this contract type."
        )

    # Inject contract-type-specific fields when a known type is set
    type_schema = TYPE_SCHEMAS.get(contract_type or "", [])
    if type_schema:
        lines.append(
            f"\nCONTRACT-TYPE-SPECIFIC FIELDS: Extract the following fields that are standard "
            f"for a {contract_type} contract. Add a top-level \"typeFields\" key to your JSON response:"
        )
        lines.append(json.dumps(type_schema, indent=2))
        lines.append(
            'For each type-specific field return: { "value": <extracted value matching the type, or null>, '
            '"confidence": <0.0-1.0>, "quote": "<verbatim source text or null>" }'
        )

    if custom_fields:
        lines.append(
            "\nORGANISATION-SPECIFIC FIELDS: Additionally extract the following org-defined fields. "
            "Add a top-level \"customFields\" key to your JSON response:"
        )
        field_specs = [
            {
                "key":     f["fieldKey"],
                "label":   f["fieldLabel"],
                "type":    f["fieldType"],
                "options": f.get("options", []),
                "hint":    f.get("helpText") or "",
            }
            for f in custom_fields
        ]
        lines.append(json.dumps(field_specs, indent=2))
        lines.append(
            'For each custom field return: { "value": <extracted value matching the type, or null>, '
            '"confidence": <0.0-1.0>, "quote": "<verbatim source text or null>" }'
        )

    lines.append("""
OPEN-ENDED: Also extract an "openEndedFindings" array for any other legally significant terms
not covered by the schemas above (e.g. unusual penalties, bespoke triggers, non-standard carve-outs).
Each entry: { "key": "<snake_case_name>", "label": "<human readable>", "value": <value>, "confidence": <0.0-1.0>, "quote": "<verbatim text>" }
""")

    return "\n".join(lines)


# ─── Graph nodes ─────────────────────────────────────────────────────────────

async def _extract(state: ReviewState) -> ReviewState:
    """Step 1: extraction with source quotes. Chunked for long docs."""
    text   = state["plain_text"]
    chunks = _chunk_text(text)

    extra_prompt = _build_custom_fields_prompt(state["custom_fields"], state["contract_type"])

    resolved = await resolve_llm(
        "default",
        org_id=state.get("org_id"),
        streaming=True,
        trace_name="review.extract",
    )
    llm = resolved.llm

    logger.info("[extract] provider=%s model=%s total_chars=%d chunks=%d",
                resolved.provider, resolved.model, len(text), len(chunks))

    all_segments:  list[dict] = []
    merged_fields: dict       = {}
    merged_flags:  dict       = {}
    merged_custom: dict       = {}
    merged_type:   dict       = {}
    open_ended:    list[dict] = []

    for i, chunk in enumerate(chunks):
        logger.info("[extract] chunk %d/%d chars=%d", i + 1, len(chunks), len(chunk))
        try:
            resp = await llm.ainvoke(
                [
                    SystemMessage(content=_EXTRACT_PROMPT + extra_prompt),
                    # The chunk is counterparty-authored text. Frame it as data
                    # so instructions inside the contract cannot steer extraction.
                    HumanMessage(content=wrap_untrusted_document(
                        chunk,
                        source=f"counterparty contract body (chunk {i + 1} of {len(chunks)})",
                    )),
                ],
                config={"callbacks": resolved.callbacks},
            )
            data = _parse_json(resp.content)
            # LLM-variance hardening (2026-06-10 review): models sometimes
            # wrap the object in a one-element array, or emit a LIST for a
            # dict-shaped key — a truthy list defeats `or {}` and `.items()`
            # crashes the whole chunk. Coerce instead of crashing.
            if isinstance(data, list):
                data = next((d for d in data if isinstance(d, dict)), {})
            if not isinstance(data, dict):
                raise ValueError(f"extract returned non-object JSON: {type(data).__name__}")
            _dict = lambda v: v if isinstance(v, dict) else {}   # noqa: E731
            _list = lambda v: v if isinstance(v, list) else []   # noqa: E731

            all_segments  = all_segments + _list(data.get("clauseSegments"))
            merged_fields = _merge_raw_fields(merged_fields, _dict(data.get("rawFields")))
            merged_flags  = _merge_clause_flags(merged_flags, _dict(data.get("clauseFlags")))

            # Merge contract-type-specific fields (prefer first non-null)
            for k, v in _dict(data.get("typeFields")).items():
                if k not in merged_type or (isinstance(merged_type[k], dict) and merged_type[k].get("value") is None):
                    merged_type[k] = v

            # Merge org custom fields (prefer first non-null)
            for k, v in _dict(data.get("customFields")).items():
                if k not in merged_custom or (isinstance(merged_custom[k], dict) and merged_custom[k].get("value") is None):
                    merged_custom[k] = v

            # Accumulate open-ended findings (deduplicate by key)
            seen_keys = {f.get("key") for f in open_ended if isinstance(f, dict)}
            for finding in _list(data.get("openEndedFindings")):
                if not isinstance(finding, dict):
                    continue
                if finding.get("key") not in seen_keys:
                    open_ended.append(finding)
                    seen_keys.add(finding.get("key"))

        except RouterRefusal:
            # A refusal is not a model failure. Degrading here would write a
            # confident wrong answer for a call that never reached a provider.
            raise
        except Exception as e:
            logger.error("[extract] chunk %d/%d FAILED: %s", i + 1, len(chunks), e, exc_info=True)
            state["error"] = f"extract chunk {i+1}: {e}"

    state["clause_segments"] = _dedupe_segments(all_segments)
    state["raw_fields"]      = merged_fields
    state["clause_flags"]    = merged_flags
    state["custom_extracted"] = {
        "typeFields":         merged_type,
        "customFields":       merged_custom,
        "openEndedFindings":  open_ended,
    }

    # P-fix #3 (2026-05-02). Smart Import second-pass for missing
    # required fields. The first-pass extract is broad but often misses
    # 1-2 high-value fields — typically `parties`, `term_length`,
    # `governing_law`, `total_value`. When the customer migrates 1000
    # contracts the field-coverage average is what they grade us on.
    # If any required field came back null/empty, run a tighter LLM
    # call focused ONLY on those fields, with the explicit instruction
    # to look harder. Cheap (only fires when needed), bounded (only
    # rerolls the missing keys), additive (never overwrites a hit).
    REQUIRED = {"parties", "term_length", "governing_law", "total_value"}
    missing = []
    for k in REQUIRED:
        v = merged_fields.get(k)
        is_empty = (
            v is None or v == "" or
            (isinstance(v, dict) and (v.get("value") in (None, "", []))) or
            (isinstance(v, list) and len(v) == 0)
        )
        if is_empty:
            missing.append(k)
    if missing and len(text) > 0:
        try:
            second_prompt = (
                "You are a focused extraction specialist. The first pass "
                "missed these specific fields: " + ", ".join(missing) + ".\n\n"
                "Re-read the contract text below and return ONLY a JSON "
                "object with just those keys. Each value should be "
                '{"value": <extracted>, "quote": "<verbatim source>", '
                '"section": "<section ref or null>", "confidence": <0-1>}. '
                "If you genuinely cannot find a field, set value=null and "
                "include a confidence of 0.0. Be conservative — do NOT "
                "fabricate. Return ONLY valid JSON, no markdown."
            )
            slice_for_recall = text[: min(len(text), _CHUNK_SIZE)]
            # Reuses the extract-node resolution (same tier, same org, same
            # trace name) — no second resolve, so this recovery pass adds no
            # new failure mode to the path that triggers it.
            resp2 = await llm.ainvoke(
                [
                    SystemMessage(content=second_prompt),
                    # Slice is taken above from the raw text, then wrapped here,
                    # so truncation can never cut a framing marker in half.
                    HumanMessage(content=wrap_untrusted_document(
                        slice_for_recall,
                        source="counterparty contract body (missing-field recovery pass)",
                    )),
                ],
                config={"callbacks": resolved.callbacks},
            )
            recovered = _parse_json(resp2.content)
            for k in missing:
                if k in recovered and recovered[k]:
                    cand = recovered[k]
                    if isinstance(cand, dict) and cand.get("value") not in (None, "", []):
                        merged_fields[k] = cand
                        logger.info("[extract] second-pass recovered field=%s", k)
            state["raw_fields"] = merged_fields
        except RouterRefusal:
            # A refusal is not a model failure. Degrading here would write a
            # confident wrong answer for a call that never reached a provider.
            raise
        except Exception as e:
            logger.warning("[extract] second-pass missing-field recovery failed: %s", e)

    logger.info("[extract] OK: %d clauses, %d raw_fields, %d type-fields, %d custom, %d open-ended",
                len(state["clause_segments"]), len(state["raw_fields"]),
                len(merged_type), len(merged_custom), len(open_ended))

    return state


async def _validate(state: ReviewState) -> ReviewState:
    """Step 2: cross-check values, normalise types, assign confidence (Sonnet)."""
    # raw_fields carries verbatim `quote` strings lifted straight out of the
    # counterparty document, so the payload is untrusted even though we built
    # the JSON around it. Frame the whole payload once (one wrap per call).
    payload = wrap_untrusted_document(
        json.dumps(state["raw_fields"], indent=2),
        source="fields extracted from the counterparty contract, with verbatim quotes",
    )

    try:
        resolved = await resolve_llm(
            "reasoning",
            org_id=state.get("org_id"),
            streaming=True,
            trace_name="review.validate",
        )
        logger.info("[validate] provider=%s model=%s raw_fields=%d",
                    resolved.provider, resolved.model, len(state["raw_fields"]))
        resp = await resolved.llm.ainvoke(
            [
                SystemMessage(content=_VALIDATE_PROMPT + payload),
                HumanMessage(content="Validate the fields above."),
            ],
            config={"callbacks": resolved.callbacks},
        )
        data = _parse_json(resp.content)
        state["validated_fields"] = data.get("validatedFields", {})
        logger.info("[validate] OK: %d validated_fields", len(state["validated_fields"]))
    except RouterRefusal:
        # A refusal is not a model failure. Degrading here would write a
        # confident wrong answer for a call that never reached a provider.
        raise
    except Exception as e:
        logger.error("[validate] FAILED: %s", e, exc_info=True)
        state["error"] = (state.get("error") or "") + f" | validate: {e}"
        state["validated_fields"] = {
            k: {"value": v.get("value"), "confidence": 0.5, "quote": v.get("quote"), "section": None, "issue": None}
            for k, v in state["raw_fields"].items()
            if isinstance(v, dict)
        }

    return state


async def _score(state: ReviewState) -> ReviewState:
    """Step 3: risk score, contract type, summary (Sonnet)."""
    # P-fix #1 (2026-05-02). Pass actual clause content for the
    # score-and-summarize step, not just the extracted fields. The
    # previous payload had only `validatedFields` (party names, dates,
    # value, etc.) so the LLM-produced summary was high-fidelity at
    # the field level but missed cross-clause patterns ("indemnity
    # caveats are tied to the survival period in §12"). Including
    # the high-signal clauses (anything with a clauseFlag set, or the
    # first 5 by sortOrder) gives the model the raw text it needs.
    flagged_types = {
        k for k, v in (state.get("clause_flags") or {}).items()
        if v and isinstance(v, (bool, dict))
    }
    significant_clauses = []
    for seg in (state.get("clause_segments") or [])[:60]:
        ct = seg.get("clauseType", "")
        # Always include the top 6 by sort, plus anything matching a
        # high-signal flag (mfn, force_majeure, auto_renewal, etc.)
        if len(significant_clauses) < 6 or ct in flagged_types:
            content = (seg.get("content") or "")[:1500]
            if content:
                significant_clauses.append({
                    "type": ct,
                    "section": seg.get("sectionRef"),
                    "text": content,
                })
        if len(significant_clauses) >= 12:
            break

    context = {
        "validatedFields": state["validated_fields"],
        "clauseFlags":     state["clause_flags"],
        # P-fix #1 — significant clause content (capped to ~18K chars)
        # so the summary captures language patterns, not just metadata.
        "significantClauses": significant_clauses,
        # If user provided a contractType hint, pass it so scoring respects it
        **({"contractTypeHint": state["contract_type"]} if state["contract_type"] else {}),
    }
    # significantClauses is verbatim clause text and validatedFields still
    # carries verbatim quotes, so the scoring payload is counterparty-authored
    # content. One wrap around the assembled payload keeps the added framing to
    # ~120 tokens for the call rather than per clause.
    payload = wrap_untrusted_document(
        json.dumps(context, indent=2),
        source="extracted contract fields and verbatim clause text from the counterparty contract",
    )

    try:
        resolved = await resolve_llm(
            "reasoning",
            org_id=state.get("org_id"),
            streaming=True,
            trace_name="review.score",
        )
        logger.info("[score] provider=%s model=%s validated_fields=%d",
                    resolved.provider, resolved.model, len(state["validated_fields"]))
        resp = await resolved.llm.ainvoke(
            [
                SystemMessage(content=_SCORE_PROMPT + payload),
                HumanMessage(content="Produce the final analysis."),
            ],
            config={"callbacks": resolved.callbacks},
        )
        data = _parse_json(resp.content)

        ct = str(data.get("contractType", "OTHER")).upper().strip()
        # If user explicitly set a type, respect it even if model disagrees
        if state["contract_type"] and state["contract_type"].upper() in _VALID_TYPES:
            ct = state["contract_type"].upper()

        state["contract_type_out"] = ct if ct in _VALID_TYPES else "OTHER"
        state["suggested_title"]   = data.get("suggestedTitle", "")
        state["summary"]           = data.get("summary", "")
        state["risk_score"]        = _clamp_risk(data.get("riskScore"))
        state["risk_factors"]      = data.get("riskFactors", [])
        state["overall_confidence"] = float(data.get("overallConfidence", 0.7))

        logger.info("[score] OK: type=%s title=%r risk=%.2f confidence=%.2f",
                    state["contract_type_out"], state["suggested_title"],
                    state["risk_score"] or 0, state["overall_confidence"])
    except RouterRefusal:
        # A refusal is not a model failure. Degrading here would write a
        # confident wrong answer for a call that never reached a provider.
        raise
    except Exception as e:
        logger.error("[score] FAILED: %s", e, exc_info=True)
        state["error"]             = (state.get("error") or "") + f" | score: {e}"
        state["contract_type_out"] = state["contract_type"] or "OTHER"
        state["summary"]           = ""
        state["risk_score"]        = None
        state["risk_factors"]      = []
        state["overall_confidence"] = 0.0

    return state


# ─── Graph ───────────────────────────────────────────────────────────────────

def _build_graph() -> Any:
    g = StateGraph(ReviewState)
    g.add_node("extract",  _extract)
    g.add_node("validate", _validate)
    g.add_node("score",    _score)
    g.set_entry_point("extract")
    g.add_edge("extract",  "validate")
    g.add_edge("validate", "score")
    g.add_edge("score",    END)
    return g.compile()


_compiled: Any = None

def get_review_graph() -> Any:
    global _compiled
    if _compiled is None:
        _compiled = _build_graph()
    return _compiled


# ─── Public interface ─────────────────────────────────────────────────────────

async def run_review(
    plain_text:    str,
    contract_type: str | None = None,
    custom_fields: list[dict] | None = None,
    org_id:        str | None = None,
) -> dict[str, Any]:
    """
    Run the 3-step review pipeline.

    Returns a dict with:
      summary, contractType, suggestedTitle, riskScore, riskFactors,
      keyTerms (flat dict), fieldConfidence (per-field),
      clauseSegments, clauseFlags, overallConfidence,
      customExtracted { customFields, openEndedFindings }
    """
    graph = get_review_graph()
    final = await graph.ainvoke({
        "plain_text":        plain_text,
        "contract_type":     contract_type,
        "custom_fields":     custom_fields or [],
        "org_id":            org_id,
        "clause_segments":   [],
        "raw_fields":        {},
        "clause_flags":      {},
        "custom_extracted":  {},
        "validated_fields":  {},
        "contract_type_out": "OTHER",
        "suggested_title":   "",
        "summary":           "",
        "risk_score":        None,
        "risk_factors":      [],
        "overall_confidence": 0.0,
        "error":             None,
    })

    key_terms:        dict[str, Any] = {}
    field_confidence: dict[str, Any] = {}

    for field_name, vdata in final["validated_fields"].items():
        if not isinstance(vdata, dict):
            continue
        val  = vdata.get("value")
        conf = vdata.get("confidence", 0.5)
        key_terms[field_name] = val
        field_confidence[field_name] = {
            "confidence": conf,
            "quote":   vdata.get("quote"),
            "section": vdata.get("section"),
            "issue":   vdata.get("issue") if conf < 0.7 else None,
        }

    return {
        "summary":          final["summary"],
        "contractType":     final["contract_type_out"],
        "suggestedTitle":   final.get("suggested_title", ""),
        "riskScore":        final["risk_score"],
        "riskFactors":      final["risk_factors"],
        "keyTerms":         key_terms,
        "fieldConfidence":  field_confidence,
        "clauseSegments":   final["clause_segments"],
        "clauseFlags":      final["clause_flags"],
        "overallConfidence": final["overall_confidence"],
        "customExtracted":  final.get("custom_extracted", {}),
        "error":            final.get("error"),
    }
