import assert from "node:assert/strict";
import test from "node:test";
import { buildAdRewardTransaction } from "../src/commerce/dynamodb-ad-reward-transaction.js";
import type { CommerceRepository } from "../src/commerce/commerce-service.js";

const now = new Date("2026-09-09T17:00:00.000Z");
const current = { coins: 200, gems: 20, energy: 180, energyUpdatedAt: "2026-09-09T16:00:00.000Z", revision: 3 };
const operation = {
  playerId: "00000000-0000-4000-8000-000000000801",
  completion: { provider: "ad-provider", providerEventId: "event-8001", claimId: "claim-8001", playerId: "00000000-0000-4000-8000-000000000801" },
  mutations: [{ resource: "energy" as const, delta: 20 }],
  idempotencyKey: "ad-reward-operation-0001", clientBuild: 1, contentVersion: "starter-1", now,
};
type AdOperation = Parameters<CommerceRepository["processAdRewardAtomically"]>[0];

test("ad reward atomically claims provider event, updates balance, writes ledger, and stores replay", () => {
  const built = buildAdRewardTransaction({ tableName: "players", current, operation, ledgerEntryIds: ["ledger-1"] });
  const items = built.command.input.TransactItems!;
  assert.equal(items.length, 4);
  assert.equal(items[0]!.Put!.Item!.pk, "AD_EVENT#ad-provider#event-8001");
  assert.match(items[0]!.Put!.ConditionExpression!, /attribute_not_exists/);
  assert.match(items[1]!.Update!.ConditionExpression!, /revision = :revision/);
  assert.equal(items[2]!.Put!.Item!.reasonCode, "AD_REWARD");
  assert.equal(items[3]!.Put!.Item!.operation, "commerce.adReward");
  assert.equal(built.result.balance.energy, 200);
  assert.equal(built.result.balance.revision, 4);
});

test("ad reward stores no raw idempotency key and no verification payload", () => {
  const built = buildAdRewardTransaction({ tableName: "players", current, operation, ledgerEntryIds: ["ledger-1"] });
  const stored = JSON.stringify(built.command.input.TransactItems);
  assert.equal(stored.includes(operation.idempotencyKey), false);
  assert.equal(stored.includes("verificationPayload"), false);
  assert.match(stored, /[a-f0-9]{64}/);
});

test("ad reward preserves energy timestamp for a coin-only grant", () => {
  const coins: AdOperation = { ...operation, mutations: [{ resource: "coins", delta: 100 }] };
  const built = buildAdRewardTransaction({ tableName: "players", current, operation: coins, ledgerEntryIds: ["ledger-2"] });
  assert.equal(built.result.balance.coins, 300);
  assert.equal(built.result.balance.energyUpdatedAt, current.energyUpdatedAt);
});

test("ad reward fails closed for cross-player completions and unsafe mutations", () => {
  const build = (override: Partial<AdOperation>, ids: readonly string[] = ["ledger-1"]) =>
    buildAdRewardTransaction({ tableName: "players", current, operation: { ...operation, ...override }, ledgerEntryIds: ids });
  assert.throws(() => build({ completion: { ...operation.completion, playerId: "00000000-0000-4000-8000-000000000802" } }), /identity/);
  assert.throws(() => build({ mutations: [] }, []), /mutations/);
  assert.throws(() => build({ mutations: [{ resource: "coins", delta: -1 }] }), /mutations/);
  assert.throws(() => build({ mutations: [{ resource: "coins", delta: 1 }, { resource: "coins", delta: 2 }] }, ["1", "2"]), /mutations/);
  assert.throws(() => build({ completion: { ...operation.completion, providerEventId: "unsafe/event" } }), /input/);
});

test("ad reward rejects unsafe overflow before constructing a transaction", () => {
  assert.throws(() => buildAdRewardTransaction({
    tableName: "players", current: { ...current, coins: Number.MAX_SAFE_INTEGER },
    operation: { ...operation, mutations: [{ resource: "coins", delta: 1 }] }, ledgerEntryIds: ["ledger-1"],
  }), /invalid balance/);
});
