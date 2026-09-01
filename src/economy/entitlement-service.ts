import type { AuthenticatedPrincipal } from "../auth/authentication.js";

export interface Entitlement {
  readonly productId: string;
  readonly state: "active" | "revoked" | "refunded";
  readonly purchasedAt: string;
  readonly environment: "sandbox" | "production";
}

export interface EntitlementRepository {
  listByPlayerId(playerId: string): Promise<readonly Entitlement[]>;
}

export class EntitlementService {
  public constructor(private readonly repository: EntitlementRepository) {}

  public async list(principal: AuthenticatedPrincipal): Promise<readonly Entitlement[]> {
    return this.repository.listByPlayerId(principal.playerId);
  }
}
