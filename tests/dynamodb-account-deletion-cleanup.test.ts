import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, QueryCommand, ScanCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbAccountDeletionCleanup } from "../src/accounts/dynamodb-account-deletion-cleanup.js";

const playerId = "55555555-5555-4555-8555-555555555555";
const now = new Date("2026-09-25T15:00:00.000Z");
const retentionId = "77777777-7777-4777-8777-777777777777";

class Client {
  public readonly commands: unknown[] = [];
  public constructor(private readonly responses: Array<unknown | Error>) {}
  public async send(command: unknown): Promise<unknown> {
    this.commands.push(command);
    const value = this.responses.shift();
    if (value instanceof Error) throw value;
    return value ?? {};
  }
}

test("cleanup atomically deletes one player record and advances the durable job", async () => {
  const item = { pk: `PLAYER#${playerId}`, sk: "SAVE#primary", entityType: "Save", recordVersion: 1, playerId };
  const client = new Client([{ Item: job() }, { Items: [item] }, {}]);
  assert.equal(await cleanup(client).processNext(playerId, now), "progressed");
  assert.ok(client.commands[0] instanceof GetCommand);
  assert.ok(client.commands[1] instanceof QueryCommand);
  const tx = (client.commands[2] as TransactWriteCommand).input.TransactItems!;
  assert.deepEqual(tx[0]?.Delete?.Key, { pk: item.pk, sk: item.sk });
  assert.equal(tx[1]?.Update?.Key?.pk, `DELETION#${playerId}`);
  assert.equal(tx[1]?.Update?.ConditionExpression?.includes("attribute_not_exists(retentionId)"), true);
});

test("cleanup removes the installation mapping in the same transaction as its profile", async () => {
  const item = { pk: `PLAYER#${playerId}`, sk: "PROFILE", entityType: "Player", recordVersion: 1, playerId, installationIdHash: "c".repeat(64) };
  const client = new Client([{ Item: job() }, { Items: [item] }, {}]);
  await cleanup(client).processNext(playerId, now);
  const tx = (client.commands[2] as TransactWriteCommand).input.TransactItems!;
  assert.equal(tx.length, 3);
  assert.deepEqual(tx[1]?.Delete?.Key, { pk: `INSTALLATION#${"c".repeat(64)}`, sk: "PLAYER" });
});

test("cleanup anonymizes purchase/fraud records and strips embedded public results", async () => {
  const purchase = { pk: "TRANSACTION#sandbox#tx-1", sk: "GRANT", entityType: "PurchaseTransaction", recordVersion: 1, playerId, result: { balance: { coins: 10 } } };
  const client = new Client([{ Item: job() }, { Items: [] }, { Items: [purchase], LastEvaluatedKey: { pk: purchase.pk, sk: purchase.sk } }, {}]);
  await cleanup(client).processNext(playerId, now);
  assert.ok(client.commands[2] instanceof ScanCommand);
  const tx = (client.commands[3] as TransactWriteCommand).input.TransactItems!;
  assert.equal(tx[0]?.Update?.UpdateExpression?.includes("REMOVE playerId, #result"), true);
  assert.equal(tx[0]?.Update?.ExpressionAttributeValues?.[":retentionId"], retentionId);
  assert.deepEqual(tx[1]?.Update?.ExpressionAttributeValues?.[":cursor"], { pk: purchase.pk, sk: purchase.sk });
  assert.equal(JSON.stringify(tx).includes(playerId), true); // conditions only; never copied into retained values
});

test("cleanup deletes transient global credentials instead of retaining their hashes", async () => {
  const credential = { pk: "REFRESH#hash", sk: "CREDENTIAL", entityType: "RefreshCredential", recordVersion: 1, playerId };
  const client = new Client([{ Item: job() }, { Items: [] }, { Items: [credential] }, {}]);
  await cleanup(client).processNext(playerId, now);
  const tx = (client.commands[3] as TransactWriteCommand).input.TransactItems!;
  assert.deepEqual(tx[0]?.Delete?.Key, { pk: credential.pk, sk: credential.sk });
});

test("cleanup fails closed for an unknown player-owned global shape", async () => {
  const unknown = { pk: "FUTURE#1", sk: "DATA", entityType: "FutureSensitiveRecord", recordVersion: 1, playerId };
  const client = new Client([{ Item: job() }, { Items: [] }, { Items: [unknown] }]);
  await assert.rejects(cleanup(client).processNext(playerId, now), /unsupported player-owned record/);
  assert.equal(client.commands.some((command) => command instanceof TransactWriteCommand), false);
});

test("completion removes the hashed provider mapping and leaves only a TTL completion marker", async () => {
  const client = new Client([{ Item: job({ providerMappingPk: `PROVIDER#${"a".repeat(64)}#${"b".repeat(64)}`, providerMappingSk: "PLAYER" }) }, { Items: [] }, { Items: [] }, {}]);
  assert.equal(await cleanup(client).processNext(playerId, now), "completed");
  const tx = (client.commands[3] as TransactWriteCommand).input.TransactItems!;
  assert.equal(tx[0]?.Delete?.Key?.pk, `PROVIDER#${"a".repeat(64)}#${"b".repeat(64)}`);
  assert.equal(tx[1]?.Update?.UpdateExpression?.includes("REMOVE scanCursor, providerMappingPk, providerMappingSk"), true);
  assert.equal(tx[1]?.Update?.UpdateExpression?.includes("#ttl = :ttl"), true);
  assert.equal(tx[1]?.Update?.ExpressionAttributeNames?.["#ttl"], "ttl");
  assert.equal(tx[1]?.Update?.ExpressionAttributeValues?.[":ttl"], Math.floor(now.getTime() / 1000) + 2_592_000);
});

test("transaction failure cannot partially delete data or advance the job and is retryable", async () => {
  const item = { pk: `PLAYER#${playerId}`, sk: "BALANCE", entityType: "Balance", recordVersion: 1, playerId };
  const failure = Object.assign(new Error("transaction unavailable"), { name: "InternalServerError" });
  const client = new Client([{ Item: job() }, { Items: [item] }, failure]);
  await assert.rejects(cleanup(client).processNext(playerId, now), /transaction unavailable/);
  const tx = (client.commands[2] as TransactWriteCommand).input.TransactItems!;
  assert.equal(tx.length, 2);
  assert.ok(tx[0]?.Delete);
  assert.ok(tx[1]?.Update);
});

function cleanup(client: Client) {
  return new DynamoDbAccountDeletionCleanup(client as unknown as DynamoDBDocumentClient, "players", () => retentionId);
}
function job(extra: Record<string, unknown> = {}) {
  return { pk: `DELETION#${playerId}`, sk: "REQUEST", entityType: "DeletionJob", recordVersion: 1, playerId, state: "requested", requestedAt: now.toISOString(), ...extra };
}
