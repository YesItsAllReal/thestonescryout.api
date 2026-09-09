import { createHash } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { CommerceGrantResult, CommerceProduct, VerifiedAppStoreTransaction } from "./commerce-service.js";
import type { EconomyBalance, EconomyResource, LedgerEntry } from "../economy/economy-service.js";
import type { Entitlement } from "../economy/entitlement-service.js";

export interface PurchaseTransactionOperation {
  readonly playerId: string;
  readonly transaction: VerifiedAppStoreTransaction;
  readonly product: CommerceProduct;
  readonly idempotencyKey: string;
  readonly clientBuild: number;
  readonly contentVersion: string;
  readonly now: Date;
}

export function buildPurchaseTransaction(input: {
  readonly tableName: string;
  readonly current: EconomyBalance;
  readonly operation: PurchaseTransactionOperation;
  readonly ledgerEntryIds: readonly string[];
  readonly idempotencyTtlSeconds?: number;
}): { readonly command: TransactWriteCommand; readonly result: CommerceGrantResult } {
  const ttlSeconds = input.idempotencyTtlSeconds ?? 2_592_000;
  validateInput(input.tableName, input.current, input.operation, input.ledgerEntryIds, ttlSeconds);

  const { operation } = input;
  const createdAt = operation.now.toISOString();
  const playerKey = `PLAYER#${operation.playerId}`;
  const idempotencyHash = sha256(operation.idempotencyKey);
  const next: Record<EconomyResource, number> = {
    coins: input.current.coins,
    gems: input.current.gems,
    energy: input.current.energy,
  };
  for (const mutation of operation.product.grants) {
    const value = next[mutation.resource] + mutation.delta;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("purchase grant would produce an invalid balance");
    next[mutation.resource] = value;
  }
  const balance: EconomyBalance = operation.product.grants.length === 0 ? input.current : {
    ...next,
    energyUpdatedAt: operation.product.grants.some((value) => value.resource === "energy")
      ? createdAt : input.current.energyUpdatedAt,
    revision: input.current.revision + 1,
  };
  const ledgerEntries: LedgerEntry[] = operation.product.grants.map((mutation, index) => ({
    ledgerEntryId: input.ledgerEntryIds[index]!, resource: mutation.resource, delta: mutation.delta,
    reasonCode: "IAP_GRANT", sourceReference: operation.transaction.transactionId,
    balanceAfter: next[mutation.resource], createdAt, idempotencyKey: idempotencyHash,
    clientBuild: operation.clientBuild, contentVersion: operation.contentVersion,
  }));
  const entitlement: Entitlement | undefined = operation.product.kind === "nonConsumable" ? {
    productId: operation.product.productId, state: "active", purchasedAt: operation.transaction.purchasedAt,
    environment: operation.transaction.environment,
  } : undefined;
  const result: CommerceGrantResult = {
    status: "granted", balance, ledgerEntries,
    ...(entitlement === undefined ? {} : { entitlement }),
  };
  const publicResult = storedResult(result);
  const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [{
    Put: { TableName: input.tableName, Item: {
      pk: `TRANSACTION#${operation.transaction.environment}#${operation.transaction.transactionId}`, sk: "GRANT",
      entityType: "PurchaseTransaction", recordVersion: 1, playerId: operation.playerId,
      transactionId: operation.transaction.transactionId,
      originalTransactionId: operation.transaction.originalTransactionId,
      productId: operation.transaction.productId, environment: operation.transaction.environment,
      productKind: operation.product.kind, purchasedAt: operation.transaction.purchasedAt,
      state: "granted", stateEffectiveAt: operation.transaction.purchasedAt,
      result: publicResult, createdAt,
    }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" },
  }];

  if (operation.product.grants.length > 0) {
    items.push({ Update: {
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
    } });
  }
  for (const entry of ledgerEntries) items.push({ Put: { TableName: input.tableName, Item: {
    pk: playerKey, sk: `LEDGER#${createdAt}#${entry.ledgerEntryId}`,
    entityType: "LedgerEntry", recordVersion: 1, playerId: operation.playerId,
    ledgerEntryId: entry.ledgerEntryId, resource: entry.resource, delta: entry.delta,
    reasonCode: entry.reasonCode, sourceReference: entry.sourceReference,
    balanceAfter: entry.balanceAfter, createdAt: entry.createdAt,
    idempotencyKeyHash: idempotencyHash, clientBuild: entry.clientBuild,
    contentVersion: entry.contentVersion,
  }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } });
  if (entitlement !== undefined) items.push({ Put: { TableName: input.tableName, Item: {
    pk: playerKey, sk: `ENTITLEMENT#${entitlement.productId}`,
    entityType: "Entitlement", recordVersion: 1, playerId: operation.playerId, ...entitlement,
    transactionId: operation.transaction.transactionId,
    stateEffectiveAt: operation.transaction.purchasedAt, updatedAt: createdAt,
  }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } });
  items.push({ Put: { TableName: input.tableName, Item: {
    pk: `IDEMPOTENCY#PURCHASE#${operation.playerId}#${idempotencyHash}`, sk: "RESULT",
    entityType: "Idempotency", recordVersion: 1, operation: "commerce.purchase",
    playerId: operation.playerId, operationKey: idempotencyHash,
    requestHash: sha256(JSON.stringify([
      operation.transaction.environment, operation.transaction.transactionId, operation.transaction.productId,
    ])),
    result: publicResult, status: "completed", createdAt,
    expiresAtEpochSeconds: Math.floor(operation.now.getTime() / 1000) + ttlSeconds,
    ttl: Math.floor(operation.now.getTime() / 1000) + ttlSeconds,
  }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } });
  return { command: new TransactWriteCommand({ TransactItems: items }), result };
}

function validateInput(tableName: string, current: EconomyBalance, operation: PurchaseTransactionOperation, ids: readonly string[], ttl: number): void {
  if (tableName.trim() === "" || !Number.isSafeInteger(ttl) || ttl < 1) throw new Error("purchase transaction configuration is invalid");
  if (!isUuid(operation.playerId) || operation.product.productId !== operation.transaction.productId) throw new Error("purchase transaction identity is invalid");
  if (operation.product.grants.length > 3 || ids.length !== operation.product.grants.length) throw new Error("purchase transaction grants are invalid");
  if (new Set(operation.product.grants.map((value) => value.resource)).size !== operation.product.grants.length) throw new Error("purchase transaction grants are invalid");
  if (new Set(ids).size !== ids.length || ids.some((value) => !/^[A-Za-z0-9._-]{1,128}$/.test(value))) throw new Error("purchase transaction ledger IDs are invalid");
  if (operation.product.kind === "consumable" && operation.product.grants.length === 0) throw new Error("purchase transaction grants are invalid");
  if (operation.product.kind !== "consumable" && operation.product.kind !== "nonConsumable") throw new Error("purchase transaction product kind is invalid");
  if (operation.product.grants.some((value) => !Number.isSafeInteger(value.delta) || value.delta <= 0)) throw new Error("purchase transaction grants are invalid");
  if (!Number.isSafeInteger(current.revision) || current.revision < 1 || !validAmount(current.coins) || !validAmount(current.gems) || !validAmount(current.energy) || !validInstant(current.energyUpdatedAt)) throw new Error("current balance is invalid");
  if (!Number.isSafeInteger(operation.clientBuild) || operation.clientBuild < 1 || !/^[A-Za-z0-9._-]{1,64}$/.test(operation.contentVersion)) throw new Error("purchase client context is invalid");
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(operation.idempotencyKey) || !validDate(operation.now) || !validInstant(operation.transaction.purchasedAt) || (operation.transaction.environment !== "sandbox" && operation.transaction.environment !== "production")) throw new Error("purchase transaction input is invalid");
  for (const value of [operation.transaction.transactionId, operation.transaction.originalTransactionId, operation.transaction.productId]) {
    if (!/^[A-Za-z0-9._:-]{1,255}$/.test(value)) throw new Error("purchase transaction input is invalid");
  }
}

function storedResult(result: CommerceGrantResult): Record<string, unknown> {
  return {
    status: result.status, balance: result.balance,
    ledgerEntries: result.ledgerEntries.map(({ idempotencyKey: _ignored, ...entry }) => entry),
    ...(result.entitlement === undefined ? {} : { entitlement: result.entitlement }),
  };
}
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function validAmount(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function validDate(value: Date): boolean { return Number.isFinite(value.getTime()); }
function validInstant(value: string): boolean { const timestamp = Date.parse(value); return Number.isFinite(timestamp); }
