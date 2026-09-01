import assert from "node:assert/strict";
import test from "node:test";

import { GuestSessionService, type SessionTokenIssuer } from "../src/accounts/guest-session-service.js";
import { MemoryGuestPlayerRepository } from "../src/accounts/memory-guest-player-repository.js";
import { Sha256InstallationIdHasher } from "../src/accounts/sha256-installation-id-hasher.js";
import { createGuestSessionHandler } from "../src/http/guest-session-handler.js";
import { createHealthHandler } from "../src/http/health-handler.js";
import type { StructuredLogger } from "../src/http/http-types.js";
import { MemoryFixedWindowRateLimiter } from "../src/http/memory-fixed-window-rate-limiter.js";

const now = () => new Date("2026-08-31T12:00:00.000Z");
const tokenIssuer: SessionTokenIssuer = {
  async issue(playerId, issuedAt) {
    return {
      accessToken: `local-access.${playerId}`,
      refreshToken: `local-refresh.${playerId}`,
      expiresAt: new Date(issuedAt.getTime() + 3_600_000).toISOString(),
    };
  },
};

class CapturingLogger implements StructuredLogger {
  public readonly events: Array<Readonly<Record<string, string | number | boolean>>> = [];
  public info(event: Readonly<Record<string, string | number | boolean>>): void { this.events.push(event); }
  public error(event: Readonly<Record<string, string | number | boolean>>): void { this.events.push(event); }
}

function guestHandler(logger = new CapturingLogger(), maximumRequests = 10) {
  const service = new GuestSessionService(
    new MemoryGuestPlayerRepository(),
    tokenIssuer,
    new Sha256InstallationIdHasher(),
    now,
  );
  return {
    handler: createGuestSessionHandler({
      service,
      logger,
      rateLimiter: new MemoryFixedWindowRateLimiter(maximumRequests, 60),
      now,
    }),
    logger,
  };
}

function request(idempotencyKey: string, installationId = "00000000-0000-4000-8000-000000000006") {
  return {
    headers: { "Idempotency-Key": idempotencyKey, "X-Request-ID": "00000000-0000-4000-8000-000000000099" },
    requestContext: { http: { sourceIp: "192.0.2.10" } },
    body: JSON.stringify({ installationId, locale: "en-US", appBuild: 1, platform: "ios" }),
  };
}

test("health handler returns only non-sensitive status and a correlation id", async () => {
  const logger = new CapturingLogger();
  const response = await createHealthHandler(logger)({ headers: {} });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { status: "ok" });
  assert.match(response.headers["x-request-id"] ?? "", /^[0-9a-f-]{36}$/);
});

test("guest handler creates and safely replays a session", async () => {
  const { handler } = guestHandler();
  const first = await handler(request("guest-create-0001"));
  const replay = await handler(request("guest-create-0001"));
  assert.equal(first.statusCode, 201);
  assert.equal(replay.statusCode, 201);
  assert.equal(JSON.parse(first.body).player.playerId, JSON.parse(replay.body).player.playerId);
});

test("guest handler rejects reuse of an idempotency key with changed input", async () => {
  const { handler } = guestHandler();
  await handler(request("guest-create-0002"));
  const conflict = await handler(request("guest-create-0002", "00000000-0000-4000-8000-000000000007"));
  assert.equal(conflict.statusCode, 409);
  assert.equal(JSON.parse(conflict.body).type, "/problems/idempotency-conflict");
});

test("guest handler rate limits without invoking or logging request content", async () => {
  const { handler, logger } = guestHandler(new CapturingLogger(), 1);
  await handler(request("guest-create-0003"));
  const limited = await handler(request("guest-create-0004"));
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["retry-after"], "60");
  const serializedLogs = JSON.stringify(logger.events);
  assert.equal(serializedLogs.includes("192.0.2.10"), false);
  assert.equal(serializedLogs.includes("00000000-0000-4000-8000-000000000006"), false);
  assert.equal(serializedLogs.includes("local-access"), false);
});

test("guest handler maps malformed JSON to a privacy-safe problem", async () => {
  const { handler } = guestHandler();
  const response = await handler({
    headers: { "Idempotency-Key": "guest-create-0005" },
    body: "{not-json",
  });
  assert.equal(response.statusCode, 400);
  assert.equal(Object.hasOwn(JSON.parse(response.body), "detail"), false);
});
