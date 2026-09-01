import { randomUUID } from "node:crypto";

import {
  CommerceIdempotencyConflictError,
  CommerceOwnershipError,
  type CommerceGrantResult,
  type CommerceNotificationResult,
  type CommerceRepository,
} from "./commerce-service.js";
import { EconomyInsufficientFundsError, EconomyNotFoundError, type EconomyBalance, type EconomyReason, type LedgerEntry, type ResourceMutation } from "../economy/economy-service.js";
import type { Entitlement } from "../economy/entitlement-service.js";

interface StoredGrant {
  readonly playerId: string;
  readonly result: CommerceGrantResult;
  readonly productId?: string | undefined;
}

interface StoredOperation {
  readonly fingerprint: string;
  readonly result: CommerceGrantResult;
}

export class MemoryCommerceRepository implements CommerceRepository {
  private readonly balances = new Map<string, EconomyBalance>();
  private readonly ledgerByPlayer = new Map<string, readonly LedgerEntry[]>();
  private readonly entitlementsByPlayer = new Map<string, Map<string, Entitlement>>();
  private readonly transactions = new Map<string, StoredGrant>();
  private readonly adEvents = new Map<string, StoredGrant>();
  private readonly operations = new Map<string, StoredOperation>();
  private readonly notifications = new Map<string, CommerceNotificationResult>();

  public seedBalance(playerId: string, balance: EconomyBalance): void {
    this.balances.set(playerId, Object.freeze({ ...balance }));
  }

  public balance(playerId: string): EconomyBalance | undefined { return this.balances.get(playerId); }
  public ledger(playerId: string): readonly LedgerEntry[] { return this.ledgerByPlayer.get(playerId) ?? []; }
  public entitlement(playerId: string, productId: string): Entitlement | undefined {
    return this.entitlementsByPlayer.get(playerId)?.get(productId);
  }

  public async processPurchaseAtomically(
    input: Parameters<CommerceRepository["processPurchaseAtomically"]>[0],
  ): Promise<CommerceGrantResult> {
    const fingerprint = JSON.stringify([input.transaction.environment, input.transaction.transactionId, input.transaction.productId]);
    const operationKey = `${input.playerId}\u0000${input.idempotencyKey}`;
    const replay = this.replay(operationKey, fingerprint);
    if (replay !== undefined) return replay;

    const transactionKey = `${input.transaction.environment}\u0000${input.transaction.transactionId}`;
    const existing = this.transactions.get(transactionKey);
    if (existing !== undefined) {
      if (existing.playerId !== input.playerId) throw new CommerceOwnershipError("transaction was already claimed by another player");
      const duplicate = { ...existing.result, status: "duplicate", balance: this.requiredBalance(input.playerId) } as const;
      this.operations.set(operationKey, { fingerprint, result: duplicate });
      return duplicate;
    }

    const entitlement = input.product.kind === "nonConsumable"
      ? Object.freeze({
          productId: input.product.productId,
          state: "active",
          purchasedAt: input.transaction.purchasedAt,
          environment: input.transaction.environment,
        } satisfies Entitlement)
      : undefined;
    const result = this.applyGrant({
      playerId: input.playerId,
      mutations: input.product.grants,
      reasonCode: "IAP_GRANT",
      sourceReference: input.transaction.transactionId,
      idempotencyKey: input.idempotencyKey,
      clientBuild: input.clientBuild,
      contentVersion: input.contentVersion,
      entitlement,
      now: input.now,
    });
    this.transactions.set(transactionKey, { playerId: input.playerId, result, productId: input.product.productId });
    this.operations.set(operationKey, { fingerprint, result });
    return result;
  }

  public async processNotificationAtomically(
    input: Parameters<CommerceRepository["processNotificationAtomically"]>[0],
  ): Promise<CommerceNotificationResult> {
    const notificationKey = `${input.notification.environment}\u0000${input.notification.notificationId}`;
    const replay = this.notifications.get(notificationKey);
    if (replay !== undefined) return { ...replay, status: "duplicate" };
    const transaction = this.transactions.get(`${input.notification.environment}\u0000${input.notification.transactionId}`);
    const transactionState = input.notification.notificationType === "REFUND" ? "refunded" : "revoked";
    let result: CommerceNotificationResult;
    if (transaction === undefined || transaction.productId !== input.notification.productId) {
      result = { status: "ignored", transactionState };
    } else {
      const current = this.entitlement(transaction.playerId, input.notification.productId);
      const entitlement = current === undefined ? undefined : Object.freeze({ ...current, state: transactionState });
      if (entitlement !== undefined) {
        this.entitlementsByPlayer.get(transaction.playerId)?.set(entitlement.productId, entitlement);
      }
      result = { status: "applied", transactionState, ...(entitlement === undefined ? {} : { entitlement }) };
    }
    this.notifications.set(notificationKey, result);
    return result;
  }

  public async processAdRewardAtomically(
    input: Parameters<CommerceRepository["processAdRewardAtomically"]>[0],
  ): Promise<CommerceGrantResult> {
    const fingerprint = JSON.stringify([input.completion.provider, input.completion.providerEventId, input.completion.claimId]);
    const operationKey = `${input.playerId}\u0000${input.idempotencyKey}`;
    const replay = this.replay(operationKey, fingerprint);
    if (replay !== undefined) return replay;
    const eventKey = `${input.completion.provider}\u0000${input.completion.providerEventId}`;
    const existing = this.adEvents.get(eventKey);
    if (existing !== undefined) {
      if (existing.playerId !== input.playerId) throw new CommerceOwnershipError("ad event was already claimed by another player");
      const duplicate = { ...existing.result, status: "duplicate", balance: this.requiredBalance(input.playerId) } as const;
      this.operations.set(operationKey, { fingerprint, result: duplicate });
      return duplicate;
    }
    const result = this.applyGrant({
      playerId: input.playerId,
      mutations: input.mutations,
      reasonCode: "AD_REWARD",
      sourceReference: input.completion.providerEventId,
      idempotencyKey: input.idempotencyKey,
      clientBuild: input.clientBuild,
      contentVersion: input.contentVersion,
      now: input.now,
    });
    this.adEvents.set(eventKey, { playerId: input.playerId, result });
    this.operations.set(operationKey, { fingerprint, result });
    return result;
  }

  private replay(operationKey: string, fingerprint: string): CommerceGrantResult | undefined {
    const replay = this.operations.get(operationKey);
    if (replay === undefined) return undefined;
    if (replay.fingerprint !== fingerprint) throw new CommerceIdempotencyConflictError("idempotency key was reused for another commerce operation");
    return replay.result;
  }

  private applyGrant(input: {
    readonly playerId: string;
    readonly mutations: readonly ResourceMutation[];
    readonly reasonCode: EconomyReason;
    readonly sourceReference: string;
    readonly idempotencyKey: string;
    readonly clientBuild: number;
    readonly contentVersion: string;
    readonly entitlement?: Entitlement | undefined;
    readonly now: Date;
  }): CommerceGrantResult {
    const current = this.requiredBalance(input.playerId);
    const next = { coins: current.coins, gems: current.gems, energy: current.energy };
    for (const mutation of input.mutations) {
      const value = next[mutation.resource] + mutation.delta;
      if (!Number.isSafeInteger(value) || value < 0) throw new EconomyInsufficientFundsError("commerce grant produced an invalid balance");
      next[mutation.resource] = value;
    }
    const createdAt = input.now.toISOString();
    const entries = input.mutations.map((mutation) => Object.freeze({
      ledgerEntryId: randomUUID(),
      resource: mutation.resource,
      delta: mutation.delta,
      reasonCode: input.reasonCode,
      sourceReference: input.sourceReference,
      balanceAfter: next[mutation.resource],
      createdAt,
      idempotencyKey: input.idempotencyKey,
      clientBuild: input.clientBuild,
      contentVersion: input.contentVersion,
    } satisfies LedgerEntry));
    const balance = input.mutations.length === 0 ? current : Object.freeze({
      ...next,
      energyUpdatedAt: input.mutations.some((value) => value.resource === "energy") ? createdAt : current.energyUpdatedAt,
      revision: current.revision + 1,
    });
    if (input.mutations.length > 0) {
      this.balances.set(input.playerId, balance);
      this.ledgerByPlayer.set(input.playerId, Object.freeze([...(this.ledgerByPlayer.get(input.playerId) ?? []), ...entries]));
    }
    if (input.entitlement !== undefined) {
      const playerEntitlements = this.entitlementsByPlayer.get(input.playerId) ?? new Map<string, Entitlement>();
      playerEntitlements.set(input.entitlement.productId, input.entitlement);
      this.entitlementsByPlayer.set(input.playerId, playerEntitlements);
    }
    return Object.freeze({
      status: "granted",
      balance,
      ledgerEntries: Object.freeze(entries),
      ...(input.entitlement === undefined ? {} : { entitlement: input.entitlement }),
    });
  }

  private requiredBalance(playerId: string): EconomyBalance {
    const value = this.balances.get(playerId);
    if (value === undefined) throw new EconomyNotFoundError("economy balance was not found");
    return value;
  }
}
