# Single sign-on (OpenID Connect), Phase 8

**Status:** it works end to end against oidc-provider, an independent, OpenID-certified implementation, in the
tests. It has **not** been tried with a customer's identity provider (Microsoft Entra ID, Okta, Keycloak,
Google Workspace). It sits behind `VIGILONE_FEATURE_OIDC_SSO`, which is OFF by default.

## How a login works

1. The login page lists the enabled providers (`GET /api/v1/sso/login-options`). The user picks one.
2. VigilOne sends the browser to the provider using an authorization code with PKCE. The `state` and `nonce`
   are random, and are stored only as SHA-256 hashes in the database. Each one is single use and expires
   after 10 minutes.
3. The provider sends the browser back to `/api/v1/sso/callback`. VigilOne then:
   * exchanges the code, authenticating as the client with `client_secret_basic`;
   * verifies the ID token against the provider's published keys: signature, issuer, audience, expiry, nonce,
     and `azp` when there are several audiences. Only asymmetric algorithms are accepted;
   * reads missing claims (email, groups) from the userinfo endpoint, whose `sub` must match the ID token's.
4. VigilOne finds the account:
   * an identity that is already linked (provider plus `sub`) signs in as its user;
   * otherwise it links a user of the provider's tenant that has the same email, but only if the provider says
     the email is **verified** and its domain is in `allowedEmailDomains` (an empty list allows any domain);
   * otherwise it creates a user, but only when `autoProvision` is on. The role comes from the group mapping,
     or else `defaultRole`;
   * otherwise it refuses and records why in the audit log (`SSO_LOGIN_REFUSED`).
5. The browser lands on `/sso/complete#code=...`. The page exchanges this one-time code (single use, valid
   for 60 seconds) for a normal VigilOne session (`POST /api/v1/sso/exchange`).

Rules that always hold:
* Super administrators never sign in through SSO, and SSO never grants the SUPER_ADMIN role.
* A disabled VigilOne user cannot sign in through SSO.
* A user from another tenant is never linked.
* When `roleClaim` and a mapping are set, the highest mapped role is applied at every login. The identity
  provider is then the source of truth for roles.

## Setting it up

1. At the identity provider, register a confidential web client:
   * redirect URI `https://<your VigilOne address>/api/v1/sso/callback`;
   * scopes `openid email profile`, plus a groups scope or claim if roles will be mapped.
2. On the VigilOne server:
   * set `VIGILONE_PUBLIC_URL=https://<your VigilOne address>` (required in production; the callback and the
     final redirect use it);
   * set `VIGILONE_FEATURE_OIDC_SSO=true`.
3. In VigilOne (as a tenant administrator), send `POST /api/v1/sso/providers` with:

   ```json
   {
     "name": "Corp IdP",
     "issuerUrl": "https://login.example.com/realms/corp",
     "clientId": "vigilone",
     "clientSecret": "…",
     "scopes": ["openid", "email", "profile"],
     "allowedEmailDomains": ["example.com"],
     "autoProvision": false,
     "roleClaim": "groups",
     "roleMapping": { "vms-operators": "OPERATOR", "vms-admins": "TENANT_ADMIN" }
   }
   ```

   VigilOne fetches the provider's discovery document when you save, and refuses the provider if it cannot.
   The issuer must be `https`; plain `http` is accepted only for a loopback address outside production. The
   client secret is stored encrypted (AES-256-GCM) and is never returned.

**Upgrading from before Phase 8:** the old code stored client secrets in plain text. The migration blanks them
and disables those providers. Enter each secret again, then re-enable the provider.

## Not done

* No test yet against Entra ID, Okta, Keycloak or Google Workspace. Claim names differ between them
  (groups, roles, `preferred_username`).
* No single logout, no back-channel logout, no SAML, and no SCIM provisioning.
* The administration screen (`IdentitySettings.tsx`) sets the name, issuer, client ID, secret and scopes. The
  domain allow-list, automatic provisioning and role mapping can be set only through the API for now.
