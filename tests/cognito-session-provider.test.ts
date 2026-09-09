import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CognitoSessionProvider,
  CognitoSessionRejectedError,
  RefreshCredentialOwnershipMismatchError,
  type CognitoSessionGateway,
  type RefreshCredentialRegistry,
} from "../src/auth/cognito-session-provider.js";
import { SessionCredentialInvalidError, SessionCredentialOwnershipError } from "../src/auth/session-lifecycle-service.js";

const now = new Date("2026-09-03T12:00:00.000Z");
const playerId = "55555555-5555-4555-8555-555555555555";
const firstRefresh = "first-refresh-credential-0001";
const nextRefresh = "replacement-refresh-credential-0002";
const issued = { accessToken: "access-token-value-00000001", refreshToken: firstRefresh, expiresInSeconds: 3600 };

class CapturingRegistry implements RefreshCredentialRegistry {
  public registered: unknown;
  public rotated: unknown;
  public ownership: unknown;
  public revoked: unknown;
  public ownershipError: Error | undefined;

  async register(input: unknown) { this.registered = input; }
  async rotate(input: unknown) { this.rotated = input; }
  async assertOwnedBy(input: unknown) {
    this.ownership = input;
    if (this.ownershipError !== undefined) throw this.ownershipError;
  }
  async markRevoked(input: unknown) { this.revoked = input; }
}

function gateway(overrides: Partial<CognitoSessionGateway> = {}): CognitoSessionGateway {
  return {
    async startCustomAuthentication() { return issued; },
    async refreshWithRotation() {
      return { ...issued, accessToken: "replacement-access-token-002", refreshToken: nextRefresh };
    },
    async revoke() {},
    ...overrides,
  };
}

test("Cognito issuance registers only a hash of the refresh credential", async () => {
  const registry = new CapturingRegistry();
  const tokens = await new CognitoSessionProvider(gateway(), registry, 2_592_000).issue(playerId, now);

  assert.equal(tokens.expiresAt, "2026-09-03T13:00:00.000Z");
  assert.deepEqual(registry.registered, {
    credentialHash: hash(firstRefresh),
    playerId,
    expiresAt: new Date("2026-10-03T12:00:00.000Z"),
    now,
  });
  assert.equal(JSON.stringify(registry.registered).includes(firstRefresh), false);
});

test("refresh requires Cognito rotation and atomically replaces the credential hash", async () => {
  const registry = new CapturingRegistry();
  const provider = new CognitoSessionProvider(gateway(), registry, 2_592_000);
  await provider.refresh({ refreshToken: firstRefresh, now });

  assert.deepEqual(registry.rotated, {
    previousCredentialHash: hash(firstRefresh),
    replacementCredentialHash: hash(nextRefresh),
    replacementRawToken: nextRefresh,
    now,
  });
});

test("Cognito rejection maps to the generic lifecycle error", async () => {
  const provider = new CognitoSessionProvider(gateway({
    async refreshWithRotation() { throw new CognitoSessionRejectedError("provider detail"); },
  }), new CapturingRegistry(), 100);
  await assert.rejects(provider.refresh({ refreshToken: firstRefresh, now }), SessionCredentialInvalidError);
});

test("revocation verifies hashed credential ownership before calling Cognito", async () => {
  const registry = new CapturingRegistry();
  let revokedToken: string | undefined;
  const provider = new CognitoSessionProvider(gateway({ async revoke(token) { revokedToken = token; } }), registry, 100);
  await provider.revoke({ playerId, refreshToken: firstRefresh, now });

  assert.deepEqual(registry.ownership, { credentialHash: hash(firstRefresh), playerId, now });
  assert.equal(revokedToken, firstRefresh);
  assert.deepEqual(registry.revoked, { credentialHash: hash(firstRefresh), playerId, now });
});

test("revocation rejects a credential belonging to another player", async () => {
  const registry = new CapturingRegistry();
  registry.ownershipError = new RefreshCredentialOwnershipMismatchError("wrong owner");
  await assert.rejects(
    new CognitoSessionProvider(gateway(), registry, 100).revoke({ playerId, refreshToken: firstRefresh, now }),
    SessionCredentialOwnershipError,
  );
});

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Issue 2: compensation on registration failure in CognitoSessionProvider.issue
// ---------------------------------------------------------------------------

test("issue: DynamoDB registration failure triggers best-effort revocation of issued refresh token", async () => {
  const dbError = new Error("DynamoDB registration failed");
  let revokedToken: string | undefined;

  const failingRegistry: RefreshCredentialRegistry = {
    async register() { throw dbError; },
    async rotate() {},
    async assertOwnedBy() {},
    async markRevoked() {},
  };

  const provider = new CognitoSessionProvider(
    gateway({ async revoke(token) { revokedToken = token; } }),
    failingRegistry,
    2_592_000,
  );

  await assert.rejects(provider.issue(playerId, now), dbError);
  // The issued refresh token must have been revoked.
  assert.equal(revokedToken, firstRefresh);
});

test("issue: conflicting/mismatched registration triggers compensation and rethrows", async () => {
  const mismatchError = new Error("existing credential belongs to a different player");
  let revokedToken: string | undefined;

  const failingRegistry: RefreshCredentialRegistry = {
    async register() { throw mismatchError; },
    async rotate() {},
    async assertOwnedBy() {},
    async markRevoked() {},
  };

  const provider = new CognitoSessionProvider(
    gateway({ async revoke(token) { revokedToken = token; } }),
    failingRegistry,
    2_592_000,
  );

  await assert.rejects(provider.issue(playerId, now), mismatchError);
  assert.equal(revokedToken, firstRefresh);
});

test("issue: compensation revocation failure is swallowed and original registration error is authoritative", async () => {
  const dbError = new Error("DynamoDB registration failed");
  const revokeError = new Error("Cognito revocation also failed");

  const failingRegistry: RefreshCredentialRegistry = {
    async register() { throw dbError; },
    async rotate() {},
    async assertOwnedBy() {},
    async markRevoked() {},
  };

  const provider = new CognitoSessionProvider(
    gateway({ async revoke() { throw revokeError; } }),
    failingRegistry,
    2_592_000,
  );

  // The original dbError must be thrown, not the revokeError.
  await assert.rejects(
    provider.issue(playerId, now),
    (error: unknown) => error === dbError,
  );
});
