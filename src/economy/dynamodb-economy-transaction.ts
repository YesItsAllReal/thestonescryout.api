import { createHash } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import type {
  EconomyBalance,
  EconomyMutationResult,
  EconomyRepository,
  EconomyResource,
  LedgerEntry,
} from "./economy-service.js";

type ApplyInput = Parameters<EconomyRepository["applyAtomically"]>[0];

export function buildEconomyTransaction(input: {
  readonly tableName: string;
  readonly current: EconomyBalance;
  readonly operation: ApplyInput;
  readonly ledgerEntryIds: readonly string[];
  readonly idempotencyTtlSeconds?: number;
}): { readonly command: TransactWriteCommand; readonly result: EconomyMutationResult } {
  const ttlSeconds = input.idempotencyTtlSeconds ?? 2_592_000;
  if (input.tableName.trim() === "" || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error("economy transaction configuration is invalid");
  }
  if (input.operation.mutations.length < 1 || input.operation.mutations.length > 3 ||
      input.ledgerEntryIds.length !== input.operation.mutations.length) {
    throw new Error("economy transaction mutations are invalid");
  }

  const next: Record<EconomyResource, number> = {
    coins: input.current.coins,
    gems: input.current.gems,
    energy: input.current.energy,
  };
  for (const mutation of input.operation.mutations) {
    const value = next[mutation.resource] + mutation.delta;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("economy balance would be invalid");
    next[mutation.resource] = value;
  }

  const createdAt = input.operation.now.toISOString();
  const balance: EconomyBalance = {
    ...next,
    energyUpdatedAt: input.operation.mutations.some((value) => value.resource === "energy")
      ? createdAt : input.current.energyUpdatedAt,
    revision: input.current.revision + 1,
  };
  const idempotencyHash = sha256(input.operation.idempotencyKey);
  const ledgerEntries: LedgerEntry[] = input.operation.mutations.map((mutation, index) => ({
    ledgerEntryId: input.ledgerEntryIds[index]!,
    resource: mutation.resource,
    delta: mutation.delta,
    reasonCode: input.operation.reasonCode,
    sourceReference: input.operation.sourceReference,
    balanceAfter: next[mutation.resource],
    createdAt,
    idempotencyKey: idempotencyHash,
    clientBuild: input.operation.clientBuild,
    contentVersion: input.operation.contentVersion,
  }));
  const result = { balance, ledgerEntries };
  const playerKey = `PLAYER#${input.operation.playerId}`;
  const requestHash = sha256(input.operation.requestFingerprint);

  const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [{
    Update: {
      TableName: input.tableName,
      Key: { pk: playerKey, sk: "BALANCE" },
      UpdateExpression: "SET coins = :coins, gems = :gems, energy = :energy, energyUpdatedAt = :energyAt, revision = :nextRevision",
      ConditionExpression: "entityType = :entityType AND recordVersion = :recordVersion AND playerId = :playerId AND revision = :revision AND coins = :oldCoins AND gems = :oldGems AND energy = :oldEnergy",
      ExpressionAttributeValues: {
        ":coins": balance.coins, ":gems": balance.gems, ":energy": balance.energy,
        ":energyAt": balance.energyUpdatedAt, ":nextRevision": balance.revision,
        ":entityType": "Balance", ":recordVersion": 1, ":playerId": input.operation.playerId,
        ":revision": input.current.revision, ":oldCoins": input.current.coins,
        ":oldGems": input.current.gems, ":oldEnergy": input.current.energy,
      },
    },
  }];

  for (const entry of ledgerEntries) {
    items.push({ Put: { TableName: input.tableName, Item: {
      pk: playerKey, sk: `LEDGER#${createdAt}#${entry.ledgerEntryId}`,
      entityType: "LedgerEntry", recordVersion: 1, playerId: input.operation.playerId,
      ledgerEntryId: entry.ledgerEntryId, resource: entry.resource, delta: entry.delta,
      reasonCode: entry.reasonCode, sourceReference: entry.sourceReference,
      balanceAfter: entry.balanceAfter, createdAt: entry.createdAt,
      idempotencyKeyHash: idempotencyHash, clientBuild: entry.clientBuild,
      contentVersion: entry.contentVersion,
    }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } });
  }
  if (input.operation.uniqueGrantKey !== undefined) {
    items.push({ Put: { TableName: input.tableName, Item: {
      pk: `ECONOMY_GRANT#${sha256(input.operation.uniqueGrantKey)}`, sk: `PLAYER#${input.operation.playerId}`,
      entityType: "EconomyGrantClaim", recordVersion: 1, playerId: input.operation.playerId,
      operationKey: idempotencyHash, result: publicResult(result), createdAt,
    }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } });
  }
  items.push({ Put: { TableName: input.tableName, Item: {
    pk: `IDEMPOTENCY#ECONOMY#${input.operation.playerId}#${idempotencyHash}`, sk: "RESULT",
    entityType: "Idempotency", recordVersion: 1, operation: "economy.apply",
    playerId: input.operation.playerId, requestHash, operationKey: idempotencyHash,
    result: publicResult(result),
    status: "completed", createdAt,
    expiresAtEpochSeconds: Math.floor(input.operation.now.getTime() / 1000) + ttlSeconds,
    ttl: Math.floor(input.operation.now.getTime() / 1000) + ttlSeconds,
  }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } });

  return { command: new TransactWriteCommand({ TransactItems: items }), result };
}

function publicResult(result: EconomyMutationResult): Record<string, unknown> {
  return {
    balance: result.balance,
    ledgerEntries: result.ledgerEntries.map(({ idempotencyKey: _ignored, ...entry }) => entry),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
