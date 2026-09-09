import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbCommerceRepository } from "../src/commerce/dynamodb-commerce-repository.js";

const playerId = "00000000-0000-4000-8000-000000001101";
const purchasedAt = "2026-09-01T12:00:00.000Z";
const now = new Date("2026-09-09T20:00:00.000Z");
const input = {
  notification: {
    notificationId: "notification-1101", notificationType: "REFUND" as const,
    transactionId: "transaction-1101", productId: "com.itsallreal.stonescryout.removeads",
    environment: "sandbox" as const, effectiveAt: "2026-09-09T19:59:00.000Z",
  }, now,
};
const transaction = {
  entityType: "PurchaseTransaction", recordVersion: 1, playerId,
  transactionId: input.notification.transactionId, productId: input.notification.productId,
  productKind: "nonConsumable", environment: "sandbox", state: "granted",
  stateEffectiveAt: purchasedAt,
};
const entitlement = {
  pk: `PLAYER#${playerId}`, sk: `ENTITLEMENT#${input.notification.productId}`,
  entityType: "Entitlement", recordVersion: 1, playerId,
  productId: input.notification.productId, state: "active", environment: "sandbox",
  purchasedAt, stateEffectiveAt: purchasedAt,
};

class Client {
  public readonly commands: unknown[] = [];
  public constructor(private readonly responses: (Record<string, unknown> | Error)[]) {}
  public async send(command: unknown): Promise<Record<string, unknown>> {
    this.commands.push(command);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response ?? {};
  }
}
function repo(client: Client): DynamoDbCommerceRepository { return new DynamoDbCommerceRepository(client as unknown as DynamoDBDocumentClient, "players"); }
function named(name: string): Error { return Object.assign(new Error(name), { name }); }

test("notification repository strongly reads and atomically updates a known non-consumable", async () => {
  const client = new Client([{}, { Item: transaction }, { Item: entitlement }, {}]);
  const result = await repo(client).processNotificationAtomically(input);
  assert.equal(result.status, "applied");
  assert.equal(result.entitlement?.state, "refunded");
  assert.equal(client.commands.length, 4);
  assert.ok(client.commands.slice(0, 3).every((command) => command instanceof GetCommand && command.input.ConsistentRead === true));
  assert.ok(client.commands[3] instanceof TransactWriteCommand);
});

test("notification repository records an unknown transaction as ignored", async () => {
  const client = new Client([{}, {}, {}]);
  const result = await repo(client).processNotificationAtomically(input);
  assert.equal(result.status, "ignored");
  const write = client.commands[2] as TransactWriteCommand;
  assert.equal(write.input.TransactItems?.length, 1);
  assert.equal(write.input.TransactItems?.[0]?.Put?.Item?.entityType, "AppStoreNotification");
});

test("notification repository replays a durable result as duplicate", async () => {
  const receipt = {
    entityType: "AppStoreNotification", recordVersion: 1, status: "completed",
    ...input.notification,
    result: { status: "applied", transactionState: "refunded", entitlement: {
      productId: input.notification.productId, state: "refunded", purchasedAt, environment: "sandbox",
    } },
  };
  const client = new Client([{ Item: receipt }]);
  const result = await repo(client).processNotificationAtomically(input);
  assert.equal(result.status, "duplicate");
  assert.equal(result.entitlement?.state, "refunded");
  assert.equal(client.commands.length, 1);
});

test("notification repository fails closed for changed or malformed replay data", async () => {
  const changed = { entityType: "AppStoreNotification", recordVersion: 1, status: "completed", ...input.notification, productId: "different", result: { status: "ignored", transactionState: "refunded" } };
  await assert.rejects(repo(new Client([{ Item: changed }])).processNotificationAtomically(input), /replay is invalid/);
  const malformed = { entityType: "AppStoreNotification", recordVersion: 1, status: "completed", ...input.notification, result: { status: "applied", transactionState: "revoked" } };
  await assert.rejects(repo(new Client([{ Item: malformed }])).processNotificationAtomically(input), /result is invalid/);
});

test("notification repository handles consumables without reading or changing an entitlement", async () => {
  const client = new Client([{}, { Item: { ...transaction, productKind: "consumable" } }, {}]);
  const result = await repo(client).processNotificationAtomically(input);
  assert.equal(result.status, "applied");
  assert.equal(result.entitlement, undefined);
  assert.equal(client.commands.length, 3);
  const write = client.commands[2] as TransactWriteCommand;
  assert.equal(write.input.TransactItems?.some((item) => item.Update?.Key?.sk === "BALANCE"), false);
});

test("notification repository recovers a concurrent durable winner", async () => {
  const receipt = { entityType: "AppStoreNotification", recordVersion: 1, status: "completed", ...input.notification, result: { status: "ignored", transactionState: "refunded" } };
  const client = new Client([{}, {}, named("TransactionCanceledException"), { Item: receipt }]);
  const result = await repo(client).processNotificationAtomically(input);
  assert.equal(result.status, "duplicate");
  assert.equal(client.commands.length, 4);
});

test("notification repository retries one concurrent state transition", async () => {
  const nextTransaction = { ...transaction, state: "refunded", stateEffectiveAt: "2026-09-09T19:00:00.000Z" };
  const nextEntitlement = { ...entitlement, state: "refunded", stateEffectiveAt: "2026-09-09T19:00:00.000Z" };
  const client = new Client([
    {}, { Item: transaction }, { Item: entitlement }, named("TransactionCanceledException"), {},
    { Item: nextTransaction }, { Item: nextEntitlement }, {},
  ]);
  const result = await repo(client).processNotificationAtomically(input);
  assert.equal(result.status, "applied");
  assert.equal(client.commands.filter((command) => command instanceof TransactWriteCommand).length, 2);
});
