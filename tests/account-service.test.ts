import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountDeletionAuthorizationError,
  AccountService,
  type AccountDeletionAuthorizer,
  type AccountProfile,
  type PlayerSessionRevoker,
} from "../src/accounts/account-service.js";
import { MemoryAccountRepository } from "../src/accounts/memory-account-repository.js";
import type { AuthenticatedPrincipal } from "../src/auth/authentication.js";

const now = () => new Date("2026-08-31T13:00:00.000Z");
const playerId = "00000000-0000-4000-8000-000000000201";
const principal: AuthenticatedPrincipal = {
  playerId,
  sessionKind: "account",
  issuer: "test-issuer",
  audience: "test-audience",
};
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
  public async authorize(): Promise<void> {}
}

class CapturingRevoker implements PlayerSessionRevoker {
  public readonly playerIds: string[] = [];
  public constructor(private readonly beforeRevoke?: () => void) {}
  public async revokeAll(id: string): Promise<void> {
    this.beforeRevoke?.();
    this.playerIds.push(id);
  }
}

class FailsOnceRevoker implements PlayerSessionRevoker {
  public attempts = 0;
  public async revokeAll(): Promise<void> {
    this.attempts++;
    if (this.attempts === 1) throw new Error("opaque provider failure");
  }
}

test("account lookup is always scoped to the authenticated principal", async () => {
  const repository = new MemoryAccountRepository();
  repository.add(profile);
  repository.add({ ...profile, playerId: "00000000-0000-4000-8000-000000000202" });
  const result = await new AccountService(repository, new AllowDeletion(), new CapturingRevoker(), now)
    .getProfile(principal);
  assert.equal(result.playerId, playerId);
});

test("account deletion is durably requested and audited before sessions are revoked", async () => {
  const repository = new MemoryAccountRepository();
  repository.add(profile);
  const revoker = new CapturingRevoker(() => {
    assert.equal(repository.auditEvents.length, 1);
  });
  const service = new AccountService(repository, new AllowDeletion(), revoker, now);
  const receipt = await service.requestDeletion({
    principal,
    request: { confirmation: "deleteAccount" },
    idempotencyKey: "account-delete-0001",
  });
  assert.deepEqual(receipt, { deletionState: "requested", requestedAt: now().toISOString() });
  assert.deepEqual(revoker.playerIds, [playerId]);
  assert.equal((await service.getProfile(principal)).deletionState, "requested");
});

test("replaying account deletion does not create another audit event", async () => {
  const repository = new MemoryAccountRepository();
  repository.add(profile);
  const service = new AccountService(repository, new AllowDeletion(), new CapturingRevoker(), now);
  const input = {
    principal,
    request: { confirmation: "deleteAccount" as const },
    idempotencyKey: "account-delete-0002",
  };
  const first = await service.requestDeletion(input);
  const replay = await service.requestDeletion(input);
  assert.deepEqual(replay, first);
  assert.equal(repository.auditEvents.length, 1);
});

test("a revocation failure leaves a durable deletion request that a retry can resume", async () => {
  const repository = new MemoryAccountRepository();
  repository.add(profile);
  const revoker = new FailsOnceRevoker();
  const service = new AccountService(repository, new AllowDeletion(), revoker, now);
  const input = {
    principal,
    request: { confirmation: "deleteAccount" as const },
    idempotencyKey: "account-delete-resume-0001",
  };

  await assert.rejects(service.requestDeletion(input), /opaque provider failure/);
  assert.equal((await service.getProfile(principal)).deletionState, "requested");
  assert.equal(repository.auditEvents.length, 1);

  const receipt = await service.requestDeletion(input);
  assert.deepEqual(receipt, { deletionState: "requested", requestedAt: now().toISOString() });
  assert.equal(revoker.attempts, 2);
  assert.equal(repository.auditEvents.length, 1);
});

test("deletion cannot proceed when reauthentication policy rejects it", async () => {
  const repository = new MemoryAccountRepository();
  repository.add(profile);
  const rejectingAuthorizer: AccountDeletionAuthorizer = {
    async authorize() { throw new AccountDeletionAuthorizationError("recent authentication required"); },
  };
  const revoker = new CapturingRevoker();
  const service = new AccountService(repository, rejectingAuthorizer, revoker, now);
  await assert.rejects(
    service.requestDeletion({
      principal,
      request: { confirmation: "deleteAccount" },
      idempotencyKey: "account-delete-0003",
    }),
    AccountDeletionAuthorizationError,
  );
  assert.equal(repository.auditEvents.length, 0);
  assert.deepEqual(revoker.playerIds, []);
});
