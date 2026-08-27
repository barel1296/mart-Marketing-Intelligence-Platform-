# Security

## Authentication

- Passwords are hashed with **scrypt** (N=32768, r=8, p=1) and stored in a
  self-describing format that records the parameters, so they can be raised later
  without invalidating existing hashes. Verification uses `timingSafeEqual`.
- Password policy: at least 12 characters, with upper case, lower case and a
  digit. Enforced server-side; the client hint is only a hint.
- Login is **timing-equalized**: a request for an unknown email performs the same
  work as one for a known email, so response time does not reveal which accounts
  exist. The error message is identical in both cases.
- Sessions are random 32-byte tokens. The database stores **only a SHA-256 hash**
  of the token, so a database read does not yield usable sessions.
- The session cookie is `HttpOnly`, `SameSite=Lax`, `Secure` in production (the
  API refuses to boot in production with `COOKIE_SECURE=false`), and scoped to
  the app path.

## CSRF

Double-submit: on login the API sets a second, readable `mart_csrf` cookie whose
hash is bound to the session. Every state-changing request must echo it in the
`x-mart-csrf` header. A `preHandler` enforces this for all non-GET routes except
login and registration, where no session exists yet.

Because the Next.js app rewrites `/api` to the API service, everything is
same-origin and the session cookie is first-party — there is no third-party
cookie dependency and no CORS wildcard.

## Multi-tenancy

Every tenant-scoped request goes through `withOrganization` or `withApp`, which:

1. resolve the session from the cookie (never from a header or body field);
2. look up the caller's membership in the requested organization;
3. verify the requested app belongs to that organization;
4. check the role has the required permission.

Two deliberate choices:

- **A non-member gets 404, not 403.** Returning 403 would confirm that an
  organization id exists. The API declines to be an existence oracle.
- **Ids from the browser are never trusted as scope.** They are inputs to an
  authorization check, and every downstream query re-applies `organization_id` in
  its `WHERE` clause rather than relying on the check having happened.

Twelve integration tests assert isolation at both levels — API responses and
stored rows — including the case where an attacker pairs their own organization
id with another tenant's app id.

### Roles

`viewer ⊂ analyst ⊂ admin ⊂ owner`, over 16 permissions. The ladder is asserted
by a test: a lower role can never hold a permission a higher role lacks. Notable
boundaries: an analyst can trigger a sync but cannot manage credentials; an admin
can connect integrations but cannot change organization settings reserved for the
owner.

## Credential handling

This is the part that would do the most damage if it were wrong, so it is worth
stating precisely.

- Provider secrets are encrypted with **AES-256-GCM** before they are written.
  The additional authenticated data is `organizationId:connectionId`, so a
  ciphertext moved to another tenant or another connection fails to decrypt
  rather than decrypting into the wrong context.
- The `integration_credentials` table has **no plaintext column**. Ciphertext,
  IV and auth tag are `bytea`; there is nowhere for a plaintext secret to land.
- The generic connection queries select an explicit column list that excludes
  credentials entirely, so no ordinary query can accidentally serialize a secret
  into a response.
- The API returns only credential **metadata**: a fingerprint (proving a
  credential exists and whether it changed), an expiry and a rotation time. An
  integration test asserts the connection payload's credential object has exactly
  `['expiresAt', 'fingerprint', 'rotatedAt']` and nothing else.
- Secrets are dropped from client component state immediately after a successful
  submit, are never placed in a URL, and are never rendered.
- `CredentialStore` is an interface. The Phase 0A implementation encrypts with a
  local key from `MART_CREDENTIAL_KEY`; a KMS-backed implementation drops in
  without touching a route. The key version is stored per credential so rotation
  is a migration rather than a re-entry.
- Disconnecting a provider **deletes** the stored credential. Historical data is
  retained with its provenance.

## Logging

Two independent layers, because one is not enough:

1. pino's path-based `redact` for known sensitive paths (headers, body fields).
2. A recursive key-pattern scrubber applied to every logged object, matching
   `token`, `secret`, `password`, `key`, `authorization`, `credential` and
   friends at any depth.

Provider HTTP logging records method, host, path, status and duration —
`safeHeaders()` strips authorization before anything is logged, and response
bodies are never dumped wholesale. A unit test plants a secret at several nesting
depths and asserts it does not appear in the output.

## Input validation

Every request body, params object and query string is parsed with zod at the
route boundary. A `ZodError` becomes a 400 with field-level detail; an
`AppError`/`ProviderError` maps to its own status and user message. Unhandled
errors return a generic message with a request id — the id is the only thing the
client gets, and the detail stays in the log.

Rate limiting is applied per user and per organization to the operations worth
protecting: authentication, mutations, and sync triggers.

## Response and transport hardening

Security headers on every API response: `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a restrictive
`Content-Security-Policy`, and `Cache-Control: no-store` on tenant-scoped data.

## Audit

`audit_log` is append-only, enforced by a trigger that raises on UPDATE and
DELETE. Recorded events include connection created / validated / credential
replaced / disconnected, account selection changed, primary attribution provider
changed (with `from` and `to`), sync triggered, mapping verified, app created and
updated, and membership changes. Entries record what happened, never what it
happened with: a connection audit row names the provider and the validation
result, never the credential.

## Secrets in the repository

`.env` is git-ignored; `.env.example` documents every variable with no real
values. The `MART_CREDENTIAL_KEY` must be 32 random bytes, base64 — config
validation rejects anything else, so the platform cannot boot with a weak or
placeholder key. No credential, token or key is committed anywhere in this
repository.
