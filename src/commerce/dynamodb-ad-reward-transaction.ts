import { createHash } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { CommerceGrantResult, CommerceRepository } from "./commerce-service.js";
import type { EconomyBalance, EconomyResource, LedgerEntry } from "../economy/economy-service.js";

type AdOperation = Parameters<CommerceRepository["processAdRewardAtomically"]>[0];

export function buildAdRewardTransaction(input: {
  readonly tableName: string;
  readonly current: EconomyBalance;
  readonly operation: AdOperation;
  readonly ledgerEntryIds: readonly string[];
  readonly idempotencyTtlSeconds?: number;
}): { readonly command: TransactWriteCommand; readonly result: CommerceGrantResult } {
  const ttlSeconds = input.idempotencyTtlSeconds ?? 2_592_000;
  validate(input.tableName, input.current, input.operation, input.ledgerEntryIds, ttlSeconds);
  const { operation } = input;
  const createdAt = operation.now.toISOString();
  const playerKey = `PLAYER#${operation.playerId}`;
  const operationKey = sha256(operation.idempotencyKey);
  const next: Record<EconomyResource, number> = {
    coins: input.current.coins, gems: input.current.gems, energy: input.current.energy,
  };
  for (const mutation of operation.mutations) {
    const value = next[mutation.resource] + mutation.delta;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("ad reward would produce an invalid balance");
    next[mutation.resource] = value;
  }
  const balance: EconomyBalance = {
    ...next,
    energyUpdatedAt: operation.mutations.some((value) => value.resource === "energy")
      ? createdAt : input.current.energyUpdatedAt,
    revision: input.current.revision + 1,
  };
  const ledgerEntries: LedgerEntry[] = operation.mutations.map((mutation, index) => ({
    ledgerEntryId: input.ledgerEntryIds[index]!, resource: mutation.resource, delta: mutation.delta,
    reasonCode: "AD_REWARD", sourceReference: operation.completion.providerEventId,
    balanceAfter: next[mutation.resource], createdAt, idempotencyKey: operationKey,
    clientBuild: operation.clientBuild, contentVersion: operation.contentVersion,
  }));
  const result: CommerceGrantResult = { status: "granted", balance, ledgerEntries };
  const stored = storedResult(result);
  const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [{
    Put: { TableName: input.tableName, Item: {
      pk: `AD_EVENT#${operation.completion.provider}#${operation.completion.providerEventId}`, sk: "GRANT",
      entityType: "AdCompletion", recordVersion: 1, playerId: operation.playerId,
      provider: operation.completion.provider, providerEventId: operation.completion.providerEventId,
      claimId: operation.completion.claimId, state: "granted", result: stored, createdAt,
    }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" },
  }, {
    Update: {
      TableName: input.tableName, Key: { pk: playerKey, sk: "BALANCE" },
      UpdateExpression: "SET coins = :coins, gems = :gems, energy = :energy, energyUpdatedAt = :energyAt, revision = :nextRevision",
      ConditionExpression: "entityType = :entityType AND recordVersion = :recordVersion AND playerId = :playerId AND revision = :revision AND coins = :oldCoins AND gems = :oldGems AND energy = :oldEnergy",
      ExpressionAttributeValues: {
        ":coins": balance.coins, ":gems": balance.gems, ":energy": balance.energy,
        ":energyAt": balance.energyUpdatedAt, ":nextRevision": balance.revision,
        ":entityType": "Balance", ":recordVersion": 1, ":playerId": operation.playerId,
        ":revision": input.current.revision, ":oldCoins": input.current.coins,
        ":oldGems": input.current.gems, ":oldEnergy": input.current.energy,
      },
    },
  }];
  for (const entry of ledgerEntries) items.push({ Put: { TableName: input.tableName, Item: {
    pk: playerKey, sk: `LEDGER#${createdAt}#${entry.ledgerEntryId}`,
    entityType: "LedgerEntry", recordVersion: 1, playerId: operation.playerId,
    ledgerEntryId: entry.ledgerEntryId, resource: entry.resource, delta: entry.delta,
    reasonCode: entry.reasonCode, sourceReference: entry.sourceReference,
    balanceAfter: entry.balanceAfter, createdAt: entry.createdAt,
    idempotencyKeyHash: operationKey, clientBuild: entry.clientBuild, contentVersion: entry.contentVersion,
  }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } });
  items.push({ Put: { TableName: input.tableName, Item: {
    pk: `IDEMPOTENCY#AD_REWARD#${operation.playerId}#${operationKey}`, sk: "RESULT",
    entityType: "Idempotency", recordVersion: 1, operation: "commerce.adReward",
    playerId: operation.playerId, operationKey,
    requestHash: sha256(JSON.stringify([
      operation.completion.provider, operation.completion.providerEventId, operation.completion.claimId,
    ])),
    result: stored, status: "completed", createdAt,
    expiresAtEpochSeconds: Math.floor(operation.now.getTime() / 1000) + ttlSeconds,
    ttl: Math.floor(operation.now.getTime() / 1000) + ttlSeconds,
  }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } });
  return { command: new TransactWriteCommand({ TransactItems: items }), result };
}

function validate(tableName: string, current: EconomyBalance, operation: AdOperation, ids: readonly string[], ttl: number): void {
  if (tableName.trim() === "" || !Number.isSafeInteger(ttl) || ttl < 1) throw new Error("ad reward configuration is invalid");
  if (!isUuid(operation.playerId) || operation.completion.playerId !== operation.playerId) throw new Error("ad reward identity is invalid");
  if (operation.mutations.length < 1 || operation.mutations.length > 3 || ids.length !== operation.mutations.length ||
      new Set(operation.mutations.map((value) => value.resource)).size !== operation.mutations.length ||
      operation.mutations.some((value) => !Number.isSafeInteger(value.delta) || value.delta <= 0)) throw new Error("ad reward mutations are invalid");
  if (new Set(ids).size !== ids.length || ids.some((value) => !safe(value, 128))) throw new Error("ad reward ledger IDs are invalid");
  if (!validAmount(current.coins) || !validAmount(current.gems) || !validAmount(current.energy) ||
      !Number.isSafeInteger(current.revision) || current.revision < 1 || !validInstant(current.energyUpdatedAt)) throw new Error("current balance is invalid");
  if (!safe(operation.completion.provider, 64) || !safe(operation.completion.providerEventId, 128) ||
      !safe(operation.completion.claimId, 128) || !safe(operation.idempotencyKey, 128, 8) ||
      !Number.isSafeInteger(operation.clientBuild) || operation.clientBuild < 1 ||
      !safe(operation.contentVersion, 64) || !Number.isFinite(operation.now.getTime())) throw new Error("ad reward input is invalid");
}

function storedResult(result: CommerceGrantResult): Record<string, unknown> {
  return { status: result.status, balance: result.balance, ledgerEntries: result.ledgerEntries.map(({ idempotencyKey: _ignored, ...entry }) => entry) };
}
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function safe(value: string, max: number, min = 1): boolean { return value.length >= min && value.length <= max && /^[A-Za-z0-9._:-]+$/.test(value); }
function validAmount(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function validInstant(value: string): boolean { return Number.isFinite(Date.parse(value)); }
