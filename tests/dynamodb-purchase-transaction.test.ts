import assert from "node:assert/strict";
import test from "node:test";
import { buildPurchaseTransaction, type PurchaseTransactionOperation } from "../src/commerce/dynamodb-purchase-transaction.js";

const now = new Date("2026-09-09T15:00:00.000Z");
const current = { coins: 200, gems: 20, energy: 200, energyUpdatedAt: "2026-09-09T14:00:00.000Z", revision: 1 };
const transaction = {
  transactionId: "store-transaction-1001", originalTransactionId: "store-original-1001",
  productId: "com.itsallreal.stonescryout.gems.small", appAccountToken: "private-account-token",
  environment: "sandbox" as const, purchasedAt: "2026-09-09T14:59:00.000Z",
};
const operation = {
  playerId: "00000000-0000-4000-8000-000000000601", transaction,
  product: { productId: transaction.productId, kind: "consumable" as const, grants: [{ resource: "gems" as const, delta: 100 }] },
  idempotencyKey: "purchase-operation-0001", clientBuild: 1, contentVersion: "starter-1", now,
};

test("purchase transaction atomically claims provider transaction, updates balance, writes ledger, and stores replay", () => {
  const built = buildPurchaseTransaction({ tableName: "players", current, operation, ledgerEntryIds: ["ledger-1"] });
  const items = built.command.input.TransactItems!;
  assert.equal(items.length, 4);
  assert.equal(items[0]!.Put!.Item!.pk, "TRANSACTION#sandbox#store-transaction-1001");
  assert.match(items[0]!.Put!.ConditionExpression!, /attribute_not_exists/);
  assert.match(items[1]!.Update!.ConditionExpression!, /revision = :revision/);
  assert.equal(items[2]!.Put!.Item!.reasonCode, "IAP_GRANT");
  assert.equal(items[3]!.Put!.Item!.operation, "commerce.purchase");
  assert.equal(built.result.balance.gems, 120);
  assert.equal(built.result.balance.revision, 2);
});

test("non-consumable purchase claims an entitlement without changing the balance revision", () => {
  const nonConsumable = {
    ...operation,
    transaction: { ...transaction, transactionId: "remove-ads-1", productId: "com.itsallreal.stonescryout.removeads" },
    product: { productId: "com.itsallreal.stonescryout.removeads", kind: "nonConsumable" as const, grants: [] },
  };
  const built = buildPurchaseTransaction({ tableName: "players", current, operation: nonConsumable, ledgerEntryIds: [] });
  const items = built.command.input.TransactItems!;
  assert.equal(items.length, 3);
  assert.equal(items.some((item) => item.Update !== undefined), false);
  const stored = items.find((item) => item.Put?.Item?.entityType === "Entitlement")!.Put!.Item!;
  assert.equal(stored.pk, `PLAYER#${operation.playerId}`);
  assert.equal(stored.sk, "ENTITLEMENT#com.itsallreal.stonescryout.removeads");
  assert.equal(stored.state, "active");
  assert.equal(built.result.balance.revision, current.revision);
  assert.equal(built.result.entitlement?.environment, "sandbox");
});

test("purchase storage excludes raw idempotency keys and app-account tokens", () => {
  const built = buildPurchaseTransaction({ tableName: "players", current, operation, ledgerEntryIds: ["ledger-1"] });
  const stored = JSON.stringify(built.command.input.TransactItems);
  assert.equal(stored.includes(operation.idempotencyKey), false);
  assert.equal(stored.includes(transaction.appAccountToken), false);
  assert.match(stored, /[a-f0-9]{64}/);
});

test("purchase transaction preserves energy time unless the grant changes energy", () => {
  const energy = { ...operation, product: { ...operation.product, grants: [{ resource: "energy" as const, delta: 20 }] } };
  const built = buildPurchaseTransaction({ tableName: "players", current, operation: energy, ledgerEntryIds: ["ledger-1"] });
  assert.equal(built.result.balance.energyUpdatedAt, now.toISOString());
  const gems = buildPurchaseTransaction({ tableName: "players", current, operation, ledgerEntryIds: ["ledger-2"] });
  assert.equal(gems.result.balance.energyUpdatedAt, current.energyUpdatedAt);
});

test("purchase transaction fails closed for mismatched products and unsafe grant shapes", () => {
  const build = (overrides: Partial<PurchaseTransactionOperation>, ids: readonly string[] = ["ledger-1"]) =>
    buildPurchaseTransaction({ tableName: "players", current, operation: { ...operation, ...overrides }, ledgerEntryIds: ids });
  assert.throws(() => build({ product: { ...operation.product, productId: "different" } }), /identity/);
  assert.throws(() => build({ product: { ...operation.product, grants: [] } }, []), /grants/);
  assert.throws(() => build({ product: { ...operation.product, grants: [{ resource: "gems", delta: -1 }] } }), /grants/);
  assert.throws(() => build({ product: { ...operation.product, grants: [
    { resource: "coins", delta: 1 }, { resource: "gems", delta: 1 },
    { resource: "energy", delta: 1 }, { resource: "coins", delta: 1 },
  ] } }, ["1", "2", "3", "4"]), /grants/);
  assert.throws(() => build({ product: { ...operation.product, grants: [
    { resource: "gems", delta: 1 }, { resource: "gems", delta: 2 },
  ] } }, ["1", "2"]), /grants/);
  assert.throws(() => build({}, []), /grants/);
});
