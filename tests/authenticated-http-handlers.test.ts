import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountService,
  type AccountDeletionAuthorizer,
  type AccountProfile,
  type PlayerSessionRevoker,
} from "../src/accounts/account-service.js";
import { MemoryAccountRepository } from "../src/accounts/memory-account-repository.js";
import type { AccessTokenVerifier, AuthenticatedPrincipal } from "../src/auth/authentication.js";
import { createDeleteAccountHandler, createGetAccountHandler } from "../src/http/account-handlers.js";
import type { AuthenticatedHandlerDependencies, StructuredLogger } from "../src/http/http-types.js";
import { MemoryFixedWindowRateLimiter } from "../src/http/memory-fixed-window-rate-limiter.js";
import { createGetSaveHandler, createPutSaveHandler } from "../src/http/save-handlers.js";
import { MemorySaveRepository } from "../src/saves/memory-save-repository.js";
import { SaveService } from "../src/saves/save-service.js";
import { Sha256SaveDeviceIdHasher } from "../src/saves/sha256-save-device-id-hasher.js";

const now = () => new Date("2026-09-01T10:00:00.000Z");
const playerId = "00000000-0000-4000-8000-000000000601";
const principal: AuthenticatedPrincipal = {
  playerId,
  sessionKind: "account",
  issuer: "local-test",
  audience: "local-test",
};
const tokenVerifier: AccessTokenVerifier = {
  async verify(token) {
    if (token !== "local-valid-access-token") throw new Error("invalid token");
    return principal;
  },
};

class CapturingLogger implements StructuredLogger {
  public readonly events: Array<Readonly<Record<string, string | number | boolean>>> = [];
  public info(event: Readonly<Record<string, string | number | boolean>>): void { this.events.push(event); }
  public error(event: Readonly<Record<string, string | number | boolean>>): void { this.events.push(event); }
}

function dependencies(logger = new CapturingLogger(), maximumRequests = 20): AuthenticatedHandlerDependencies {
  return {
    tokenVerifier,
    rateLimiter: new MemoryFixedWindowRateLimiter(maximumRequests, 60),
    logger,
    now,
  };
}

function authorizedHeaders(idempotencyKey?: string) {
  return {
    authorization: "Bearer local-valid-access-token",
    "x-request-id": "00000000-0000-4000-8000-000000000699",
    ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
  };
}

const profile: AccountProfile = {
  playerId,
  accountKind: "apple",
  displayName: null,
  locale: "en-US",
  createdAt: "2026-08-31T12:00:00.000Z",
  linkedProviders: ["apple"],
  deletionState: "active",
};

class AllowDeletion implements AccountDeletionAuthorizer {
  public async authorize(): Promise<{}> { return {}; }
}

class NoopRevoker implements PlayerSessionRevoker {
  public async revokeAll(): Promise<void> {}
}

test("account profile handler rejects missing authentication", async () => {
  const repository = new MemoryAccountRepository();
  repository.add(profile);
  const service = new AccountService(repository, new AllowDeletion(), new NoopRevoker(), now);
  const response = await createGetAccountHandler(service, dependencies())({ headers: {} });
  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).type, "/problems/authentication-required");
});

test("account profile handler returns only the verified principal's profile", async () => {
  const repository = new MemoryAccountRepository();
  repository.add(profile);
  repository.add({ ...profile, playerId: "00000000-0000-4000-8000-000000000602" });
  const service = new AccountService(repository, new AllowDeletion(), new NoopRevoker(), now);
  const response = await createGetAccountHandler(service, dependencies())({ headers: authorizedHeaders() });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).playerId, playerId);
});

test("account deletion transport maps reauthentication without logging credentials", async () => {
  const repository = new MemoryAccountRepository();
  repository.add(profile);
  const logger = new CapturingLogger();
  const service = new AccountService(repository, new AllowDeletion(), new NoopRevoker(), now);
  const identityToken = "sensitive-apple-identity-token-value";
  const response = await createDeleteAccountHandler(service, dependencies(logger))({
    headers: authorizedHeaders("account-delete-http-1"),
    body: JSON.stringify({
      confirmation: "deleteAccount",
      reauthentication: {
        provider: "apple",
        credential: { identityToken, nonce: "sensitive-nonce-value" },
      },
    }),
  });
  assert.equal(response.statusCode, 202);
  const logs = JSON.stringify(logger.events);
  assert.equal(logs.includes(identityToken), false);
  assert.equal(logs.includes("local-valid-access-token"), false);
});

function saveContext() {
  const repository = new MemorySaveRepository();
  return {
    repository,
    service: new SaveService(repository, new Sha256SaveDeviceIdHasher(), now),
  };
}

const saveBody = {
  slot: "primary",
  expectedRevision: 0,
  schemaVersion: 1,
  snapshot: { board: { rows: 7, columns: 9 } },
  deviceId: "00000000-0000-4000-8000-000000000698",
};

test("save handlers create and read a player-scoped save", async () => {
  const context = saveContext();
  const deps = dependencies();
  const created = await createPutSaveHandler(context.service, deps)({
    headers: authorizedHeaders("save-http-write-1"),
    body: JSON.stringify(saveBody),
  });
  const fetched = await createGetSaveHandler(context.service, deps)({
    headers: authorizedHeaders(),
    queryStringParameters: { slot: "primary" },
  });
  assert.equal(created.statusCode, 200);
  assert.equal(fetched.statusCode, 200);
  assert.equal(JSON.parse(fetched.body).revision, 1);
});

test("save handler returns explicit current metadata for a stale revision", async () => {
  const context = saveContext();
  const deps = dependencies();
  const handler = createPutSaveHandler(context.service, deps);
  await handler({ headers: authorizedHeaders("save-http-write-2"), body: JSON.stringify(saveBody) });
  const conflict = await handler({
    headers: authorizedHeaders("save-http-write-3"),
    body: JSON.stringify({ ...saveBody, snapshot: { stale: true } }),
  });
  const body = JSON.parse(conflict.body);
  assert.equal(conflict.statusCode, 409);
  assert.equal(body.currentRevision, 1);
  assert.equal(body.currentSchemaVersion, 1);
  assert.equal(Object.hasOwn(body, "snapshot"), false);
});

test("authenticated handler rate limiting does not log source IP or bearer token", async () => {
  const repository = new MemoryAccountRepository();
  repository.add(profile);
  const logger = new CapturingLogger();
  const deps = dependencies(logger, 1);
  const handler = createGetAccountHandler(
    new AccountService(repository, new AllowDeletion(), new NoopRevoker(), now),
    deps,
  );
  const request = {
    headers: authorizedHeaders(),
    requestContext: { http: { sourceIp: "192.0.2.200" } },
  };
  await handler(request);
  const limited = await handler(request);
  assert.equal(limited.statusCode, 429);
  const logs = JSON.stringify(logger.events);
  assert.equal(logs.includes("192.0.2.200"), false);
  assert.equal(logs.includes("local-valid-access-token"), false);
});
