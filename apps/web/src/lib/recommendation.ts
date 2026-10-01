/**
 * docs/41 P0.2 — the approval recommendation in words.
 *
 * "Ready to approve" is only ever shown when the API's guard passed (the label
 * stays "approve"); when it didn't, the label is "cant_recommend" and the
 * reasons say why ("Can't recommend — the document changed after it was
 * analysed"). The model's other labels keep their words.
 */
export const RECOMMENDATION_LABEL: Record<string, string> = {
  approve:         'Ready to approve',
  review_required: 'Review required',
  reject_advised:  'Reject advised',
  cant_recommend:  "Can't recommend",
}

export function recommendationText(label: string | null | undefined, reasons: string[] | null | undefined = []): string | null {
  if (!label) return null
  const key = label.toLowerCase()
  if (key === 'cant_recommend') {
    const first = reasons?.[0]
    return first ? `Can't recommend — ${first}` : "Can't recommend"
  }
  return RECOMMENDATION_LABEL[key] ?? RECOMMENDATION_LABEL.review_required
}
