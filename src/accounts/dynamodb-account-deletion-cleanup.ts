import { randomUUID } from "node:crypto";
import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { AccountDeletionCleanupRepository, AccountDeletionStep } from "./account-deletion-worker.js";

type Client = Pick<DynamoDBDocumentClient, "send">;
type Item = Record<string, unknown>;

/**
 * Deletes the player partition first, then performs a bounded table scan for
 * non-player-partition records carrying the playerId. This avoids a new index
 * for the initial low-volume environment; production should add an owner index
 * before deletion volume makes bounded full-table scans inappropriate.
 */
export class DynamoDbAccountDeletionCleanup implements AccountDeletionCleanupRepository {
  public constructor(
    private readonly client: Client,
    private readonly tableName: string,
    private readonly createRetentionId: () => string = randomUUID,
    private readonly completedJobTtlSeconds = 2_592_000,
  ) {
    if (tableName.trim() === "" || !Number.isSafeInteger(completedJobTtlSeconds) || completedJobTtlSeconds < 1) {
      throw new Error("deletion cleanup configuration is invalid");
    }
  }

  public async processNext(playerId: string, now: Date): Promise<AccountDeletionStep> {
    const job = await this.readJob(playerId);
    if (job.state === "completed") return "completed";
    const retentionId = typeof job.retentionId === "string" ? job.retentionId : this.createRetentionId();

    const playerPage = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `PLAYER#${playerId}` },
      Limit: 1,
      ConsistentRead: true,
    })) as { Items?: Item[] };
    const playerItem = playerPage.Items?.[0];
    if (playerItem !== undefined) {
      await this.deletePlayerItem(playerId, job, playerItem, retentionId, now);
      return "progressed";
    }

    const hasProviderKey = typeof job.providerMappingPk === "string" && typeof job.providerMappingSk === "string";
    const external = await this.client.send(new ScanCommand({
      TableName: this.tableName,
      ExclusiveStartKey: validCursor(job.scanCursor) ? job.scanCursor : undefined,
      FilterExpression: "playerId = :playerId AND pk <> :playerPk AND pk <> :jobPk" +
        (hasProviderKey ? " AND NOT (pk = :providerPk AND sk = :providerSk)" : ""),
      ExpressionAttributeValues: {
        ":playerId": playerId,
        ":playerPk": `PLAYER#${playerId}`,
        ":jobPk": `DELETION#${playerId}`,
        ...(hasProviderKey ? { ":providerPk": job.providerMappingPk, ":providerSk": job.providerMappingSk } : {}),
      },
      Limit: 1,
      ConsistentRead: true,
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    const externalItem = external.Items?.[0];
    if (externalItem !== undefined) {
      await this.cleanExternalItem(playerId, job, externalItem, retentionId, external.LastEvaluatedKey, now);
      return "progressed";
    }
    if (external.LastEvaluatedKey !== undefined) {
      await this.advanceCursor(playerId, job, retentionId, external.LastEvaluatedKey, now);
      return "progressed";
    }
    await this.complete(playerId, job, retentionId, now);
    return "completed";
  }

  private async readJob(playerId: string): Promise<Item> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: jobKey(playerId),
      ConsistentRead: true,
    })) as { Item?: Item };
    const item = result.Item;
    if (item === undefined || item.entityType !== "DeletionJob" || item.recordVersion !== 1 ||
        item.playerId !== playerId || (item.state !== "requested" && item.state !== "processing" && item.state !== "completed")) {
      throw new Error("deletion job is missing or invalid");
    }
    return item;
  }

  private async deletePlayerItem(playerId: string, job: Item, item: Item, retentionId: string, now: Date): Promise<void> {
    const key = itemKey(item);
    if (item.playerId !== playerId) throw new Error("player deletion record ownership is invalid");
    const actions: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [{
      Delete: {
        TableName: this.tableName,
        Key: key,
        ConditionExpression: "playerId = :playerId AND entityType = :entityType AND recordVersion = :version",
        ExpressionAttributeValues: { ":playerId": playerId, ":entityType": item.entityType, ":version": item.recordVersion },
      },
    }];
    if (item.entityType === "Player" && typeof item.installationIdHash === "string") {
      actions.push({ Delete: {
        TableName: this.tableName,
        Key: { pk: `INSTALLATION#${item.installationIdHash}`, sk: "PLAYER" },
        ConditionExpression: "playerId = :playerId AND entityType = :type",
        ExpressionAttributeValues: { ":playerId": playerId, ":type": "InstallationMapping" },
      } });
    }
    actions.push(jobProgress(this.tableName, playerId, job, retentionId, now));
    await this.client.send(new TransactWriteCommand({ TransactItems: actions }));
  }

  private async cleanExternalItem(
    playerId: string,
    job: Item,
    item: Item,
    retentionId: string,
    cursor: Record<string, unknown> | undefined,
    now: Date,
  ): Promise<void> {
    const key = itemKey(item);
    const retained = new Set(["PurchaseTransaction", "AdCompletion", "OfflineGrantClaim", "EconomyGrantClaim"]);
    const deletable = new Set(["RefreshCredential", "Idempotency", "InstallationMapping", "ProviderMapping"]);
    if (!retained.has(String(item.entityType)) && !deletable.has(String(item.entityType))) {
      throw new Error("unsupported player-owned record blocks deletion");
    }
    const mutation = retained.has(String(item.entityType)) ? {
      Update: {
        TableName: this.tableName,
        Key: key,
        UpdateExpression: "SET retentionId = :retentionId, anonymizedAt = :at REMOVE playerId, #result",
        ConditionExpression: "playerId = :playerId AND entityType = :entityType AND recordVersion = :version",
        ExpressionAttributeNames: { "#result": "result" },
        ExpressionAttributeValues: {
          ":retentionId": retentionId, ":at": now.toISOString(), ":playerId": playerId,
          ":entityType": item.entityType, ":version": item.recordVersion,
        },
      },
    } : {
      Delete: {
        TableName: this.tableName,
        Key: key,
        ConditionExpression: "playerId = :playerId AND entityType = :entityType AND recordVersion = :version",
        ExpressionAttributeValues: { ":playerId": playerId, ":entityType": item.entityType, ":version": item.recordVersion },
      },
    };
    await this.client.send(new TransactWriteCommand({ TransactItems: [
      mutation,
      jobProgress(this.tableName, playerId, job, retentionId, now, cursor),
    ] }));
  }

  private async advanceCursor(playerId: string, job: Item, retentionId: string, cursor: Record<string, unknown>, now: Date): Promise<void> {
    await this.client.send(new TransactWriteCommand({ TransactItems: [
      jobProgress(this.tableName, playerId, job, retentionId, now, cursor),
    ] }));
  }

  private async complete(playerId: string, job: Item, retentionId: string, now: Date): Promise<void> {
    const actions: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [];
    if (typeof job.providerMappingPk === "string" && typeof job.providerMappingSk === "string") {
      actions.push({ Delete: {
        TableName: this.tableName,
        Key: { pk: job.providerMappingPk, sk: job.providerMappingSk },
        ConditionExpression: "playerId = :playerId AND entityType = :type",
        ExpressionAttributeValues: { ":playerId": playerId, ":type": "ProviderMapping" },
      } });
    }
    actions.push({ Update: {
      TableName: this.tableName,
      Key: jobKey(playerId),
      UpdateExpression: "SET #state = :completed, retentionId = :retentionId, completedAt = :at, ttl = :ttl REMOVE scanCursor, providerMappingPk, providerMappingSk",
      ConditionExpression: "entityType = :type AND recordVersion = :version AND playerId = :playerId AND (#state = :requested OR #state = :processing)",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: {
        ":completed": "completed", ":retentionId": retentionId, ":at": now.toISOString(),
        ":ttl": Math.floor(now.getTime() / 1000) + this.completedJobTtlSeconds,
        ":type": "DeletionJob", ":version": 1, ":playerId": playerId,
        ":requested": "requested", ":processing": "processing",
      },
    } });
    await this.client.send(new TransactWriteCommand({ TransactItems: actions }));
  }
}

function jobProgress(tableName: string, playerId: string, job: Item, retentionId: string, now: Date, cursor?: Record<string, unknown>) {
  return { Update: {
    TableName: tableName,
    Key: jobKey(playerId),
    UpdateExpression: cursor === undefined
      ? "SET #state = :processing, retentionId = :retentionId, updatedAt = :at REMOVE scanCursor"
      : "SET #state = :processing, retentionId = :retentionId, updatedAt = :at, scanCursor = :cursor",
    ConditionExpression: "entityType = :type AND recordVersion = :version AND playerId = :playerId AND (#state = :expected OR #state = :processing)" +
      (typeof job.retentionId === "string" ? " AND retentionId = :retentionId" : " AND attribute_not_exists(retentionId)"),
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: {
      ":processing": "processing", ":expected": job.state, ":retentionId": retentionId,
      ":at": now.toISOString(), ":type": "DeletionJob", ":version": 1, ":playerId": playerId,
      ...(cursor === undefined ? {} : { ":cursor": cursor }),
    },
  } };
}

function jobKey(playerId: string) { return { pk: `DELETION#${playerId}`, sk: "REQUEST" }; }
function itemKey(item: Item): Record<string, string> {
  if (typeof item.pk !== "string" || typeof item.sk !== "string" || typeof item.entityType !== "string" || item.recordVersion !== 1) {
    throw new Error("deletion target record is invalid");
  }
  return { pk: item.pk, sk: item.sk };
}
function validCursor(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
