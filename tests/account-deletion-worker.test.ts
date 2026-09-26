import assert from "node:assert/strict";
import test from "node:test";
import { AccountDeletionWorker, type AccountDeletionCleanupRepository } from "../src/accounts/account-deletion-worker.js";

const playerId = "55555555-5555-4555-8555-555555555555";

test("deletion worker stops as soon as durable cleanup reports completion", async () => {
  const calls: string[] = [];
  const repository: AccountDeletionCleanupRepository = {
    async processNext(id) { calls.push(id); return calls.length === 3 ? "completed" : "progressed"; },
  };
  const result = await new AccountDeletionWorker(repository, () => new Date(), 10).run(playerId);
  assert.deepEqual(result, { completed: true, steps: 3 });
  assert.deepEqual(calls, [playerId, playerId, playerId]);
});

test("deletion worker yields after its bounded step budget for safe retry", async () => {
  let calls = 0;
  const repository: AccountDeletionCleanupRepository = {
    async processNext() { calls++; return "progressed"; },
  };
  const result = await new AccountDeletionWorker(repository, () => new Date(), 2).run(playerId);
  assert.deepEqual(result, { completed: false, steps: 2 });
  assert.equal(calls, 2);
});

test("deletion worker rejects malformed internal identifiers before repository access", async () => {
  let called = false;
  const repository: AccountDeletionCleanupRepository = {
    async processNext() { called = true; return "completed"; },
  };
  await assert.rejects(new AccountDeletionWorker(repository, () => new Date()).run("not-an-id"));
  assert.equal(called, false);
});
