# Checkpoint 6 implementation status

Last verified: 2026-09-26

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
  ad route remains disabled in the deployed Lambda pending deployment approval.
  Locally, an explicit `SCO_AD_REWARD_TEST_MODE_ENABLED=true` development/staging
  gate now wires the route to a verifier that accepts only Google’s official
  rewarded test unit, an exact earned-callback envelope, and the authenticated
  player’s matching claim. The gate is rejected at startup in production. This
  enables internal TestFlight reward testing without weakening the requirement
  for genuine Google SSV before production activation.
- Public content catalog and remote-configuration services depend on repository,
  detached-signature verifier, and HTTPS URL-policy ports rather than S3,
  CloudFront, or key-service types. The dev bucket and CloudFront distribution
  are provisioned but not wired to these services; no signing key ID has been
  approved or configured.
- Local HTTPS content repositories now resolve deterministic catalog and
  configuration object paths beneath an injected CDN base URL. They enforce
  HTTPS-only same-origin requests, reject redirects, bound time and response
  size, require JSON objects, and map network/status/type/parse failures to the
  generic content-unavailable boundary without logging response bodies. They are
  not configured in Lambda or deployed, and no content objects were uploaded.
- Local content trust adapters now canonicalize bounded JSON-compatible values
  deterministically, verify Ed25519 signatures against an injected public-key
  ring, and enforce exact HTTPS origin/path policies for CDN downloads and
  external links. Unknown keys, malformed signatures/documents, redirects,
  credential-bearing URLs, and lookalike origins fail closed. No signing key or
  private key was created, selected, or stored.
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
  recovery. The adapter is wired into the Lambda and its guest-session flow is
  deployed.
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
  pointer update; resolution passes through the atomic
  save/economy/entitlement reconciliation boundary described below.
- Account-link planning now preserves the existing Apple account as the identity
  survivor regardless of board-save choice, validates all source records before
  policy execution, and carries complete balance, save-device, and entitlement
  provenance needed for conditional persistence. The owner-approved internal
  `accountState` migration treats legacy missing values as `active`, emits
  `active` on new profiles, and makes `merged` profiles unavailable to account
  lookup and authentication without overloading public deletion state.
- CI runs OpenAPI lint, strict TypeScript compilation, and Node tests.
- A local AWS persistence composition factory now assembles the concrete guest,
  account, Apple sign-in/link, save, offline-sync, economy, entitlement, and
  commerce DynamoDB adapters without network access at construction. Explicit
  account-link reconciliation is composed only when a trusted content version
  is supplied and otherwise remains fail-closed.
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
  The deployed Cognito Option 1 Lite baseline passed 244/244 local tests
  (225 pre-deployment + 19 focused gateway tests). Its concrete adapters are
  deployed to Lambda. This was the Cognito deployment slice, not completion of
  all Checkpoint 6 routes. Deployment-time fixes (Bugs 1–4) and
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
- Initial refresh-credential registration and every successful rotation now
  append privacy-minimized `SESSION_CREDENTIAL_ISSUED` and
  `SESSION_CREDENTIAL_ROTATED` audit events in the same DynamoDB transaction as
  credential state. Audit records contain no token or credential hash. Initial
  registration also recognizes DynamoDB transaction-cancellation conflicts and
  strongly verifies the concurrent winner before accepting it.
- A deployed `CognitoPlayerSessionRevoker` implements provider-wide account
  session invalidation with `AdminUserGlobalSignOut`. It validates the
  server-owned UUID username, treats a missing shadow user as idempotently
  revoked, and maps every other provider failure to an opaque error. It is not
  wired into the development Lambda. The development API role has the scoped
  `cognito-idp:AdminUserGlobalSignOut` permission on the development pool.
- A concrete DynamoDB account-link reconciliation repository and pure transaction
  builder now strongly load and bind the
  pending unexpired ticket, active profiles, Apple mapping, hashed installation
  mapping, both balances, and both save revisions in one conditional write. It
  tombstones the guest, independently applies the chosen board, transfers
  guest-owned entitlement transaction ownership and unlocks, appends complete
  reconciliation ledger/audit records, stores only a hashed replay key, and
  refuses plans beyond DynamoDB's 100-action limit. Composition is enabled only
  when a trusted account-link content version is injected. Balance reconciliation
  proves origin plus ledger history and fails closed on legacy balance rows until
  their origin fields receive an explicitly approved backfill.
- Reconciliation readiness now also retires a guest-owned unlock when the
  survivor already owns the same unlock, without overwriting the survivor's
  record. Non-conditional DynamoDB transaction cancellations propagate as
  service failures instead of being misreported as concurrency conflicts.
  Offline coverage explicitly verifies both save choices, shared-unlock cleanup,
  legacy-origin failure, and conditional-winner recovery.
- Account deletion no longer depends on Lambda stubs locally. When both Apple
  audience configuration and the disabled-by-default
  `SCO_ACCOUNT_DELETION_ENABLED=true` gate are present, the identity factory
  composes concrete Apple reauthentication, strongly consistent provider
  ownership lookup, and Cognito global sign-out, and the Lambda enables the real
  deletion handler. The development gate is live as of 2026-09-26; staging and
  production remain untouched.
- Deletion retry coverage proves that a provider revocation failure occurs only
  after the durable deletion state and audit event exist, and that an identical
  retry resumes revocation without duplicating the audit record.
- The local asynchronous deletion worker now has a separately bundled internal
  Lambda entry point. Successful Apple reauthentication passes only the derived
  hashed provider key into the durable job. Bounded atomic steps erase the
  player partition, delete transient global credentials/replays, anonymize only
  purchase and verified-fraud records under a random retention ID, remove the
  Apple and installation mappings, and leave a 30-day TTL completion marker.
  Unknown future entity types fail closed. Worker retries and transaction
  failures cannot advance the job independently of their data mutation. The
  development worker, NEW_IMAGE stream, filtered event-source mapping, retry
  destination, and alarms are live. A key-filtered TTL `REMOVE` event is safely
  acknowledged without reprocessing an expired completion marker.
- A local Apple account-deletion authorizer now requires a fresh verified Apple
  assertion and a strongly consistent hashed provider-mapping lookup that must
  resolve to the authenticated player. Guest sessions, missing proofs,
  cross-player identities, malformed mappings, and provider/store failures all
  fail through the same privacy-safe authorization boundary. The development
  composition is deployed and enabled; a real Apple-reauthenticated destructive
  device acceptance test remains pending.
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
- The newer economy and entitlement read routes now have independent strict
  environment rollout gates (`SCO_ECONOMY_READ_ENABLED` and
  `SCO_ENTITLEMENTS_READ_ENABLED`) that default to false. A future reconciliation
  code deployment therefore cannot silently activate either read route.
- Rewarded test grants have a separate strict rollout gate,
  `SCO_AD_REWARD_TEST_MODE_ENABLED`, which defaults to false and cannot be true
  when `SCO_ENVIRONMENT=production`. Activating it still requires an approved
  development Lambda configuration/code deployment; no deployment was performed
  as part of the implementation.
- SCO_APPLE_AUDIENCE is optional at Lambda startup. When absent, Apple
  sign-in routes return 503 and all other routes function normally. On
  2026-09-22 the owner confirmed `com.itsallrealministries.stonescryout` is
  Sign in with Apple-enabled and is the primary App ID. A separately approved
  configuration-only update then added that exact audience to `sco-dev-api`,
  preserving its code hash and all original environment values. Health returned
  200, malformed Apple input returned 400 rather than 503, unauthenticated link
  returned 401, and privacy-safe log inspection passed. The protected TestFlight
  workflow and provisioning entitlement checks subsequently passed, and the
  owner completed a successful real-device Apple sign-in on 2026-09-23.
  The backend returned a valid session, the iOS app retained only the backend
  session in Keychain, and Cloud Backup remained connected after force-quit and
  relaunch. Conflict reconciliation was not exercised.
- Lambda artifacts are produced by npm run bundle (esbuild CJS + package + validate).
  Both runtime dependencies (jose, AWS SDK) and application code are bundled
  into self-contained CJS files. Artifact validation runs a child Node process
  that requires() each bundle and asserts typeof handler === "function", failing
  on every unexpected error including cold-start failures.
- The deployed session-issuance API Lambda IAM policy requires five Cognito actions:
  AdminCreateUser, AdminGetUser, AdminSetUserPassword, AdminInitiateAuth,
  AdminRespondToAuthChallenge. AdminGetUser is required for every repeat
  sign-in (existing shadow users) and must not be omitted. Enabling account
  deletion will additionally require `AdminUserGlobalSignOut`, for six total.
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
  - No remaining Apple audience change: the confirmed audience is now live.

## Checkpoint 6 closure audit

Checkpoint 6 is not yet closed end to end. Its contract, persistence, security,
and offline-test foundations are substantially implemented. The current local
tree passes 379/379 TypeScript tests, 30/30 PowerShell tests, OpenAPI validation,
and all three Lambda artifact checks. The following behaviors deliberately fail closed:

1. `POST /v1/sync/commands`: DynamoDB persistence and deterministic envelope
   validation exist, but authoritative game-command execution rules must come
   from the shared game domain before replay can safely mutate saves or economy.
2. `DELETE /v1/account`: durable deletion state, audit, Apple reauthentication,
   Cognito global-sign-out, and bounded asynchronous cleanup are deployed in
   development. Synthetic disposable-account worker acceptance passed, including
   complete cleanup, 30-day marker TTL, revoked credential rejection, empty DLQ,
   and unrelated-record isolation. Fresh Apple reauthentication through the iOS
   route still requires real-device acceptance before release closure.
3. `POST /v1/spend` and `POST /v1/rewards/claim`: the atomic economy ledger and
   fail-closed policy boundaries exist. Activation needs the complete approved
   action/reference price table and a concrete reward-evidence verifier.
4. `GET /v1/content/catalog` and `GET /v1/config`: HTTPS repositories, signature
   verification, URL policy, and validation exist locally. Activation needs an
   approved public signing key, signed objects, and environment URLs; no key or
   object has been created.
5. Account-link conflict reconciliation is active in development with trusted
   content version `starter-1` after the verified 10-row balance-origin migration.
   Genuine conflict acceptance for both save choices still requires disposable
   real-device Apple accounts; it has not been claimed from synthetic tests.

The purchase, App Store notification, rewarded-ad, and Game Center work belongs
to Checkpoint 7 and does not block Checkpoint 6 closure.

## Next contract-first slices

1. Integrate the shared deterministic game-command executor when its command and
   content rules are available from the primary app/shared domain.
2. Complete the remaining deletion, economy-mutation, signed-content, and
   account-link reconciliation activation steps listed above. Native Apple
   sign-in acceptance is complete.

## Provisioned dev environment (us-east-1, account 598628878271)

All resources use the `sco-dev-` prefix and are fully isolated from existing
`itsallreal.org` and `bmerge-*` resources.

- IAM role: `sco-dev-lambda-role` — least-privilege, scoped to sco-dev-players,
  /sco/dev/* SSM parameters, /sco/dev/api log group, five Cognito session
  actions, and `AdminUserGlobalSignOut` on the sco-dev user pool.
- IAM role: `sco-dev-cognito-triggers-role` — Lambda trust, logs-only policy
  scoped to /sco/dev/cognito-triggers.
- DynamoDB table: `sco-dev-players` — pk+sk, on-demand billing, no PITR (dev).
  TTL is enabled on `ttl`; NEW_IMAGE streams drive deletion cleanup.
- Lambda function: `sco-dev-api` — Node 22, arm64, 512 MB, 10 s, handler
  `api.handler`. Wired with concrete Cognito and DynamoDB adapters.
  Thirteen environment variables are set, including the confirmed
  `SCO_APPLE_AUDIENCE`, `SCO_ACCOUNT_LINK_CONTENT_VERSION=starter-1`, and
  `SCO_ACCOUNT_DELETION_ENABLED=true`.
- Lambda function: `sco-dev-account-deletion-worker` — Node 22, arm64,
  256 MB, 30 s, handler `account-deletion-worker.handler`. Its filtered mapping
  uses batch size 1, parallelization factor 1, partial-batch responses, bounded
  retries, and the development deletion DLQ. Reserved concurrency is omitted
  because the account's initial concurrency cap requires ten unreserved units.
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
- CloudWatch log groups: /sco/dev/api, /sco/dev/apigw, /sco/dev/cognito-triggers,
  /sco/dev/account-deletion-worker
  — 14-day retention.

Four development deletion alarms were configured and were `OK` on 2026-09-26.

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
