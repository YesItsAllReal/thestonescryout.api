import assert from "node:assert/strict";
import test from "node:test";

import type { AuthenticatedPrincipal } from "../src/auth/authentication.js";
import {
  EconomyClaimRejectedError,
  EconomyIdempotencyConflictError,
  EconomyInsufficientFundsError,
  EconomyRevisionConflictError,
  EconomyService,
  type EconomySpendRules,
  type RewardClaimVerifier,
} from "../src/economy/economy-service.js";
import { EntitlementService } from "../src/economy/entitlement-service.js";
import { MemoryEconomyRepository } from "../src/economy/memory-economy-repository.js";
import { MemoryEntitlementRepository } from "../src/economy/memory-entitlement-repository.js";

const now = () => new Date("2026-08-31T15:00:00.000Z");
const principal: AuthenticatedPrincipal = {
  playerId: "00000000-0000-4000-8000-000000000401",
  sessionKind: "account",
  issuer: "test",
  audience: "test",
};
const spendRules: EconomySpendRules = {
  async resolve(input) {
    if (input.action === "inventoryExpansion") {
      return {
        mutations: [{ resource: "coins", delta: -100 }],
        reasonCode: "INVENTORY_EXPANSION",
        sourceReference: input.referenceId,
      };
    }
    return {
      mutations: [{ resource: "gems", delta: -5 }, { resource: "energy", delta: 20 }],
      reasonCode: "STORE_SPEND",
      sourceReference: input.referenceId,
    };
  },
};
const rewardVerifier: RewardClaimVerifier = {
  async verify(input) {
    if (input.claimToken !== "verified-claim") throw new Error("unverified claim");
    return {
      mutations: [{ resource: "coins", delta: 50 }, { resource: "energy", delta: 20 }],
      reasonCode: "DAILY_GIFT",
      sourceReference: input.claimId,
    };
  },
};

function context() {
  const repository = new MemoryEconomyRepository();
  repository.seed(principal.playerId, {
    coins: 250,
    gems: 25,
    energy: 80,
    energyUpdatedAt: "2026-08-31T14:00:00.000Z",
    revision: 1,
  });
  return { repository, service: new EconomyService(repository, spendRules, rewardVerifier, now) };
}

const spendInput = {
  principal,
  action: "inventoryExpansion" as const,
  referenceId: "inventory-slot-1",
  expectedRevision: 1,
  idempotencyKey: "economy-spend-0001",
  clientBuild: 1,
  contentVersion: "starter-1",
};

test("recognized spend rules determine the debit and append an immutable ledger entry", async () => {
  const { repository, service } = context();
  const result = await service.spend(spendInput);
  assert.equal(result.balance.coins, 150);
  assert.equal(result.balance.revision, 2);
  assert.deepEqual(result.ledgerEntries.map((entry) => [entry.resource, entry.delta, entry.balanceAfter]), [["coins", -100, 150]]);
  assert.equal(Object.isFrozen(repository.ledger(principal.playerId)[0]), true);
});

test("a spend cannot make any balance negative and leaves no ledger entry", async () => {
  const { repository, service } = context();
  await service.spend(spendInput);
  await service.spend({ ...spendInput, expectedRevision: 2, idempotencyKey: "economy-spend-0002" });
  await assert.rejects(
    service.spend({ ...spendInput, expectedRevision: 3, idempotencyKey: "economy-spend-0003" }),
    EconomyInsufficientFundsError,
  );
  assert.equal((await service.getBalance(principal)).coins, 50);
  assert.equal(repository.ledger(principal.playerId).length, 2);
});

test("identical spend replay returns the original transaction without another debit", async () => {
  const { repository, service } = context();
  const first = await service.spend(spendInput);
  const replay = await service.spend(spendInput);
  assert.deepEqual(replay, first);
  assert.equal(repository.ledger(principal.playerId).length, 1);
});

test("changed input with the same economy idempotency key is rejected", async () => {
  const { service } = context();
  await service.spend(spendInput);
  await assert.rejects(
    service.spend({ ...spendInput, referenceId: "inventory-slot-2" }),
    EconomyIdempotencyConflictError,
  );
});

test("stale economy revisions return current revision without mutation", async () => {
  const { repository, service } = context();
  await assert.rejects(
    service.spend({ ...spendInput, expectedRevision: 0 }),
    (error: unknown) => error instanceof EconomyRevisionConflictError && error.currentRevision === 1,
  );
  assert.equal(repository.ledger(principal.playerId).length, 0);
});

test("reward amounts come only from a verifier and a claim grants once", async () => {
  const { repository, service } = context();
  const input = {
    principal,
    claimType: "dailyGift" as const,
    claimId: "daily-2026-08-31",
    claimToken: "verified-claim",
    idempotencyKey: "economy-reward-0001",
    clientBuild: 1,
    contentVersion: "starter-1",
  };
  const first = await service.claimReward(input);
  const replay = await service.claimReward(input);
  assert.equal(first.balance.coins, 300);
  assert.equal(first.balance.energy, 100);
  assert.deepEqual(replay, first);
  assert.equal(repository.ledger(principal.playerId).length, 2);
});

test("the same verified claim cannot grant twice with a new idempotency key", async () => {
  const { repository, service } = context();
  const input = {
    principal,
    claimType: "dailyGift" as const,
    claimId: "daily-2026-08-31",
    claimToken: "verified-claim",
    idempotencyKey: "economy-reward-0003",
    clientBuild: 1,
    contentVersion: "starter-1",
  };
  const first = await service.claimReward(input);
  const duplicate = await service.claimReward({ ...input, idempotencyKey: "economy-reward-0004" });
  assert.deepEqual(duplicate, first);
  assert.equal(repository.ledger(principal.playerId).length, 2);
});

test("unverified reward claims produce no grant", async () => {
  const { repository, service } = context();
  await assert.rejects(
    service.claimReward({
      principal,
      claimType: "dailyGift",
      claimId: "daily-2026-08-31",
      claimToken: "not-valid",
      idempotencyKey: "economy-reward-0002",
      clientBuild: 1,
      contentVersion: "starter-1",
    }),
    EconomyClaimRejectedError,
  );
  assert.equal(repository.ledger(principal.playerId).length, 0);
});

test("entitlements are read only for the authenticated player", async () => {
  const repository = new MemoryEntitlementRepository();
  repository.seed(principal.playerId, [{
    productId: "com.itsallreal.stonescryout.removeads",
    state: "active",
    purchasedAt: now().toISOString(),
    environment: "sandbox",
  }]);
  repository.seed("other-player", [{
    productId: "other-product",
    state: "active",
    purchasedAt: now().toISOString(),
    environment: "sandbox",
  }]);
  const result = await new EntitlementService(repository).list(principal);
  assert.deepEqual(result.map((value) => value.productId), ["com.itsallreal.stonescryout.removeads"]);
});
