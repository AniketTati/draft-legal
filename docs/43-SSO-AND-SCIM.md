# 43 — Single sign-on (OIDC) and SCIM provisioning

docs/41 Part 20 rates SSO/SCIM as the integration that blocks enterprise deals.
This is how it works and how an admin sets it up.

## Single sign-on (OIDC)

Each workspace can have one OpenID Connect connection: Okta, Microsoft Entra ID,
Google Workspace, OneLogin, JumpCloud, Auth0, or any OIDC provider.

**Sign-in.** On the sign-in page, the user picks "Sign in with SSO" and enters
their work email. If the email's domain belongs to a workspace's connection, the
browser goes to that provider. After the provider signs them in, it sends them back
to draftLegal, signed in. Password sign-in stays available, so a broken provider
setup can't lock an admin out.

**What the server checks on the way back** (`apps/api/src/lib/sso/oidc.ts`):
- The `state` is signed by us, used once, and tied to the browser that started
  the sign-in (an HttpOnly cookie). This blocks login CSRF.
- The code exchange uses PKCE.
- The ID token's issuer, audience, expiry and nonce are checked, and its
  signature is checked against the provider's published keys (openid-client,
  with non-repudiation checks on).
- The email must be present, must not be marked unverified, and must be in one
  of the connection's domains.
- The user must belong to this workspace. A user of another workspace is never
  signed in. A deactivated user is refused. An invited user is activated.
- With just-in-time provisioning on, an unknown user is created with the default
  role. With it off, they are told to ask their admin for an invitation.
- The provider's subject (`sub`) is linked to the user the first time. After
  that, a different subject with the same email is refused.

The browser receives a one-time code that lasts 60 seconds. The web app trades it
for its session at `POST /api/v1/auth/sso/exchange`, so tokens never appear in a
URL.

**Setup (admin).** Settings → Integrations → Single sign-on:
1. Create an OIDC "web" app at your provider. Set its sign-in redirect URI to
   the **callback URL** shown on the page (`<public URL>/api/v1/auth/sso/callback`).
   Allow the scopes `openid email profile`.
2. Enter the issuer URL, client ID and client secret. The secret is stored
   encrypted and is never shown again.
3. Enter the email domains this connection signs in (for example `acme.com`).
   Each domain can belong to only one workspace.
4. Choose just-in-time provisioning and its default role, turn the connection on,
   and click **Test connection**. The test fetches the provider's discovery
   document.

## SCIM 2.0 provisioning

Base URL: `<public URL>/scim/v2`. Authentication: a SCIM bearer token from
Settings → Integrations → Single sign-on → SCIM tokens. The token is shown once
and stored hashed.

| Resource | Supported |
|---|---|
| `GET /ServiceProviderConfig` | yes |
| `/Users` | list with `filter=userName eq "…"` (also `externalId`, `emails.value`) and paging; get; create; replace (PUT); PATCH (Okta's `path` form and Entra ID's `value` form, booleans as `"False"`); DELETE |
| `/Groups` | list with `filter=displayName eq "…"`; get; create; replace; PATCH (`add`, `remove` including `members[value eq "id"]`, `replace`); DELETE |

- **Deactivation.** `active: false` and `DELETE /Users/:id` both deactivate the
  user. The user's history stays. The user is signed out, and their API keys
  are revoked, as when an admin deactivates someone.
- **Existing users.** Creating a user whose email already exists in this
  workspace links the existing user to the provider. If the email exists in
  another workspace, the request gets `409 uniqueness`.
- **Groups to roles.** An admin picks the role each group gives (Settings →
  Single sign-on → Groups). Members get the role when they join and lose it
  when they leave. Roles granted by hand are never removed.
- Each token reaches only its own workspace. Another workspace's ids answer `404`.

## Settings an operator must configure

| Variable | Purpose |
|---|---|
| `AI_KEY_ENCRYPTION_KEY` | 32 bytes, base64. Encrypts the client secret (the existing BYOK key helper). |
| `JWT_SECRET` | Already required. Signs the SSO `state`. |
| `API_PUBLIC_URL` (optional) | The public base URL of the API, used for the callback and SCIM URLs. Defaults to `FRONTEND_URL` (the web app proxies `/api` and `/scim`). |
| `SSO_REDIRECT_URI` (optional) | Overrides the callback URL completely. |
| Hosting | `/scim/v2/**` must reach the API, as `/api/**` does (add a rewrite next to the `/api/**` one). |

## SAML: next step

There is no maintained SAML library in the lockfile, so SAML is not built yet.
Every provider listed above also speaks OIDC. When a customer needs SAML:
- add `@node-saml/node-saml` (maintained, used by passport-saml);
- add `protocol: 'saml'` connections to `SsoConnection`, with IdP metadata XML,
  an entity ID and the ACS URL;
- reuse `userForIdentity` for provisioning;
- reuse the same one-time-code hand-off to the web app.
