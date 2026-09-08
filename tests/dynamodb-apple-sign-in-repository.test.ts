import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbAppleSignInRepository } from "../src/accounts/dynamodb-apple-sign-in-repository.js";
import { AccountIdempotencyConflictError } from "../src/accounts/apple-account-service.js";
const playerId = "77777777-7777-4777-8777-777777777777";
const input = { issuer: "https://appleid.apple.com", subject: "private-apple-subject", idempotencyKey: "apple-signin-1001", now: new Date("2026-09-02T20:00:00Z") };
class Client { commands: unknown[] = []; constructor(private responses: Array<unknown | Error>) {} async send(command: unknown): Promise<unknown> { this.commands.push(command); const value = this.responses.shift(); if (value instanceof Error) throw value; return value ?? {}; } }
function repo(client: Client) { return new DynamoDbAppleSignInRepository(client as unknown as DynamoDBDocumentClient, "players", () => playerId); }
function profile() { return { entityType: "Player", recordVersion: 1, playerId, accountKind: "apple", createdAt: input.now.toISOString(), deletionState: "active" }; }
test("Apple sign-in atomically creates player, hashed mapping, and replay", async () => {
  const client = new Client([{}, {}, {}]);
  assert.equal((await repo(client).signInOrCreate(input)).playerId, playerId);
  const writes = (client.commands[2] as TransactWriteCommand).input.TransactItems;
  assert.equal(writes?.length, 3);
  const mapping = writes?.[1]?.Put?.Item;
  assert.match(String(mapping?.pk), /^PROVIDER#[a-f0-9]{64}#[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(mapping).includes(input.subject), false);
});
test("Apple sign-in recovers an existing provider mapping", async () => {
  const client = new Client([{}, { Item: { entityType: "ProviderMapping", recordVersion: 1, playerId } }, {}, { Item: profile() }]);
  assert.equal((await repo(client).signInOrCreate(input)).playerId, playerId);
  assert.equal(client.commands.some((command) => command instanceof TransactWriteCommand), false);
});
test("Apple sign-in rejects changed identity under an idempotency key", async () => {
  const client = new Client([{ Item: { entityType: "Idempotency", recordVersion: 1, operation: "apple.signIn", requestHash: "different", playerId } }]);
  await assert.rejects(repo(client).signInOrCreate(input), AccountIdempotencyConflictError);
  assert.ok(client.commands[0] instanceof GetCommand);
});
