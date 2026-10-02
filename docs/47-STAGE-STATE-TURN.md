# 47 — Stage, state and turn (docs/41 Part 18, Workstream D)

A contract is described by three stored values, not one status:

- **stage** — where it is: `request · draft · negotiate · approve · sign · active · closed`;
- **stageState** — what is happening in the stage;
- **turn** — who must act: `internal · counterparty · approvers · signers · none`,
  with `turnSince` (since when) and `turnOwnerId` (the person, when the turn is ours).

The model is `packages/types/src/lifecycle.ts`. Every move goes through one service,
`apps/api/src/lib/lifecycle.ts` `transition()`, which checks the allowed
transitions, writes stage + state + turn + the derived status in one
compare-and-set update, and records a `STAGE_CHANGED` audit event (typed payload,
`lib/status-change.ts`) and the `contract.stage_changed` / `contract.turn_changed`
webhooks.

## States per stage

| Stage | States | Default turn |
|---|---|---|
| request | submitted · in_triage · more_info · declined | internal |
| draft | drafting · ready · returned | internal |
| negotiate | with_us · with_counterparty · returned | internal / counterparty |
| approve | pending · approved · declined | approvers (pending), internal otherwise |
| sign | out_for_signature · declined · voided | signers (out), internal otherwise |
| active | active · expiring · auto_renewed | none |
| closed | expired · terminated · superseded · cancelled · archived | none |

## `status` — the derived column (kept for a release, §6.12)

Webhooks (`contract.*`), analytics, the search index and API clients read
`status`. It is derived from stage + state (`statusFor`):

| Stage / state | status |
|---|---|
| request/* | DRAFT |
| draft/drafting, draft/returned | DRAFT |
| draft/ready | PENDING_REVIEW |
| negotiate/* | UNDER_NEGOTIATION |
| approve/pending | PENDING_APPROVAL |
| approve/approved | APPROVED |
| approve/declined | DRAFT (as a rejected approval always read) |
| sign/* | PENDING_SIGNATURE |
| active/* | EXECUTED |
| closed/expired | EXPIRED |
| closed/terminated | TERMINATED |
| closed/superseded, cancelled, archived | ARCHIVED |

And back (`stageForStatus`, used by the migration, imports and clients that still send a status):

| status | stage / state |
|---|---|
| DRAFT | draft/drafting |
| PENDING_REVIEW | draft/ready |
| UNDER_NEGOTIATION | negotiate/with_us (see turn heuristic) |
| PENDING_APPROVAL | approve/pending |
| APPROVED | approve/approved |
| REJECTED (never written) | draft/returned |
| PENDING_SIGNATURE | sign/out_for_signature |
| EXECUTED | active/active |
| EXPIRED | closed/expired |
| TERMINATED | closed/terminated |
| ARCHIVED | closed/archived |

The database keeps the two agreeing: the `contracts_stage_sync` trigger
(migration `stage_turn_approvals`) derives the status when the stage moves,
and derives the stage when a writer sets only a status (seeds, scripts,
imports, anything not yet moved to `transition()`). `lifecycle-views.integration.test.ts`
checks the SQL tables match the TypeScript ones.

## Migration of existing rows

- stage/state from status, as above;
- turn from stage/state, except **negotiations**: the counterparty's turn when
  the version the contract stands on is ours and we shared it (a share link,
  or a redline exported for them) after it was made; ours otherwise;
- `turnSince` = the last status-change event, else `updatedAt`;
- `turnOwnerId` = the owner when the turn is ours;
- approvals in flight are attached to the version the contract stands on
  (`ApprovalInstance.versionId`), not reset; `outcome` is filled from status.

## Allowed transitions

| From → To | Who may | Notes |
|---|---|---|
| request → draft | import, manual | a request accepted (converted) |
| draft → negotiate | send, counterparty, manual, agent | sending to the counterparty, or their version |
| draft/negotiate → approve | approval | submit for approval only |
| draft/negotiate → sign | signature | only where the org allows signing without approval |
| negotiate → draft | manual, agent, revert | backwards: reason required |
| approve → draft/negotiate | approval (Return), edit, counterparty, revert | Return goes to the stage it was worked in |
| approve → sign | signature | approved, on this version, no open exceptions |
| approve → active | manual, agent | signed outside the product |
| sign → approve/negotiate/draft | revert (reason) | after a void or decline; Approve only while the approval stands |
| sign → active | signature | the last signature (sets executedAt) |
| active → closed | dates, manual, agent | expired, terminated, archived |
| any pre-active → closed/cancelled | cancel (reason) | |
| closed/cancelled → its earlier stage | undo_cancel (admin, reason) | |
| closed/expired → active | dates | a new expiry date in the future |
| **active → negotiate/draft** | **never** | changes after signature are amendments |

Within a stage the flows move the state (approve pending → approved is the
approval workflow's; sign → voided the signing flow's). A person may by hand:
draft drafting ↔ ready, negotiate with_us ↔ with_counterparty, archive an
expired contract (`lib/contract-status.ts manualRefusal`). `undo` (an
assistant action undone) puts back exactly where the action moved from.

## Automatic moves

| Trigger | Move |
|---|---|
| counterparty upload / email reply | → negotiate/with_us (our turn); a submission in flight is withdrawn |
| share link, emailed link, redline downloaded for them | draft/negotiate → negotiate/with_counterparty |
| submit for approval | → approve/pending |
| last approval | → approve/approved (ready to sign) |
| return / decline | → draft or negotiate /returned · approve/declined |
| sent for signature | → sign/out_for_signature |
| void / signer declines | → sign/voided · sign/declined |
| last signature | → active/active (executedAt) |
| daily date job (`lib/lifecycle-dates.ts`) | active → expiring (30 days), → closed/expired or active/auto_renewed; expired → active on new dates |

## Approvals on versions, and reset rules

An approval request is of one version (`ApprovalInstance.versionId`). Each
workflow step may say when an approval given at that step is asked again
(`resetOn`, default `always`):

- `always` — any change (a new version, or a change to value/currency/type…);
- `any_document_change` — a new version;
- `{ mode: 'clause_text_changes', clauseTypes: [...] }` — those clauses' text (all when none listed);
- `{ mode: 'fields', fields: [...] }` — those fields;
- `never`.

On a change while in Approve (`lib/approval-reset.ts`): steps that reset are
marked RESET and asked again from the earliest; approvers are told what
changed ("v6 changed §5 Limitation of Liability — your approval was reset");
a "Ready to approve" label written for the old version is withdrawn. When none
resets, the approval carries to the new version (on the record). A
counterparty's version after submission always withdraws the request. A clause
exception resets only when its own clause's text changes.

## Approval outcomes

`ApprovalInstance.outcome`: approved · returned · declined · withdrawn ·
cancelled. `status` keeps its older values (a return or decline is REJECTED).
Decisions: APPROVED · RETURNED · DECLINED · DELEGATED (REJECTED from older
clients = RETURNED). A reason is required to return or decline.

**Slack:** the app has no dialog to collect a reason (no `views.open` /
`view_submission` handling), so its Reject button became "Return with a
reason" and answers with a link to the contract; Approve still decides in Slack.

## Pooled role steps

A sequential step for a role is one step with `approverRoleId` and no
approver: every holder sees it (queue, inbox, notifications), the first to
decide claims it (compare-and-set). Pooled roles change who sees what:
**announce it to admins**.
