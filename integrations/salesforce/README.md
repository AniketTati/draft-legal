# draftLegal for Salesforce

Sales starts and tracks contracts without leaving Salesforce. Legal works in
draftLegal. This is the Salesforce side of docs/41 Part 17, as an SFDX
project. The draftLegal side lives in `apps/api` (routes `salesforce.ts`,
`lib/salesforce/*`, the `integration-sync` worker).

**Who owns what.** Salesforce owns the commercial deal until signing. draftLegal
owns the contract.
- Fields mapped *From Salesforce* follow Salesforce until the contract goes out
  for signature.
- After that, a change in Salesforce is never written to the contract. It
  becomes a decision for the contract's owner, for example "Salesforce changed
  Contract value: 40,000 → 45,000. Update contract?"
- Status, stage, whose turn, dates, value and the signed PDF flow from draftLegal
  to Salesforce.

## What's in the package

| Piece | What it does |
|---|---|
| `DL_Contract__c` (draftLegal Contract) | One record per draftLegal contract. The integration user writes it (upsert by the external id `DL_Contract_Id__c`). It holds status, stage, *Waiting on*, approvals, dates, value, counterparty, lookups to Account and Opportunity, the Quote id and *Open in draftLegal*. The signed PDF is attached as a File. Everyone else can only read it. |
| `DL_Request__c` (draftLegal Request) | One record per request a rep sent, with a link to it in draftLegal. |
| `DraftLegalApi` (Apex) | Calls draftLegal through the `draftLegal` Named Credential and adds this org's id (`X-Salesforce-Org-Id`). draftLegal refuses a call from any other Salesforce org. |
| `DraftLegalRecords` (Apex) | Reads the Opportunity, Account and Quote fields that the field map names. It reads in user mode, so field-level security applies. |
| `DraftLegalRequestAction` | Flow action **Create draftLegal request** (Opportunity, Quote or Account → request; optional *Generate now* for self-serve types). |
| `DraftLegalChangeAction` | Flow action **Tell draftLegal a deal changed**. Use it in a record-triggered Flow. It runs asynchronously. |
| `DraftLegalApiTest` | Apex tests against a mocked draftLegal. No callouts leave the org. |
| LWC `dlNewContract` | The native "New contract" form for Opportunity, Quote and Account record pages, or as a quick action. It is built from the field map for the chosen type. Locked fields are read-only. |
| LWC `dlContractStatus` | On the draftLegal Contract page: the stage path, *Waiting on*, approvals, key terms and **Open in draftLegal**. |
| LWC `dlDocumentPreview` | The contract's current document in a frame, read-only. It uses a 10-minute signed link, so no draftLegal sign-in is needed. |
| `draftLegal` External Credential + Named Credential | Store the draftLegal API key and send it as `Authorization: Bearer …`. |
| `draftLegal` CSP Trusted Site | Lets Lightning frame the document preview (`frame-src`). |
| Permission sets `draftLegal Integration`, `draftLegal User` | For the integration user, and for reps and managers. |

## Setup

### 1. draftLegal server (once, by the operator)

Create a **Connected App** (or External Client App) in a Salesforce org you
control. It is draftLegal's app, and every customer org authorises it.
- Enable OAuth. Callback URL: `<public draftLegal URL>/api/v1/integrations/salesforce/oauth/callback`
  (Settings → Integrations → Salesforce shows the exact value).
- Scopes: **Manage user data via APIs (`api`)** and **Perform requests at any time
  (`refresh_token`, `offline_access`)**.
- Require PKCE (Proof Key for Code Exchange). draftLegal always sends it.
- Refresh token policy: *valid until revoked*.

Then set these on the API (and on the worker service, which runs the sync):

| Variable | Value |
|---|---|
| `SALESFORCE_CLIENT_ID` | the Connected App's consumer key |
| `SALESFORCE_CLIENT_SECRET` | its consumer secret |
| `AI_KEY_ENCRYPTION_KEY` | 32 bytes, base64. It already encrypts BYOK keys, and it now encrypts Salesforce tokens too. |
| `API_PUBLIC_URL` (optional) | the public base URL for the callback, if it isn't `FRONTEND_URL` |
| `SALESFORCE_REDIRECT_URI` (optional) | overrides the callback URL completely |

Hosting: `/embed/**` must be allowed in a frame by Salesforce. `firebase.json`
sends `Content-Security-Policy: frame-ancestors 'self' https://*.lightning.force.com https://*.my.salesforce.com …`
for it. Browsers ignore `X-Frame-Options` when `frame-ancestors` is present.

### 2. The customer's draftLegal workspace (an admin)

1. **Settings → Integrations → Salesforce → Connect Salesforce.** Choose
   Production, Sandbox or your My Domain, and sign in as the Salesforce
   **integration user**. draftLegal stores that org's id. One Salesforce org
   connects to one draftLegal workspace.
2. **Field map.** Map Salesforce fields (picked from your org's own fields) to
   draftLegal fields:
   - *From Salesforce*: for example Opportunity `Amount` → Contract value, and
     Account `Name` → Counterparty. Tick **Read-only** to lock a field on the
     rep's form.
   - *To Salesforce*: for example Contract value → Opportunity `Amount`, written
     once the contract is signed.
   - A template variable: choose *A template variable…* and enter its name.
3. **Generate straight from Salesforce:** list the self-serve types (NDA by
   default).
4. **Settings → Integrations → API keys:** create a key with the **salesforce**
   scope. You'll paste it into Salesforce next. It can create requests, generate
   self-serve contracts and read status, and nothing else.

### 3. The customer's Salesforce org (a Salesforce admin)

1. Deploy the package:
   `sf project deploy start --source-dir force-app --target-org <alias>`.
   It needs API 61.0 or later.
2. **Named Credential `draftLegal`**: set its URL to your draftLegal address
   (for example `https://app.draft-legal.com`).
3. **External Credential `draftLegal` → Principal `ApiKeyPrincipal`**: add the
   parameter **`ApiKey`** with the key from step 2.4.
4. **CSP Trusted Site `draftLegal`**: point it at the same address.
5. Assign **draftLegal Integration** to the integration user, and
   **draftLegal User** to reps and managers. Both grant the External Credential
   principal.
6. **Pages**: add **draftLegal: New contract** to the Opportunity page (or create
   a quick action from it). Add **draftLegal: Contract status** and
   **draftLegal: Document preview** to the draftLegal Contract page. Add the
   *draftLegal Contracts* related list to Account and Opportunity.
7. **Optional Flows:**
   - Record-triggered on Opportunity *update* (for example when `Amount`,
     `CloseDate` or `StageName` changes): **Tell draftLegal a deal changed**.
   - Record-triggered when an Opportunity reaches a stage: **Create draftLegal
     request**, on an *asynchronous path*, because callouts can't run in the
     save transaction.

## How it works

- **DL → SF (S1).** Every contract event (created, updated, status changed,
  approvals, signatures, executed) queues a sync. Changes within 5 seconds are
  batched.
  - The worker upserts `DL_Contract__c` through the Composite API (200 records a
    call).
  - On a 401 it refreshes the token. On `429` or `REQUEST_LIMIT_EXCEEDED` it
    backs off for as long as Salesforce asks.
  - A payload the record already shows is skipped.
  - On execution it files the signed PDF on the record and on the Opportunity,
    once.
  - A nightly run (03:30) compares and repairs drift.
  - Every attempt is logged: Settings → Integrations → Salesforce → Sync log, and
    Health, each with **Retry**.
- **SF → DL (S2).** The form or Flow posts the mapped record data to
  `POST /api/v1/integrations/salesforce/requests`.
  - draftLegal makes a request pre-filled through the map and links (or creates)
    the counterparty by Account id (`crmId`).
  - A rep whose email is a draftLegal member becomes the requester. Otherwise
    the request records who asked.
  - *Generate now* drafts a self-serve type at once.
- **Changes (S2/S3).** `POST /api/v1/integrations/salesforce/changes` updates the
  open requests and contracts made from the record, under the ownership rule
  above.
- **Embedded preview (S3).** `POST /api/v1/integrations/salesforce/embed-token`
  returns a link to `/embed/contracts/:id?token=…`. The link names one contract
  of one workspace, allows reading only, and expires in 10 minutes.

## Tests

- **Apex:** `sf apex run test --class-names DraftLegalApiTest --target-org <alias>`.
- **The draftLegal side:** `apps/api` unit tests (`lib/salesforce/*.test.ts`,
  `lib/integrations/*.test.ts`) and integration tests
  (`routes/salesforce-inbound.integration.test.ts`,
  `workers/integration-sync.integration.test.ts`).
- **LWC Jest:** not set up. `@salesforce/sfdx-lwc-jest` is not in the monorepo,
  and installing it only for these three components wasn't worth it. Run
  `sf force lightning lwc test setup` in this folder to add it. The pure helpers
  (`toFormField`, `formatValue`) are exported so they can be tested first.

This package can't be deployed from this repository's CI (there is no Salesforce
org). Deploy it to a scratch org or sandbox before the first customer.

## Not done yet

- **CPQ line items (S3).** Sync on primary-quote approval into the contract's
  dynamic tables: a new version when the draft is unedited, otherwise a
  reconcile task. The API's conflict model already covers the reconcile half.
- **Messages both ways (S3).** Messages from Salesforce would become comments
  with `source: salesforce`, and draftLegal comments would show in Salesforce.
- **Mapped user actions.** End-user actions would carry the Salesforce user's
  email or federation id, mapped to a draftLegal user. Requests already do this.
- **Packaging (S4).** A namespace and second-generation managed package
  (`sf package create`), then AppExchange security review.
- **Several Salesforce orgs per workspace.** One today (the
  `IntegrationConnection` unique key is per org and provider).
