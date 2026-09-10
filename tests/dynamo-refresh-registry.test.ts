import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { DynamoRefreshRegistry } from "../src/auth/dynamo-refresh-registry.js";
import {
  RefreshCredentialRejectedError,
  RefreshCredentialOwnershipMismatchError,
} from "../src/auth/cognito-session-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TABLE = "example-player-table";
const playerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherPlayerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = new Date("2026-09-04T12:00:00.000Z");
const expiresAt = new Date("2026-10-04T12:00:00.000Z");
const nowEpoch = Math.floor(now.getTime() / 1000);
const expiresEpoch = Math.floor(expiresAt.getTime() / 1000);

// Raw token values — never stored in DynamoDB, only their hashes are.
const rawToken  = "raw-refresh-token-value-0000000001";
const rawToken2 = "raw-refresh-token-value-0000000002";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const hash1 = sha256(rawToken);
const hash2 = sha256(rawToken2);

class ScriptedClient {
  public readonly commands: unknown[] = [];
  public constructor(private readonly responses: Array<unknown | Error>) {}
  public async send(command: unknown): Promise<unknown> {
    this.commands.push(command);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response ?? {};
  }
}

function activeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Item: {
      entityType: "RefreshCredential",
      recordVersion: 1,
      playerId,
      status: "active",
      expiresAtEpochSeconds: expiresEpoch,
      ttl: expiresEpoch,
      ...overrides,
    },
  };
}

function registry(client: ScriptedClient): DynamoRefreshRegistry {
  return new DynamoRefreshRegistry(client as unknown as DynamoDBDocumentClient, TABLE);
}

// ---------------------------------------------------------------------------
// Raw tokens never stored
// ---------------------------------------------------------------------------

test("register stores only the credential hash, never the raw token", async () => {
  const client = new ScriptedClient([{}]);
  await registry(client).register({ credentialHash: hash1, playerId, expiresAt, now });

  assert.equal(client.commands.length, 1);
  assert.ok(client.commands[0] instanceof TransactWriteCommand);
  const item = (client.commands[0] as TransactWriteCommand).input.TransactItems?.[0]?.Put?.Item;
  assert.ok(item !== undefined);
  assert.equal(JSON.stringify(item).includes(rawToken), false, "raw token must not appear in stored item");
  assert.ok((item["pk"] as string).includes(hash1), "pk must contain the hash");
  assert.equal(item["playerId"], playerId);
  const audit = (client.commands[0] as TransactWriteCommand).input.TransactItems?.[1]?.Put?.Item;
  assert.equal(audit?.["action"], "SESSION_CREDENTIAL_ISSUED");
  assert.equal(audit?.["playerId"], playerId);
  assert.equal(JSON.stringify(audit).includes(hash1), false);
  assert.equal(JSON.stringify(audit).includes(rawToken), false);
});

// ---------------------------------------------------------------------------
// Conditional initial registration
// ---------------------------------------------------------------------------

test("register uses attribute_not_exists condition", async () => {
  const client = new ScriptedClient([{}]);
  await registry(client).register({ credentialHash: hash1, playerId, expiresAt, now });

  const condition = (client.commands[0] as TransactWriteCommand)
    .input.TransactItems?.[0]?.Put?.ConditionExpression;
  assert.ok(typeof condition === "string" && condition.includes("attribute_not_exists"));
});

test("register is idempotent when the record already exists for the same player", async () => {
  const conflict = new Error("conflict");
  conflict.name = "ConditionalCheckFailedException";
  // Fix 2: on conflict, registry reads and verifies the existing record.
  const client = new ScriptedClient([conflict, activeRecord()]);
  await assert.doesNotReject(
    registry(client).register({ credentialHash: hash1, playerId, expiresAt, now }),
  );
  // Must have issued a GetCommand to verify the existing record.
  assert.ok(client.commands[1] instanceof GetCommand);
});

test("register resolves a concurrent DynamoDB transaction cancellation", async () => {
  const conflict = new Error("cancelled");
  conflict.name = "TransactionCanceledException";
  const client = new ScriptedClient([conflict, activeRecord()]);
  await assert.doesNotReject(
    registry(client).register({ credentialHash: hash1, playerId, expiresAt, now }),
  );
  assert.ok(client.commands[1] instanceof GetCommand);
});

test("register fails closed when the existing record belongs to a different player", async () => {
  const conflict = new Error("conflict");
  conflict.name = "ConditionalCheckFailedException";
  const client = new ScriptedClient([conflict, activeRecord({ playerId: otherPlayerId })]);
  await assert.rejects(
    registry(client).register({ credentialHash: hash1, playerId, expiresAt, now }),
    RefreshCredentialRejectedError,
  );
});

test("register fails closed when the existing record is not active", async () => {
  const conflict = new Error("conflict");
  conflict.name = "ConditionalCheckFailedException";
  const client = new ScriptedClient([conflict, activeRecord({ status: "revoked" })]);
  await assert.rejects(
    registry(client).register({ credentialHash: hash1, playerId, expiresAt, now }),
    RefreshCredentialRejectedError,
  );
});

test("register fails closed when the existing record has an unsupported version", async () => {
  const conflict = new Error("conflict");
  conflict.name = "ConditionalCheckFailedException";
  const client = new ScriptedClient([conflict, activeRecord({ recordVersion: 99 })]);
  await assert.rejects(
    registry(client).register({ credentialHash: hash1, playerId, expiresAt, now }),
    RefreshCredentialRejectedError,
  );
});

// ---------------------------------------------------------------------------
// TTL stored but not used for authorization
// ---------------------------------------------------------------------------

test("register stores ttl attribute for cleanup only", async () => {
  const client = new ScriptedClient([{}]);
  await registry(client).register({ credentialHash: hash1, playerId, expiresAt, now });

  const item = (client.commands[0] as TransactWriteCommand).input.TransactItems?.[0]?.Put?.Item;
  assert.equal(item?.["ttl"], expiresEpoch);
  assert.equal(item?.["expiresAtEpochSeconds"], expiresEpoch);
});

test("expired record is rejected by explicit expiry check before TTL deletion occurs", async () => {
  const pastExpiry = new Date(expiresAt.getTime() + 1000); // 1 second after expiry
  const client = new ScriptedClient([activeRecord()]);
  await assert.rejects(
    registry(client).assertOwnedBy({ credentialHash: hash1, playerId, now: pastExpiry }),
    RefreshCredentialRejectedError,
  );
});

// ---------------------------------------------------------------------------
// Atomic successful rotation
// ---------------------------------------------------------------------------

test("rotate atomically revokes previous and writes replacement", async () => {
  const client = new ScriptedClient([activeRecord(), {}]);
  await registry(client).rotate({
    previousCredentialHash: hash1,
    replacementCredentialHash: hash2,
    now,
  });

  assert.ok(client.commands[0] instanceof GetCommand);
  assert.ok(client.commands[1] instanceof TransactWriteCommand);
  const items = (client.commands[1] as TransactWriteCommand).input.TransactItems;
  assert.equal(items?.length, 3);

  // Issue 4: Update condition must include entityType, recordVersion, playerId,
  // expiresAtEpochSeconds, and active status.
  const updateCondition = items?.[0]?.Update?.ConditionExpression ?? "";
  assert.ok(updateCondition.includes(":active"),        "must check active status");
  assert.ok(updateCondition.includes(":entityType"),    "must check entityType");
  assert.ok(updateCondition.includes(":recordVersion"), "must check recordVersion");
  assert.ok(updateCondition.includes(":playerId"),      "must check playerId");
  assert.ok(updateCondition.includes(":expiresAt"),     "must check expiresAtEpochSeconds");

  // Issue 3: replacement must inherit the previous record's expiry.
  const replacementItem = items?.[1]?.Put?.Item;
  assert.equal(replacementItem?.["expiresAtEpochSeconds"], expiresEpoch,
    "replacement must inherit previous expiry, not extend it");
  assert.equal(replacementItem?.["ttl"], expiresEpoch);
  assert.equal(replacementItem?.["playerId"], playerId);
  const audit = items?.[2]?.Put?.Item;
  assert.equal(audit?.["action"], "SESSION_CREDENTIAL_ROTATED");
  assert.equal(audit?.["playerId"], playerId);
  assert.equal(JSON.stringify(audit).includes(hash1), false);
  assert.equal(JSON.stringify(audit).includes(hash2), false);
  assert.equal(JSON.stringify(audit).includes(rawToken2), false);
});

test("rotate preserves original expiry when rotating near end of lifetime", async () => {
  // Token issued 29 days ago, expires in 1 day.
  const nearExpiry = new Date("2026-10-03T12:00:00.000Z"); // 1 day before expiresAt
  const nearExpiryEpoch = Math.floor(nearExpiry.getTime() / 1000);
  const shortLivedRecord = activeRecord({ expiresAtEpochSeconds: nearExpiryEpoch, ttl: nearExpiryEpoch });

  const client = new ScriptedClient([shortLivedRecord, {}]);
  await registry(client).rotate({
    previousCredentialHash: hash1,
    replacementCredentialHash: hash2,
    // Caller passes full lifetime, but registry must ignore it and use inherited expiry.
    now,
  });

  const items = (client.commands[1] as TransactWriteCommand).input.TransactItems;
  const replacementItem = items?.[1]?.Put?.Item;
  assert.equal(replacementItem?.["expiresAtEpochSeconds"], nearExpiryEpoch,
    "replacement must inherit the near-expiry value, not the full 30-day lifetime");
});

// ---------------------------------------------------------------------------
// Replay/reuse rejection
// ---------------------------------------------------------------------------

test("rotate rejects a credential that was already rotated (concurrent winner)", async () => {
  const conflict = new Error("cancelled");
  conflict.name = "TransactionCanceledException";
  const client = new ScriptedClient([activeRecord(), conflict]);
  await assert.rejects(
    registry(client).rotate({
      previousCredentialHash: hash1,
      replacementCredentialHash: hash2,
      now,
    }),
    RefreshCredentialRejectedError,
  );
});

test("assertOwnedBy rejects a revoked credential", async () => {
  const client = new ScriptedClient([activeRecord({ status: "revoked" })]);
  await assert.rejects(
    registry(client).assertOwnedBy({ credentialHash: hash1, playerId, now }),
    RefreshCredentialRejectedError,
  );
});

test("assertOwnedBy rejects a missing credential", async () => {
  const client = new ScriptedClient([{ Item: undefined }]);
  await assert.rejects(
    registry(client).assertOwnedBy({ credentialHash: hash1, playerId, now }),
    RefreshCredentialRejectedError,
  );
});

// ---------------------------------------------------------------------------
// Ownership mismatch
// ---------------------------------------------------------------------------

test("assertOwnedBy rejects a credential belonging to a different player", async () => {
  const client = new ScriptedClient([activeRecord()]);
  await assert.rejects(
    registry(client).assertOwnedBy({ credentialHash: hash1, playerId: otherPlayerId, now }),
    RefreshCredentialOwnershipMismatchError,
  );
});

// ---------------------------------------------------------------------------
// Idempotent revocation
// ---------------------------------------------------------------------------

test("markRevoked is idempotent when a cancelled transaction finds no credential", async () => {
  const conflict = new Error("cancelled");
  conflict.name = "TransactionCanceledException";
  const client = new ScriptedClient([conflict, { Item: undefined }]);
  await assert.doesNotReject(
    registry(client).markRevoked({ credentialHash: hash1, playerId, now }),
  );
  assert.ok(client.commands[0] instanceof TransactWriteCommand);
  assert.ok(client.commands[1] instanceof GetCommand);
});

test("markRevoked atomically revokes the owned credential and appends a privacy-safe audit event", async () => {
  const client = new ScriptedClient([{}]);
  await registry(client).markRevoked({ credentialHash: hash1, playerId, now });

  const cmd = client.commands[0] as TransactWriteCommand;
  const items = cmd.input.TransactItems;
  assert.equal(items?.length, 2);
  assert.ok(items?.[0]?.Update?.UpdateExpression?.includes(":revoked"));
  assert.ok(items?.[0]?.Update?.ConditionExpression?.includes("playerId = :playerId"));
  assert.equal(items?.[1]?.Put?.Item?.["action"], "SESSION_CREDENTIAL_REVOKED");
  assert.equal(items?.[1]?.Put?.Item?.["playerId"], playerId);
  assert.equal(JSON.stringify(items?.[1]?.Put?.Item).includes(rawToken), false);
  assert.equal(JSON.stringify(items?.[1]?.Put?.Item).includes(hash1), false);
  assert.match(String(items?.[1]?.Put?.Item?.["auditEventId"]), /^[a-f0-9]{64}$/);
});

test("markRevoked accepts a concurrent winner only for the same player's revoked record", async () => {
  const conflict = new Error("cancelled");
  conflict.name = "TransactionCanceledException";
  const client = new ScriptedClient([conflict, activeRecord({ status: "revoked" })]);
  await assert.doesNotReject(
    registry(client).markRevoked({ credentialHash: hash1, playerId, now }),
  );
});

test("markRevoked fails closed when a revocation conflict belongs to another player", async () => {
  const conflict = new Error("cancelled");
  conflict.name = "TransactionCanceledException";
  const client = new ScriptedClient([conflict, activeRecord({ status: "revoked", playerId: otherPlayerId })]);
  await assert.rejects(
    registry(client).markRevoked({ credentialHash: hash1, playerId, now }),
    RefreshCredentialRejectedError,
  );
});

// ---------------------------------------------------------------------------
// Concurrent rotation — exactly one winner
// ---------------------------------------------------------------------------

test("concurrent rotation: second attempt is rejected after first wins", async () => {
  // First rotation succeeds.
  const client1 = new ScriptedClient([activeRecord(), {}]);
  await assert.doesNotReject(
    registry(client1).rotate({
      previousCredentialHash: hash1,
      replacementCredentialHash: hash2,
      now,
    }),
  );

  // Second rotation attempt on the same previous hash is rejected.
  const conflict = new Error("cancelled");
  conflict.name = "TransactionCanceledException";
  const client2 = new ScriptedClient([activeRecord(), conflict]);
  await assert.rejects(
    registry(client2).rotate({
      previousCredentialHash: hash1,
      replacementCredentialHash: sha256("third-token"),
      now,
    }),
    RefreshCredentialRejectedError,
  );
});

// ---------------------------------------------------------------------------
// Unsupported record versions fail closed
// ---------------------------------------------------------------------------

test("assertOwnedBy rejects an unknown recordVersion", async () => {
  const client = new ScriptedClient([activeRecord({ recordVersion: 99 })]);
  await assert.rejects(
    registry(client).assertOwnedBy({ credentialHash: hash1, playerId, now }),
    RefreshCredentialRejectedError,
  );
});

test("assertOwnedBy rejects a malformed record missing playerId", async () => {
  const client = new ScriptedClient([activeRecord({ playerId: undefined })]);
  await assert.rejects(
    registry(client).assertOwnedBy({ credentialHash: hash1, playerId, now }),
    RefreshCredentialRejectedError,
  );
});

// ---------------------------------------------------------------------------
// Fix 9: compensation on partial rotation
// ---------------------------------------------------------------------------

test("rotate best-effort revokes replacement token when DynamoDB persistence fails", async () => {
  const dbError = new Error("DynamoDB unavailable");
  let revokedToken: string | undefined;
  const gateway = { async revoke(token: string) { revokedToken = token; } };

  const client = new ScriptedClient([activeRecord(), dbError]);
  const reg = new DynamoRefreshRegistry(
    client as unknown as DynamoDBDocumentClient,
    TABLE,
    gateway,
  );

  const replacementRaw = "replacement-raw-token-value-0001";
  await assert.rejects(
    reg.rotate({
      previousCredentialHash: hash1,
      replacementCredentialHash: hash2,
      now,
      replacementRawToken: replacementRaw,
    }),
    dbError,
  );
  // The replacement token must have been revoked.
  assert.equal(revokedToken, replacementRaw);
});

test("rotate does not revoke when no gateway is provided", async () => {
  const dbError = new Error("DynamoDB unavailable");
  const client = new ScriptedClient([activeRecord(), dbError]);
  // No gateway — must still throw the original error without crashing.
  await assert.rejects(
    registry(client).rotate({
      previousCredentialHash: hash1,
      replacementCredentialHash: hash2,
      now,
    }),
    dbError,
  );
});

test("register rejects a non-hex credential hash", async () => {
  const client = new ScriptedClient([]);
  await assert.rejects(
    registry(client).register({ credentialHash: "not-a-hash", playerId, expiresAt, now }),
    /SHA-256/,
  );
  assert.equal(client.commands.length, 0);
});

// ---------------------------------------------------------------------------
// Issue 1: compensation on TransactionCanceledException
// ---------------------------------------------------------------------------

test("rotate compensates on TransactionCanceledException before mapping to RefreshCredentialRejectedError", async () => {
  const conflict = new Error("cancelled");
  conflict.name = "TransactionCanceledException";
  let revokedToken: string | undefined;
  const gateway = { async revoke(token: string) { revokedToken = token; } };

  const client = new ScriptedClient([activeRecord(), conflict]);
  const reg = new DynamoRefreshRegistry(
    client as unknown as DynamoDBDocumentClient,
    TABLE,
    gateway,
  );

  const replacementRaw = "replacement-raw-token-value-0002";
  await assert.rejects(
    reg.rotate({
      previousCredentialHash: hash1,
      replacementCredentialHash: hash2,
      now,
      replacementRawToken: replacementRaw,
    }),
    RefreshCredentialRejectedError,
  );
  // Compensation must run even when the error is mapped to RefreshCredentialRejectedError.
  assert.equal(revokedToken, replacementRaw);
});

// ---------------------------------------------------------------------------
// Issue 2: compensation on registration failure
// ---------------------------------------------------------------------------

test("issue: DynamoDB registration service failure triggers compensation revocation", async () => {
  const dbError = new Error("DynamoDB service error");
  let revokedHash: string | undefined;
  const gateway = { async revoke(token: string) { revokedHash = token; } };

  const client = new ScriptedClient([dbError]);
  const reg = new DynamoRefreshRegistry(
    client as unknown as DynamoDBDocumentClient,
    TABLE,
    gateway,
  );

  // register() itself does not call revoke — compensation for registration
  // failure lives in CognitoSessionProvider.issue. This test verifies the
  // registry propagates the error so the provider can compensate.
  await assert.rejects(
    reg.register({ credentialHash: hash1, playerId, expiresAt, now }),
    dbError,
  );
  // Registry does not revoke — that is the provider's responsibility.
  assert.equal(revokedHash, undefined);
});
