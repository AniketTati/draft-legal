/**
 * docs/41 P0.2 / P1 — the approval recommendation in words.
 *
 * The label is the API's policy over the review findings (never a model's):
 * ready_to_approve, review, needs_exception, escalate, cant_recommend, with
 * the reasons ("Can't recommend — the document changed after it was
 * analysed"). Approvals decided before P1 keep the model's old labels.
 */
export const RECOMMENDATION_LABEL: Record<string, string> = {
  ready_to_approve: 'Ready to approve',
  review:           'Review',
  needs_exception:  'Needs exception',
  escalate:         'Escalate',
  cant_recommend:   "Can't recommend",
  // Before docs/41 P1.
  approve:          'Ready to approve',
  review_required:  'Review required',
  reject_advised:   'Reject advised',
}

export function recommendationText(label: string | null | undefined, reasons: string[] | null | undefined = []): string | null {
  if (!label) return null
  const key = label.toLowerCase()
  if (key === 'cant_recommend' || key === 'review' || key === 'needs_exception' || key === 'escalate') {
    const first = reasons?.[0]
    return first ? `${RECOMMENDATION_LABEL[key]} — ${first}` : RECOMMENDATION_LABEL[key]
  }
  return RECOMMENDATION_LABEL[key] ?? RECOMMENDATION_LABEL.review
}
