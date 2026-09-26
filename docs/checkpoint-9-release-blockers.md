# Checkpoint 9 account release blockers

Status: locally implemented and validated; not deployed or enabled.

## Account-link reconciliation

`POST /v1/account/link` remains the only link and conflict-resolution endpoint.
The opaque, expiring, single-use ticket is bound to the guest player, hashed
verified Apple identity, existing account, and requested save choice. Either
choice preserves the existing Apple account. Only ordinary save selection
changes; economy provenance, verified grants, purchases, entitlements, and
unlocks reconcile independently in one conditional transaction. Duplicate guest
unlocks are always retired. Legacy balances without all three verified origin
fields fail closed.

Activation requires a verified development balance-origin inventory/backfill
and an owner-approved `SCO_ACCOUNT_LINK_CONTENT_VERSION`. There is no new route,
index, or public contract field.

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

## Proposed development deployment (approval required)

1. Build and record SHA-256 values for `api.zip` and
   `account-deletion-worker.zip`; capture API Lambda configuration/code rollback
   snapshots.
2. Add `cognito-idp:AdminUserGlobalSignOut` on the existing development user
   pool to `sco-dev-lambda-role`.
3. Deploy the reviewed API artifact without enabling either feature.
4. Enable `NEW_IMAGE` DynamoDB Streams on `sco-dev-players`, then create a
   separate `sco-dev-account-deletion-worker` Node 22 arm64 Lambda,
   using `account-deletion-worker.handler`, the existing player-table name, and
   table read/write permissions. Do not attach it to API Gateway.
5. Add a filtered DynamoDB Streams event-source mapping for version-one
   `DeletionJob` records in `requested` or `processing` state, with partial batch
   failure reporting, batch size 1, reserved concurrency 1, bounded retries, and
   an on-failure destination. The
   durable job creation and each cleanup mutation then drive the lifecycle
   without a non-atomic second enqueue.
6. After origin migration verification, set the approved account-link content
   version. Enable `SCO_ACCOUNT_DELETION_ENABLED=true` only after the worker and
   alarm path are verified.

Rollback disables both API flags first, disables the worker event-source mapping,
restores the captured API artifact/configuration and IAM policy, and leaves any
durable deletion job available for controlled resumption. Never roll back by
restoring already deleted personal data.

Required monitoring: deletion-job age, worker error/retry count, dead-letter
queue depth, unsupported-record failures, reconciliation conditional conflicts,
and reconciliation action-limit failures. Alarms and dashboards are AWS changes
and therefore remain uncreated.

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

No iOS contract or client change is required.
