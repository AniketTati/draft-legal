/**
 * The clause types the extraction tags and people can tag (docs/39 E1), with
 * the names the screens show. Moved from the contract page so the API can
 * check a tagged type and the "Tag as clause" menu can list them.
 */
export const CLAUSE_TYPE_LABELS: Record<string, string> = {
  limitation_of_liability:       'Limitation of Liability',
  uncapped_liability:             'Uncapped Liability',
  indemnification:                'Indemnification',
  liquidated_damages:             'Liquidated Damages',
  payment:                        'Payment Terms',
  price_adjustment:               'Price Adjustment',
  minimum_commitment:             'Minimum Commitment',
  volume_restriction:             'Volume Restriction',
  ip_ownership:                   'IP Ownership',
  ip_license_back:                'IP License-Back',
  license_grant:                  'License Grant',
  joint_ip:                       'Joint IP Ownership',
  source_code_escrow:             'Source Code Escrow',
  termination:                    'Termination',
  post_termination_services:      'Post-Termination Services',
  confidentiality:                'Confidentiality',
  confidential_info_definition:   'Definition of Confidential Information',
  non_compete:                    'Non-Compete',
  non_solicitation:               'Non-Solicitation',
  non_disparagement:              'Non-Disparagement',
  covenant_not_to_sue:            'Covenant Not to Sue',
  governing_law:                  'Governing Law',
  dispute_resolution:             'Dispute Resolution',
  notice:                         'Notice',
  auto_renewal:                   'Auto-Renewal',
  renewal_term:                   'Renewal Terms',
  exclusivity:                    'Exclusivity',
  warranty:                       'Warranty',
  warranty_duration:              'Warranty Duration',
  representations_warranties:     'Representations & Warranties',
  force_majeure:                  'Force Majeure',
  assignment:                     'Assignment',
  change_of_control:              'Change of Control',
  mfn:                            'Most Favoured Nation',
  audit_rights:                   'Audit Rights',
  rofr:                           'Right of First Refusal/Offer',
  insurance:                      'Insurance',
  acceptance:                     'Acceptance',
  data_protection:                'Data Protection',
  third_party_beneficiary:        'Third-Party Beneficiary',
  general:                        'General',
}

/** A clause type as the screens name it: a known one's label, else its key in words. */
export function clauseTypeLabel(type: string): string {
  return CLAUSE_TYPE_LABELS[type] ?? type.replace(/_/g, ' ')
}
