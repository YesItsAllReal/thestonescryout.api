import assert from "node:assert/strict";
import test from "node:test";

import { buildEconomyTransaction } from "../src/economy/dynamodb-economy-transaction.js";
import type { ResourceMutation } from "../src/economy/economy-service.js";

const now = new Date("2026-09-08T21:00:00.000Z");
const current = { coins: 200, gems: 20, energy: 200, energyUpdatedAt: "2026-09-08T20:00:00.000Z", revision: 1 };
const operation = {
  playerId: "00000000-0000-4000-8000-000000000401",
  expectedRevision: 1,
  requestFingerprint: "private-request-fingerprint",
  mutations: [{ resource: "coins" as const, delta: -100 }],
  reasonCode: "INVENTORY_EXPANSION" as const,
  sourceReference: "inventory-slot-1",
  idempotencyKey: "economy-spend-secret-0001",
  clientBuild: 1,
  contentVersion: "starter-1",
  now,
};

test("economy transaction atomically conditions balance, writes ledger, and stores replay", () => {
  const { command, result } = buildEconomyTransaction({ tableName: "players", current, operation, ledgerEntryIds: ["entry-1"] });
  const items = command.input.TransactItems!;
  assert.equal(items.length, 3);
  assert.match(items[0]!.Update!.ConditionExpression!, /revision = :revision/);
  assert.match(items[0]!.Update!.ConditionExpression!, /coins = :oldCoins/);
  assert.equal(items[1]!.Put!.Item!.entityType, "LedgerEntry");
  assert.equal(items[2]!.Put!.Item!.operation, "economy.apply");
  assert.equal(result.balance.coins, 100);
  assert.equal(result.balance.revision, 2);
});

test("economy transaction stores hashes instead of raw idempotency keys or fingerprints", () => {
  const { command } = buildEconomyTransaction({ tableName: "players", current, operation, ledgerEntryIds: ["entry-1"] });
  const stored = JSON.stringify(command.input.TransactItems);
  assert.equal(stored.includes(operation.idempotencyKey), false);
  assert.equal(stored.includes(operation.requestFingerprint), false);
  assert.match(stored, /[a-f0-9]{64}/);
});

test("verified grant claim and economy mutation share one transaction", () => {
  const { command } = buildEconomyTransaction({
    tableName: "players", current,
    operation: { ...operation, uniqueGrantKey: "dailyGift:2026-09-08", mutations: [
      { resource: "coins", delta: 50 }, { resource: "energy", delta: 20 },
    ] },
    ledgerEntryIds: ["entry-1", "entry-2"],
  });
  const items = command.input.TransactItems!;
  assert.equal(items.length, 5);
  assert.equal(items.filter((item) => item.Put?.Item?.entityType === "LedgerEntry").length, 2);
  assert.equal(items.some((item) => item.Put?.Item?.entityType === "EconomyGrantClaim"), true);
});

test("economy transaction rejects negative, unsafe, empty, and oversized mutation results", () => {
  const build = (mutations: readonly ResourceMutation[]) => buildEconomyTransaction({
    tableName: "players", current, operation: { ...operation, mutations }, ledgerEntryIds: mutations.map((_, index) => `entry-${index}`),
  });
  assert.throws(() => build([{ resource: "gems", delta: -21 }]));
  assert.throws(() => build([{ resource: "coins", delta: Number.MAX_SAFE_INTEGER }]));
  assert.throws(() => build([]));
  assert.throws(() => build([
    { resource: "coins", delta: 1 }, { resource: "gems", delta: 1 },
    { resource: "energy", delta: 1 }, { resource: "coins", delta: 1 },
  ]));
});

test("energy timestamp changes only when energy is mutated", () => {
  const coins = buildEconomyTransaction({ tableName: "players", current, operation, ledgerEntryIds: ["entry-1"] });
  assert.equal(coins.result.balance.energyUpdatedAt, current.energyUpdatedAt);
  const energy = buildEconomyTransaction({ tableName: "players", current, operation: {
    ...operation, mutations: [{ resource: "energy", delta: -1 }],
  }, ledgerEntryIds: ["entry-2"] });
  assert.equal(energy.result.balance.energyUpdatedAt, now.toISOString());
});
