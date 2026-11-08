import assert from "node:assert/strict";
import test from "node:test";

import type { AccessTokenVerifier, AuthenticatedPrincipal } from "../src/auth/authentication.js";
import {
  AdRewardService,
  AppStoreNotificationService,
  PurchaseService,
  type AdCompletionVerifier,
  type AdRewardCatalog,
  type AppAccountTokenMatcher,
  type AppStoreNotificationVerifier,
  type AppStoreTransactionVerifier,
  type CommerceProductCatalog,
} from "../src/commerce/commerce-service.js";
import { MemoryCommerceRepository } from "../src/commerce/memory-commerce-repository.js";
import {
  ContentCatalogService,
  RemoteConfigurationService,
  type PublicUrlPolicy,
  type SignedContentCatalog,
  type SignedDocumentVerifier,
  type SignedRemoteConfiguration,
} from "../src/content/content-service.js";
import { MemoryContentCatalogRepository, MemoryRemoteConfigurationRepository } from "../src/content/memory-content-repositories.js";
import { createAdRewardVerificationHandler, createAppStoreNotificationHandler, createPurchaseVerificationHandler } from "../src/http/commerce-handlers.js";
import { createContentCatalogHandler, createRemoteConfigurationHandler } from "../src/http/content-handlers.js";
import type { AuthenticatedHandlerDependencies, StructuredLogger } from "../src/http/http-types.js";
import { MemoryFixedWindowRateLimiter } from "../src/http/memory-fixed-window-rate-limiter.js";

const now = () => new Date("2026-09-01T12:00:00.000Z");
const playerId = "00000000-0000-4000-8000-000000000801";
const principal: AuthenticatedPrincipal = { playerId, sessionKind: "account", issuer: "test", audience: "test" };

class CapturingLogger implements StructuredLogger {
  public readonly events: Array<Readonly<Record<string, string | number | boolean>>> = [];
  public info(event: Readonly<Record<string, string | number | boolean>>): void { this.events.push(event); }
  public error(event: Readonly<Record<string, string | number | boolean>>): void { this.events.push(event); }
}

function publicDependencies(logger = new CapturingLogger()) {
  return { rateLimiter: new MemoryFixedWindowRateLimiter(20, 60), logger, now };
}

function authenticatedDependencies(logger = new CapturingLogger()): AuthenticatedHandlerDependencies {
  const verifier: AccessTokenVerifier = {
    async verify(token) {
      if (token !== "local-commerce-token") throw new Error("invalid");
      return principal;
    },
  };
  return { ...publicDependencies(logger), tokenVerifier: verifier };
}

function commerceRepository() {
  const repository = new MemoryCommerceRepository();
  repository.seedBalance(playerId, {
    coins: 250, gems: 25, energy: 80, energyUpdatedAt: now().toISOString(), revision: 1,
  });
  return repository;
}

test("purchase handler never logs signed JWS and strips internal ledger fields", async () => {
  const signedTransaction = "signed-sensitive-app-store-transaction-jws";
  const transactionVerifier: AppStoreTransactionVerifier = {
    async verify() {
      return {
        transactionId: "transaction-http-1",
        originalTransactionId: "original-http-1",
        productId: "com.itsallreal.stonescryout.gems.small",
        appAccountToken: "app-account-token-801",
        environment: "sandbox",
        purchasedAt: now().toISOString(),
      };
    },
  };
  const ownership: AppAccountTokenMatcher = { async matches() { return true; } };
  const products: CommerceProductCatalog = {
    async get(productId) { return { productId, kind: "consumable", grants: [{ resource: "gems", delta: 100 }] }; },
  };
  const logger = new CapturingLogger();
  const handler = createPurchaseVerificationHandler(
    new PurchaseService(transactionVerifier, ownership, products, commerceRepository(), now),
    authenticatedDependencies(logger),
  );
  const response = await handler({
    headers: { authorization: "Bearer local-commerce-token", "idempotency-key": "purchase-http-1" },
    body: JSON.stringify({ signedTransaction, clientBuild: 1, contentVersion: "starter-1" }),
  });
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.balance.gems, 125);
  assert.equal(Object.hasOwn(body.ledgerEntries[0], "idempotencyKey"), false);
  assert.equal(JSON.stringify(logger.events).includes(signedTransaction), false);
});

test("App Store notification handler maps signature failure without echoing payload", async () => {
  const signedPayload = "signed-sensitive-notification-payload";
  const verifier: AppStoreNotificationVerifier = { async verify() { throw new Error("bad signature details"); } };
  const logger = new CapturingLogger();
  const response = await createAppStoreNotificationHandler(
    new AppStoreNotificationService(verifier, commerceRepository(), now),
    publicDependencies(logger),
  )({ body: JSON.stringify({ signedPayload }) });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.includes(signedPayload), false);
  assert.equal(JSON.stringify(logger.events).includes(signedPayload), false);
});

test("rewarded-ad handler grants server-configured value and hides provider payload", async () => {
  const verificationPayload = "signed-sensitive-ad-completion-payload";
  const verifier: AdCompletionVerifier = {
    async verify() {
      return { provider: "test", providerEventId: "event-http-1", claimId: "claim-http-1", playerId };
    },
  };
  const rewards: AdRewardCatalog = { async resolve() { return [{ resource: "coins", delta: 100 }]; } };
  const logger = new CapturingLogger();
  const response = await createAdRewardVerificationHandler(
    new AdRewardService(verifier, rewards, commerceRepository(), now),
    authenticatedDependencies(logger),
  )({
    headers: { authorization: "Bearer local-commerce-token", "idempotency-key": "ad-http-reward-1" },
    body: JSON.stringify({
      placement: "storeCoins",
      rewardChoice: "coins100",
      claimId: "claim-http-1",
      verificationPayload,
      clientBuild: 1,
      contentVersion: "starter-1",
    }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).balance.coins, 350);
  assert.equal(JSON.stringify(logger.events).includes(verificationPayload), false);
});

test("rewarded-ad handler logs a privacy-safe provider-verification stage", async () => {
  const verificationPayload = "sensitive-invalid-ad-completion-payload";
  const verifier: AdCompletionVerifier = {
    async verify() { throw new Error("provider detail must not be logged"); },
  };
  const rewards: AdRewardCatalog = { async resolve() { return [{ resource: "coins", delta: 100 }]; } };
  const logger = new CapturingLogger();
  const response = await createAdRewardVerificationHandler(
    new AdRewardService(verifier, rewards, commerceRepository(), now),
    authenticatedDependencies(logger),
  )({
    headers: { authorization: "Bearer local-commerce-token", "idempotency-key": "ad-http-reward-failure-1" },
    body: JSON.stringify({
      placement: "storeCoins",
      rewardChoice: "coins100",
      claimId: "claim-http-failure-1",
      verificationPayload,
      clientBuild: 1,
      contentVersion: "starter-1",
    }),
  });
  assert.equal(response.statusCode, 401);
  assert.equal(logger.events.some((event) => event.failureClass === "provider_verification"), true);
  const logs = JSON.stringify(logger.events);
  assert.equal(logs.includes(verificationPayload), false);
  assert.equal(logs.includes("provider detail"), false);
});

const signature = "a".repeat(64);
const signatureVerifier: SignedDocumentVerifier = { async verify(input) { return input.signature === signature; } };
const urlPolicy: PublicUrlPolicy = {
  allows(value, purpose) {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === (purpose === "content" ? "cdn.stones.example" : "www.stones.example");
  },
};
const catalog: SignedContentCatalog = {
  catalogVersion: "catalog-1",
  channel: "production",
  publishedAt: now().toISOString(),
  packs: [{
    packId: "starter-en", version: "1.0.0", minimumAppBuild: 1, locale: "en-US",
    type: "starter", displayName: "Starter", compressedSize: 100, uncompressedSize: 200,
    sha256: "b".repeat(64), downloadUrl: "https://cdn.stones.example/starter.zip",
    publishedAt: now().toISOString(), editorialStatus: "approved",
  }],
  keyId: "content-key-1",
  signatureAlgorithm: "ed25519",
  signature,
};
const config: SignedRemoteConfiguration = {
  configVersion: "config-1", minimumAppBuild: 1, activeCatalogVersion: "catalog-1",
  featureFlags: {
    googleSignIn: false, rewardedAds: false, weekendDig: false, quizzes: true,
    gameCenter: true, remoteContent: true, purchases: true, accountSync: true, ministryLinks: true,
  },
  economy: {
    startingCoins: 250, startingGems: 25, startingEnergy: 80, energyCap: 100,
    energyRegenerationSeconds: 120, dailyGiftCoins: 50, dailyGiftEnergy: 20,
    rewardedCoins: 100, rewardedEnergy: 20, rewardedDailyCap: 5,
  },
  maintenanceMessage: null,
  links: {
    privacyUrl: "https://www.stones.example/privacy",
    termsUrl: "https://www.stones.example/terms",
    supportUrl: "https://www.stones.example/support",
  },
  publishedAt: now().toISOString(), keyId: "config-key-1", signatureAlgorithm: "ed25519", signature,
};

test("content catalog handler requires and maps compatibility query parameters", async () => {
  const handler = createContentCatalogHandler(
    new ContentCatalogService(new MemoryContentCatalogRepository(catalog), signatureVerifier, urlPolicy),
    publicDependencies(),
  );
  const invalid = await handler({ queryStringParameters: { platform: "ios" } });
  const valid = await handler({
    queryStringParameters: { platform: "ios", appBuild: "1", locale: "en-US", channel: "production" },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(valid.statusCode, 200);
  assert.equal(JSON.parse(valid.body).catalogVersion, "catalog-1");
});

test("configuration handler maps invalid signed documents to a privacy-safe 503", async () => {
  const invalidSignature = { ...config, signature: "c".repeat(64) };
  const handler = createRemoteConfigurationHandler(
    new RemoteConfigurationService(
      new MemoryRemoteConfigurationRepository(invalidSignature),
      signatureVerifier,
      urlPolicy,
    ),
    publicDependencies(),
  );
  const response = await handler({
    queryStringParameters: { platform: "ios", appBuild: "1", locale: "en-US" },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).type, "/problems/service-unavailable");
});
