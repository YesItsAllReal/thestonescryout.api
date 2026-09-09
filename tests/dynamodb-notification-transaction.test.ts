import assert from "node:assert/strict";
import test from "node:test";
import { buildIgnoredNotificationTransaction, buildKnownNotificationTransaction } from "../src/commerce/dynamodb-notification-transaction.js";

const now = new Date("2026-09-09T19:00:00.000Z");
const operation = {
  notification: {
    notificationId: "notification-1001", notificationType: "REFUND" as const,
    transactionId: "transaction-1001", productId: "com.itsallreal.stonescryout.removeads",
    environment: "sandbox" as const, effectiveAt: "2026-09-09T18:59:00.000Z",
  }, now,
};
const transaction = {
  playerId: "00000000-0000-4000-8000-000000001001", transactionId: "transaction-1001",
  productId: "com.itsallreal.stonescryout.removeads", productKind: "nonConsumable" as const,
  environment: "sandbox" as const, state: "granted" as const,
  stateEffectiveAt: "2026-09-01T12:00:00.000Z",
};
const entitlement = { productId: transaction.productId, state: "active" as const, purchasedAt: "2026-09-01T12:00:00.000Z", environment: "sandbox" as const, stateEffectiveAt: "2026-09-01T12:00:00.000Z" };

test("known non-consumable notification atomically updates transaction, entitlement, and receipt", () => {
  const built = buildKnownNotificationTransaction({ tableName: "players", operation, transaction, entitlement });
  const items = built.command.input.TransactItems!;
  assert.equal(items.length, 3);
  assert.equal(items[0]!.Update!.Key!.pk, "TRANSACTION#sandbox#transaction-1001");
  assert.match(items[0]!.Update!.ConditionExpression!, /#state = :currentState/);
  assert.match(items[0]!.Update!.ConditionExpression!, /stateEffectiveAt = :currentEffectiveAt/);
  assert.equal(items[1]!.Update!.Key!.sk, `ENTITLEMENT#${transaction.productId}`);
  assert.match(items[1]!.Update!.ConditionExpression!, /purchasedAt = :purchasedAt/);
  assert.equal(items[2]!.Put!.Item!.pk, "NOTIFICATION#sandbox#notification-1001");
  assert.equal(built.result.status, "applied");
  assert.equal(built.result.entitlement?.state, "refunded");
});

test("known consumable notification records state without inventing a currency clawback", () => {
  const built = buildKnownNotificationTransaction({
    tableName: "players", operation,
    transaction: { ...transaction, productKind: "consumable" },
  });
  const items = built.command.input.TransactItems!;
  assert.equal(items.length, 2);
  assert.equal(items.some((item) => item.Update?.Key?.sk === "BALANCE"), false);
  assert.equal(items.some((item) => String(item.Put?.Item?.sk).startsWith("LEDGER#")), false);
  assert.equal(built.result.entitlement, undefined);
});

test("unknown notification is durably recorded as ignored without changing player state", () => {
  const built = buildIgnoredNotificationTransaction({ tableName: "players", operation });
  const items = built.command.input.TransactItems!;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.Put!.Item!.entityType, "AppStoreNotification");
  assert.equal(built.result.status, "ignored");
  assert.equal(built.result.transactionState, "refunded");
});

test("revocation produces revoked transaction and entitlement state", () => {
  const built = buildKnownNotificationTransaction({
    tableName: "players", operation: { ...operation, notification: { ...operation.notification, notificationType: "REVOKE" } },
    transaction: { ...transaction, state: "refunded", stateEffectiveAt: "2026-09-09T18:00:00.000Z" },
    entitlement: { ...entitlement, state: "refunded", stateEffectiveAt: "2026-09-09T18:00:00.000Z" },
  });
  assert.equal(built.result.transactionState, "revoked");
  assert.equal(built.result.entitlement?.state, "revoked");
});

test("notification transaction rejects stale or equal provider-effective timestamps", () => {
  assert.throws(() => buildKnownNotificationTransaction({
    tableName: "players",
    operation: { ...operation, notification: { ...operation.notification, effectiveAt: transaction.stateEffectiveAt } },
    transaction, entitlement,
  }), /ordering/);
});

test("notification transaction rejects mismatches and impossible entitlement shapes", () => {
  assert.throws(() => buildKnownNotificationTransaction({ tableName: "players", operation, transaction: { ...transaction, productId: "different" }, entitlement }), /does not match/);
  assert.throws(() => buildKnownNotificationTransaction({ tableName: "players", operation, transaction }), /missing its entitlement/);
  assert.throws(() => buildKnownNotificationTransaction({ tableName: "players", operation, transaction: { ...transaction, productKind: "consumable" }, entitlement }), /cannot update/);
  assert.throws(() => buildKnownNotificationTransaction({ tableName: "players", operation, transaction, entitlement: { ...entitlement, environment: "production" } }), /entitlement is invalid/);
});

test("notification transaction rejects unsafe provider identifiers before writing", () => {
  assert.throws(() => buildIgnoredNotificationTransaction({
    tableName: "players", operation: { ...operation, notification: { ...operation.notification, notificationId: "unsafe/id" } },
  }), /input is invalid/);
});
