import { createHash, randomUUID } from "node:crypto";

import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

import {
  GuestSessionIdempotencyConflictError,
  type GuestPlayerRepository,
  type PlayerProfile,
} from "./guest-session-service.js";

type DocumentClient = Pick<DynamoDBDocumentClient, "send">;
type GuestInput = Parameters<GuestPlayerRepository["findOrCreateGuest"]>[0];

interface StoredIdempotency {
  readonly requestHash: string;
  readonly playerId: string;
}
export interface GuestStartingBalance { readonly coins:number;readonly gems:number;readonly energy:number }

export class DynamoDbGuestPlayerRepository implements GuestPlayerRepository {
  public constructor(
    private readonly client: DocumentClient,
    private readonly tableName: string,
    private readonly createPlayerId: () => string = randomUUID,
    private readonly idempotencyTtlSeconds = 86_400,
    private readonly startingBalance: GuestStartingBalance = { coins:0, gems:0, energy:0 },
  ) {
    if (tableName.trim() === "") throw new Error("DynamoDB table name is required");
    if (!Number.isSafeInteger(idempotencyTtlSeconds) || idempotencyTtlSeconds < 1) {
      throw new Error("idempotency TTL must be a positive integer");
    }
  }

  public async findOrCreateGuest(input: GuestInput): Promise<PlayerProfile> {
    const requestHash = hashRequest(input);
    const idempotencyKey = keyForIdempotency(input.idempotencyKey);
    const replay = await this.readIdempotency(idempotencyKey.pk, idempotencyKey.sk);
    if (replay !== undefined) return this.resolveReplay(replay, requestHash);

    const installation = await this.readInstallation(input.installationIdHash);
    if (installation !== undefined) {
      await this.claimIdempotency(input, requestHash, installation);
      return this.readPlayerRequired(installation);
    }

    const player: PlayerProfile = {
      playerId: this.createPlayerId(),
      accountKind: "guest",
      createdAt: input.now.toISOString(),
      deletionState: "active",
    };

    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: playerItem(player, input),
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: balanceItem(player.playerId, input.now, this.startingBalance),
              ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: installationItem(input.installationIdHash, player.playerId),
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: idempotencyItem(idempotencyKey, input, requestHash, player.playerId, this.idempotencyTtlSeconds),
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }));
      return player;
    } catch (error: unknown) {
      if (!isTransactionConflict(error)) throw error;
      return this.recoverAfterConflict(input, requestHash, idempotencyKey);
    }
  }

  private async recoverAfterConflict(
    input: GuestInput,
    requestHash: string,
    idempotencyKey: { readonly pk: string; readonly sk: string },
  ): Promise<PlayerProfile> {
    const replay = await this.readIdempotency(idempotencyKey.pk, idempotencyKey.sk);
    if (replay !== undefined) return this.resolveReplay(replay, requestHash);

    const playerId = await this.readInstallation(input.installationIdHash);
    if (playerId === undefined) throw new Error("guest creation transaction was cancelled without a recoverable winner");
    await this.claimIdempotency(input, requestHash, playerId);
    return this.readPlayerRequired(playerId);
  }

  private async claimIdempotency(input: GuestInput, requestHash: string, playerId: string): Promise<void> {
    const key = keyForIdempotency(input.idempotencyKey);
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: idempotencyItem(key, input, requestHash, playerId, this.idempotencyTtlSeconds),
        ConditionExpression: "attribute_not_exists(pk)",
      }));
    } catch (error: unknown) {
      if (!isConditionalConflict(error)) throw error;
      const replay = await this.readIdempotency(key.pk, key.sk);
      if (replay === undefined) throw new Error("idempotency claim failed without a stored winner");
      await this.resolveReplay(replay, requestHash);
    }
  }

  private async resolveReplay(replay: StoredIdempotency, requestHash: string): Promise<PlayerProfile> {
    if (replay.requestHash !== requestHash) {
      throw new GuestSessionIdempotencyConflictError("idempotency key was reused for a different request");
    }
    return this.readPlayerRequired(replay.playerId);
  }

  private async readIdempotency(pk: string, sk: string): Promise<StoredIdempotency | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk, sk },
      ConsistentRead: true,
    }));
    const item = result.Item;
    if (item === undefined) return undefined;
    if (item.entityType !== "Idempotency" || typeof item.requestHash !== "string" || typeof item.playerId !== "string") {
      throw new Error("stored guest idempotency record is invalid");
    }
    return { requestHash: item.requestHash, playerId: item.playerId };
  }

  private async readInstallation(installationIdHash: string): Promise<string | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: `INSTALLATION#${installationIdHash}`, sk: "PLAYER" },
      ConsistentRead: true,
    }));
    if (result.Item === undefined) return undefined;
    if (result.Item.entityType !== "InstallationMapping" || typeof result.Item.playerId !== "string") {
      throw new Error("stored installation mapping is invalid");
    }
    return result.Item.playerId;
  }

  private async readPlayerRequired(playerId: string): Promise<PlayerProfile> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: `PLAYER#${playerId}`, sk: "PROFILE" },
      ConsistentRead: true,
    }));
    const item = result.Item;
    if (item === undefined || item.entityType !== "Player" || item.playerId !== playerId ||
        (item.accountKind !== "guest" && item.accountKind !== "apple" && item.accountKind !== "google") ||
        typeof item.createdAt !== "string" ||
        (item.deletionState !== "active" && item.deletionState !== "requested" && item.deletionState !== "processing")) {
      throw new Error("stored player profile is invalid");
    }
    return {
      playerId,
      accountKind: item.accountKind,
      createdAt: item.createdAt,
      deletionState: item.deletionState,
    };
  }
}

function balanceItem(playerId:string,now:Date,balance:GuestStartingBalance):Record<string,unknown>{
  for(const value of [balance.coins,balance.gems,balance.energy])if(!Number.isSafeInteger(value)||value<0)throw new Error("guest starting balance is invalid");
  return{pk:`PLAYER#${playerId}`,sk:"BALANCE",entityType:"Balance",recordVersion:1,playerId,coins:balance.coins,gems:balance.gems,energy:balance.energy,energyUpdatedAt:now.toISOString(),revision:1};
}

function playerItem(player: PlayerProfile, input: GuestInput): Record<string, unknown> {
  return {
    pk: `PLAYER#${player.playerId}`,
    sk: "PROFILE",
    entityType: "Player",
    recordVersion: 1,
    ...player,
    locale: input.locale,
    lastSeenBuild: input.appBuild,
    platform: input.platform,
  };
}

function installationItem(installationIdHash: string, playerId: string): Record<string, unknown> {
  return {
    pk: `INSTALLATION#${installationIdHash}`,
    sk: "PLAYER",
    entityType: "InstallationMapping",
    recordVersion: 1,
    playerId,
  };
}

function idempotencyItem(
  key: { readonly pk: string; readonly sk: string },
  input: GuestInput,
  requestHash: string,
  playerId: string,
  ttlSeconds: number,
): Record<string, unknown> {
  return {
    ...key,
    entityType: "Idempotency",
    recordVersion: 1,
    operation: "guestSession.create",
    scope: "guest",
    requestHash,
    playerId,
    status: "completed",
    createdAt: input.now.toISOString(),
    expiresAtEpochSeconds: Math.floor(input.now.getTime() / 1000) + ttlSeconds,
  };
}

function keyForIdempotency(idempotencyKey: string): { readonly pk: string; readonly sk: string } {
  return { pk: `IDEMPOTENCY#GUEST#${sha256(idempotencyKey)}`, sk: "RESULT" };
}

function hashRequest(input: GuestInput): string {
  return sha256(JSON.stringify([
    input.installationIdHash,
    input.locale,
    input.appBuild,
    input.platform,
  ]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isTransactionConflict(error: unknown): boolean {
  return error instanceof Error && error.name === "TransactionCanceledException";
}

function isConditionalConflict(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}
