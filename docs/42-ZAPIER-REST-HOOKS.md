# 42 — Zapier, Make and other automation tools: REST hooks

draftLegal already sends signed webhooks for 15 events. A REST hook lets an
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

`contract.created`, `contract.uploaded`, `contract.updated`, `contract.executed`,
`signature.sent`, `signature.completed`, `signature.voided`, `approval.submitted`,
`approval.decided`, `obligation.extracted`, `obligation.completed`,
`obligation.overdue`, `invoice.created`, `invoice.reconciled`, `amendment.created`.

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
