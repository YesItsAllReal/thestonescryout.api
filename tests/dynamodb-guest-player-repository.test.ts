import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

import { DynamoDbGuestPlayerRepository } from "../src/accounts/dynamodb-guest-player-repository.js";
import { GuestSessionIdempotencyConflictError } from "../src/accounts/guest-session-service.js";

const now = new Date("2026-09-02T12:00:00.000Z");
const input = {
  installationIdHash: "a".repeat(64),
  idempotencyKey: "request-key-0001",
  locale: "en-US",
  appBuild: 42,
  platform: "ios" as const,
  now,
};
const playerId = "11111111-1111-4111-8111-111111111111";

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

test("DynamoDB guest creation atomically writes profile, installation claim, and idempotency result", async () => {
  const client = new ScriptedClient([{}, {}, {}]);
  const repository = createRepository(client);

  const player = await repository.findOrCreateGuest(input);

  assert.deepEqual(player, {
    playerId,
    accountKind: "guest",
    createdAt: now.toISOString(),
    deletionState: "active",
  });
  assert.equal(client.commands.length, 3);
  assert.ok(client.commands[0] instanceof GetCommand);
  assert.ok(client.commands[1] instanceof GetCommand);
  assert.ok(client.commands[2] instanceof TransactWriteCommand);
  const transaction = (client.commands[2] as TransactWriteCommand).input.TransactItems;
  assert.equal(transaction?.length, 4);
  assert.equal(transaction?.[0]?.Put?.Item?.pk, `PLAYER#${playerId}`);
  assert.equal(transaction?.[1]?.Put?.Item?.sk, "BALANCE");
  assert.equal(transaction?.[1]?.Put?.Item?.revision, 1);
  assert.equal(transaction?.[2]?.Put?.Item?.pk, `INSTALLATION#${input.installationIdHash}`);
  assert.match(String(transaction?.[3]?.Put?.Item?.pk), /^IDEMPOTENCY#GUEST#[a-f0-9]{64}$/);
  assert.equal(
    transaction?.[3]?.Put?.Item?.expiresAtEpochSeconds,
    Math.floor(now.getTime() / 1000) + 86_400,
  );
  assert.equal(transaction?.every(item=>item.Put?.ConditionExpression?.includes("attribute_not_exists")),true);
});

test("DynamoDB guest creation uses only injected server starting balances", async () => {
  const client = new ScriptedClient([{}, {}, {}]);
  const repository = new DynamoDbGuestPlayerRepository(
    client as unknown as DynamoDBDocumentClient,
    "example-player-table",
    () => playerId,
    86_400,
    { coins: 100, gems: 5, energy: 40 },
  );
  await repository.findOrCreateGuest(input);
  const balance = (client.commands[2] as TransactWriteCommand).input.TransactItems?.[1]?.Put?.Item;
  assert.deepEqual({ coins: balance?.coins, gems: balance?.gems, energy: balance?.energy }, { coins: 100, gems: 5, energy: 40 });
});

test("DynamoDB guest creation replays the stored player for an identical idempotency request", async () => {
  const requestHash = hashFromSuccessfulTransaction();
  const client = new ScriptedClient([
    { Item: { entityType: "Idempotency", requestHash, playerId } },
    { Item: storedPlayer() },
  ]);

  const player = await createRepository(client).findOrCreateGuest(input);

  assert.equal(player.playerId, playerId);
  assert.equal(client.commands.length, 2);
  assert.ok(client.commands.every((command) => command instanceof GetCommand));
});

test("DynamoDB guest creation rejects a changed request under a claimed idempotency key", async () => {
  const client = new ScriptedClient([
    { Item: { entityType: "Idempotency", requestHash: "different", playerId } },
  ]);

  await assert.rejects(
    createRepository(client).findOrCreateGuest(input),
    GuestSessionIdempotencyConflictError,
  );
  assert.equal(client.commands.length, 1);
});

test("DynamoDB guest creation recovers the winning installation after transaction contention", async () => {
  const cancelled = new Error("cancelled");
  cancelled.name = "TransactionCanceledException";
  const client = new ScriptedClient([
    {},
    {},
    cancelled,
    {},
    { Item: { entityType: "InstallationMapping", playerId } },
    {},
    { Item: storedPlayer() },
  ]);

  const player = await createRepository(client).findOrCreateGuest(input);

  assert.equal(player.playerId, playerId);
  assert.ok(client.commands[5] instanceof PutCommand);
  const claim = (client.commands[5] as PutCommand).input.Item;
  assert.equal(claim?.playerId, playerId);
  assert.equal(claim?.operation, "guestSession.create");
});

function createRepository(client: ScriptedClient): DynamoDbGuestPlayerRepository {
  return new DynamoDbGuestPlayerRepository(
    client as unknown as DynamoDBDocumentClient,
    "example-player-table",
    () => playerId,
  );
}

function storedPlayer(): Record<string, unknown> {
  return {
    entityType: "Player",
    playerId,
    accountKind: "guest",
    createdAt: now.toISOString(),
    deletionState: "active",
  };
}

function hashFromSuccessfulTransaction(): string {
  return createHash("sha256").update(JSON.stringify([
    input.installationIdHash,
    input.locale,
    input.appBuild,
    input.platform,
  ]), "utf8").digest("hex");
}
