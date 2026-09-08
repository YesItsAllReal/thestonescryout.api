import assert from "node:assert/strict";
import test from "node:test";

import type { SessionTokens } from "../src/accounts/guest-session-service.js";
import type { AuthenticatedPrincipal, AccessTokenVerifier } from "../src/auth/authentication.js";
import {
  SessionCredentialInvalidError,
  SessionCredentialOwnershipError,
  SessionLifecycleService,
  type SessionLifecycleProvider,
} from "../src/auth/session-lifecycle-service.js";
import { createRefreshSessionHandler, createRevokeSessionHandler } from "../src/http/session-handlers.js";
import type { StructuredLogger } from "../src/http/http-types.js";
import { MemoryFixedWindowRateLimiter } from "../src/http/memory-fixed-window-rate-limiter.js";

const now = () => new Date("2026-09-02T17:00:00.000Z");
const playerId = "44444444-4444-4444-8444-444444444444";
const refreshToken = "opaque-refresh-credential-0001";
const tokens: SessionTokens = {
  accessToken: "replacement-access-token-0001",
  refreshToken: "replacement-refresh-token-0002",
  expiresAt: "2026-09-02T18:00:00.000Z",
};
const principal: AuthenticatedPrincipal = {
  playerId,
  sessionKind: "guest",
  issuer: "https://issuer.example.test",
  audience: "mobile-client",
};

class CapturingProvider implements SessionLifecycleProvider {
  public readonly refreshed: string[] = [];
  public readonly revoked: Array<{ playerId: string; refreshToken: string }> = [];

  public async refresh(input: { refreshToken: string }): Promise<SessionTokens> {
    this.refreshed.push(input.refreshToken);
    return tokens;
  }

  public async revoke(input: { playerId: string; refreshToken: string }): Promise<void> {
    this.revoked.push({ playerId: input.playerId, refreshToken: input.refreshToken });
  }
}

class CapturingLogger implements StructuredLogger {
  public readonly events: Array<Readonly<Record<string, string | number | boolean>>> = [];
  public info(event: Readonly<Record<string, string | number | boolean>>): void { this.events.push(event); }
  public error(event: Readonly<Record<string, string | number | boolean>>): void { this.events.push(event); }
}

test("session refresh delegates opaque credential validation and rotation to the provider", async () => {
  const provider = new CapturingProvider();
  const service = new SessionLifecycleService(provider, now);

  assert.deepEqual(await service.refresh(refreshToken), tokens);
  assert.deepEqual(provider.refreshed, [refreshToken]);
});

test("session revocation is bound to the verified principal player", async () => {
  const provider = new CapturingProvider();
  await new SessionLifecycleService(provider, now).revoke(principal, refreshToken);
  assert.deepEqual(provider.revoked, [{ playerId, refreshToken }]);
});

test("refresh handler returns generic authentication failure without logging credentials", async () => {
  const logger = new CapturingLogger();
  const provider: SessionLifecycleProvider = {
    async refresh() { throw new SessionCredentialInvalidError("provider detail"); },
    async revoke() {},
  };
  const response = await createRefreshSessionHandler(
    new SessionLifecycleService(provider, now),
    publicDependencies(logger),
  )({ body: JSON.stringify({ refreshToken }), requestContext: { http: { sourceIp: "192.0.2.44" } } });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.includes("provider detail"), false);
  assert.equal(JSON.stringify(logger.events).includes(refreshToken), false);
  assert.equal(JSON.stringify(logger.events).includes("192.0.2.44"), false);
});

test("revoke handler maps cross-player credential ownership to forbidden without logging tokens", async () => {
  const logger = new CapturingLogger();
  const provider: SessionLifecycleProvider = {
    async refresh() { return tokens; },
    async revoke() { throw new SessionCredentialOwnershipError("belongs to another player"); },
  };
  const verifier: AccessTokenVerifier = { async verify() { return principal; } };
  const response = await createRevokeSessionHandler(
    new SessionLifecycleService(provider, now),
    { ...publicDependencies(logger), tokenVerifier: verifier },
  )({
    headers: { authorization: "Bearer access-token-secret" },
    body: JSON.stringify({ refreshToken }),
    requestContext: { http: { sourceIp: "192.0.2.45" } },
  });

  assert.equal(response.statusCode, 403);
  const logs = JSON.stringify(logger.events);
  assert.equal(logs.includes(refreshToken), false);
  assert.equal(logs.includes("access-token-secret"), false);
  assert.equal(logs.includes("belongs to another player"), false);
});

test("revoke handler returns an empty idempotent success response", async () => {
  const logger = new CapturingLogger();
  const provider = new CapturingProvider();
  const verifier: AccessTokenVerifier = { async verify() { return principal; } };
  const response = await createRevokeSessionHandler(
    new SessionLifecycleService(provider, now),
    { ...publicDependencies(logger), tokenVerifier: verifier },
  )({ headers: { authorization: "Bearer valid-access-token" }, body: JSON.stringify({ refreshToken }) });

  assert.equal(response.statusCode, 204);
  assert.equal(response.body, "");
  assert.deepEqual(provider.revoked, [{ playerId, refreshToken }]);
});

function publicDependencies(logger: CapturingLogger) {
  return {
    logger,
    rateLimiter: new MemoryFixedWindowRateLimiter(10, 60),
    now,
  };
}
