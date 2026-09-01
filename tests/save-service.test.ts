import assert from "node:assert/strict";
import test from "node:test";

import type { AuthenticatedPrincipal } from "../src/auth/authentication.js";
import { MemorySaveRepository } from "../src/saves/memory-save-repository.js";
import {
  SaveIdempotencyConflictError,
  SaveRevisionConflictError,
  SaveService,
  type SaveWriteRequest,
} from "../src/saves/save-service.js";
import { Sha256SaveDeviceIdHasher } from "../src/saves/sha256-save-device-id-hasher.js";

const now = () => new Date("2026-08-31T14:00:00.000Z");
const principal: AuthenticatedPrincipal = {
  playerId: "00000000-0000-4000-8000-000000000301",
  sessionKind: "account",
  issuer: "test",
  audience: "test",
};
const request: SaveWriteRequest = {
  slot: "primary",
  expectedRevision: 0,
  schemaVersion: 1,
  snapshot: { board: { rows: 7, columns: 9 }, commandIds: ["command-1"] },
  deviceId: "00000000-0000-4000-8000-000000000399",
};

function service(repository = new MemorySaveRepository()) {
  return { repository, service: new SaveService(repository, new Sha256SaveDeviceIdHasher(), now) };
}

test("creates revision one only when expectedRevision is zero", async () => {
  const context = service();
  const saved = await context.service.put({ principal, request, idempotencyKey: "save-write-0001" });
  assert.equal(saved.revision, 1);
  assert.deepEqual(await context.service.get(principal, "primary"), saved);
});

test("an identical retry returns the original save without incrementing revision", async () => {
  const context = service();
  const input = { principal, request, idempotencyKey: "save-write-0002" };
  const first = await context.service.put(input);
  const replay = await context.service.put(input);
  assert.deepEqual(replay, first);
  assert.equal((await context.service.get(principal, "primary")).revision, 1);
});

test("reusing an idempotency key with changed snapshot is rejected", async () => {
  const context = service();
  await context.service.put({ principal, request, idempotencyKey: "save-write-0003" });
  await assert.rejects(
    context.service.put({
      principal,
      request: { ...request, snapshot: { changed: true } },
      idempotencyKey: "save-write-0003",
    }),
    SaveIdempotencyConflictError,
  );
});

test("a stale revision returns current metadata and never overwrites the save", async () => {
  const context = service();
  const original = await context.service.put({ principal, request, idempotencyKey: "save-write-0004" });
  await assert.rejects(
    context.service.put({
      principal,
      request: { ...request, snapshot: { stale: true } },
      idempotencyKey: "save-write-0005",
    }),
    (error: unknown) => error instanceof SaveRevisionConflictError &&
      error.conflict.currentRevision === 1 &&
      error.conflict.currentSchemaVersion === 1,
  );
  assert.deepEqual(await context.service.get(principal, "primary"), original);
});

test("concurrent writes from the same revision have exactly one winner", async () => {
  const context = service();
  const results = await Promise.allSettled([
    context.service.put({ principal, request, idempotencyKey: "save-write-0006" }),
    context.service.put({
      principal,
      request: { ...request, snapshot: { board: "other-device" } },
      idempotencyKey: "save-write-0007",
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason instanceof SaveRevisionConflictError).length, 1);
});

test("save records are isolated by the authenticated player", async () => {
  const context = service();
  await context.service.put({ principal, request, idempotencyKey: "save-write-0008" });
  const other = { ...principal, playerId: "00000000-0000-4000-8000-000000000302" };
  const otherSave = await context.service.put({
    principal: other,
    request: { ...request, snapshot: { player: "other" } },
    idempotencyKey: "save-write-0009",
  });
  assert.deepEqual(otherSave.snapshot, { player: "other" });
  assert.notDeepEqual((await context.service.get(principal, "primary")).snapshot, otherSave.snapshot);
});

test("idempotency keys are scoped by authenticated player", async () => {
  const context = service();
  const other = { ...principal, playerId: "00000000-0000-4000-8000-000000000303" };
  const first = await context.service.put({ principal, request, idempotencyKey: "shared-client-key" });
  const second = await context.service.put({
    principal: other,
    request: { ...request, snapshot: { player: "other" } },
    idempotencyKey: "shared-client-key",
  });
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 1);
});
