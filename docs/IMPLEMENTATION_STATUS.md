# Checkpoint 6 implementation status

Last verified: 2026-09-08

Architecture: AWS serverless/DynamoDB is approved by ADR 0001. Dev environment
resources have been provisioned in us-east-1 (account 598628878271). See the
provisioned resources section below for identifiers.

## Verified locally

- Authoritative OpenAPI 3.1 contract includes non-sensitive health and guest
  session creation/recovery, idempotency conflict, validation, rate-limit, and
  server-error responses with correlation IDs.
- Guest domain service validates client input, hashes installation IDs, depends
  on repository/token-issuer ports, and contains no AWS SDK types.
- Bearer authentication depends on an access-token verifier port that returns a
  minimal authenticated principal; issuer/audience values remain environment
  configuration rather than domain constants.
- Sign in with Apple depends on a provider-verifier port and accepts only the
  verified Apple issuer/subject. Apple tokens, authorization codes, and nonces do
  not enter player records or provider keys.
- Guest-to-Apple linking requires a guest principal. An identity already linked
  to progress returns an opaque conflict ticket and requires an explicit save
  choice; economy, unlocks, and entitlements remain server-reconciled.
- In-memory Apple/account adapters cover new sign-in, provider recovery, linking,
  explicit conflict resolution, authorization rejection, and idempotency conflict
  behavior without AWS or provider network access.
- Authenticated account lookup derives its resource key only from the verified
  principal and returns the current profile/deletion state without accepting a
  caller-selected player identifier.
- Account deletion uses explicit confirmation and a reauthentication-policy port.
  The repository boundary durably transitions deletion state and appends one audit
  event before the session-revocation boundary runs; identical retries are safe.
- The deletion contract returns `202` with visible `requested`/`processing` state.
  It specifies asynchronous deletion/anonymization and permits only minimized
  legally, accounting, purchase, or fraud-required retention.
- Authenticated save reads/writes are scoped by the verified player and slot.
  Writes require `expectedRevision`, increment exactly once, hash the random
  app-scoped device identifier, and replay idempotently within player scope.
- Stale or concurrent save writes never overwrite the winner. They return an
  explicit conflict carrying current revision/schema/update metadata so the
  client can fetch and present a deliberate resolution path.
- Save snapshots are versioned non-executable JSON objects with local size,
  nesting, finite-number, and key-length validation. In-memory concurrency tests
  prove exactly one writer wins from the same expected revision.
- Economy balance reads are player-scoped and server-authoritative. Clients can
  request only recognized spend actions/references; server rule ports determine
  resources, costs, grants, reason codes, and resulting atomic mutations.
- Reward claims accept no client-provided resource, amount, delta, or reason.
  A verifier port supplies positive grants, and a player/claim uniqueness key
  prevents a verified claim from granting twice even with a new idempotency key.
- Atomic economy writes validate every resulting balance before committing,
  reject stale revisions and insufficient funds without partial ledger entries,
  increment balance revision once, and append immutable per-resource entries.
- Entitlement reads are player-scoped and expose active, revoked, and refunded
  states across sandbox/production without trusting StoreKit callbacks directly.
- App Store purchase verification accepts only signed transaction payloads behind
  a verifier port, then checks the immutable app-account-token/player binding and
  a server product catalog before one atomic grant. Transaction IDs are globally
  unique per StoreKit environment and cannot be claimed by another player.
- Signed App Store notification verification is isolated behind a provider port.
  Notification IDs are globally idempotent, and verified refund/revocation events
  update known non-consumable entitlement state without trusting request fields.
- Pure DynamoDB notification transaction builders now durably claim every
  environment-scoped notification ID. Known purchases atomically transition the
  exact transaction and, for non-consumables, its exact entitlement; unknown
  transactions are recorded as ignored. Consumable notifications record provider
  state but intentionally create no balance or ledger debit pending an approved
  clawback/debt policy. The concrete DynamoDB repository now performs strong
  notification, transaction, and entitlement reads; maps durable replays to
  duplicate results; and retries one concurrent state transition. The HTTP route
  remains disabled pending an Apple notification verifier and deployment approval.
- Rewarded-ad completion requires provider verification plus exact player and
  preissued claim binding. Provider event IDs are globally unique, and server
  reward configuration—not the client label—determines the positive grant.
- The commerce repository boundary groups global dedupe, balance/ledger grants,
  and entitlement changes as one atomic operation. In-memory tests cover duplicate
  transactions/events across new idempotency keys and cross-player ownership.
- A pure DynamoDB purchase transaction builder now atomically claims the
  environment-scoped StoreKit transaction, conditionally updates an authoritative
  balance, appends immutable IAP ledger entries, writes a non-consumable
  entitlement when applicable, and stores the hashed idempotent result. Raw
  idempotency keys and app-account tokens are never persisted. The purchase route
  remains disabled pending Apple verifier adapters and deployment approval.
- A concrete DynamoDB commerce repository now executes that purchase transaction
  behind strong idempotency, transaction-ownership, and balance reads. It records
  durable receipts for duplicates submitted under new keys, rejects cross-player
  claims, recovers concurrent winners, and retries one unrelated balance race.
  Notification processing remains explicitly fail-closed until its atomic
  adapter is implemented.
- A pure DynamoDB rewarded-ad transaction builder now atomically claims the
  verified provider event, conditionally updates the authoritative balance,
  appends immutable `AD_REWARD` ledger entries, and stores a hashed idempotent
  result. It rejects cross-player completions, repeated resource mutations, and
  unsafe key/value shapes before constructing a write. Provider payloads never
  enter persistence. The concrete repository executes this transaction with
  strong replay/event reads, cross-player protection, durable duplicate
  receipts, concurrent-winner recovery, and one bounded balance-race retry. The
  ad route remains disabled pending a provider verifier and deployment approval.
- Public content catalog and remote-configuration services depend on repository,
  detached-signature verifier, and HTTPS URL-policy ports rather than S3,
  CloudFront, or key-service types. No bucket, distribution, hostname, or key ID
  has been selected.
- Catalog validation requires unique pack IDs, approved editorial status, valid
  checksums/sizes/build ranges, a matching environment channel, allowlisted CDN
  URLs, and at least one permanent starter pack.
- Signed configuration has a fixed feature-flag shape and compiled safe bounds for
  starting balances, energy, regeneration, daily gifts, and rewarded-ad limits.
  Unsafe values or public links are rejected even after signature acceptance.
- Shared framework-neutral HTTP support now performs per-route rate limiting,
  bearer verification, correlation IDs, privacy-safe structured logging, JSON
  parsing, and problem responses without importing API Gateway or Lambda types.
- Account profile/deletion handlers enforce principal-derived resource access,
  map nested Apple reauthentication only into the policy port, and never log
  bearer/provider credentials or request bodies.
- Save read/write handlers support slot selection, strict transport validation,
  idempotency headers, and explicit revision-conflict documents containing only
  current revision/schema/update metadata—not either snapshot.
- Apple sign-in/link handlers apply public/authenticated rate limits, validate the
  strict credential envelope, map provider verification failures safely, and
  return only an opaque conflict ID plus allowed save choices—never either
  conflicting player identifier.
- Economy handlers expose authoritative balances, recognized spend/reward inputs,
  explicit revision and insufficient-funds conflicts, and player-scoped
  entitlements. Public ledger entries intentionally omit internal idempotency key,
  client-build, and content-version storage fields.
- Handler tests confirm Apple identity tokens, nonces, bearer tokens, reward claim
  tokens, source IPs, request bodies, and internal ledger metadata are not logged
  or returned outside their contract.
- Purchase, App Store notification, and rewarded-ad handlers now enforce their
  authenticated/public boundaries, strict transport shapes, provider-safe error
  mapping, idempotency headers, and public commerce response projection. Signed
  transaction/notification/ad payloads are never logged or echoed.
- Content catalog/configuration handlers require explicit platform/build/locale
  (and catalog channel) query inputs, apply public rate limits, and map signature,
  policy, or availability failures to a generic `503` without leaking key/policy
  diagnostics.
- The application composition root now assembles all 17 contract routes from
  domain services and shared handler dependencies without eagerly accessing AWS
  or provider implementations.
- An exact method/path router rejects duplicate route definitions at startup,
  distinguishes `404` from `405`, and contains escaped handler failures as
  privacy-safe `500` responses.
- A structural API Gateway HTTP API v2 adapter maps raw paths, methods, headers,
  cookies, query parameters, source IPs, and plain/base64 request bodies to the
  framework-neutral request model. It imports no AWS SDK or Lambda type package.
- In-memory guest repository provides same-request replay, rejects changed-input
  idempotency-key reuse, and recovers one player per installation hash.
- Framework-neutral handlers compatible with an API Gateway HTTP API adapter
  return health and guest-session responses without importing AWS SDK types.
- Local fixed-window rate limiter and structured-logger ports are wired at the
  handler boundary. Tests verify raw installation IDs, source IPs, and tokens do
  not enter structured log events.
- DynamoDB access patterns, keys, transactional conditions, idempotency records,
  secondary-index policy, and versioned migration process are documented in
  `docs/dynamodb-data-model.md`.
- Runtime configuration now fails closed unless the environment name, player
  table, HTTPS token issuer, and token audience are supplied explicitly; no AWS
  account, Region, table, issuer, or client identifier is hardcoded.
- The concrete Cognito JWT verifier is implemented locally. It resolves issuer
  JWKS at runtime and enforces RS256, exact issuer, expiry/time claims,
  `token_use=access`, exact `client_id`, immutable UUID `player_id`, and bounded
  `session_kind`, returning only a minimal domain principal.
- Offline RSA tests cover valid principals, wrong token use/client, expiration,
  missing application identity, and invalid/unsupported signatures. Cognito must
  still be configured to inject authoritative `player_id` and `session_kind`
  claims; the token contract is recorded in
  `docs/authentication-token-contract.md`.
- The API contract now defines refresh-token rotation and authenticated session
  revocation endpoints. Framework-neutral services and handlers keep opaque
  refresh credentials out of URLs/logs, map invalid credentials generically,
  and require revocation to bind the credential to the verified player.
- The concrete Apple JWKS verifier is implemented locally. It enforces Apple's
  exact issuer, an environment-supplied audience, RS256/JWKS signature, expiry,
  bounded subject, and a constant-time match between the token nonce and the
  SHA-256 digest of the caller's raw nonce.
- Offline RSA tests cover valid Apple assertions, issuer/audience mismatch,
  expiry, nonce mismatch, missing/malformed subjects, and unsupported signing
  algorithms. Platform identifiers and any authorization-code/private-key
  workflow remain undeployed and are documented in
  `docs/apple-identity-verification.md`.
- The concrete DynamoDB guest repository is implemented locally. It uses
  consistent reads and a conditional transaction to create the player,
  installation mapping, and expiring hashed-key idempotency result atomically;
  contention recovers the winning installation without retaining the raw ID.
- Guest creation now initializes the authoritative revision-one balance in that
  same transaction. Starting coins, gems, and energy are injected from trusted
  server configuration and never accepted from the session request.
- Offline adapter tests inspect generated DynamoDB commands and cover atomic
  creation, identical replay, changed-request rejection, and transaction-race
  recovery. The adapter is not yet wired into or deployed to the Lambda.
- The concrete DynamoDB save repository is implemented locally with strongly
  consistent player/slot reads, exact revision conditions, atomic save/result
  transactions, player-scoped hashed idempotency keys, durable original-result
  replay, and explicit metadata-only conflict recovery after concurrent writes.
- Serialized save snapshots are capped at 300 KiB so the save and replay items
  retain safe metadata headroom below DynamoDB's 400 KiB per-item limit.
- The concrete DynamoDB account repository is implemented locally with strongly
  consistent principal-scoped profile reads and strict storage-version checks.
  Account deletion atomically transitions the profile, creates a resumable job,
  appends one immutable audit event, and stores the original receipt before the
  service invokes session revocation. Later retries reuse the durable job and do
  not create duplicate audit events.
- Apple linking now exposes separate persistence operations for an initial guest
  link and an explicit conflict resolution. This prevents a DynamoDB adapter
  from treating `preferGuestSave` or `preferExistingSave` as a simple provider
  pointer update; resolution must pass through the forthcoming atomic
  save/economy/entitlement reconciliation boundary.
- CI runs OpenAPI lint, strict TypeScript compilation, and Node tests.
- A local AWS persistence composition factory now assembles the concrete guest,
  account, Apple sign-in/link, save, and offline-sync DynamoDB adapters without
  network access at construction. Explicit account-link reconciliation resolution remains
  fail-closed until its full reconciliation transaction is implemented.
- A local AWS identity-service composition factory now combines those concrete
  repositories with the Cognito access-token verifier, Apple identity verifier,
  guest/account/save services, and injected provider lifecycle ports. Factory
  construction is covered by an offline test and performs no AWS or Apple calls.
- The approved Cognito Option 1 Lite boundary now validates Cognito token output,
  requires rotated refresh credentials, hashes credentials before ownership
  persistence, binds revocation to the authoritative player, and derives the
  principal through an active DynamoDB profile lookup keyed by a signed,
  backend-created UUID username. This avoids paid V2 access-token customization.
- A staged Amazon Q handoff is recorded in
  `docs/amazon-q/checkpoint-6-cognito-option-1-lite.md`; its first phase is
  read-only and must stop for owner approval before changing AWS.
- Local implementation of Cognito custom-auth gateway, DynamoDB refresh
  credential registry, and Cognito trigger dispatcher is complete and tested.
  244/244 local tests pass (225 pre-deployment + 19 new focused gateway tests
  added post-deployment). Concrete adapters are deployed to Lambda.
  Checkpoint 6 deployment is complete. Deployment-time fixes (Bugs 1–4) and
  post-deployment revocation hardening (Bug 5, revoke() error handling) are
  live. The corrective API code-only deployment used commit aea102f and passed
  all 17 smoke tests. See
  `docs/amazon-q/checkpoint-6-deployment-handoff.md` for the full deployment
  record, discovered bugs, and live AWS state.
- Explicit session revocation now has a local durable-audit implementation:
  the owned refresh-credential transition and one immutable
  `SESSION_CREDENTIAL_REVOKED` event are committed in the same DynamoDB
  transaction. Concurrent/idempotent retries accept only the same player's
  well-formed revoked record. Audit records contain neither raw credentials nor
  credential hashes. This change is local only until a separately approved API
  Lambda code deployment.
- A local `CognitoPlayerSessionRevoker` implements provider-wide account
  session invalidation with `AdminUserGlobalSignOut`. It validates the
  server-owned UUID username, treats a missing shadow user as idempotently
  revoked, and maps every other provider failure to an opaque error. It is not
  wired into the Lambda yet: deployment requires explicit approval to add
  `cognito-idp:AdminUserGlobalSignOut` to the API role and completion of the
  deletion reauthentication boundary.
- A local Apple account-deletion authorizer now requires a fresh verified Apple
  assertion and a strongly consistent hashed provider-mapping lookup that must
  resolve to the authenticated player. Guest sessions, missing proofs,
  cross-player identities, malformed mappings, and provider/store failures all
  fail through the same privacy-safe authorization boundary. It remains
  unwired while `SCO_APPLE_AUDIENCE` is intentionally absent.
- The DynamoDB economy implementation now has a pure, offline-tested atomic
  transaction builder. A balance compare-and-set, one immutable ledger item per
  normalized resource mutation, optional verified-grant claim, and hashed
  idempotency receipt share one transaction. Raw idempotency keys and request
  fingerprints are never persisted. The concrete repository adds strongly
  consistent replay, verified-grant, and balance reads; explicit stale-revision
  results; conditional-write recovery; and fail-closed record/version parsing.
  It is available from the AWS persistence factory without eager network calls.
  Economy routes stay disabled until an approved spend-rule table and concrete
  reward-evidence verifier are supplied and deployment is separately approved.
- A trusted economy-policy boundary now resolves spend mutations exclusively
  from exact server-configured action/reference pairs and rejects every
  unconfigured price. Verified reward evidence is bound to the requested claim
  before approved configuration supplies amounts. Product-approved defaults are
  represented as 50 coins + 20 energy for a daily gift and rewarded choices of
  100 coins or 20 energy; provider eligibility/deduplication remains behind an
  injected verifier. No client-supplied amount can enter the ledger.
- `GET /v1/economy` is locally wired to the concrete, strongly consistent
  DynamoDB balance reader behind bearer authentication. Its sibling mutation
  routes remain explicit 503 responses, and injected mutation policies fail
  closed even if called accidentally. This read route is not live until a
  separately approved API Lambda code deployment.
- `GET /v1/entitlements` is locally wired to a paginated, strongly consistent
  DynamoDB reader behind bearer authentication. It validates every stored key,
  owner, version, state, environment, and purchase timestamp before returning a
  deterministic product-ID ordering. Purchase and notification mutation routes
  remain explicit 503 responses. This read route is not live until a separately
  approved API Lambda code deployment.
- SCO_APPLE_AUDIENCE is optional at Lambda startup. When absent, Apple
  sign-in routes return 503 and all other routes function normally. Apple
  deployment remains blocked until com.itsallrealministries.stonescryout is
  confirmed as Sign in with Apple-enabled in the Apple Developer portal.
- Lambda artifacts are produced by npm run bundle (esbuild CJS + package + validate).
  Both runtime dependencies (jose, AWS SDK) and application code are bundled
  into self-contained CJS files. Artifact validation runs a child Node process
  that requires() each bundle and asserts typeof handler === "function", failing
  on every unexpected error including cold-start failures.
- The future API Lambda IAM policy requires exactly five Cognito actions:
  AdminCreateUser, AdminGetUser, AdminSetUserPassword, AdminInitiateAuth,
  AdminRespondToAuthChallenge. AdminGetUser is required for every repeat
  sign-in (existing shadow users) and must not be omitted.
- Owner-approved development economy starting values: 200 coins, 20 gems,
  200 energy, energyCap=200. These are trusted server configuration values
  supplied via Lambda environment variables and signed remote configuration.
  They are never accepted from client session requests.
- The final ordered deployment runbook, exact PowerShell commands, policies,
  preflight checks, rollback snapshot capture, smoke test script, complete
  rollback commands, and cost estimate are recorded in
  `docs/deployment-runbook-checkpoint-6.md`.
- The following changes are planned but not yet applied to AWS:
  - Identity Center setup and ScoDevOperator permission set (skipped for
    single-developer machine; ItsAllRealAdmin used directly).
  - Apple authentication deployment blocked until Apple Developer portal
    confirmation is recorded. SCO_APPLE_AUDIENCE must not be set until then.

## Next contract-first slices

1. Product-approved consumable refund/clawback or debt-reconciliation policy;
   current notification handling updates known entitlement/transaction state but
   never invents a currency debit policy.
2. Provider revocation lifecycle and durable security/account/economy audit event
   adapters.
3. Apple authentication: set SCO_APPLE_AUDIENCE once Apple Developer portal
   confirms com.itsallrealministries.stonescryout is Sign in with Apple-enabled.

## Provisioned dev environment (us-east-1, account 598628878271)

All resources use the `sco-dev-` prefix and are fully isolated from existing
`itsallreal.org` and `bmerge-*` resources.

- IAM role: `sco-dev-lambda-role` — least-privilege, scoped to sco-dev-players,
  /sco/dev/* SSM parameters, /sco/dev/api log group, and five Cognito admin
  actions on the sco-dev user pool.
- IAM role: `sco-dev-cognito-triggers-role` — Lambda trust, logs-only policy
  scoped to /sco/dev/cognito-triggers.
- DynamoDB table: `sco-dev-players` — pk+sk, on-demand billing, no PITR (dev).
  TTL enabled on attribute `ttl`.
- Lambda function: `sco-dev-api` — Node 22, arm64, 512 MB, 10 s, handler
  `api.handler`. Wired with concrete Cognito and DynamoDB adapters.
  Ten required environment variables set. SCO_APPLE_AUDIENCE absent.
- Lambda function: `sco-dev-cognito-triggers` — Node 22, arm64, 128 MB, 5 s,
  handler `cognito-triggers.handler`. Dispatches DefineAuth, CreateAuth,
  VerifyAuth triggers. JSON log format, /sco/dev/cognito-triggers log group.
- API Gateway HTTP API: `sco-dev-api` (id: q0zoa13ye9) — $default stage,
  auto-deploy, 20 req/s rate limit, 50 burst.
  Endpoint: https://q0zoa13ye9.execute-api.us-east-1.amazonaws.com
- S3 bucket: `sco-dev-content-598628878271` — fully private, OAC-only access.
- CloudFront distribution: E1WW3HKF9297IA — no alias, HTTPS-only, HTTP/2+3,
  PriceClass_100. Domain: https://d34mfol19lzvcv.cloudfront.net
- Cognito user pool: `sco-dev-users` (id: us-east-1_SDheytSys) — deletion
  protection on, MFA off, AllowAdminCreateUserOnly=true,
  AccountRecoverySetting=admin_only. LambdaConfig wired to sco-dev-cognito-triggers
  for DefineAuth, CreateAuth, and VerifyAuth.
  Issuer: https://cognito-idp.us-east-1.amazonaws.com/us-east-1_SDheytSys
- Cognito app client: `sco-dev-mobile` (id: 5vkq6jm3vbulh6v8n4f565benr) —
  no secret, ALLOW_CUSTOM_AUTH only (ALLOW_REFRESH_TOKEN_AUTH removed),
  RefreshTokenRotation=ENABLED RetryGracePeriodSeconds=0,
  60 min access token, 30-day refresh token.
- CloudWatch log groups: /sco/dev/api, /sco/dev/apigw, /sco/dev/cognito-triggers
  — 14-day retention.

## Decisions required before staging/production or federation work

- Resolve duplicate itsallreal.org hosted zones before adding any DNS records.
- Apple Services ID/bundle ID per environment for identity token audience.
  No private key or credential belongs in this repository or logs.
- Approved subdomain for API (e.g. sco-api.itsallreal.org) pending hosted
  zone resolution.
- Staging and production environment provisioning (same pattern, sco-staging-
  and sco-prod- prefixes).
- Key-management choices (customer KMS keys) when moving to production.
- PITR and backup policy for staging/production tables.

The OpenAPI server URL remains `https://api.invalid` until a custom domain is
approved and configured.
