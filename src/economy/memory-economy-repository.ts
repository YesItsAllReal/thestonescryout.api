import { randomUUID } from "node:crypto";

import {
  EconomyIdempotencyConflictError,
  EconomyInsufficientFundsError,
  EconomyNotFoundError,
  type EconomyApplyResult,
  type EconomyBalance,
  type EconomyRepository,
  type EconomyResource,
  type LedgerEntry,
} from "./economy-service.js";

interface StoredOperation {
  readonly fingerprint: string;
  readonly result: EconomyApplyResult;
}

export class MemoryEconomyRepository implements EconomyRepository {
  private readonly balances = new Map<string, EconomyBalance>();
  private readonly operations = new Map<string, StoredOperation>();
  private readonly grants = new Map<string, EconomyApplyResult>();
  private readonly ledgerByPlayer = new Map<string, readonly LedgerEntry[]>();

  public seed(playerId: string, balance: EconomyBalance): void {
    this.balances.set(playerId, freezeBalance(balance));
  }

  public ledger(playerId: string): readonly LedgerEntry[] {
    return this.ledgerByPlayer.get(playerId) ?? [];
  }

  public async getBalance(playerId: string, _now: Date): Promise<EconomyBalance> {
    const balance = this.balances.get(playerId);
    if (balance === undefined) throw new EconomyNotFoundError("economy balance was not found");
    return balance;
  }

  public async applyAtomically(
    input: Parameters<EconomyRepository["applyAtomically"]>[0],
  ): Promise<EconomyApplyResult> {
    const operationKey = `${input.playerId}\u0000${input.idempotencyKey}`;
    const replay = this.operations.get(operationKey);
    if (replay !== undefined) {
      if (replay.fingerprint !== input.requestFingerprint) {
        throw new EconomyIdempotencyConflictError("idempotency key was reused for another economy operation");
      }
      return replay.result;
    }
    if (input.uniqueGrantKey !== undefined) {
      const grant = this.grants.get(`${input.playerId}\u0000${input.uniqueGrantKey}`);
      if (grant !== undefined) {
        this.operations.set(operationKey, { fingerprint: input.requestFingerprint, result: grant });
        return grant;
      }
    }

    const current = this.balances.get(input.playerId);
    if (current === undefined) throw new EconomyNotFoundError("economy balance was not found");
    let result: EconomyApplyResult;
    if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
      result = { kind: "revisionConflict", currentRevision: current.revision };
    } else {
      const nextValues: Record<EconomyResource, number> = {
        coins: current.coins,
        gems: current.gems,
        energy: current.energy,
      };
      for (const mutation of input.mutations) {
        const next = nextValues[mutation.resource] + mutation.delta;
        if (!Number.isSafeInteger(next) || next < 0) {
          throw new EconomyInsufficientFundsError("economy mutation would produce an invalid balance");
        }
        nextValues[mutation.resource] = next;
      }

      const createdAt = input.now.toISOString();
      const entries = input.mutations.map((mutation) => Object.freeze({
        ledgerEntryId: randomUUID(),
        resource: mutation.resource,
        delta: mutation.delta,
        reasonCode: input.reasonCode,
        sourceReference: input.sourceReference,
        balanceAfter: nextValues[mutation.resource],
        createdAt,
        idempotencyKey: input.idempotencyKey,
        clientBuild: input.clientBuild,
        contentVersion: input.contentVersion,
      } satisfies LedgerEntry));
      const balance = freezeBalance({
        ...nextValues,
        energyUpdatedAt: input.mutations.some((mutation) => mutation.resource === "energy")
          ? createdAt
          : current.energyUpdatedAt,
        revision: current.revision + 1,
      });
      this.balances.set(input.playerId, balance);
      this.ledgerByPlayer.set(input.playerId, Object.freeze([...(this.ledgerByPlayer.get(input.playerId) ?? []), ...entries]));
      result = { kind: "applied", result: Object.freeze({ balance, ledgerEntries: Object.freeze(entries) }) };
    }
    this.operations.set(operationKey, { fingerprint: input.requestFingerprint, result });
    if (input.uniqueGrantKey !== undefined && result.kind === "applied") {
      this.grants.set(`${input.playerId}\u0000${input.uniqueGrantKey}`, result);
    }
    return result;
  }
}

function freezeBalance(balance: EconomyBalance): EconomyBalance {
  return Object.freeze({ ...balance });
}
