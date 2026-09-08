import { createHash } from "node:crypto";

import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

import {
  SaveIdempotencyConflictError,
  type GameSave,
  type SaveConflictMetadata,
  type SaveRepository,
  type SaveWriteResult,
} from "./save-service.js";

type DocumentClient = Pick<DynamoDBDocumentClient, "send">;
type SaveInput = Parameters<SaveRepository["putConditionally"]>[0];

interface StoredResult {
  readonly requestHash: string;
  readonly result: SaveWriteResult;
}

export class DynamoDbSaveRepository implements SaveRepository {
  public constructor(
    private readonly client: DocumentClient,
    private readonly tableName: string,
    private readonly idempotencyTtlSeconds = 86_400,
  ) {
    if (tableName.trim() === "") throw new Error("DynamoDB table name is required");
    if (!Number.isSafeInteger(idempotencyTtlSeconds) || idempotencyTtlSeconds < 1) {
      throw new Error("idempotency TTL must be a positive integer");
    }
  }

  public async get(playerId: string, slot: string): Promise<GameSave | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: saveKey(playerId, slot),
      ConsistentRead: true,
    }));
    return result.Item === undefined ? undefined : readSave(result.Item, playerId, slot);
  }

  public async putConditionally(input: SaveInput): Promise<SaveWriteResult> {
    const requestHash = hashRequest(input);
    const idempotencyKey = keyForIdempotency(input.playerId, input.idempotencyKey);
    const replay = await this.readIdempotency(idempotencyKey);
    if (replay !== undefined) return resolveReplay(replay, requestHash);

    const current = await this.get(input.playerId, input.slot);
    if ((current?.revision ?? 0) !== input.expectedRevision) {
      return this.recordConflict(input, requestHash, conflictFor(input.slot, current));
    }

    const save: GameSave = {
      slot: input.slot,
      revision: input.expectedRevision + 1,
      schemaVersion: input.schemaVersion,
      snapshot: input.snapshot,
      updatedAt: input.now.toISOString(),
    };
    const savedResult = { kind: "saved", save } as const;

    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: saveItem(input.playerId, save, input.deviceIdHash),
              ConditionExpression: input.expectedRevision === 0
                ? "attribute_not_exists(pk)"
                : "revision = :expectedRevision",
              ...(input.expectedRevision === 0 ? {} : {
                ExpressionAttributeValues: { ":expectedRevision": input.expectedRevision },
              }),
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: idempotencyItem(idempotencyKey, input, requestHash, savedResult, this.idempotencyTtlSeconds),
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }));
      return savedResult;
    } catch (error: unknown) {
      if (!isConditionalTransactionCancellation(error)) throw error;
      const winner = await this.readIdempotency(idempotencyKey);
      if (winner !== undefined) return resolveReplay(winner, requestHash);
      const latest = await this.get(input.playerId, input.slot);
      return this.recordConflict(input, requestHash, conflictFor(input.slot, latest));
    }
  }

  private async recordConflict(
    input: SaveInput,
    requestHash: string,
    conflict: SaveConflictMetadata,
  ): Promise<SaveWriteResult> {
    const result = { kind: "conflict", conflict } as const;
    const key = keyForIdempotency(input.playerId, input.idempotencyKey);
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: idempotencyItem(key, input, requestHash, result, this.idempotencyTtlSeconds),
        ConditionExpression: "attribute_not_exists(pk)",
      }));
      return result;
    } catch (error: unknown) {
      if (!isConditionalWriteFailure(error)) throw error;
      const winner = await this.readIdempotency(key);
      if (winner === undefined) throw new Error("save idempotency claim failed without a stored winner");
      return resolveReplay(winner, requestHash);
    }
  }

  private async readIdempotency(key: Record<string, string>): Promise<StoredResult | undefined> {
    const response = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: key,
      ConsistentRead: true,
    }));
    const item = response.Item;
    if (item === undefined) return undefined;
    if (item.entityType !== "Idempotency" || item.operation !== "save.put" ||
        typeof item.requestHash !== "string") {
      throw new Error("stored save idempotency record is invalid");
    }
    return { requestHash: item.requestHash, result: readStoredResult(item.result) };
  }
}

function saveKey(playerId: string, slot: string): Record<string, string> {
  return { pk: `PLAYER#${playerId}`, sk: `SAVE#${slot}` };
}

function keyForIdempotency(playerId: string, idempotencyKey: string): Record<string, string> {
  return {
    pk: `IDEMPOTENCY#PLAYER#${playerId}#${sha256(idempotencyKey)}`,
    sk: "RESULT",
  };
}

function saveItem(playerId: string, save: GameSave, deviceIdHash: string): Record<string, unknown> {
  return {
    ...saveKey(playerId, save.slot),
    entityType: "Save",
    recordVersion: 1,
    playerId,
    revision: save.revision,
    schemaVersion: save.schemaVersion,
    snapshot: save.snapshot,
    updatedAt: save.updatedAt,
    deviceIdHash,
  };
}

function idempotencyItem(
  key: Record<string, string>,
  input: SaveInput,
  requestHash: string,
  result: SaveWriteResult,
  ttlSeconds: number,
): Record<string, unknown> {
  return {
    ...key,
    entityType: "Idempotency",
    recordVersion: 1,
    operation: "save.put",
    scope: `player:${input.playerId}`,
    requestHash,
    result,
    status: "completed",
    createdAt: input.now.toISOString(),
    expiresAtEpochSeconds: Math.floor(input.now.getTime() / 1000) + ttlSeconds,
  };
}

function readSave(item: Record<string, unknown>, playerId: string, slot: string): GameSave {
  if (item.entityType !== "Save" || item.playerId !== playerId ||
      typeof item.revision !== "number" || !Number.isSafeInteger(item.revision) || item.revision < 1 ||
      typeof item.schemaVersion !== "number" || !Number.isSafeInteger(item.schemaVersion) || item.schemaVersion < 1 ||
      typeof item.updatedAt !== "string" || item.snapshot === null ||
      typeof item.snapshot !== "object" || Array.isArray(item.snapshot)) {
    throw new Error("stored save record is invalid");
  }
  return {
    slot,
    revision: item.revision,
    schemaVersion: item.schemaVersion,
    snapshot: item.snapshot as GameSave["snapshot"],
    updatedAt: item.updatedAt,
  };
}

function readStoredResult(value: unknown): SaveWriteResult {
  if (value === null || typeof value !== "object") throw new Error("stored save result is invalid");
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "saved" && candidate.save !== null && typeof candidate.save === "object") {
    const save = candidate.save as Record<string, unknown>;
    if (typeof save.slot === "string") {
      return { kind: "saved", save: readSave({ ...save, entityType: "Save", playerId: "stored" }, "stored", save.slot) };
    }
  }
  if (candidate.kind === "conflict" && candidate.conflict !== null && typeof candidate.conflict === "object") {
    const conflict = candidate.conflict as Record<string, unknown>;
    if (typeof conflict.slot === "string" && typeof conflict.currentRevision === "number" &&
        Number.isSafeInteger(conflict.currentRevision) && conflict.currentRevision >= 0) {
      return {
        kind: "conflict",
        conflict: {
          slot: conflict.slot,
          currentRevision: conflict.currentRevision,
          ...(typeof conflict.currentSchemaVersion === "number" ? { currentSchemaVersion: conflict.currentSchemaVersion } : {}),
          ...(typeof conflict.currentUpdatedAt === "string" ? { currentUpdatedAt: conflict.currentUpdatedAt } : {}),
        },
      };
    }
  }
  throw new Error("stored save result is invalid");
}

function resolveReplay(stored: StoredResult, requestHash: string): SaveWriteResult {
  if (stored.requestHash !== requestHash) {
    throw new SaveIdempotencyConflictError("idempotency key was reused for a different save write");
  }
  return stored.result;
}

function conflictFor(slot: string, current: GameSave | undefined): SaveConflictMetadata {
  return {
    slot,
    currentRevision: current?.revision ?? 0,
    ...(current === undefined ? {} : {
      currentSchemaVersion: current.schemaVersion,
      currentUpdatedAt: current.updatedAt,
    }),
  };
}

function hashRequest(input: SaveInput): string {
  return sha256(JSON.stringify([
    input.playerId,
    input.slot,
    input.expectedRevision,
    input.schemaVersion,
    input.snapshot,
    input.deviceIdHash,
  ]));
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
