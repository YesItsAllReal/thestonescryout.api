import type { Entitlement, EntitlementRepository } from "./entitlement-service.js";

export class MemoryEntitlementRepository implements EntitlementRepository {
  private readonly entitlements = new Map<string, readonly Entitlement[]>();

  public seed(playerId: string, values: readonly Entitlement[]): void {
    this.entitlements.set(playerId, Object.freeze(values.map((value) => Object.freeze({ ...value }))));
  }

  public async listByPlayerId(playerId: string): Promise<readonly Entitlement[]> {
    return this.entitlements.get(playerId) ?? [];
  }
}
