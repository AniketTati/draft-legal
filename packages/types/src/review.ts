/**
 * docs/41 P1 (Parts 5, 7, 8) — the words the review uses, each with what it
 * means and where it comes from, read the same way by the API (GET
 * /contracts/:id/review) and the contract page's Review panel.
 *
 * "MARKET" / "Aligned with Market" had no definition and no source. Every
 * label here is either a fact (the text is the template's, the text changed
 * since vN) or a comparison with the org's own playbook. None of them is a
 * judgement against "the market": there is no benchmark to judge against.
 */

export type RecommendationLabel = 'ready_to_approve' | 'review' | 'needs_exception' | 'escalate' | 'cant_recommend'

export const RECOMMENDATION_TEXT: Record<RecommendationLabel, { label: string; definition: string }> = {
  ready_to_approve: { label: 'Ready to approve', definition: 'This version was analysed, nothing required is missing or deleted, and every change matches a position your playbook allows.' },
  review: { label: 'Review', definition: 'Something in this version needs a person to look at it before it is approved: see the findings.' },
  needs_exception: { label: 'Needs exception', definition: 'A clause is at a position that needs approval, or a required clause is confirmed missing. Someone with authority has to approve it.' },
  escalate: { label: 'Escalate', definition: 'A clause goes past a position your playbook says you walk away from, or one it does not allow. Do not proceed without escalating.' },
  cant_recommend: { label: "Can't recommend", definition: "This version hasn't been fully analysed, so nothing can be said about it yet." },
}

/** The status a clause or finding is shown with. */
export type ReviewStatus =
  | 'standard' | 'matches_preferred' | 'fallback' | 'needs_approval' | 'not_met'
  | 'changed' | 'added' | 'deleted' | 'unchanged' | 'not_detected' | 'not_covered' | 'not_allowed' | 'unreadable' | 'accepted' | 'resolved'

/**
 * Each status's label and definition. `{v}` is the baseline version
 * ("v4"), `{source}` where standard text came from ("NDA template v3").
 */
export const REVIEW_STATUS_TEXT: Record<ReviewStatus, { label: string; definition: string }> = {
  standard: { label: 'Standard', definition: 'From {source}, unchanged. Text identical to your approved template or clause library is not sent to AI for an opinion.' },
  matches_preferred: { label: 'Matches preferred', definition: 'Compared with your playbook: this clause gives you what your preferred position asks for.' },
  fallback: { label: 'Fallback', definition: 'Compared with your playbook: this clause reaches only your fallback position. Your playbook allows it, but it is not what you open with.' },
  needs_approval: { label: 'Needs approval', definition: 'Compared with your playbook: this clause is worse than your fallback position. Someone with authority has to approve it.' },
  not_met: { label: "Doesn't meet your positions", definition: 'Compared with your playbook: this clause meets none of your positions for it, or a rule your playbook sets.' },
  changed: { label: 'Changed since {v}', definition: 'The words of this clause differ from {v}, the version this one is compared with.' },
  added: { label: 'Added since {v}', definition: 'This text was not in {v}, the version this one is compared with.' },
  deleted: { label: 'Deleted since {v}', definition: 'This clause was in {v} and is not in this version.' },
  unchanged: { label: 'Unchanged since {v}', definition: 'The same words as {v}, the version this one is compared with.' },
  not_detected: { label: 'Not detected', definition: 'Your playbook requires this clause and none was found. It may be there under another heading: find it and tag it, or confirm it is missing.' },
  not_covered: { label: 'Not covered by your playbook', definition: 'Your playbook has no position for this kind of clause, so nothing was checked against it.' },
  not_allowed: { label: 'Not allowed', definition: 'Your playbook does not allow this clause in this type of contract.' },
  unreadable: { label: "Doesn't read as text", definition: 'Text added since {v} is not made of words (a check on the letters, not AI). It may be typing by mistake.' },
  accepted: { label: 'Accepted as is', definition: 'A person looked at this and accepted it as it is.' },
  resolved: { label: 'Resolved', definition: 'This was dealt with.' },
}

/** A label or definition with its placeholders filled. */
export function reviewText(s: string, vars: { v?: string | null; source?: string | null }): string {
  return s.replace(/\{v\}/g, vars.v ?? 'the last version').replace(/\{source\}/g, vars.source ?? 'your template')
}
