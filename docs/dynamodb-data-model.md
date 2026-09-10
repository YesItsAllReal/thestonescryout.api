# DynamoDB data model and evolution

Status: design approved by ADR 0001. A development table has been provisioned;
repository adapters are implemented and validated locally before deployment.

## Table boundary

Checkpoint 6 uses one logical player-data table per environment. The physical
table name, AWS account, and Region remain environment-supplied deployment
inputs. Content binaries remain outside this table behind the content repository
boundary.

Every item has `pk`, `sk`, `entityType`, and `recordVersion`. Timestamps are UTC
RFC 3339 strings. Opaque UUIDs are immutable; email addresses, raw installation
identifiers, provider tokens, and Apple credentials are never keys.

Player profiles also have an internal `accountState` of `active` or `merged`.
Legacy version-one profiles without the additive field are read as `active`;
all new writers emit it. A `merged` profile is a minimal audit tombstone, is
never accepted as an authenticated account, and records its surviving player
only in protected storage. This internal lifecycle is not part of the public
account or deletion-state contract.

## Keys and access patterns

| Entity | `pk` | `sk` | Primary access pattern |
| --- | --- | --- | --- |
| Player | `PLAYER#<playerId>` | `PROFILE` | Load/update an authorized profile |
| Installation mapping | `INSTALLATION#<sha256>` | `PLAYER` | Recover the same guest without retaining the raw installation ID |
| Provider mapping | `PROVIDER#<issuerHash>#<subjectHash>` | `PLAYER` | Resolve a verified federated subject to one player |
| Save | `PLAYER#<playerId>` | `SAVE#<slot>` | Load or conditionally replace a save by revision |
| Balance | `PLAYER#<playerId>` | `BALANCE` | Load authoritative balances |
| Ledger entry | `PLAYER#<playerId>` | `LEDGER#<createdAt>#<entryId>` | Page a player's immutable economy history |
| Entitlement | `PLAYER#<playerId>` | `ENTITLEMENT#<productId>` | Load current product entitlement state |
| Content unlock | `PLAYER#<playerId>` | `UNLOCK#<unlockId>` | Union verified content progress during account reconciliation |
| Purchase transaction | `TRANSACTION#<environment>#<transactionId>` | `GRANT` | Prevent a transaction from granting twice |
| App Store notification | `NOTIFICATION#<environment>#<notificationId>` | `RESULT` | Process a signed provider event once |
| Ad completion | `AD_EVENT#<provider>#<providerEventId>` | `GRANT` | Prevent one verified completion from granting across players |
| Idempotency record | `IDEMPOTENCY#<scope>#<keyHash>` | `RESULT` | Replay the original result or reject a changed payload |
| Audit event | `PLAYER#<playerId>` | `AUDIT#<createdAt>#<eventId>` | Page security/account/economy audit history |
| Deletion job | `DELETION#<playerId>` | `REQUEST` | Resume asynchronous deletion safely |
| Link conflict | `LINK_CONFLICT#<conflictId>` | `REQUEST` | Resolve an opaque, expiring account-link decision |
| Catalog | `CONTENT#<channel>` | `CATALOG#<version>` | Load a compatible signed catalog descriptor |
| Configuration | `CONFIG#<environment>` | `VERSION#<version>` | Load a bounded, signed configuration descriptor |

Provider issuers and subjects are normalized/validated and independently hashed
before becoming key components. Raw subjects and issuer URLs do not appear in
table keys. Any lifecycle data must use separately protected attributes.

## Conditional writes and transactions

- Guest creation transactionally writes Player, Installation mapping, and
  an authoritative revision-one Balance from injected server configuration,
  and the Idempotency record. Installation mapping uses `attribute_not_exists(pk)`;
  contention reads and returns the winning player.
- An idempotency record stores operation, player scope, request hash, response
  reference, status, and expiry. The same key plus the same request replays the
  result. The same key plus a different request is a conflict.
- Save replacement requires `revision = expectedRevision`, then increments it
  exactly once. A mismatch returns the current revision and an explicit conflict;
  it never silently selects a snapshot.
- Save snapshots are limited to 300 KiB of serialized JSON, leaving headroom
  below DynamoDB's 400 KiB item limit for keys, version fields, and metadata.
  Completed idempotency records retain the original public result so a later
  replay cannot accidentally return a newer save revision.
- Economy mutations use one transaction containing the idempotency record,
  balance condition/update, immutable ledger entry, and any entitlement/reward
  state. A spend condition requires the resulting balance to be nonnegative.
- Purchase processing transactionally claims the environment/transaction ID,
  checks its player binding, and writes any balance, ledger, and entitlement
  changes. Ad processing similarly claims the provider event globally and binds
  it to the preissued player claim before granting.
- App Store notification IDs are globally idempotent per environment. Verified
  refunds/revocations update transaction and entitlement state; consumable
  clawback/debt policy must be product-approved before it can debit balances.
- Provider linking transactionally claims the provider mapping, updates the
  player, and appends an audit event. Existing progress is never silently
  overwritten; a separate merge decision is required.
- Initial provider linking and resolution of an existing-account conflict are
  separate repository operations. A conflict-resolution adapter is not allowed
  to implement a save choice by merely repointing the provider mapping; it must
  atomically reconcile the selected save, authoritative economy, entitlements,
  content unlocks, provider ownership, conflict state, and audit result.
- The reconciliation write additionally removes the retired guest installation
  mapping, marks its profile `accountState=merged`, conditionally transfers
  guest-owned entitlement transaction ownership and unlocks, and writes
  `ACCOUNT_LINK_RECONCILIATION` ledger entries with trusted build/content
  context. The pure builder rejects plans requiring more than DynamoDB's 100
  transactional actions; it never silently truncates a reconciliation.
- Account deletion uses a state transition condition (`active` to `requested`)
  and an idempotent job record. Retained purchase records are minimized and
  separated from deleted profile data.
- The deletion transaction also appends one immutable audit event and stores the
  original receipt. Requests made after deletion is already requested reuse the
  durable job timestamp and do not append another audit event, even under a new
  idempotency key.

## Secondary indexes

No secondary index is required for the initial player-scoped API. A deletion-job
index may be added when an asynchronous worker is implemented:

- `gsi1pk = DELETION_STATE#<state>`
- `gsi1sk = <requestedAt>#<playerId>`

Operational analytics should use privacy-reviewed event export rather than table
scans. New indexes require a documented access pattern before deployment.

## Versioning and migrations

- `recordVersion` describes the storage shape for each entity; save payloads also
  carry their independent client/domain `schemaVersion`.
- Readers accept supported historical record versions and map them to current
  domain models. Writers emit only the current version.
- Additive migrations are preferred. Backfills are resumable, idempotent, and
  checkpointed; they never depend on a single full-table scan completing.
- Destructive shape changes use expand/migrate/verify/contract. The contract step
  occurs only after all deployed readers no longer require the old attributes.
- Golden fixtures cover every supported historical version before a migration is
  enabled. Unknown future versions fail closed without leaking stored content.
- Environment data never moves implicitly between local, development, TestFlight
  staging, and production.

## Deployment identifier policy

Development identifiers are recorded in `IMPLEMENTATION_STATUS.md`. Before any
new environment or infrastructure change, surface for owner approval: AWS
accounts and Regions, physical table and index names, Cognito user-pool/client
IDs, token issuers/audiences, content bucket and CloudFront distribution names,
public API/CDN URLs, retention periods, and KMS/key-management choices.
