# 42 — Zapier, Make and other automation tools: REST hooks

draftLegal already sends signed webhooks for 17 events. A REST hook lets an
automation tool (Zapier, Make, n8n, Workato) subscribe to one of them when a user
turns a trigger on, and unsubscribe when they turn it off. No admin needs to copy
URLs. This follows the REST Hooks pattern (resthooks.org) that Zapier's platform
uses. It is the "Zapier" row in docs/41 Part 20.

## Authentication

Use an API key with the **`hooks`** scope (Settings → Integrations → API keys).
The scope allows subscribing and unsubscribing, and nothing else. To read
contracts in the same Zap, give the key `contracts:read` as well.

```
Authorization: Bearer clm_live_…
```

## Endpoints

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/v1/hooks` | Subscribe. Body: `{ "target_url": "https://hooks.zapier.com/…", "event": "contract.executed" }`. `url` or `hookUrl` are accepted in place of `target_url`. Returns `201 { id, event, target_url, name, secret, createdAt }`. |
| `DELETE` | `/api/v1/hooks/:id` | Unsubscribe. Returns `204`, or `404` if the id is not one of this workspace's subscriptions. |
| `GET` | `/api/v1/hooks` | This workspace's subscriptions (the same list as Settings → Integrations → Webhooks). |
| `GET` | `/api/v1/hooks/samples/:event` | One sample delivery for the event, as an array. Use it for Zapier's "perform list" (the trigger's test step). |

A subscription is an ordinary webhook with one event:
- it appears on the Integrations page, where an admin can pause or delete it;
- deliveries are signed, retried (5 attempts, exponential backoff) and logged
  in Integrations → Health, like every other webhook;
- `target_url` must be a public `https` or `http` address. Private, loopback and
  cloud-metadata addresses are refused, as for every webhook.

## Events

All 17, with a sample `data` for each. The samples are the ones
`GET /api/v1/hooks/samples/:event` returns.

| Event | When | Sample `data` |
|---|---|---|
| `contract.created` | A contract is created (drafted, from a template or a request). | `{ "contractId": "cmb1example0contract", "title": "Mutual NDA — Acme Corp", "type": "NDA", "status": "DRAFT", "counterpartyName": "Acme Corp" }` |
| `contract.uploaded` | A contract file is uploaded. | `{ "contractId": "cmb1example0contract", "title": "Master Services Agreement", "filename": "msa.pdf", "mimeType": "application/pdf", "fileSize": 248113 }` |
| `contract.updated` | A contract's details change. | `{ "contractId": "cmb1example0contract", "title": "Mutual NDA — Acme Corp", "status": "UNDER_NEGOTIATION", "changes": ["status"], "source": "user" }` |
| `contract.executed` | A contract is signed by everyone. | `{ "contractId": "cmb1example0contract", "executedAt": "2026-10-01T14:03:00.000Z" }` |
| `contract.stage_changed` | A contract moves stage or state (Draft, Negotiate, Approve, Sign, Active, Closed; expiry included). `reason` is present when the move gave one. | `{ "contractId": "cmb1example0contract", "from": { "stage": "negotiate", "state": "with_us" }, "to": { "stage": "approve", "state": "pending" }, "status": "PENDING_APPROVAL", "turn": "approvers", "source": "approval" }` |
| `contract.turn_changed` | Whose move it is changes (internal, counterparty, approvers, signers, none). | `{ "contractId": "cmb1example0contract", "from": "internal", "to": "counterparty", "stage": "negotiate", "source": "send" }` |
| `signature.sent` | A contract is sent for signature. | `{ "contractId": "cmb1example0contract", "signatureRequestId": "cmb1example0sigreq", "signerCount": 2, "signOrder": "parallel", "expiresAt": "2026-10-31T00:00:00.000Z" }` |
| `signature.completed` | Every signer has signed. | `{ "contractId": "cmb1example0contract", "signatureRequestId": "cmb1example0sigreq", "signerCount": 2, "completedAt": "2026-10-01T14:03:00.000Z" }` |
| `signature.voided` | A signature request is voided or a signer declines. | `{ "contractId": "cmb1example0contract", "signatureRequestId": "cmb1example0sigreq", "reason": "Jane Doe declined: wrong entity" }` |
| `approval.submitted` | A contract is submitted for approval. | `{ "contractId": "cmb1example0contract", "title": "Order Form — Acme Corp", "type": "ORDER_FORM", "value": 45000, "currency": "USD", "instanceId": "cmb1example0approval", "stepId": "cmb1example0step", "stepName": "Legal review", "approverId": "cmb1example0user" }` |
| `approval.decided` | An approver decides a step. `decision` is `APPROVED` or `REJECTED` (a return or a decline); `outcome` says which. | `{ "instanceId": "cmb1example0approval", "contractId": "cmb1example0contract", "stepId": "cmb1example0step", "decision": "APPROVED", "outcome": "approved", "instanceStatus": "APPROVED", "decidedBy": "cmb1example0user" }` |
| `obligation.extracted` | Obligations are found in a contract. | `{ "contractId": "cmb1example0contract", "count": 4 }` |
| `obligation.completed` | An obligation is marked done. | `{ "obligationId": "cmb1example0obligation", "contractId": "cmb1example0contract", "type": "PAYMENT", "completedAt": "2026-10-01T09:00:00.000Z", "hasEvidence": true }` |
| `obligation.overdue` | An obligation passes its due date (daily check). | `{ "contractId": "cmb1example0contract", "obligationId": "cmb1example0obligation", "description": "Deliver the quarterly security report", "dueDate": "2026-09-30", "daysOverdue": 1 }` |
| `invoice.created` | An invoice is added. | `{ "invoiceId": "cmb1example0invoice", "contractId": "cmb1example0contract", "vendorName": "Acme Corp", "amount": 12000, "currency": "USD", "status": "PENDING" }` |
| `invoice.reconciled` | An invoice is matched to its contract. | `{ "invoiceId": "cmb1example0invoice", "contractId": "cmb1example0contract", "obligationId": "cmb1example0obligation", "reconciledAt": "2026-10-01T09:00:00.000Z" }` |
| `amendment.created` | An amendment is made to a contract. | `{ "contractId": "cmb1example0amendment", "parentContractId": "cmb1example0contract", "relationshipType": "amendment", "title": "Amendment No. 1", "type": "AMENDMENT" }` |

`GET /api/v1/admin/integrations/events` returns the same list.

## What a delivery looks like

```http
POST <target_url>
Content-Type: application/json
X-CLM-Event: contract.executed
X-CLM-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the subscription's secret>
X-CLM-Delivery-Id: <id>

{ "event": "contract.executed", "timestamp": "2026-10-01T14:03:00.000Z",
  "data": { "contractId": "…", "executedAt": "2026-10-01T14:03:00.000Z" } }
```

To check that a delivery came from us, compute the HMAC of the raw body with the
`secret` that the subscribe call returned, and compare it with `X-CLM-Signature`.
Zapier does not need to check it, because the hook URL it gives is a secret too.

## A Zapier trigger, in Zapier's platform

- **Subscribe:** `POST {{api}}/api/v1/hooks` with
  `{ "target_url": "{{bundle.targetUrl}}", "event": "contract.executed" }`.
- **Unsubscribe:** `DELETE {{api}}/api/v1/hooks/{{bundle.subscribeData.id}}`.
- **Perform list:** `GET {{api}}/api/v1/hooks/samples/contract.executed`.
- **Perform:** return `[bundle.cleanedRequest]`. Each delivery is one trigger run;
  the contract is in `data`.

## Code

`apps/api/src/routes/hooks.ts` (routes), `apps/api/src/lib/integrations/hook-samples.ts`
(samples, one per event; a unit test fails if an event has none), and the webhook
worker `apps/api/src/workers/webhook.worker.ts` (delivery).
