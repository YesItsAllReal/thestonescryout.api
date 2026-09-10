import { createHash, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AccountIdempotencyConflictError, type AppleAccountRepository } from "./apple-account-service.js";
import type { PlayerProfile } from "./guest-session-service.js";
import { providerIdentityKey } from "./provider-identity-key.js";
import type { GuestStartingBalance } from "./dynamodb-guest-player-repository.js";

type Client = Pick<DynamoDBDocumentClient, "send">;
type Input = Parameters<AppleAccountRepository["signInOrCreate"]>[0];

export class DynamoDbAppleSignInRepository implements Pick<AppleAccountRepository, "signInOrCreate"> {
  public constructor(
    private readonly client: Client,
    private readonly tableName: string,
    private readonly createPlayerId: () => string = randomUUID,
    private readonly idempotencyTtlSeconds = 86_400,
    private readonly startingBalance:GuestStartingBalance={coins:0,gems:0,energy:0},
  ) {}

  public async signInOrCreate(input: Input): Promise<PlayerProfile> {
    const requestHash = sha256(JSON.stringify([input.issuer, input.subject]));
    const idempotencyKey = { pk: `IDEMPOTENCY#APPLE_SIGN_IN#${sha256(input.idempotencyKey)}`, sk: "RESULT" };
    const replay = await this.readReplay(idempotencyKey);
    if (replay !== undefined) return this.resolveReplay(replay, requestHash);

    const providerKey = providerIdentityKey(input.issuer, input.subject);
    const existingId = await this.readProvider(providerKey);
    if (existingId !== undefined) {
      await this.claimReplay(idempotencyKey, input, requestHash, existingId);
      return this.readPlayer(existingId);
    }

    const player: PlayerProfile = {
      playerId: this.createPlayerId(), accountKind: "apple",
      createdAt: input.now.toISOString(), deletionState: "active",
    };
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.tableName, Item: {
          pk: `PLAYER#${player.playerId}`, sk: "PROFILE", entityType: "Player", recordVersion: 1, accountState: "active",
          ...player, displayName: null, locale: "und", linkedProviders: ["apple"],
        }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName:this.tableName,Item:{pk:`PLAYER#${player.playerId}`,sk:"BALANCE",entityType:"Balance",recordVersion:1,playerId:player.playerId,coins:this.startingBalance.coins,gems:this.startingBalance.gems,energy:this.startingBalance.energy,originCoins:this.startingBalance.coins,originGems:this.startingBalance.gems,originEnergy:this.startingBalance.energy,energyUpdatedAt:input.now.toISOString(),revision:1},ConditionExpression:"attribute_not_exists(pk) AND attribute_not_exists(sk)"}},
        { Put: { TableName: this.tableName, Item: {
          ...providerKey, entityType: "ProviderMapping", recordVersion: 1,
          provider: "apple", playerId: player.playerId,
        }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: this.tableName, Item: replayItem(idempotencyKey, input, requestHash, player.playerId, this.idempotencyTtlSeconds), ConditionExpression: "attribute_not_exists(pk)" } },
      ] }));
      return player;
    } catch (error: unknown) {
      if (!isConditionalCancellation(error)) throw error;
      const winner = await this.readReplay(idempotencyKey);
      if (winner !== undefined) return this.resolveReplay(winner, requestHash);
      const playerId = await this.readProvider(providerKey);
      if (playerId === undefined) throw new Error("Apple sign-in transaction cancelled without a durable winner");
      await this.claimReplay(idempotencyKey, input, requestHash, playerId);
      return this.readPlayer(playerId);
    }
  }

  private async readReplay(key: Record<string, string>): Promise<{ requestHash: string; playerId: string } | undefined> {
    const response = await this.client.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }));
    const item = response.Item;
    if (item === undefined) return undefined;
    if (item.entityType !== "Idempotency" || item.operation !== "apple.signIn" || item.recordVersion !== 1 ||
        typeof item.requestHash !== "string" || typeof item.playerId !== "string") throw new Error("stored Apple sign-in replay is invalid");
    return { requestHash: item.requestHash, playerId: item.playerId };
  }

  private resolveReplay(replay: { requestHash: string; playerId: string }, requestHash: string): Promise<PlayerProfile> {
    if (replay.requestHash !== requestHash) throw new AccountIdempotencyConflictError("idempotency key was reused for different input");
    return this.readPlayer(replay.playerId);
  }

  private async readProvider(key: { pk: string; sk: string }): Promise<string | undefined> {
    const response = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: key.pk, sk: key.sk }, ConsistentRead: true }));
    if (response.Item === undefined) return undefined;
    if (response.Item.entityType !== "ProviderMapping" || response.Item.recordVersion !== 1 || typeof response.Item.playerId !== "string") throw new Error("stored provider mapping is invalid");
    return response.Item.playerId;
  }

  private async readPlayer(playerId: string): Promise<PlayerProfile> {
    const response = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: `PLAYER#${playerId}`, sk: "PROFILE" }, ConsistentRead: true }));
    const item = response.Item;
    if (item?.entityType !== "Player" || item.recordVersion !== 1 || item.playerId !== playerId ||
        (item.accountState !== undefined && item.accountState !== "active") ||
        (item.accountKind !== "apple" && item.accountKind !== "google" && item.accountKind !== "guest") ||
        typeof item.createdAt !== "string" || (item.deletionState !== "active" && item.deletionState !== "requested" && item.deletionState !== "processing")) throw new Error("stored player is invalid");
    return { playerId, accountKind: item.accountKind, createdAt: item.createdAt, deletionState: item.deletionState };
  }

  private async claimReplay(key: Record<string, string>, input: Input, requestHash: string, playerId: string): Promise<void> {
    try {
      await this.client.send(new PutCommand({ TableName: this.tableName, Item: replayItem(key, input, requestHash, playerId, this.idempotencyTtlSeconds), ConditionExpression: "attribute_not_exists(pk)" }));
    } catch (error: unknown) {
      if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
      const replay = await this.readReplay(key);
      if (replay === undefined) throw new Error("Apple sign-in replay claim failed without a winner");
      await this.resolveReplay(replay, requestHash);
    }
  }
}

function replayItem(key: Record<string, string>, input: Input, requestHash: string, playerId: string, ttl: number) {
  return { ...key, entityType: "Idempotency", recordVersion: 1, operation: "apple.signIn", scope: "apple-sign-in", requestHash, playerId,
    status: "completed", createdAt: input.now.toISOString(), expiresAtEpochSeconds: Math.floor(input.now.getTime() / 1000) + ttl };
}
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function isConditionalCancellation(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return false;
  return (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed") ?? false;
}
