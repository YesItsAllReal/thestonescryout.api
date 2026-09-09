import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { GetCommand, PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { CommerceIdempotencyConflictError, CommerceOwnershipError } from "../src/commerce/commerce-service.js";
import { CommerceOperationNotConfiguredError, DynamoDbCommerceRepository } from "../src/commerce/dynamodb-commerce-repository.js";

const playerId = "00000000-0000-4000-8000-000000000701";
const now = new Date("2026-09-09T16:00:00.000Z");
const balance = { entityType: "Balance", recordVersion: 1, playerId, coins: 200, gems: 20, energy: 200, energyUpdatedAt: "2026-09-09T15:00:00.000Z", revision: 1 };
const input = {
  playerId,
  transaction: {
    transactionId: "transaction-7001", originalTransactionId: "original-7001",
    productId: "com.itsallreal.stonescryout.gems.small", appAccountToken: "private-token",
    environment: "sandbox" as const, purchasedAt: "2026-09-09T15:59:00.000Z",
  },
  product: { productId: "com.itsallreal.stonescryout.gems.small", kind: "consumable" as const, grants: [{ resource: "gems" as const, delta: 100 }] },
  idempotencyKey: "purchase-repository-0001", clientBuild: 1, contentVersion: "starter-1", now,
};
const storedResult = {
  status: "granted", balance: { coins: 200, gems: 120, energy: 200, energyUpdatedAt: balance.energyUpdatedAt, revision: 2 },
  ledgerEntries: [{ ledgerEntryId: "ledger-1", resource: "gems", delta: 100, reasonCode: "IAP_GRANT", sourceReference: "transaction-7001", balanceAfter: 120, createdAt: now.toISOString(), clientBuild: 1, contentVersion: "starter-1" }],
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
function repo(client: Client): DynamoDbCommerceRepository {
  return new DynamoDbCommerceRepository(client as unknown as DynamoDBDocumentClient, "players", () => "ledger-1");
}
function named(name: string): Error { return Object.assign(new Error(name), { name }); }
function transactionItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entityType: "PurchaseTransaction", recordVersion: 1, playerId,
    transactionId: input.transaction.transactionId,
    originalTransactionId: input.transaction.originalTransactionId,
    productId: input.transaction.productId, environment: "sandbox",
    purchasedAt: input.transaction.purchasedAt, state: "granted", result: storedResult,
    ...overrides,
  };
}

test("commerce repository strongly checks replay and global transaction before one atomic purchase", async () => {
  const client = new Client([{}, {}, { Item: balance }, {}]);
  const result = await repo(client).processPurchaseAtomically(input);
  assert.equal(result.status, "granted");
  assert.equal(result.balance.gems, 120);
  assert.equal(client.commands.length, 4);
  assert.ok(client.commands[0] instanceof GetCommand);
  assert.equal((client.commands[0] as GetCommand).input.ConsistentRead, true);
  assert.ok(client.commands[1] instanceof GetCommand);
  assert.equal((client.commands[1] as GetCommand).input.Key?.pk, "TRANSACTION#sandbox#transaction-7001");
  assert.ok(client.commands[3] instanceof TransactWriteCommand);
});

test("commerce repository replays a matching hashed idempotency result without writing", async () => {
  const first = repo(new Client([{}, {}, { Item: balance }, {}]));
  const granted = await first.processPurchaseAtomically(input);
  const transaction = (first as unknown as { client: Client }).client.commands[3] as TransactWriteCommand;
  const replayItem = transaction.input.TransactItems!.find((item) => item.Put?.Item?.operation === "commerce.purchase")!.Put!.Item!;
  const client = new Client([{ Item: replayItem }]);
  const result = await repo(client).processPurchaseAtomically(input);
  assert.equal(result.status, "granted");
  assert.equal(client.commands.length, 1);
  assert.equal(JSON.stringify(client.commands).includes(input.idempotencyKey), false);
});

test("commerce repository rejects changed input under the same idempotency key", async () => {
  const operationKey = createHash("sha256").update(input.idempotencyKey).digest("hex");
  const replay = { entityType: "Idempotency", recordVersion: 1, operation: "commerce.purchase", playerId, operationKey, requestHash: "different", result: storedResult };
  const client = new Client([{ Item: replay }]);
  await assert.rejects(repo(client).processPurchaseAtomically(input), CommerceIdempotencyConflictError);
});

test("commerce repository prevents a globally claimed transaction crossing players", async () => {
  const client = new Client([{}, { Item: transactionItem({ playerId: "00000000-0000-4000-8000-000000000702" }) }]);
  await assert.rejects(repo(client).processPurchaseAtomically(input), CommerceOwnershipError);
  assert.equal(client.commands.some((command) => command instanceof TransactWriteCommand), false);
});

test("commerce repository fails closed when a stored grant differs from trusted product rules", async () => {
  const changed = { ...storedResult, ledgerEntries: [{ ...storedResult.ledgerEntries[0]!, delta: 999 }] };
  const client = new Client([{}, { Item: transactionItem({ result: changed }) }]);
  await assert.rejects(repo(client).processPurchaseAtomically(input), /does not match product grants/);
});

test("commerce repository records a durable duplicate receipt using the current balance", async () => {
  const current = { ...balance, gems: 150, revision: 3 };
  const client = new Client([{}, { Item: transactionItem() }, { Item: current }, {}]);
  const result = await repo(client).processPurchaseAtomically({ ...input, idempotencyKey: "purchase-repository-0002" });
  assert.equal(result.status, "duplicate");
  assert.equal(result.balance.gems, 150);
  assert.ok(client.commands[3] instanceof PutCommand);
  const receipt = (client.commands[3] as PutCommand).input.Item!;
  assert.equal(receipt.operation, "commerce.purchase");
  assert.equal(JSON.stringify(receipt).includes("purchase-repository-0002"), false);
});

test("commerce repository recovers a concurrent winning transaction", async () => {
  const client = new Client([{}, {}, { Item: balance }, named("TransactionCanceledException"), {}, { Item: transactionItem() }, { Item: { ...balance, gems: 120, revision: 2 } }, {}]);
  const result = await repo(client).processPurchaseAtomically(input);
  assert.equal(result.status, "duplicate");
  assert.equal(client.commands[7] instanceof PutCommand, true);
});

test("commerce repository retries once after unrelated balance contention", async () => {
  const latest = { ...balance, coins: 250, revision: 2 };
  const client = new Client([{}, {}, { Item: balance }, named("TransactionCanceledException"), {}, {}, { Item: latest }, {}]);
  const result = await repo(client).processPurchaseAtomically(input);
  assert.equal(result.status, "granted");
  assert.equal(result.balance.coins, 250);
  assert.equal(result.balance.revision, 3);
  assert.equal(client.commands.filter((command) => command instanceof TransactWriteCommand).length, 2);
});

test("unfinished DynamoDB commerce mutations fail closed", async () => {
  const repository = repo(new Client([]));
  await assert.rejects(repository.processNotificationAtomically({ notification: {} as never, now }), CommerceOperationNotConfiguredError);
  await assert.rejects(repository.processAdRewardAtomically({} as never), CommerceOperationNotConfiguredError);
});
