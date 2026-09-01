import { randomUUID } from "node:crypto";

import {
  AccountDeletionIdempotencyConflictError,
  AccountNotFoundError,
  type AccountDeletionReceipt,
  type AccountProfile,
  type AccountRepository,
} from "./account-service.js";

interface StoredDeletion {
  readonly playerId: string;
  readonly receipt: AccountDeletionReceipt;
}

export interface AccountAuditEvent {
  readonly auditEventId: string;
  readonly playerId: string;
  readonly action: "ACCOUNT_DELETION_REQUESTED";
  readonly createdAt: string;
}

export class MemoryAccountRepository implements AccountRepository {
  private readonly profiles = new Map<string, AccountProfile>();
  private readonly deletionByKey = new Map<string, StoredDeletion>();
  public readonly auditEvents: AccountAuditEvent[] = [];

  public add(profile: AccountProfile): void {
    this.profiles.set(profile.playerId, profile);
  }

  public async getByPlayerId(playerId: string): Promise<AccountProfile | undefined> {
    return this.profiles.get(playerId);
  }

  public async requestDeletionWithAudit(
    input: Parameters<AccountRepository["requestDeletionWithAudit"]>[0],
  ): Promise<AccountDeletionReceipt> {
    const replay = this.deletionByKey.get(input.idempotencyKey);
    if (replay !== undefined) {
      if (replay.playerId !== input.playerId) {
        throw new AccountDeletionIdempotencyConflictError(
          "idempotency key was reused for another account",
        );
      }
      return replay.receipt;
    }
    const profile = this.profiles.get(input.playerId);
    if (profile === undefined) throw new AccountNotFoundError("account was not found");
    const requestedAt = input.now.toISOString();
    const receipt: AccountDeletionReceipt = {
      deletionState: profile.deletionState === "processing" ? "processing" : "requested",
      requestedAt,
    };
    this.profiles.set(input.playerId, { ...profile, deletionState: receipt.deletionState });
    this.auditEvents.push({
      auditEventId: randomUUID(),
      playerId: input.playerId,
      action: "ACCOUNT_DELETION_REQUESTED",
      createdAt: requestedAt,
    });
    this.deletionByKey.set(input.idempotencyKey, { playerId: input.playerId, receipt });
    return receipt;
  }
}
