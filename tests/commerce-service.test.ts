import assert from "node:assert/strict";
import test from "node:test";

import type { AuthenticatedPrincipal } from "../src/auth/authentication.js";
import {
  AdRewardService,
  AppStoreNotificationService,
  CommerceOwnershipError,
  CommerceVerificationError,
  PurchaseService,
  type AdCompletionVerifier,
  type AdRewardCatalog,
  type AppAccountTokenMatcher,
  type AppStoreNotificationVerifier,
  type AppStoreTransactionVerifier,
  type CommerceProductCatalog,
} from "../src/commerce/commerce-service.js";
import { MemoryCommerceRepository } from "../src/commerce/memory-commerce-repository.js";

const now = () => new Date("2026-08-31T16:00:00.000Z");
const principal: AuthenticatedPrincipal = {
  playerId: "00000000-0000-4000-8000-000000000501",
  sessionKind: "account",
  issuer: "test",
  audience: "test",
};
const transactionVerifier: AppStoreTransactionVerifier = {
  async verify() {
    return {
      transactionId: "transaction-1001",
      originalTransactionId: "original-1001",
      productId: "com.itsallreal.stonescryout.gems.small",
      appAccountToken: "account-token-501",
      environment: "sandbox",
      purchasedAt: now().toISOString(),
    };
  },
};
const ownership: AppAccountTokenMatcher = {
  async matches(playerId, token) { return playerId === principal.playerId && token === "account-token-501"; },
};
const products: CommerceProductCatalog = {
  async get(productId) {
    if (productId === "com.itsallreal.stonescryout.gems.small") {
      return { productId, kind: "consumable", grants: [{ resource: "gems", delta: 100 }] };
    }
    if (productId === "com.itsallreal.stonescryout.removeads") {
      return { productId, kind: "nonConsumable", grants: [] };
    }
    return undefined;
  },
};

function repository() {
  const value = new MemoryCommerceRepository();
  value.seedBalance(principal.playerId, {
    coins: 250,
    gems: 25,
    energy: 80,
    energyUpdatedAt: now().toISOString(),
    revision: 1,
  });
  return value;
}

function purchaseInput(override: Partial<{ principal: AuthenticatedPrincipal; idempotencyKey: string }> = {}) {
  return {
    principal: override.principal ?? principal,
    signedTransaction: "signed.app-store.transaction.payload",
    idempotencyKey: override.idempotencyKey ?? "purchase-verify-0001",
    clientBuild: 1,
    contentVersion: "starter-1",
  };
}

test("a verified player-bound App Store transaction grants exactly once", async () => {
  const repo = repository();
  const service = new PurchaseService(transactionVerifier, ownership, products, repo, now);
  const first = await service.verifyPurchase(purchaseInput());
  const duplicate = await service.verifyPurchase(purchaseInput({ idempotencyKey: "purchase-verify-0002" }));
  assert.equal(first.status, "granted");
  assert.equal(first.balance.gems, 125);
  assert.equal(duplicate.status, "duplicate");
  assert.equal(repo.balance(principal.playerId)?.gems, 125);
  assert.equal(repo.ledger(principal.playerId).length, 1);
});

test("a globally claimed transaction cannot be attached to another player", async () => {
  const repo = repository();
  const other: AuthenticatedPrincipal = { ...principal, playerId: "00000000-0000-4000-8000-000000000502" };
  repo.seedBalance(other.playerId, {
    coins: 0, gems: 0, energy: 0, energyUpdatedAt: now().toISOString(), revision: 1,
  });
  const permissiveOwnership: AppAccountTokenMatcher = { async matches() { return true; } };
  const service = new PurchaseService(transactionVerifier, permissiveOwnership, products, repo, now);
  await service.verifyPurchase(purchaseInput());
  await assert.rejects(
    service.verifyPurchase(purchaseInput({ principal: other, idempotencyKey: "purchase-verify-0003" })),
    CommerceOwnershipError,
  );
  assert.equal(repo.balance(other.playerId)?.gems, 0);
});

test("transaction ownership binding is required after signature verification", async () => {
  const service = new PurchaseService(
    transactionVerifier,
    { async matches() { return false; } },
    products,
    repository(),
    now,
  );
  await assert.rejects(service.verifyPurchase(purchaseInput()), CommerceOwnershipError);
});

test("unverified signed transactions never reach the grant repository", async () => {
  const repo = repository();
  const service = new PurchaseService(
    { async verify() { throw new Error("bad JWS signature"); } },
    ownership,
    products,
    repo,
    now,
  );
  await assert.rejects(service.verifyPurchase(purchaseInput()), CommerceVerificationError);
  assert.equal(repo.ledger(principal.playerId).length, 0);
});

test("verified refund notifications update a non-consumable entitlement once", async () => {
  const repo = repository();
  const removeAdsVerifier: AppStoreTransactionVerifier = {
    async verify() {
      return {
        ...(await transactionVerifier.verify("ignored", now())),
        transactionId: "transaction-removeads-1",
        productId: "com.itsallreal.stonescryout.removeads",
      };
    },
  };
  await new PurchaseService(removeAdsVerifier, ownership, products, repo, now).verifyPurchase(purchaseInput());
  const notificationVerifier: AppStoreNotificationVerifier = {
    async verify() {
      return {
        notificationId: "notification-refund-1",
        notificationType: "REFUND",
        transactionId: "transaction-removeads-1",
        productId: "com.itsallreal.stonescryout.removeads",
        environment: "sandbox",
        effectiveAt: now().toISOString(),
      };
    },
  };
  const service = new AppStoreNotificationService(notificationVerifier, repo, now);
  const first = await service.process("signed.app-store.notification.payload");
  const replay = await service.process("signed.app-store.notification.payload");
  assert.equal(first.status, "applied");
  assert.equal(first.entitlement?.state, "refunded");
  assert.equal(replay.status, "duplicate");
  assert.equal(repo.entitlement(principal.playerId, "com.itsallreal.stonescryout.removeads")?.state, "refunded");
});

test("a verified ad completion grants its configured reward once across idempotency keys", async () => {
  const repo = repository();
  const verifier: AdCompletionVerifier = {
    async verify() {
      return {
        provider: "test-provider",
        providerEventId: "ad-event-1001",
        claimId: "ad-claim-1001",
        playerId: principal.playerId,
      };
    },
  };
  const rewards: AdRewardCatalog = {
    async resolve(_placement, rewardChoice) {
      return rewardChoice === "energy20"
        ? [{ resource: "energy", delta: 20 }]
        : [{ resource: "coins", delta: 100 }];
    },
  };
  const service = new AdRewardService(verifier, rewards, repo, now);
  const input = {
    principal,
    placement: "storeEnergy" as const,
    rewardChoice: "energy20" as const,
    claimId: "ad-claim-1001",
    verificationPayload: "signed.ad-provider.completion.payload",
    idempotencyKey: "ad-reward-0001",
    clientBuild: 1,
    contentVersion: "starter-1",
  };
  const first = await service.verifyReward(input);
  const duplicate = await service.verifyReward({ ...input, idempotencyKey: "ad-reward-0002" });
  assert.equal(first.balance.energy, 100);
  assert.equal(duplicate.status, "duplicate");
  assert.equal(repo.ledger(principal.playerId).length, 1);
});

test("ad completion must bind both player and preissued claim", async () => {
  const verifier: AdCompletionVerifier = {
    async verify() {
      return { provider: "test", providerEventId: "event", claimId: "different-claim", playerId: principal.playerId };
    },
  };
  const rewards: AdRewardCatalog = { async resolve() { return [{ resource: "coins", delta: 100 }]; } };
  const service = new AdRewardService(verifier, rewards, repository(), now);
  await assert.rejects(
    service.verifyReward({
      principal,
      placement: "storeCoins",
      rewardChoice: "coins100",
      claimId: "ad-claim-1002",
      verificationPayload: "signed.ad-provider.completion.payload",
      idempotencyKey: "ad-reward-0003",
      clientBuild: 1,
      contentVersion: "starter-1",
    }),
    CommerceOwnershipError,
  );
});
