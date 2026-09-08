import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

import {
  RefreshCredentialRejectedError,
  RefreshCredentialOwnershipMismatchError,
  type RefreshCredentialRegistry,
  type CognitoSessionGateway,
} from "./cognito-session-provider.js";

type DocumentClient = Pick<DynamoDBDocumentClient, "send">;

const RECORD_VERSION = 1;
const ENTITY_TYPE = "RefreshCredential";

interface StoredRecord {
  readonly recordVersion: number;
  readonly playerId: string;
  readonly status: "active" | "revoked";
  readonly expiresAtEpochSeconds: number;
}

export class DynamoRefreshRegistry implements RefreshCredentialRegistry {
  public constructor(
    private readonly client: DocumentClient,
    private readonly tableName: string,
    // Optional gateway reference used only for compensation on partial rotation
    // and partial registration.
    private readonly gateway?: Pick<CognitoSessionGateway, "revoke">,
  ) {
    if (tableName.trim() === "") throw new Error("DynamoDB table name is required");
  }

  public async register(input: {
    readonly credentialHash: string;
    readonly playerId: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<void> {
    assertHash(input.credentialHash);
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [{
          Put: {
            TableName: this.tableName,
            Item: {
              pk: pk(input.credentialHash),
              sk: "CREDENTIAL",
              entityType: ENTITY_TYPE,
              recordVersion: RECORD_VERSION,
              playerId: input.playerId,
              status: "active",
              createdAt: input.now.toISOString(),
              expiresAtEpochSeconds: toEpochSeconds(input.expiresAt),
              ttl: toEpochSeconds(input.expiresAt),
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        }],
      }));
    } catch (error) {
      if (!isConditionalConflict(error)) throw error;
      // A record for this hash already exists. Strongly read and verify it
      // belongs to the same player and is still active — never treat a hash
      // owned by another player as a valid idempotent replay.
      await this.verifyExistingRegistration(input.credentialHash, input.playerId, input.now);
    }
  }

  // Issue 3: replacementExpiresAt removed — the replacement inherits the
  // previous record's expiresAtEpochSeconds so rotation never extends the
  // session lifetime. Callers must not supply it.
  public async rotate(input: {
    readonly previousCredentialHash: string;
    readonly replacementCredentialHash: string;
    readonly now: Date;
    readonly replacementRawToken?: string;
  }): Promise<void> {
    assertHash(input.previousCredentialHash);
    assertHash(input.replacementCredentialHash);

    const previous = await this.readRequired(input.previousCredentialHash, input.now);

    // Replacement inherits the original family expiry — rotation does not
    // restart the lifetime. Cognito's rotated token also inherits the remaining
    // lifetime of the original token.
    const inheritedExpiresAtEpochSeconds = previous.expiresAtEpochSeconds;

    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            // Condition checks entityType, recordVersion, playerId,
            // expiresAtEpochSeconds, and active status — not just status alone.
            // This prevents a race where state changes between the read and write.
            Update: {
              TableName: this.tableName,
              Key: { pk: pk(input.previousCredentialHash), sk: "CREDENTIAL" },
              UpdateExpression: "SET #status = :revoked",
              ConditionExpression:
                "#status = :active" +
                " AND entityType = :entityType" +
                " AND recordVersion = :recordVersion" +
                " AND playerId = :playerId" +
                " AND expiresAtEpochSeconds = :expiresAt",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":revoked":       "revoked",
                ":active":        "active",
                ":entityType":    ENTITY_TYPE,
                ":recordVersion": RECORD_VERSION,
                ":playerId":      previous.playerId,
                ":expiresAt":     inheritedExpiresAtEpochSeconds,
              },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: {
                pk: pk(input.replacementCredentialHash),
                sk: "CREDENTIAL",
                entityType: ENTITY_TYPE,
                recordVersion: RECORD_VERSION,
                playerId: previous.playerId,
                status: "active",
                createdAt: input.now.toISOString(),
                expiresAtEpochSeconds: inheritedExpiresAtEpochSeconds,
                ttl: inheritedExpiresAtEpochSeconds,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }));
    } catch (error) {
      // Issue 1: best-effort revocation runs for EVERY failed rotation
      // transaction — including TransactionCanceledException — before the error
      // is mapped or rethrown. Cognito has already issued the replacement token
      // at this point; without compensation it remains valid but unregistered.
      if (input.replacementRawToken !== undefined && this.gateway !== undefined) {
        await this.gateway.revoke(input.replacementRawToken).catch(() => {
          // Revocation is best-effort — swallow errors here.
        });
      }
      if (isTransactionConflict(error)) {
        throw new RefreshCredentialRejectedError("refresh credential has already been rotated");
      }
      throw error;
    }
  }

  public async assertOwnedBy(input: {
    readonly credentialHash: string;
    readonly playerId: string;
    readonly now: Date;
  }): Promise<void> {
    assertHash(input.credentialHash);
    const record = await this.readRequired(input.credentialHash, input.now);
    if (record.playerId !== input.playerId) {
      throw new RefreshCredentialOwnershipMismatchError(
        "refresh credential belongs to a different player",
      );
    }
  }

  public async markRevoked(input: {
    readonly credentialHash: string;
    readonly now: Date;
  }): Promise<void> {
    assertHash(input.credentialHash);
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: pk(input.credentialHash), sk: "CREDENTIAL" },
        UpdateExpression: "SET #status = :revoked",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":revoked": "revoked" },
      }));
    } catch (error) {
      if (isConditionalConflict(error)) return;
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async verifyExistingRegistration(
    credentialHash: string,
    expectedPlayerId: string,
    now: Date,
  ): Promise<void> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: pk(credentialHash), sk: "CREDENTIAL" },
      ConsistentRead: true,
    }));
    const item = result.Item;
    if (item === undefined) {
      throw new RefreshCredentialRejectedError("refresh credential registration conflict could not be resolved");
    }
    if (item["recordVersion"] !== RECORD_VERSION || item["entityType"] !== ENTITY_TYPE) {
      throw new RefreshCredentialRejectedError("existing refresh credential record version is unsupported");
    }
    if (typeof item["playerId"] !== "string" || item["playerId"] !== expectedPlayerId) {
      throw new RefreshCredentialRejectedError("existing refresh credential belongs to a different player");
    }
    if (item["status"] !== "active") {
      throw new RefreshCredentialRejectedError("existing refresh credential is not active");
    }
    if (typeof item["expiresAtEpochSeconds"] !== "number" ||
        toEpochSeconds(now) >= item["expiresAtEpochSeconds"]) {
      throw new RefreshCredentialRejectedError("existing refresh credential has expired");
    }
  }

  private async readRequired(credentialHash: string, now: Date): Promise<StoredRecord> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: pk(credentialHash), sk: "CREDENTIAL" },
      ConsistentRead: true,
    }));

    const item = result.Item;
    if (item === undefined) {
      throw new RefreshCredentialRejectedError("refresh credential not found");
    }

    if (item["recordVersion"] !== RECORD_VERSION || item["entityType"] !== ENTITY_TYPE) {
      throw new RefreshCredentialRejectedError("refresh credential record version is unsupported");
    }

    if (
      typeof item["playerId"] !== "string" ||
      (item["status"] !== "active" && item["status"] !== "revoked") ||
      typeof item["expiresAtEpochSeconds"] !== "number"
    ) {
      throw new RefreshCredentialRejectedError("refresh credential record is malformed");
    }

    // TTL is used only for eventual cleanup. Authorization uses the explicit
    // expiry check here — never rely on TTL deletion having occurred.
    if (toEpochSeconds(now) >= item["expiresAtEpochSeconds"]) {
      throw new RefreshCredentialRejectedError("refresh credential has expired");
    }

    if (item["status"] === "revoked") {
      throw new RefreshCredentialRejectedError("refresh credential has been revoked");
    }

    return {
      recordVersion: item["recordVersion"],
      playerId:      item["playerId"],
      status:        item["status"],
      expiresAtEpochSeconds: item["expiresAtEpochSeconds"],
    };
  }
}

function pk(credentialHash: string): string {
  return `REFRESH#${credentialHash}`;
}

function assertHash(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("credential hash must be a 64-character lowercase hex SHA-256 digest");
  }
}

function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function isConditionalConflict(error: unknown): boolean {
  return isNamed(error, "ConditionalCheckFailedException");
}

function isTransactionConflict(error: unknown): boolean {
  return isNamed(error, "TransactionCanceledException");
}

function isNamed(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null &&
    (error as { name?: string }).name === name;
}
