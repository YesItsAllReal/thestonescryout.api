import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

import { DynamoDbSaveRepository } from "../src/saves/dynamodb-save-repository.js";
import { SaveIdempotencyConflictError } from "../src/saves/save-service.js";

const now = new Date("2026-09-02T15:00:00.000Z");
const playerId = "22222222-2222-4222-8222-222222222222";
const input = {
  playerId,
  slot: "primary",
  expectedRevision: 0,
  schemaVersion: 3,
  snapshot: { board: { rows: 7, columns: 9 }, commandIds: ["command-1"] },
  deviceIdHash: "d".repeat(64),
  idempotencyKey: "save-request-0001",
  now,
};

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

test("DynamoDB save creation conditionally commits the save and replay result together", async () => {
  const client = new ScriptedClient([{}, {}, {}]);
  const result = await repository(client).putConditionally(input);

  assert.equal(result.kind, "saved");
  assert.equal(result.kind === "saved" && result.save.revision, 1);
  assert.ok(client.commands[2] instanceof TransactWriteCommand);
  const writes = (client.commands[2] as TransactWriteCommand).input.TransactItems;
  assert.equal(writes?.length, 2);
  assert.deepEqual(writes?.[0]?.Put?.Item?.pk, `PLAYER#${playerId}`);
  assert.deepEqual(writes?.[0]?.Put?.Item?.sk, "SAVE#primary");
  assert.equal(writes?.[0]?.Put?.ConditionExpression, "attribute_not_exists(pk)");
  assert.match(String(writes?.[1]?.Put?.Item?.pk), /^IDEMPOTENCY#PLAYER#.+#[a-f0-9]{64}$/);
  assert.equal((writes?.[1]?.Put?.Item?.result as { kind?: string }).kind, "saved");
});

test("DynamoDB save update requires the exact expected revision", async () => {
  const current = saveItem(4, { old: true });
  const client = new ScriptedClient([{}, { Item: current }, {}]);
  const result = await repository(client).putConditionally({ ...input, expectedRevision: 4 });

  assert.equal(result.kind === "saved" && result.save.revision, 5);
  const write = (client.commands[2] as TransactWriteCommand).input.TransactItems?.[0]?.Put;
  assert.equal(write?.ConditionExpression, "revision = :expectedRevision");
  assert.equal(write?.ExpressionAttributeValues?.[":expectedRevision"], 4);
});

test("DynamoDB save stale revisions record and replay metadata without writing the snapshot", async () => {
  const client = new ScriptedClient([{}, { Item: saveItem(2, { winner: true }) }, {}]);
  const result = await repository(client).putConditionally(input);

  assert.deepEqual(result, {
    kind: "conflict",
    conflict: {
      slot: "primary",
      currentRevision: 2,
      currentSchemaVersion: 3,
      currentUpdatedAt: now.toISOString(),
    },
  });
  assert.ok(client.commands[2] instanceof PutCommand);
  assert.equal(client.commands.some((command) => command instanceof TransactWriteCommand), false);
  const stored = (client.commands[2] as PutCommand).input.Item;
  assert.equal((stored?.result as { kind?: string }).kind, "conflict");
  assert.equal(JSON.stringify(stored).includes("winner"), false);
});

test("DynamoDB save replay rejects a changed request under the same player-scoped key", async () => {
  const client = new ScriptedClient([{
    Item: {
      entityType: "Idempotency",
      operation: "save.put",
      requestHash: "different",
      result: { kind: "conflict", conflict: { slot: "primary", currentRevision: 0 } },
    },
  }]);

  await assert.rejects(repository(client).putConditionally(input), SaveIdempotencyConflictError);
  assert.equal(client.commands.length, 1);
});

test("DynamoDB save replay returns the original successful response without rewriting", async () => {
  const originalSave = {
    slot: "primary",
    revision: 1,
    schemaVersion: 3,
    snapshot: input.snapshot,
    updatedAt: now.toISOString(),
  };
  const client = new ScriptedClient([{
    Item: {
      entityType: "Idempotency",
      operation: "save.put",
      requestHash: requestHash(),
      result: { kind: "saved", save: originalSave },
    },
  }]);

  assert.deepEqual(await repository(client).putConditionally(input), {
    kind: "saved",
    save: originalSave,
  });
  assert.equal(client.commands.length, 1);
});

test("DynamoDB save contention reads the winner and returns an explicit conflict", async () => {
  const cancellation = new Error("conditional transaction cancellation") as Error & {
    CancellationReasons?: readonly { Code: string }[];
  };
  cancellation.name = "TransactionCanceledException";
  cancellation.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
  const client = new ScriptedClient([
    {},
    {},
    cancellation,
    {},
    { Item: saveItem(1, { winner: true }) },
    {},
  ]);

  const result = await repository(client).putConditionally(input);

  assert.equal(result.kind, "conflict");
  assert.equal(result.kind === "conflict" && result.conflict.currentRevision, 1);
  assert.ok(client.commands[5] instanceof PutCommand);
});

test("DynamoDB save reads are strongly consistent and player scoped", async () => {
  const client = new ScriptedClient([{ Item: saveItem(7, { restored: true }) }]);
  const result = await repository(client).get(playerId, "primary");

  assert.equal(result?.revision, 7);
  const command = client.commands[0] as GetCommand;
  assert.equal(command.input.ConsistentRead, true);
  assert.deepEqual(command.input.Key, { pk: `PLAYER#${playerId}`, sk: "SAVE#primary" });
});

function repository(client: ScriptedClient): DynamoDbSaveRepository {
  return new DynamoDbSaveRepository(client as unknown as DynamoDBDocumentClient, "example-player-table");
}

function saveItem(revision: number, snapshot: Record<string, unknown>): Record<string, unknown> {
  return {
    pk: `PLAYER#${playerId}`,
    sk: "SAVE#primary",
    entityType: "Save",
    recordVersion: 1,
    playerId,
    revision,
    schemaVersion: 3,
    snapshot,
    updatedAt: now.toISOString(),
    deviceIdHash: "d".repeat(64),
  };
}

function requestHash(): string {
  return createHash("sha256").update(JSON.stringify([
    input.playerId,
    input.slot,
    input.expectedRevision,
    input.schemaVersion,
    input.snapshot,
    input.deviceIdHash,
  ]), "utf8").digest("hex");
}
