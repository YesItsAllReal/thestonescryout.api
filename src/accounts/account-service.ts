import type { AuthenticatedPrincipal } from "../auth/authentication.js";

export type LinkedProvider = "apple" | "google";

export interface AccountProfile {
  readonly playerId: string;
  readonly accountKind: "guest" | "apple" | "google";
  readonly displayName: string | null;
  readonly locale: string;
  readonly createdAt: string;
  readonly linkedProviders: readonly LinkedProvider[];
  readonly deletionState: "active" | "requested" | "processing";
}

export interface AccountDeletionProof {
  readonly provider: "apple";
  readonly identityToken: string;
  readonly nonce: string;
  readonly authorizationCode?: string | undefined;
}

export interface AccountDeletionRequest {
  readonly confirmation: "deleteAccount";
  readonly reauthentication?: AccountDeletionProof | undefined;
}

export interface AccountDeletionReceipt {
  readonly deletionState: "requested" | "processing";
  readonly requestedAt: string;
}

export interface AccountRepository {
  getByPlayerId(playerId: string): Promise<AccountProfile | undefined>;
  requestDeletionWithAudit(input: {
    readonly playerId: string;
    readonly idempotencyKey: string;
    readonly now: Date;
  }): Promise<AccountDeletionReceipt>;
}

export interface AccountDeletionAuthorizer {
  authorize(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly proof: AccountDeletionProof | undefined;
    readonly now: Date;
  }): Promise<void>;
}

export interface PlayerSessionRevoker {
  revokeAll(playerId: string): Promise<void>;
}

export class AccountNotFoundError extends Error {}
export class AccountDeletionValidationError extends Error {}
export class AccountDeletionAuthorizationError extends Error {}
export class AccountDeletionIdempotencyConflictError extends Error {}

export class AccountService {
  public constructor(
    private readonly repository: AccountRepository,
    private readonly deletionAuthorizer: AccountDeletionAuthorizer,
    private readonly sessionRevoker: PlayerSessionRevoker,
    private readonly now: () => Date,
  ) {}

  public async getProfile(principal: AuthenticatedPrincipal): Promise<AccountProfile> {
    const profile = await this.repository.getByPlayerId(principal.playerId);
    if (profile === undefined) throw new AccountNotFoundError("account was not found");
    return profile;
  }

  public async requestDeletion(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly request: AccountDeletionRequest;
    readonly idempotencyKey: string;
  }): Promise<AccountDeletionReceipt> {
    validateDeletionRequest(input.request, input.idempotencyKey);
    const timestamp = this.now();
    await this.deletionAuthorizer.authorize({
      principal: input.principal,
      proof: input.request.reauthentication,
      now: timestamp,
    });
    const receipt = await this.repository.requestDeletionWithAudit({
      playerId: input.principal.playerId,
      idempotencyKey: input.idempotencyKey,
      now: timestamp,
    });
    // The durable deletion request must exist before credentials are revoked so
    // a retry can resume cleanup even if revocation has a transient failure.
    await this.sessionRevoker.revokeAll(input.principal.playerId);
    return receipt;
  }
}

function validateDeletionRequest(request: AccountDeletionRequest, idempotencyKey: string): void {
  if (request.confirmation !== "deleteAccount") {
    throw new AccountDeletionValidationError("account deletion confirmation is invalid");
  }
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(idempotencyKey)) {
    throw new AccountDeletionValidationError("idempotency key is invalid");
  }
}
