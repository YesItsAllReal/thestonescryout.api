import { createHash, randomUUID } from "node:crypto";

import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

import {
  AccountDeletionIdempotencyConflictError,
  AccountNotFoundError,
  type AccountDeletionReceipt,
  type AccountProfile,
  type AccountRepository,
} from "./account-service.js";

type DocumentClient = Pick<DynamoDBDocumentClient, "send">;
type DeletionInput = Parameters<AccountRepository["requestDeletionWithAudit"]>[0];

interface StoredDeletion {
  readonly requestHash: string;
  readonly receipt: AccountDeletionReceipt;
}

export class DynamoDbAccountRepository implements AccountRepository {
  public constructor(
    private readonly client: DocumentClient,
    private readonly tableName: string,
    private readonly createAuditEventId: () => string = randomUUID,
    private readonly idempotencyTtlSeconds = 2_592_000,
  ) {
    if (tableName.trim() === "") throw new Error("DynamoDB table name is required");
    if (!Number.isSafeInteger(idempotencyTtlSeconds) || idempotencyTtlSeconds < 1) {
      throw new Error("idempotency TTL must be a positive integer");
    }
  }

  public async getByPlayerId(playerId: string): Promise<AccountProfile | undefined> {
    const response = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: profileKey(playerId),
      ConsistentRead: true,
    }));
    if (response.Item === undefined) return undefined;
    if (response.Item.accountState === "merged") return undefined;
    return readProfile(response.Item, playerId);
  }

  public async requestDeletionWithAudit(input: DeletionInput): Promise<AccountDeletionReceipt> {
    const requestHash = hashDeletionRequest(input.playerId);
    const idempotencyKey = deletionIdempotencyKey(input.playerId, input.idempotencyKey);
    const replay = await this.readDeletion(idempotencyKey);
    if (replay !== undefined) return resolveReplay(replay, requestHash);

    const profile = await this.getByPlayerId(input.playerId);
    if (profile === undefined) throw new AccountNotFoundError("account was not found");
    if (profile.deletionState !== "active") {
      const requestedAt = await this.readDeletionRequestedAt(input.playerId);
      return this.claimExistingDeletion(input, requestHash, {
        deletionState: profile.deletionState,
        requestedAt,
      });
    }

    const receipt: AccountDeletionReceipt = {
      deletionState: "requested",
      requestedAt: input.now.toISOString(),
    };
    const auditEventId = this.createAuditEventId();
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: profileKey(input.playerId),
              UpdateExpression: "SET deletionState = :requested, deletionRequestedAt = :requestedAt",
              ConditionExpression: "entityType = :playerType AND recordVersion = :recordVersion AND deletionState = :active AND (attribute_not_exists(accountState) OR accountState = :accountActive)",
              ExpressionAttributeValues: {
                ":requested": "requested",
                ":requestedAt": receipt.requestedAt,
                ":playerType": "Player",
                ":recordVersion": 1,
                ":active": "active",
                ":accountActive": "active",
              },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: deletionJobItem(input.playerId, receipt, input.providerMappingKey),
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: auditItem(input.playerId, receipt.requestedAt, auditEventId),
              ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: deletionIdempotencyItem(idempotencyKey, input, requestHash, receipt, this.idempotencyTtlSeconds),
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }));
      return receipt;
    } catch (error: unknown) {
      if (!isConditionalTransactionCancellation(error)) throw error;
      const winner = await this.readDeletion(idempotencyKey);
      if (winner !== undefined) return resolveReplay(winner, requestHash);
      const current = await this.getByPlayerId(input.playerId);
      if (current === undefined) throw new AccountNotFoundError("account was not found");
      if (current.deletionState === "active") {
        throw new Error("account deletion transaction was cancelled without a durable winner");
      }
      return this.claimExistingDeletion(input, requestHash, {
        deletionState: current.deletionState,
        requestedAt: await this.readDeletionRequestedAt(input.playerId),
      });
    }
  }

  private async claimExistingDeletion(
    input: DeletionInput,
    requestHash: string,
    receipt: AccountDeletionReceipt,
  ): Promise<AccountDeletionReceipt> {
    const key = deletionIdempotencyKey(input.playerId, input.idempotencyKey);
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: deletionIdempotencyItem(key, input, requestHash, receipt, this.idempotencyTtlSeconds),
        ConditionExpression: "attribute_not_exists(pk)",
      }));
      return receipt;
    } catch (error: unknown) {
      if (!isConditionalWriteFailure(error)) throw error;
      const winner = await this.readDeletion(key);
      if (winner === undefined) throw new Error("deletion idempotency claim failed without a stored winner");
      return resolveReplay(winner, requestHash);
    }
  }

  private async readDeletion(key: Record<string, string>): Promise<StoredDeletion | undefined> {
    const response = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: key,
      ConsistentRead: true,
    }));
    const item = response.Item;
    if (item === undefined) return undefined;
    if (item.entityType !== "Idempotency" || item.operation !== "account.delete" ||
        item.recordVersion !== 1 || typeof item.requestHash !== "string") {
      throw new Error("stored account deletion idempotency record is invalid");
    }
    return { requestHash: item.requestHash, receipt: readReceipt(item.receipt) };
  }

  private async readDeletionRequestedAt(playerId: string): Promise<string> {
    const response = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: `DELETION#${playerId}`, sk: "REQUEST" },
      ConsistentRead: true,
    }));
    if (response.Item?.entityType !== "DeletionJob" || response.Item.recordVersion !== 1 ||
        typeof response.Item.requestedAt !== "string") {
      throw new Error("durable deletion job is missing or invalid");
    }
    return response.Item.requestedAt;
  }
}

function readProfile(item: Record<string, unknown>, playerId: string): AccountProfile {
  if (item.entityType !== "Player" || item.recordVersion !== 1 || item.playerId !== playerId ||
      (item.accountState !== undefined && item.accountState !== "active") ||
      (item.accountKind !== "guest" && item.accountKind !== "apple" && item.accountKind !== "google") ||
      typeof item.locale !== "string" || typeof item.createdAt !== "string" ||
      (item.deletionState !== "active" && item.deletionState !== "requested" && item.deletionState !== "processing") ||
      (item.displayName !== undefined && item.displayName !== null && typeof item.displayName !== "string") ||
      (item.linkedProviders !== undefined && (!Array.isArray(item.linkedProviders) ||
        item.linkedProviders.some((provider) => provider !== "apple" && provider !== "google")))) {
    throw new Error("stored account profile is invalid");
  }
  return {
    playerId,
    accountKind: item.accountKind,
    displayName: item.displayName ?? null,
    locale: item.locale,
    createdAt: item.createdAt,
    linkedProviders: (item.linkedProviders ?? []) as AccountProfile["linkedProviders"],
    deletionState: item.deletionState,
  };
}

function readReceipt(value: unknown): AccountDeletionReceipt {
  if (value === null || typeof value !== "object") throw new Error("stored deletion receipt is invalid");
  const receipt = value as Record<string, unknown>;
  if ((receipt.deletionState !== "requested" && receipt.deletionState !== "processing") ||
      typeof receipt.requestedAt !== "string") {
    throw new Error("stored deletion receipt is invalid");
  }
  return { deletionState: receipt.deletionState, requestedAt: receipt.requestedAt };
}

function resolveReplay(stored: StoredDeletion, requestHash: string): AccountDeletionReceipt {
  if (stored.requestHash !== requestHash) {
    throw new AccountDeletionIdempotencyConflictError("idempotency key was reused for another deletion request");
  }
  return stored.receipt;
}

function profileKey(playerId: string): Record<string, string> {
  return { pk: `PLAYER#${playerId}`, sk: "PROFILE" };
}

function deletionIdempotencyKey(playerId: string, key: string): Record<string, string> {
  return { pk: `IDEMPOTENCY#PLAYER#${playerId}#${sha256(key)}`, sk: "RESULT" };
}

function deletionJobItem(
  playerId: string,
  receipt: AccountDeletionReceipt,
  providerMappingKey: { readonly pk: string; readonly sk: string } | undefined,
): Record<string, unknown> {
  return {
    pk: `DELETION#${playerId}`,
    sk: "REQUEST",
    entityType: "DeletionJob",
    recordVersion: 1,
    playerId,
    state: receipt.deletionState,
    requestedAt: receipt.requestedAt,
    ...(providerMappingKey === undefined ? {} : {
      providerMappingPk: providerMappingKey.pk,
      providerMappingSk: providerMappingKey.sk,
    }),
  };
}

function auditItem(playerId: string, createdAt: string, eventId: string): Record<string, unknown> {
  return {
    pk: `PLAYER#${playerId}`,
    sk: `AUDIT#${createdAt}#${eventId}`,
    entityType: "AuditEvent",
    recordVersion: 1,
    auditEventId: eventId,
    playerId,
    action: "ACCOUNT_DELETION_REQUESTED",
    createdAt,
  };
}

function deletionIdempotencyItem(
  key: Record<string, string>,
  input: DeletionInput,
  requestHash: string,
  receipt: AccountDeletionReceipt,
  ttlSeconds: number,
): Record<string, unknown> {
  return {
    ...key,
    entityType: "Idempotency",
    recordVersion: 1,
    operation: "account.delete",
    scope: `player:${input.playerId}`,
    requestHash,
    receipt,
    status: "completed",
    createdAt: input.now.toISOString(),
    expiresAtEpochSeconds: Math.floor(input.now.getTime() / 1000) + ttlSeconds,
  };
}

function hashDeletionRequest(playerId: string): string {
  return sha256(JSON.stringify([playerId, "deleteAccount"]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isConditionalWriteFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

function isConditionalTransactionCancellation(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return false;
  const reasons = (error as Error & { CancellationReasons?: readonly { Code?: string }[] }).CancellationReasons;
  return reasons?.some((reason) => reason.Code === "ConditionalCheckFailed") ?? false;
}
