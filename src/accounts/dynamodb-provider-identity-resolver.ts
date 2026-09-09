import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import type { ProviderIdentityOwnershipResolver } from "./apple-deletion-authorizer.js";
import { providerIdentityKey } from "./provider-identity-key.js";

type DocumentClient = Pick<DynamoDBDocumentClient, "send">;

export class DynamoDbProviderIdentityOwnershipResolver implements ProviderIdentityOwnershipResolver {
  public constructor(
    private readonly client: DocumentClient,
    private readonly tableName: string,
  ) {
    if (tableName.trim() === "") throw new Error("DynamoDB table name is required");
  }

  public async resolvePlayerId(input: {
    readonly issuer: string;
    readonly subject: string;
  }): Promise<string | undefined> {
    const key = providerIdentityKey(input.issuer, input.subject);
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: key.pk, sk: key.sk },
      ConsistentRead: true,
    }));
    const item = result.Item;
    if (item === undefined) return undefined;
    if (item["entityType"] !== "ProviderMapping" || item["recordVersion"] !== 1 ||
        item["provider"] !== "apple" || typeof item["playerId"] !== "string") {
      throw new Error("stored provider mapping is invalid");
    }
    return item["playerId"];
  }
}
