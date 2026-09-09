import assert from "node:assert/strict";
import test from "node:test";

import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { DynamoDbProviderIdentityOwnershipResolver } from "../src/accounts/dynamodb-provider-identity-resolver.js";

const issuer = "https://appleid.apple.com";
const subject = "private-apple-subject";
const playerId = "00000000-0000-4000-8000-000000000201";

class Client {
  public command: unknown;
  public constructor(private readonly item: Record<string, unknown> | undefined) {}
  async send(command: unknown): Promise<unknown> { this.command = command; return { Item: this.item }; }
}

test("provider ownership lookup is strongly consistent and stores no raw subject in its key", async () => {
  const client = new Client({ entityType: "ProviderMapping", recordVersion: 1, provider: "apple", playerId });
  const resolver = new DynamoDbProviderIdentityOwnershipResolver(client as unknown as DynamoDBDocumentClient, "players");
  assert.equal(await resolver.resolvePlayerId({ issuer, subject }), playerId);
  const command = client.command as GetCommand;
  assert.equal(command.input.ConsistentRead, true);
  assert.equal(JSON.stringify(command.input.Key).includes(subject), false);
  assert.match(String(command.input.Key?.["pk"]), /^PROVIDER#[a-f0-9]{64}#[a-f0-9]{64}$/);
});

test("missing provider mapping resolves to undefined", async () => {
  const resolver = new DynamoDbProviderIdentityOwnershipResolver(new Client(undefined) as unknown as DynamoDBDocumentClient, "players");
  assert.equal(await resolver.resolvePlayerId({ issuer, subject }), undefined);
});

test("malformed or non-Apple provider mappings fail closed", async () => {
  for (const item of [
    { entityType: "ProviderMapping", recordVersion: 99, provider: "apple", playerId },
    { entityType: "ProviderMapping", recordVersion: 1, provider: "google", playerId },
    { entityType: "ProviderMapping", recordVersion: 1, provider: "apple" },
  ]) {
    const resolver = new DynamoDbProviderIdentityOwnershipResolver(new Client(item) as unknown as DynamoDBDocumentClient, "players");
    await assert.rejects(resolver.resolvePlayerId({ issuer, subject }), /invalid/);
  }
});
