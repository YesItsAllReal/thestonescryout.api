# Account-link conflict reconciliation

Status: required contract defined; DynamoDB implementation pending.

The client supplies only its authenticated guest session, verified Apple
credential, opaque conflict ID, explicit save choice, and idempotency key. It
never supplies player IDs, balances, ledger deltas, entitlements, or unlocks.

Resolution must be one conditional transaction that:

1. Requires a pending, unexpired conflict bound to the authenticated guest and
   current hashed provider mapping.
2. Requires both player/economy/save revisions to remain unchanged.
3. Selects only the requested board snapshot; snapshot choice never selects or
   discards economic value.
4. Reconciles currency only through server-authored ledger entries, without
   duplicating purchased or verified grants.
5. Unions valid unlocks/progress by stable ID and preserves verified
   entitlements and globally claimed StoreKit transactions.
6. Moves provider ownership to the surviving player and tombstones the other
   profile without deleting required audit or purchase evidence.
7. Marks the ticket resolved, stores the original idempotent response, and
   appends a privacy-minimized audit event.

Any concurrent change writes nothing. Missing, expired, resolved, or mismatched
tickets; unsupported schemas; deleted accounts; negative balances; unknown
entitlements; duplicate transactions; rule-version drift; or oversized
transactions fail closed. Consumable refund/clawback policy remains a separate
product decision and cannot be invented during linking.

Approved offline value uses Option 1 Lite: the backend replays at most 500
hash-chained commands against the exact approved content/build rules. Commands
do not expire solely because of age, and only server reward rules can produce a
grant key, resource, amount, reason code, or source reference.
