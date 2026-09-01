# Checkpoint 6 implementation status

Last verified: 2026-08-31

Architecture: AWS serverless/DynamoDB is approved by ADR 0001. No AWS resources,
credentials, domains, or external services have been created or configured.

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
- Rewarded-ad completion requires provider verification plus exact player and
  preissued claim binding. Provider event IDs are globally unique, and server
  reward configuration—not the client label—determines the positive grant.
- The commerce repository boundary groups global dedupe, balance/ledger grants,
  and entitlement changes as one atomic operation. In-memory tests cover duplicate
  transactions/events across new idempotency keys and cross-player ownership.
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
- CI runs OpenAPI lint, strict TypeScript compilation, and Node tests.

## Next contract-first slices

1. Signed content catalog and bounded remote-configuration descriptors.
2. Product-approved consumable refund/clawback or debt-reconciliation policy;
   current notification handling updates known entitlement/transaction state but
   never invents a currency debit policy.
3. Provider revocation lifecycle and durable security/account/economy audit event
   adapters.
4. Concrete DynamoDB, Cognito, CloudWatch, API Gateway, and content-delivery
   adapters only after their identifiers and environment layout are approved.

## Decisions required before infrastructure or federation work

- AWS account and Region for development, TestFlight staging, and production.
- Physical resource naming and isolation strategy.
- Cognito user-pool/client IDs and approved token issuer/audience per environment.
- Apple Services ID/bundle association and redirect URLs; no private key or
  credential belongs in this repository or logs.
- Public API and CDN hostnames, content bucket/distribution identifiers, retention
  periods, and key-management choices.

The OpenAPI server URL remains `https://api.invalid` until public environment URLs
are explicitly approved.
