/**
 * Contract-type fields (docs/39 B1) — the fields the extraction adds for each
 * contract type, mirrored from TYPE_SCHEMAS in the agents service
 * (apps/agents/app/agents/review_agent.py), which prompts with them. The API
 * reads this copy to show and edit them; api/src/lib/type-fields-drift.test.ts
 * fails when the two lists differ.
 */
import type { FieldValueType } from './fields'

export interface TypeFieldDef {
  key: string
  label: string
  type: Extract<FieldValueType, 'text' | 'number' | 'boolean'>
}

export const TYPE_FIELDS: Readonly<Record<string, readonly TypeFieldDef[]>> = {
  NDA: [
    { key: 'mutual', label: 'Mutual / Bilateral', type: 'boolean' },
    { key: 'permitted_use', label: 'Permitted Use', type: 'text' },
    { key: 'carve_outs', label: 'Confidentiality Carve-Outs', type: 'text' },
    { key: 'residual_clause', label: 'Residual Knowledge Clause', type: 'boolean' },
    { key: 'non_compete', label: 'Non-Compete Restriction', type: 'boolean' },
    { key: 'non_solicitation', label: 'Non-Solicitation', type: 'boolean' },
    { key: 'return_of_information', label: 'Return / Destruction of Information', type: 'boolean' },
    { key: 'injunctive_relief', label: 'Injunctive Relief Available', type: 'boolean' },
    { key: 'standard_basis', label: 'Agreement Basis / Standard Form', type: 'text' },
  ],
  MSA: [
    { key: 'sow_execution_process', label: 'SOW Execution Process', type: 'text' },
    { key: 'change_order_process', label: 'Change Order Process', type: 'text' },
    { key: 'warranty_period_days', label: 'Warranty Period (Days)', type: 'number' },
    { key: 'dispute_resolution', label: 'Dispute Resolution Mechanism', type: 'text' },
    { key: 'acceptance_process', label: 'Acceptance Process', type: 'text' },
    { key: 'step_in_rights', label: 'Step-In Rights', type: 'boolean' },
    { key: 'key_personnel', label: 'Key Personnel Requirement', type: 'text' },
    { key: 'benchmarking_rights', label: 'Benchmarking Rights', type: 'boolean' },
    { key: 'source_code_escrow', label: 'Source Code Escrow', type: 'boolean' },
    { key: 'most_favored_nation', label: 'Most Favoured Nation (MFN)', type: 'boolean' },
    { key: 'data_portability', label: 'Data Portability on Exit', type: 'text' },
  ],
  SOW: [
    { key: 'deliverables', label: 'Deliverables', type: 'text' },
    { key: 'milestones', label: 'Milestones & Target Dates', type: 'text' },
    { key: 'acceptance_criteria', label: 'Acceptance Criteria', type: 'text' },
    { key: 'payment_model', label: 'Payment Model', type: 'text' },
    { key: 'change_control', label: 'Change Control Process', type: 'text' },
    { key: 'project_manager', label: 'Named Project Manager', type: 'text' },
    { key: 'work_location', label: 'Work Location', type: 'text' },
    { key: 'travel_expenses', label: 'Travel Expenses Reimbursable', type: 'boolean' },
    { key: 'assumptions', label: 'Key Assumptions', type: 'text' },
    { key: 'out_of_scope', label: 'Out of Scope', type: 'text' },
    { key: 'governing_msa', label: 'Governing MSA / Framework', type: 'text' },
  ],
  SLA: [
    { key: 'uptime_percentage', label: 'Target Uptime (%)', type: 'number' },
    { key: 'response_time_hours', label: 'P1 Incident Response Time (Hours)', type: 'number' },
    { key: 'resolution_time_hours', label: 'P1 Incident Resolution Time (Hours)', type: 'number' },
    { key: 'measurement_period', label: 'Measurement Period', type: 'text' },
    { key: 'maintenance_exclusions', label: 'Planned Maintenance Exclusions', type: 'text' },
    { key: 'credit_formula', label: 'Service Credit Formula', type: 'text' },
    { key: 'max_credit_percentage', label: 'Maximum Credit Cap (%)', type: 'number' },
    { key: 'reporting_frequency', label: 'SLA Reporting Frequency', type: 'text' },
    { key: 'escalation_procedure', label: 'Escalation Procedure', type: 'text' },
    { key: 'remediation_plan_required', label: 'Remediation Plan Required', type: 'boolean' },
    { key: 'termination_for_sla_failure', label: 'Termination Right for SLA Failure', type: 'text' },
  ],
  EMPLOYMENT: [
    { key: 'job_title', label: 'Job Title / Role', type: 'text' },
    { key: 'base_salary', label: 'Base Salary', type: 'number' },
    { key: 'salary_currency', label: 'Salary Currency', type: 'text' },
    { key: 'employment_type', label: 'Employment Type', type: 'text' },
    { key: 'at_will', label: 'At-Will Employment', type: 'boolean' },
    { key: 'probation_period_days', label: 'Probation Period (Days)', type: 'number' },
    { key: 'bonus_structure', label: 'Bonus / Commission Structure', type: 'text' },
    { key: 'equity_grant', label: 'Equity / Stock Option Grant', type: 'text' },
    { key: 'vesting_schedule', label: 'Vesting Schedule', type: 'text' },
    { key: 'non_compete_duration_months', label: 'Non-Compete Duration (Months)', type: 'number' },
    { key: 'non_solicitation_duration_months', label: 'Non-Solicitation Duration (Months)', type: 'number' },
    { key: 'severance_months', label: 'Severance Pay (Months of Salary)', type: 'number' },
    { key: 'garden_leave', label: 'Garden Leave', type: 'boolean' },
    { key: 'ip_assignment', label: 'IP Assignment to Employer', type: 'boolean' },
    { key: 'remote_work_permitted', label: 'Remote / Hybrid Work Permitted', type: 'boolean' },
    { key: 'relocation_required', label: 'Relocation Required', type: 'boolean' },
  ],
  VENDOR_AGREEMENT: [
    { key: 'payment_method', label: 'Payment Method', type: 'text' },
    { key: 'delivery_terms', label: 'Delivery Terms (Incoterms)', type: 'text' },
    { key: 'warranty_duration_days', label: 'Warranty Duration (Days)', type: 'number' },
    { key: 'return_policy', label: 'Return & Refund Policy', type: 'text' },
    { key: 'quality_standards', label: 'Quality Standards & Certifications', type: 'text' },
    { key: 'vendor_insurance_required', label: 'Vendor Insurance Required', type: 'boolean' },
    { key: 'minimum_insurance_coverage', label: 'Minimum Insurance Coverage', type: 'text' },
    { key: 'subcontracting_permitted', label: 'Subcontracting Permitted', type: 'boolean' },
    { key: 'background_check_required', label: 'Background Checks Required', type: 'boolean' },
    { key: 'volume_discount', label: 'Volume Discount Tiers', type: 'text' },
    { key: 'minimum_purchase_commitment', label: 'Minimum Purchase Commitment', type: 'number' },
    { key: 'price_adjustment_mechanism', label: 'Price Adjustment Mechanism', type: 'text' },
    { key: 'preferred_supplier_status', label: 'Preferred / Sole Supplier Status', type: 'boolean' },
  ],
  PARTNERSHIP: [
    { key: 'partnership_type', label: 'Partnership Type', type: 'text' },
    { key: 'revenue_split', label: 'Revenue / Profit Split', type: 'text' },
    { key: 'capital_contributions', label: 'Capital Contributions', type: 'text' },
    { key: 'decision_making', label: 'Decision-Making Authority', type: 'text' },
    { key: 'territory', label: 'Territory / Market Scope', type: 'text' },
    { key: 'exclusivity', label: 'Exclusivity', type: 'boolean' },
    { key: 'branding_rights', label: 'Co-Branding Rights', type: 'text' },
    { key: 'jointly_developed_ip', label: 'Jointly Developed IP Ownership', type: 'text' },
    { key: 'exit_mechanism', label: 'Exit Mechanism', type: 'text' },
    { key: 'non_compete', label: 'Non-Compete Between Partners', type: 'boolean' },
    { key: 'governance_structure', label: 'Governance Structure', type: 'text' },
    { key: 'minimum_commitment', label: 'Minimum Activity Commitment', type: 'text' },
  ],
  LICENSE: [
    { key: 'license_type', label: 'License Type', type: 'text' },
    { key: 'license_duration', label: 'License Duration', type: 'text' },
    { key: 'territory', label: 'Licensed Territory', type: 'text' },
    { key: 'permitted_uses', label: 'Permitted Uses', type: 'text' },
    { key: 'field_of_use', label: 'Field of Use Restriction', type: 'text' },
    { key: 'sublicensing_allowed', label: 'Sublicensing Permitted', type: 'boolean' },
    { key: 'royalty_structure', label: 'Royalty Structure', type: 'text' },
    { key: 'minimum_royalty', label: 'Minimum Annual Royalty', type: 'number' },
    { key: 'source_code_included', label: 'Source Code Access', type: 'boolean' },
    { key: 'modification_rights', label: 'Modification / Derivative Works', type: 'boolean' },
    { key: 'audit_rights', label: 'Royalty Audit Rights', type: 'boolean' },
    { key: 'reversion_rights', label: 'Reversion of Rights', type: 'text' },
    { key: 'improvements_ownership', label: 'Improvements Ownership', type: 'text' },
  ],
  DATA_PROCESSING: [
    { key: 'data_controller', label: 'Data Controller', type: 'text' },
    { key: 'data_processor', label: 'Data Processor', type: 'text' },
    { key: 'processing_purposes', label: 'Processing Purposes & Legal Basis', type: 'text' },
    { key: 'personal_data_categories', label: 'Categories of Personal Data', type: 'text' },
    { key: 'data_subjects', label: 'Data Subjects', type: 'text' },
    { key: 'retention_period', label: 'Data Retention Period', type: 'text' },
    { key: 'sub_processors_permitted', label: 'Sub-Processors Permitted', type: 'boolean' },
    { key: 'transfer_mechanism', label: 'International Transfer Mechanism', type: 'text' },
    { key: 'security_measures', label: 'Required Security Measures', type: 'text' },
    { key: 'breach_notification_hours', label: 'Breach Notification Deadline (Hours)', type: 'number' },
    { key: 'dpia_required', label: 'DPIA Required', type: 'boolean' },
    { key: 'applicable_regulation', label: 'Applicable Privacy Regulation', type: 'text' },
    { key: 'deletion_on_termination', label: 'Data Deletion on Termination', type: 'text' },
  ],
  ORDER_FORM: [
    { key: 'order_number', label: 'Order / PO Reference Number', type: 'text' },
    { key: 'products_or_services', label: 'Products / Services Ordered', type: 'text' },
    { key: 'quantity', label: 'Quantity / Licences', type: 'number' },
    { key: 'unit_price', label: 'Unit / Seat Price', type: 'number' },
    { key: 'total_order_value', label: 'Total Order Value', type: 'number' },
    { key: 'delivery_date', label: 'Expected Delivery Date', type: 'text' },
    { key: 'payment_due_date', label: 'Payment Due Date', type: 'text' },
    { key: 'shipping_method', label: 'Shipping / Delivery Method', type: 'text' },
    { key: 'billing_contact', label: 'Billing / AP Contact', type: 'text' },
    { key: 'discount_applied', label: 'Discounts Applied', type: 'text' },
    { key: 'governing_agreement', label: 'Governing Agreement / Terms', type: 'text' },
  ],
}

/** The fields a contract type adds, or none. */
export function typeFieldsFor(contractType: string | null | undefined): readonly TypeFieldDef[] {
  return TYPE_FIELDS[contractType ?? ''] ?? []
}
