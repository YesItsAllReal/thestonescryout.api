import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountIdempotencyConflictError,
  AccountLinkAuthorizationError,
  AccountLinkDecisionRequiredError,
  AppleAccountService,
  AppleIdentityVerificationError,
  type AppleIdentityVerifier,
} from "../src/accounts/apple-account-service.js";
import type { PlayerProfile, SessionTokenIssuer } from "../src/accounts/guest-session-service.js";
import { MemoryAppleAccountRepository } from "../src/accounts/memory-apple-account-repository.js";

const timestamp = new Date("2026-08-31T12:00:00.000Z");
const credential = {
  identityToken: "header.payload.signature-for-tests-only",
  nonce: "nonce-value-0000000001",
};
const verifier: AppleIdentityVerifier = {
  async verify() {
    return { issuer: "https://appleid.apple.com", subject: "apple-subject-123" };
  },
};
const tokenIssuer: SessionTokenIssuer = {
  async issue(playerId) {
    return {
      accessToken: `test-access-token.${playerId}`,
      refreshToken: `test-refresh-token.${playerId}`,
      expiresAt: new Date(timestamp.getTime() + 3_600_000).toISOString(),
    };
  },
};

function player(playerId: string, accountKind: PlayerProfile["accountKind"]): PlayerProfile {
  return { playerId, accountKind, createdAt: timestamp.toISOString(), deletionState: "active" };
}

function service(repository: MemoryAppleAccountRepository, identityVerifier = verifier) {
  return new AppleAccountService(identityVerifier, repository, tokenIssuer, () => timestamp);
}

test("Apple sign-in trusts only the verified issuer and subject returned by the verifier", async () => {
  const response = await service(new MemoryAppleAccountRepository()).signIn(credential, "apple-signin-0001");
  assert.equal(response.player.accountKind, "apple");
  assert.equal(response.tokens.accessToken, `test-access-token.${response.player.playerId}`);
});

test("Apple verification failures do not expose provider details", async () => {
  const failingVerifier: AppleIdentityVerifier = { async verify() { throw new Error("provider token detail"); } };
  await assert.rejects(
    service(new MemoryAppleAccountRepository(), failingVerifier).signIn(credential, "apple-signin-0002"),
    (error: unknown) => error instanceof AppleIdentityVerificationError && !error.message.includes("provider token detail"),
  );
});

test("Apple sign-in rejects an idempotency key reused for another verified subject", async () => {
  const repository = new MemoryAppleAccountRepository();
  const subjectVerifier: AppleIdentityVerifier = {
    async verify(value) {
      return {
        issuer: "https://appleid.apple.com",
        subject: value.identityToken.endsWith("one") ? "subject-one" : "subject-two",
      };
    },
  };
  const accountService = service(repository, subjectVerifier);
  await accountService.signIn(
    { ...credential, identityToken: "header.payload.signature-one" },
    "apple-signin-0003",
  );
  await assert.rejects(
    accountService.signIn(
      { ...credential, identityToken: "header.payload.signature-two" },
      "apple-signin-0003",
    ),
    AccountIdempotencyConflictError,
  );
});

test("guest linking attaches an unused verified Apple identity", async () => {
  const repository = new MemoryAppleAccountRepository();
  repository.addPlayer(player("00000000-0000-4000-8000-000000000101", "guest"));
  const response = await service(repository).linkGuest({
    principal: {
      playerId: "00000000-0000-4000-8000-000000000101",
      sessionKind: "guest",
      issuer: "local-test-issuer",
      audience: "local-test-audience",
    },
    credential,
    idempotencyKey: "apple-link-0001",
  });
  assert.equal(response.player.playerId, "00000000-0000-4000-8000-000000000101");
  assert.equal(response.player.accountKind, "apple");
});

test("linking never silently overwrites progress when Apple already belongs to another player", async () => {
  const repository = new MemoryAppleAccountRepository();
  const guestId = "00000000-0000-4000-8000-000000000102";
  const existingId = "00000000-0000-4000-8000-000000000103";
  repository.addPlayer(player(guestId, "guest"));
  repository.addPlayer(player(existingId, "apple"));
  repository.associateAppleIdentity("https://appleid.apple.com", "apple-subject-123", existingId);
  const accountService = service(repository);
  let conflictId = "";
  await assert.rejects(
    accountService.linkGuest({
      principal: { playerId: guestId, sessionKind: "guest", issuer: "test", audience: "test" },
      credential,
      idempotencyKey: "apple-link-0002",
    }),
    (error: unknown) => {
      if (!(error instanceof AccountLinkDecisionRequiredError)) return false;
      conflictId = error.conflictId;
      return error.guestPlayerId === guestId && error.existingPlayerId === existingId;
    },
  );

  const resolved = await accountService.linkGuest({
    principal: { playerId: guestId, sessionKind: "guest", issuer: "test", audience: "test" },
    credential,
    idempotencyKey: "apple-link-resolution-0001",
    resolution: { conflictId, saveChoice: "preferExistingSave" },
  });
  assert.equal(resolved.player.playerId, existingId);
});

test("an account session cannot impersonate a guest during linking", async () => {
  await assert.rejects(
    service(new MemoryAppleAccountRepository()).linkGuest({
      principal: { playerId: "00000000-0000-4000-8000-000000000104", sessionKind: "account", issuer: "test", audience: "test" },
      credential,
      idempotencyKey: "apple-link-0003",
    }),
    AccountLinkAuthorizationError,
  );
});
