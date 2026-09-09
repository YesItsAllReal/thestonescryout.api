import assert from "node:assert/strict";
import test from "node:test";
import { QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbEntitlementRepository } from "../src/economy/dynamodb-entitlement-repository.js";

const playerId = "00000000-0000-4000-8000-000000000501";
const purchasedAt = "2026-09-09T12:00:00.000Z";

class Client {
  public readonly commands: unknown[] = [];
  public constructor(private readonly responses: Record<string, unknown>[]) {}
  public async send(command: unknown): Promise<Record<string, unknown>> {
    this.commands.push(command);
    return this.responses.shift() ?? {};
  }
}

function item(productId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pk: `PLAYER#${playerId}`,
    sk: `ENTITLEMENT#${productId}`,
    entityType: "Entitlement",
    recordVersion: 1,
    playerId,
    productId,
    state: "active",
    purchasedAt,
    environment: "sandbox",
    ...overrides,
  };
}

function repository(client: Client): DynamoDbEntitlementRepository {
  return new DynamoDbEntitlementRepository(client as unknown as DynamoDBDocumentClient, "players");
}

test("entitlement repository strongly queries only the authenticated player partition", async () => {
  const client = new Client([{ Items: [item("product.two"), item("product.one")] }]);
  const result = await repository(client).listByPlayerId(playerId);

  assert.deepEqual(result.map((value) => value.productId), ["product.one", "product.two"]);
  assert.equal(client.commands.length, 1);
  assert.ok(client.commands[0] instanceof QueryCommand);
  const input = (client.commands[0] as QueryCommand).input;
  assert.equal(input.ConsistentRead, true);
  assert.equal(input.KeyConditionExpression, "pk = :pk AND begins_with(sk, :prefix)");
  assert.deepEqual(input.ExpressionAttributeValues, {
    ":pk": `PLAYER#${playerId}`,
    ":prefix": "ENTITLEMENT#",
  });
});

test("entitlement repository follows DynamoDB pagination without weakening consistency", async () => {
  const cursor = { pk: `PLAYER#${playerId}`, sk: "ENTITLEMENT#product.one" };
  const client = new Client([
    { Items: [item("product.one")], LastEvaluatedKey: cursor },
    { Items: [item("product.two", { state: "refunded", environment: "production" })] },
  ]);

  const result = await repository(client).listByPlayerId(playerId);

  assert.equal(result.length, 2);
  assert.equal(client.commands.length, 2);
  assert.deepEqual((client.commands[1] as QueryCommand).input.ExclusiveStartKey, cursor);
  assert.equal((client.commands[1] as QueryCommand).input.ConsistentRead, true);
});

test("entitlement repository returns an immutable empty result when no records exist", async () => {
  const result = await repository(new Client([{}])).listByPlayerId(playerId);
  assert.deepEqual(result, []);
  assert.equal(Object.isFrozen(result), true);
});

test("entitlement repository fails closed for malformed or cross-player records", async () => {
  const malformed = [
    item("product.one", { recordVersion: 2 }),
    item("product.one", { playerId: "00000000-0000-4000-8000-000000000502" }),
    item("product.one", { sk: "ENTITLEMENT#different" }),
    item("product.one", { state: "unknown" }),
    item("product.one", { environment: "test" }),
    item("product.one", { purchasedAt: "not-a-date" }),
  ];
  for (const value of malformed) {
    await assert.rejects(repository(new Client([{ Items: [value] }])).listByPlayerId(playerId), /stored entitlement is invalid/);
  }
});

test("entitlement repository rejects invalid construction and player identifiers before AWS calls", async () => {
  assert.throws(() => new DynamoDbEntitlementRepository(new Client([]) as unknown as DynamoDBDocumentClient, " "));
  const client = new Client([]);
  await assert.rejects(repository(client).listByPlayerId("not-a-player"), /player ID is invalid/);
  assert.equal(client.commands.length, 0);
});
