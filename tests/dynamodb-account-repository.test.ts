import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

import { DynamoDbAccountRepository } from "../src/accounts/dynamodb-account-repository.js";
import { AccountNotFoundError } from "../src/accounts/account-service.js";

const playerId = "55555555-5555-4555-8555-555555555555";
const now = new Date("2026-09-02T19:00:00.000Z");
const auditId = "66666666-6666-4666-8666-666666666666";
const input = { playerId, idempotencyKey: "account-delete-1001", now };

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

test("DynamoDB account lookup is strongly consistent and maps only the selected player", async () => {
  const client = new ScriptedClient([{ Item: profileItem() }]);
  const profile = await repository(client).getByPlayerId(playerId);

  assert.deepEqual(profile, {
    playerId,
    accountKind: "apple",
    displayName: null,
    locale: "en-US",
    createdAt: "2026-09-01T12:00:00.000Z",
    linkedProviders: ["apple"],
    deletionState: "active",
  });
  const command = client.commands[0] as GetCommand;
  assert.equal(command.input.ConsistentRead, true);
  assert.deepEqual(command.input.Key, { pk: `PLAYER#${playerId}`, sk: "PROFILE" });
});

test("DynamoDB deletion atomically transitions profile, creates job, audit, and replay receipt", async () => {
  const client = new ScriptedClient([{}, { Item: profileItem() }, {}]);
  const receipt = await repository(client).requestDeletionWithAudit(input);

  assert.deepEqual(receipt, { deletionState: "requested", requestedAt: now.toISOString() });
  const command = client.commands[2] as TransactWriteCommand;
  assert.ok(command instanceof TransactWriteCommand);
  const items = command.input.TransactItems;
  assert.equal(items?.length, 4);
  assert.equal(items?.[0]?.Update?.ConditionExpression?.includes("deletionState = :active"), true);
  assert.equal(items?.[1]?.Put?.Item?.pk, `DELETION#${playerId}`);
  assert.equal(items?.[2]?.Put?.Item?.action, "ACCOUNT_DELETION_REQUESTED");
  assert.equal(items?.[2]?.Put?.Item?.auditEventId, auditId);
  assert.match(String(items?.[3]?.Put?.Item?.pk), /^IDEMPOTENCY#PLAYER#.+#[a-f0-9]{64}$/);
});

test("DynamoDB deletion replays its durable receipt without another audit transaction", async () => {
  const receipt = { deletionState: "requested", requestedAt: now.toISOString() } as const;
  const client = new ScriptedClient([{
    Item: {
      entityType: "Idempotency",
      recordVersion: 1,
      operation: "account.delete",
      requestHash: requestHash(),
      receipt,
    },
  }]);

  assert.deepEqual(await repository(client).requestDeletionWithAudit(input), receipt);
  assert.equal(client.commands.length, 1);
});

test("DynamoDB deletion with a new key reuses an existing durable job without another audit", async () => {
  const requested = profileItem("requested");
  const client = new ScriptedClient([
    {},
    { Item: requested },
    { Item: deletionJob() },
    {},
  ]);

  const receipt = await repository(client).requestDeletionWithAudit(input);

  assert.deepEqual(receipt, { deletionState: "requested", requestedAt: now.toISOString() });
  assert.ok(client.commands[3] instanceof PutCommand);
  assert.equal(client.commands.some((command) => command instanceof TransactWriteCommand), false);
});

test("DynamoDB deletion rejects a missing account without creating durable records", async () => {
  const client = new ScriptedClient([{}, {}]);
  await assert.rejects(repository(client).requestDeletionWithAudit(input), AccountNotFoundError);
  assert.equal(client.commands.every((command) => command instanceof GetCommand), true);
});

function repository(client: ScriptedClient): DynamoDbAccountRepository {
  return new DynamoDbAccountRepository(
    client as unknown as DynamoDBDocumentClient,
    "example-player-table",
    () => auditId,
  );
}

function profileItem(deletionState: "active" | "requested" | "processing" = "active") {
  return {
    pk: `PLAYER#${playerId}`,
    sk: "PROFILE",
    entityType: "Player",
    recordVersion: 1,
    playerId,
    accountKind: "apple",
    displayName: null,
    locale: "en-US",
    createdAt: "2026-09-01T12:00:00.000Z",
    linkedProviders: ["apple"],
    deletionState,
  };
}

function deletionJob() {
  return {
    entityType: "DeletionJob",
    recordVersion: 1,
    requestedAt: now.toISOString(),
  };
}

function requestHash(): string {
  return createHash("sha256")
    .update(JSON.stringify([playerId, "deleteAccount"]), "utf8")
    .digest("hex");
}
