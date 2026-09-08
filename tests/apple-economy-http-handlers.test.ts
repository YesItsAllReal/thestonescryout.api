import assert from "node:assert/strict";
import test from "node:test";

import { AppleAccountService, type AppleIdentityVerifier } from "../src/accounts/apple-account-service.js";
import type { PlayerProfile, SessionTokenIssuer } from "../src/accounts/guest-session-service.js";
import { MemoryAppleAccountRepository } from "../src/accounts/memory-apple-account-repository.js";
import type { AccessTokenVerifier, AuthenticatedPrincipal } from "../src/auth/authentication.js";
import {
  EconomyService,
  type EconomySpendRules,
  type RewardClaimVerifier,
} from "../src/economy/economy-service.js";
import { EntitlementService } from "../src/economy/entitlement-service.js";
import { MemoryEconomyRepository } from "../src/economy/memory-economy-repository.js";
import { MemoryEntitlementRepository } from "../src/economy/memory-entitlement-repository.js";
import { createAppleLinkHandler, createAppleSignInHandler } from "../src/http/apple-account-handlers.js";
import { createGetEconomyHandler, createGetEntitlementsHandler, createRewardClaimHandler, createSpendHandler } from "../src/http/economy-handlers.js";
import type { AuthenticatedHandlerDependencies, StructuredLogger } from "../src/http/http-types.js";
import { MemoryFixedWindowRateLimiter } from "../src/http/memory-fixed-window-rate-limiter.js";

const now = () => new Date("2026-09-01T11:00:00.000Z");
const guestId = "00000000-0000-4000-8000-000000000701";
const guestPrincipal: AuthenticatedPrincipal = {
  playerId: guestId,
  sessionKind: "guest",
  issuer: "local-test",
  audience: "local-test",
};
const accountPrincipal: AuthenticatedPrincipal = { ...guestPrincipal, sessionKind: "account" };

class CapturingLogger implements StructuredLogger {
  public readonly events: Array<Readonly<Record<string, string | number | boolean>>> = [];
  public info(event: Readonly<Record<string, string | number | boolean>>): void { this.events.push(event); }
  public error(event: Readonly<Record<string, string | number | boolean>>): void { this.events.push(event); }
}

function dependencies(principal: AuthenticatedPrincipal, logger = new CapturingLogger()): AuthenticatedHandlerDependencies {
  const verifier: AccessTokenVerifier = {
    async verify(token) {
      if (token !== "local-bearer-token") throw new Error("invalid");
      return principal;
    },
  };
  return {
    tokenVerifier: verifier,
    rateLimiter: new MemoryFixedWindowRateLimiter(30, 60),
    logger,
    now,
  };
}

function headers(idempotencyKey?: string) {
  return {
    authorization: "Bearer local-bearer-token",
    ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
  };
}

const identityToken = "test-apple-identity-token-sensitive-value";
const appleCredential = { identityToken, nonce: "nonce-value-0000000001" };
const appleVerifier: AppleIdentityVerifier = {
  async verify() { return { issuer: "https://appleid.apple.com", subject: "apple-subject-http" }; },
};
const tokenIssuer: SessionTokenIssuer = {
  async issue(playerId) {
    return {
      accessToken: `local-access.${playerId}`,
      refreshToken: `local-refresh.${playerId}`,
      expiresAt: new Date(now().getTime() + 3_600_000).toISOString(),
    };
  },
};

test("Apple sign-in handler verifies credentials without logging them", async () => {
  const logger = new CapturingLogger();
  const service = new AppleAccountService(appleVerifier, new MemoryAppleAccountRepository(), tokenIssuer, now);
  const response = await createAppleSignInHandler(service, {
    rateLimiter: new MemoryFixedWindowRateLimiter(10, 60), logger, now,
  })({
    headers: { "idempotency-key": "apple-http-signin-1" },
    body: JSON.stringify(appleCredential),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).player.accountKind, "apple");
  assert.equal(JSON.stringify(logger.events).includes(identityToken), false);
});

test("Apple link handler returns an opaque decision without exposing either player ID", async () => {
  const repository = new MemoryAppleAccountRepository();
  const guest: PlayerProfile = { playerId: guestId, accountKind: "guest", createdAt: now().toISOString(), deletionState: "active" };
  const existing: PlayerProfile = {
    playerId: "00000000-0000-4000-8000-000000000702",
    accountKind: "apple",
    createdAt: now().toISOString(),
    deletionState: "active",
  };
  repository.addPlayer(guest);
  repository.addPlayer(existing);
  repository.associateAppleIdentity("https://appleid.apple.com", "apple-subject-http", existing.playerId);
  const service = new AppleAccountService(appleVerifier, repository, tokenIssuer, now);
  const response = await createAppleLinkHandler(service, dependencies(guestPrincipal))({
    headers: headers("apple-http-link-1"),
    body: JSON.stringify({ provider: "apple", credential: appleCredential }),
  });
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 409);
  assert.match(body.conflictId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(body.allowedSaveChoices, ["preferGuestSave", "preferExistingSave"]);
  assert.equal(response.body.includes(guest.playerId), false);
  assert.equal(response.body.includes(existing.playerId), false);
});

function economyContext() {
  const repository = new MemoryEconomyRepository();
  repository.seed(accountPrincipal.playerId, {
    coins: 250,
    gems: 25,
    energy: 80,
    energyUpdatedAt: now().toISOString(),
    revision: 1,
  });
  const spendRules: EconomySpendRules = {
    async resolve(input) {
      return {
        mutations: [{ resource: "coins", delta: -100 }],
        reasonCode: "INVENTORY_EXPANSION",
        sourceReference: input.referenceId,
      };
    },
  };
  const rewardVerifier: RewardClaimVerifier = {
    async verify(input) {
      if (input.claimToken !== "verified-sensitive-claim") throw new Error("invalid");
      return {
        mutations: [{ resource: "coins", delta: 50 }],
        reasonCode: "DAILY_GIFT",
        sourceReference: input.claimId,
      };
    },
  };
  return { repository, service: new EconomyService(repository, spendRules, rewardVerifier, now) };
}

test("economy handlers return authoritative balance and strip internal ledger metadata", async () => {
  const context = economyContext();
  const deps = dependencies(accountPrincipal);
  const initial = await createGetEconomyHandler(context.service, deps)({ headers: headers() });
  const spent = await createSpendHandler(context.service, deps)({
    headers: headers("economy-http-spend-1"),
    body: JSON.stringify({
      action: "inventoryExpansion",
      referenceId: "inventory-slot-1",
      expectedRevision: 1,
      clientBuild: 1,
      contentVersion: "starter-1",
    }),
  });
  const body = JSON.parse(spent.body);
  assert.equal(JSON.parse(initial.body).coins, 250);
  assert.equal(body.balance.coins, 150);
  assert.equal(Object.hasOwn(body.ledgerEntries[0], "idempotencyKey"), false);
  assert.equal(Object.hasOwn(body.ledgerEntries[0], "clientBuild"), false);
  assert.equal(Object.hasOwn(body.ledgerEntries[0], "contentVersion"), false);
});

test("economy spend handler exposes current revision on stale input", async () => {
  const context = economyContext();
  const response = await createSpendHandler(context.service, dependencies(accountPrincipal))({
    headers: headers("economy-http-spend-2"),
    body: JSON.stringify({
      action: "inventoryExpansion",
      referenceId: "inventory-slot-1",
      expectedRevision: 9,
      clientBuild: 1,
      contentVersion: "starter-1",
    }),
  });
  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).currentRevision, 1);
});

test("verified reward claim handler never logs its opaque claim token", async () => {
  const context = economyContext();
  const logger = new CapturingLogger();
  const response = await createRewardClaimHandler(context.service, dependencies(accountPrincipal, logger))({
    headers: headers("economy-http-reward-1"),
    body: JSON.stringify({
      claimType: "dailyGift",
      claimId: "daily-2026-09-01",
      claimToken: "verified-sensitive-claim",
      clientBuild: 1,
      contentVersion: "starter-1",
    }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.stringify(logger.events).includes("verified-sensitive-claim"), false);
});

test("entitlement handler wraps only the authenticated player's records", async () => {
  const repository = new MemoryEntitlementRepository();
  repository.seed(accountPrincipal.playerId, [{
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
  const response = await createGetEntitlementsHandler(
    new EntitlementService(repository),
    dependencies(accountPrincipal),
  )({ headers: headers() });
  assert.deepEqual(JSON.parse(response.body).entitlements.map((value: { productId: string }) => value.productId), [
    "com.itsallreal.stonescryout.removeads",
  ]);
});
