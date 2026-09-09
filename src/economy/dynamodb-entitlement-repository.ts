import { QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Entitlement, EntitlementRepository } from "./entitlement-service.js";

type Client = Pick<DynamoDBDocumentClient, "send">;

export class DynamoDbEntitlementRepository implements EntitlementRepository {
  public constructor(
    private readonly client: Client,
    private readonly tableName: string,
  ) {
    if (tableName.trim() === "") throw new Error("DynamoDB table name is required");
  }

  public async listByPlayerId(playerId: string): Promise<readonly Entitlement[]> {
    if (!isUuid(playerId)) throw new Error("player ID is invalid");
    const pk = `PLAYER#${playerId}`;
    const values: Entitlement[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const response = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        ConsistentRead: true,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": "ENTITLEMENT#" },
        ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
      }));
      for (const item of response.Items ?? []) values.push(readEntitlement(item, pk, playerId));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);

    return Object.freeze(values.sort((left, right) => left.productId.localeCompare(right.productId)));
  }
}

function readEntitlement(item: Record<string, unknown>, pk: string, playerId: string): Entitlement {
  if (
    item.pk !== pk || item.entityType !== "Entitlement" || item.recordVersion !== 1 ||
    item.playerId !== playerId || typeof item.productId !== "string" ||
    item.productId.length < 1 || item.productId.length > 255 ||
    item.sk !== `ENTITLEMENT#${item.productId}` ||
    (item.state !== "active" && item.state !== "revoked" && item.state !== "refunded") ||
    (item.environment !== "sandbox" && item.environment !== "production") ||
    typeof item.purchasedAt !== "string" || !isIsoInstant(item.purchasedAt)
  ) throw new Error("stored entitlement is invalid");
  return Object.freeze({
    productId: item.productId,
    state: item.state,
    purchasedAt: item.purchasedAt,
    environment: item.environment,
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isIsoInstant(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
