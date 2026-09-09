import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { GetCommand, PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { CommerceIdempotencyConflictError, CommerceOwnershipError } from "../src/commerce/commerce-service.js";
import { DynamoDbCommerceRepository } from "../src/commerce/dynamodb-commerce-repository.js";

const playerId = "00000000-0000-4000-8000-000000000901";
const now = new Date("2026-09-09T18:00:00.000Z");
const balance = { entityType: "Balance", recordVersion: 1, playerId, coins: 200, gems: 20, energy: 180, energyUpdatedAt: "2026-09-09T17:00:00.000Z", revision: 1 };
const input = {
  playerId,
  completion: { provider: "ad-provider", providerEventId: "event-9001", claimId: "claim-9001", playerId },
  mutations: [{ resource: "energy" as const, delta: 20 }],
  idempotencyKey: "ad-repository-key-0001", clientBuild: 1, contentVersion: "starter-1", now,
};
const storedResult = {
  status: "granted", balance: { coins: 200, gems: 20, energy: 200, energyUpdatedAt: now.toISOString(), revision: 2 },
  ledgerEntries: [{ ledgerEntryId: "ledger-1", resource: "energy", delta: 20, reasonCode: "AD_REWARD", sourceReference: "event-9001", balanceAfter: 200, createdAt: now.toISOString(), clientBuild: 1, contentVersion: "starter-1" }],
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
function repo(client: Client): DynamoDbCommerceRepository { return new DynamoDbCommerceRepository(client as unknown as DynamoDBDocumentClient, "players", () => "ledger-1"); }
function named(name: string): Error { return Object.assign(new Error(name), { name }); }
function eventItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { entityType: "AdCompletion", recordVersion: 1, state: "granted", playerId, provider: input.completion.provider, providerEventId: input.completion.providerEventId, claimId: input.completion.claimId, result: storedResult, ...overrides };
}

test("ad repository strongly checks replay and provider event before one atomic reward", async () => {
  const client = new Client([{}, {}, { Item: balance }, {}]);
  const result = await repo(client).processAdRewardAtomically(input);
  assert.equal(result.status, "granted");
  assert.equal(result.balance.energy, 200);
  assert.equal((client.commands[0] as GetCommand).input.ConsistentRead, true);
  assert.equal((client.commands[1] as GetCommand).input.Key?.pk, "AD_EVENT#ad-provider#event-9001");
  assert.ok(client.commands[3] instanceof TransactWriteCommand);
});

test("ad repository replays matching hashed idempotency without writing", async () => {
  const sourceClient = new Client([{}, {}, { Item: balance }, {}]);
  await repo(sourceClient).processAdRewardAtomically(input);
  const transaction = sourceClient.commands[3] as TransactWriteCommand;
  const replay = transaction.input.TransactItems!.find((item) => item.Put?.Item?.operation === "commerce.adReward")!.Put!.Item!;
  const client = new Client([{ Item: replay }]);
  const result = await repo(client).processAdRewardAtomically(input);
  assert.equal(result.status, "granted");
  assert.equal(client.commands.length, 1);
  assert.equal(JSON.stringify(client.commands).includes(input.idempotencyKey), false);
});

test("ad repository rejects changed input under the same idempotency key", async () => {
  const operationKey = createHash("sha256").update(input.idempotencyKey).digest("hex");
  const replay = { entityType: "Idempotency", recordVersion: 1, operation: "commerce.adReward", playerId, operationKey, requestHash: "different", result: storedResult };
  await assert.rejects(repo(new Client([{ Item: replay }])).processAdRewardAtomically(input), CommerceIdempotencyConflictError);
});

test("ad repository prevents a provider event crossing players or claims", async () => {
  await assert.rejects(repo(new Client([{}, { Item: eventItem({ playerId: "00000000-0000-4000-8000-000000000902" }) }])).processAdRewardAtomically(input), CommerceOwnershipError);
  await assert.rejects(repo(new Client([{}, { Item: eventItem({ claimId: "another-claim" }) }])).processAdRewardAtomically(input), CommerceOwnershipError);
});

test("ad repository fails closed when stored result differs from configured reward", async () => {
  const changed = { ...storedResult, ledgerEntries: [{ ...storedResult.ledgerEntries[0]!, delta: 100 }] };
  await assert.rejects(repo(new Client([{}, { Item: eventItem({ result: changed }) }])).processAdRewardAtomically(input), /does not match configured reward/);
});

test("ad repository records duplicate receipt with current authoritative balance", async () => {
  const current = { ...balance, energy: 190, revision: 3 };
  const client = new Client([{}, { Item: eventItem() }, { Item: current }, {}]);
  const result = await repo(client).processAdRewardAtomically({ ...input, idempotencyKey: "ad-repository-key-0002" });
  assert.equal(result.status, "duplicate");
  assert.equal(result.balance.energy, 190);
  assert.ok(client.commands[3] instanceof PutCommand);
  assert.equal(JSON.stringify((client.commands[3] as PutCommand).input.Item).includes("ad-repository-key-0002"), false);
});

test("ad repository recovers concurrent winner and retries unrelated balance contention", async () => {
  const winnerClient = new Client([{}, {}, { Item: balance }, named("TransactionCanceledException"), {}, { Item: eventItem() }, { Item: { ...balance, energy: 200, revision: 2 } }, {}]);
  assert.equal((await repo(winnerClient).processAdRewardAtomically(input)).status, "duplicate");
  const retryClient = new Client([{}, {}, { Item: balance }, named("TransactionCanceledException"), {}, {}, { Item: { ...balance, coins: 250, revision: 2 } }, {}]);
  const retried = await repo(retryClient).processAdRewardAtomically(input);
  assert.equal(retried.status, "granted");
  assert.equal(retried.balance.revision, 3);
  assert.equal(retryClient.commands.filter((command) => command instanceof TransactWriteCommand).length, 2);
});
