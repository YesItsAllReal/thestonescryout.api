# Checkpoint 9 account release blockers

Status: deployed and enabled in the AWS development environment on 2026-09-26;
real-device destructive acceptance remains pending.

## Account-link reconciliation

`POST /v1/account/link` remains the only link and conflict-resolution endpoint.
The opaque, expiring, single-use ticket is bound to the guest player, hashed
verified Apple identity, existing account, and requested save choice. Either
choice preserves the existing Apple account. Only ordinary save selection
changes; economy provenance, verified grants, purchases, entitlements, and
unlocks reconcile independently in one conditional transaction. Duplicate guest
unlocks are always retired. Legacy balances without all three verified origin
fields fail closed.

The development inventory found 10 legacy balances and assigned trustworthy
origin provenance to all 10 with conditional writes. Reverification found no
partial or unsupported rows. Development now uses the owner-approved
`SCO_ACCOUNT_LINK_CONTENT_VERSION=starter-1`. There is no new route, index, or
public contract field.

## Account deletion and retention

`DELETE /v1/account` requires a bearer account session, exact confirmation,
idempotency key, and fresh Apple proof under the existing contract. The request,
audit event, and cleanup job become durable before Cognito global sign-out.

The worker applies this inventory:

| Data | Completion behavior |
| --- | --- |
| Profile, save, balance, ledger, unlock, entitlement, account audit | Delete |
| Apple/provider and installation mappings | Delete |
| Refresh credentials and idempotency results | Delete |
| Purchase transaction | Retain transaction/product/environment/state/times; remove player and embedded result; add random retention ID |
| Verified ad/offline/economy grant claim | Retain fraud-proof identifiers; remove player and result; add random retention ID |
| Deletion job | Retain state/timestamps/random retention ID for 30 days, then DynamoDB TTL |
| Structured logs | Existing privacy-safe fields only; CloudWatch expires after 14 days |
| Development backups | PITR is off; no backup currently retains deleted rows |

The domain worker supports bounded batches; the DynamoDB-stream Lambda processes
one atomic mutation and job checkpoint per record. Each job update emits the next
step. A timeout retries from durable state. A bounded
one-item DynamoDB scan finds global records carrying `playerId`; this needs no
index at current development volume. Add an owner lookup GSI before production
scale makes scans operationally inappropriate. Unknown record versions or
entity types block completion instead of being silently retained or deleted.

## Development deployment record

The approved sequence was completed in development: rollback snapshots were
captured, scoped global-sign-out IAM was added, the reviewed API was deployed,
NEW_IMAGE streams and the separate Node 22 arm64 worker were created, and a
key-filtered mapping was configured with partial-batch reporting, batch size 1,
parallelization factor 1, five retries, one-hour maximum record age, bisection,
and an SQS failure destination. Reserved concurrency 1 could not be configured
because the account's initial concurrency cap requires ten units to remain
unreserved; the owner approved the serialized mapping controls instead. The
worker safely ignores the eventual TTL `REMOVE` event for an exact deletion-job
key. Account-link reconciliation and account deletion are now enabled only in
development.

Rollback disables both API flags first, disables the worker event-source mapping,
restores the captured API artifact/configuration and IAM policy, and leaves any
durable deletion job available for controlled resumption. Never roll back by
restoring already deleted personal data.

Four development alarms cover worker errors, iterator age, concurrency, and DLQ
depth. All were `OK` and the DLQ was empty after acceptance on 2026-09-26.

## Development acceptance plan

Use newly created synthetic development accounts only. Verify both reconciliation
save choices, Apple identity continuity, independent economy/entitlement/unlock
results, replay and simultaneous-resolution behavior, and redacted logs. For
deletion, capture only non-secret test fixture keys, request deletion with fresh
Apple authentication, verify immediate session invalidation, poll the internal
job without printing player data, confirm every inventory row above, verify the
same request receipt, and confirm later authentication fails. A destructive live
account test requires separate owner approval and an explicitly disposable
account.

Synthetic worker acceptance passed for disposable guest accounts: cleanup
completed, the marker TTL was exactly 30 days, player-partition and external
player-owned counts reached zero, refresh and account access both returned 401,
and the DLQ remained empty. This does not substitute for the still-required iOS
tests using newly created disposable Apple accounts: genuine conflict creation
and both save choices, duplicate/concurrent resolution, and a fresh
Apple-reauthenticated `DELETE /v1/account`. The owner's existing TestFlight
Apple-linked account must not be used. No iOS contract or client change is
required.
