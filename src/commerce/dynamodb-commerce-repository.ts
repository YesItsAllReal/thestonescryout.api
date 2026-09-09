import { createHash, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  CommerceIdempotencyConflictError, CommerceOwnershipError,
  type CommerceGrantResult, type CommerceNotificationResult, type CommerceRepository,
} from "./commerce-service.js";
import { buildPurchaseTransaction } from "./dynamodb-purchase-transaction.js";
import type { EconomyBalance, LedgerEntry } from "../economy/economy-service.js";
import type { Entitlement } from "../economy/entitlement-service.js";

type Client = Pick<DynamoDBDocumentClient, "send">;
type Purchase = Parameters<CommerceRepository["processPurchaseAtomically"]>[0];

export class CommerceOperationNotConfiguredError extends Error {}

export class DynamoDbCommerceRepository implements CommerceRepository {
  public constructor(
    private readonly client: Client,
    private readonly tableName: string,
    private readonly createId: () => string = randomUUID,
    private readonly idempotencyTtlSeconds = 2_592_000,
  ) {
    if (tableName.trim() === "" || !Number.isSafeInteger(idempotencyTtlSeconds) || idempotencyTtlSeconds < 1) {
      throw new Error("DynamoDB commerce configuration is invalid");
    }
  }

  public async processPurchaseAtomically(input: Purchase): Promise<CommerceGrantResult> {
    const replay = await this.readReplay(input);
    if (replay !== undefined) return replay;
    const claimed = await this.readTransaction(input);
    if (claimed !== undefined) return this.recordDuplicate(input, claimed);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await this.readBalance(input.playerId);
      const built = buildPurchaseTransaction({
        tableName: this.tableName, current, operation: input,
        ledgerEntryIds: input.product.grants.map(() => this.createId()),
        idempotencyTtlSeconds: this.idempotencyTtlSeconds,
      });
      try {
        await this.client.send(built.command);
        return built.result;
      } catch (error: unknown) {
        if (!named(error, "TransactionCanceledException")) throw error;
        const winner = await this.readReplay(input);
        if (winner !== undefined) return winner;
        const transaction = await this.readTransaction(input);
        if (transaction !== undefined) return this.recordDuplicate(input, transaction);
        if (attempt === 1) throw new Error("purchase transaction was cancelled without a durable winner");
      }
    }
    throw new Error("purchase transaction retry was exhausted");
  }

  public async processNotificationAtomically(
    _input: Parameters<CommerceRepository["processNotificationAtomically"]>[0],
  ): Promise<CommerceNotificationResult> {
    throw new CommerceOperationNotConfiguredError("DynamoDB notification processing is not configured");
  }

  public async processAdRewardAtomically(
    _input: Parameters<CommerceRepository["processAdRewardAtomically"]>[0],
  ): Promise<CommerceGrantResult> {
    throw new CommerceOperationNotConfiguredError("DynamoDB ad reward processing is not configured");
  }

  private async readReplay(input: Purchase): Promise<CommerceGrantResult | undefined> {
    const operationKey = sha256(input.idempotencyKey);
    const response = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: `IDEMPOTENCY#PURCHASE#${input.playerId}#${operationKey}`, sk: "RESULT" },
      ConsistentRead: true,
    }));
    if (response.Item === undefined) return undefined;
    const item = response.Item;
    if (item.entityType !== "Idempotency" || item.recordVersion !== 1 || item.operation !== "commerce.purchase" ||
        item.playerId !== input.playerId || item.operationKey !== operationKey || typeof item.requestHash !== "string") {
      throw new Error("stored purchase replay is invalid");
    }
    if (item.requestHash !== requestHash(input)) {
      throw new CommerceIdempotencyConflictError("idempotency key was reused for another purchase");
    }
    const result = readResult(item.result, input.playerId, operationKey);
    validateResultForInput(result, input);
    return result;
  }

  private async readTransaction(input: Purchase): Promise<CommerceGrantResult | undefined> {
    const response = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: `TRANSACTION#${input.transaction.environment}#${input.transaction.transactionId}`, sk: "GRANT" },
      ConsistentRead: true,
    }));
    if (response.Item === undefined) return undefined;
    const item = response.Item;
    if (item.entityType !== "PurchaseTransaction" || item.recordVersion !== 1 ||
        item.transactionId !== input.transaction.transactionId || item.originalTransactionId !== input.transaction.originalTransactionId ||
        item.environment !== input.transaction.environment || item.purchasedAt !== input.transaction.purchasedAt || item.state !== "granted" ||
        typeof item.playerId !== "string" || typeof item.productId !== "string") {
      throw new Error("stored purchase transaction is invalid");
    }
    if (item.playerId !== input.playerId || item.productId !== input.transaction.productId) {
      throw new CommerceOwnershipError("transaction was already claimed by another purchase");
    }
    const result = readResult(item.result, input.playerId, sha256(input.idempotencyKey));
    validateResultForInput(result, input);
    return result;
  }

  private async recordDuplicate(input: Purchase, claimed: CommerceGrantResult): Promise<CommerceGrantResult> {
    const operationKey = sha256(input.idempotencyKey);
    const result: CommerceGrantResult = {
      ...claimed, status: "duplicate", balance: await this.readBalance(input.playerId),
    };
    const createdAt = input.now.toISOString();
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `IDEMPOTENCY#PURCHASE#${input.playerId}#${operationKey}`, sk: "RESULT",
          entityType: "Idempotency", recordVersion: 1, operation: "commerce.purchase",
          playerId: input.playerId, operationKey, requestHash: requestHash(input),
          result: storedResult(result), status: "completed", createdAt,
          expiresAtEpochSeconds: Math.floor(input.now.getTime() / 1000) + this.idempotencyTtlSeconds,
          ttl: Math.floor(input.now.getTime() / 1000) + this.idempotencyTtlSeconds,
        },
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      }));
      return result;
    } catch (error: unknown) {
      if (!named(error, "ConditionalCheckFailedException")) throw error;
      const replay = await this.readReplay(input);
      if (replay === undefined) throw new Error("purchase replay collision has no durable result");
      return replay;
    }
  }

  private async readBalance(playerId: string): Promise<EconomyBalance> {
    const response = await this.client.send(new GetCommand({
      TableName: this.tableName, Key: { pk: `PLAYER#${playerId}`, sk: "BALANCE" }, ConsistentRead: true,
    }));
    if (response.Item === undefined) throw new Error("purchase balance was not found");
    return readBalance(response.Item, playerId);
  }
}

function readResult(value: unknown, playerId: string, operationKey: string): CommerceGrantResult {
  if (!record(value) || !record(value.balance) || !Array.isArray(value.ledgerEntries) || value.ledgerEntries.length > 3 ||
      (value.status !== "granted" && value.status !== "duplicate")) throw new Error("stored purchase result is invalid");
  const balance = readBalance({ ...value.balance, entityType: "Balance", recordVersion: 1, playerId }, playerId);
  const ledgerEntries = value.ledgerEntries.map((raw): LedgerEntry => {
    if (!record(raw) || typeof raw.ledgerEntryId !== "string" ||
        (raw.resource !== "coins" && raw.resource !== "gems" && raw.resource !== "energy") ||
        typeof raw.delta !== "number" || !Number.isSafeInteger(raw.delta) || raw.delta <= 0 ||
        raw.reasonCode !== "IAP_GRANT" || typeof raw.sourceReference !== "string" ||
        !amount(raw.balanceAfter) || typeof raw.createdAt !== "string" ||
        !positive(raw.clientBuild) || typeof raw.contentVersion !== "string") throw new Error("stored purchase ledger result is invalid");
    return {
      ledgerEntryId: raw.ledgerEntryId, resource: raw.resource, delta: raw.delta,
      reasonCode: raw.reasonCode, sourceReference: raw.sourceReference,
      balanceAfter: raw.balanceAfter, createdAt: raw.createdAt, idempotencyKey: operationKey,
      clientBuild: raw.clientBuild, contentVersion: raw.contentVersion,
    };
  });
  const entitlement = value.entitlement === undefined ? undefined : readEntitlement(value.entitlement);
  return { status: value.status, balance, ledgerEntries, ...(entitlement === undefined ? {} : { entitlement }) };
}

function readBalance(item: Record<string, unknown>, playerId: string): EconomyBalance {
  if (item.entityType !== "Balance" || item.recordVersion !== 1 || item.playerId !== playerId ||
      !amount(item.coins) || !amount(item.gems) || !amount(item.energy) ||
      typeof item.energyUpdatedAt !== "string" || !positive(item.revision)) throw new Error("stored purchase balance is invalid");
  return { coins: item.coins, gems: item.gems, energy: item.energy, energyUpdatedAt: item.energyUpdatedAt, revision: item.revision };
}

function readEntitlement(value: unknown): Entitlement {
  if (!record(value) || typeof value.productId !== "string" || value.productId.length < 1 || value.productId.length > 255 ||
      (value.state !== "active" && value.state !== "revoked" && value.state !== "refunded") ||
      (value.environment !== "sandbox" && value.environment !== "production") || typeof value.purchasedAt !== "string") {
    throw new Error("stored purchase entitlement is invalid");
  }
  return { productId: value.productId, state: value.state, purchasedAt: value.purchasedAt, environment: value.environment };
}

function validateResultForInput(result: CommerceGrantResult, input: Purchase): void {
  if (result.ledgerEntries.length !== input.product.grants.length) throw new Error("stored purchase result does not match product grants");
  for (let index = 0; index < input.product.grants.length; index += 1) {
    const expected = input.product.grants[index]!;
    const actual = result.ledgerEntries[index]!;
    if (actual.resource !== expected.resource || actual.delta !== expected.delta || actual.sourceReference !== input.transaction.transactionId) {
      throw new Error("stored purchase result does not match product grants");
    }
  }
  if (input.product.kind === "nonConsumable") {
    if (result.entitlement?.productId !== input.product.productId ||
        result.entitlement.environment !== input.transaction.environment ||
        result.entitlement.purchasedAt !== input.transaction.purchasedAt || result.entitlement.state !== "active") {
      throw new Error("stored purchase result does not match entitlement");
    }
  } else if (result.entitlement !== undefined) {
    throw new Error("stored consumable purchase contains an entitlement");
  }
}

function storedResult(result: CommerceGrantResult): Record<string, unknown> {
  return {
    status: result.status, balance: result.balance,
    ledgerEntries: result.ledgerEntries.map(({ idempotencyKey: _ignored, ...entry }) => entry),
    ...(result.entitlement === undefined ? {} : { entitlement: result.entitlement }),
  };
}
function requestHash(input: Purchase): string { return sha256(JSON.stringify([input.transaction.environment, input.transaction.transactionId, input.transaction.productId])); }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function amount(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function named(value: unknown, name: string): boolean { return record(value) && value.name === name; }
