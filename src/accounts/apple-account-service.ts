import type { AuthenticatedPrincipal } from "../auth/authentication.js";
import type { PlayerProfile, SessionTokens, SessionTokenIssuer } from "./guest-session-service.js";

export interface AppleCredentialRequest {
  readonly identityToken: string;
  readonly nonce: string;
  readonly authorizationCode?: string | undefined;
}

export interface VerifiedAppleIdentity {
  readonly issuer: "https://appleid.apple.com";
  readonly subject: string;
}

export interface AppleIdentityVerifier {
  verify(credential: AppleCredentialRequest, now: Date): Promise<VerifiedAppleIdentity>;
}

export type LinkSaveChoice = "preferGuestSave" | "preferExistingSave";

export interface LinkResolution {
  readonly conflictId: string;
  readonly saveChoice: LinkSaveChoice;
}

export type AppleLinkResult =
  | { readonly kind: "linked"; readonly player: PlayerProfile }
  | {
      readonly kind: "decisionRequired";
      readonly conflictId: string;
      readonly guestPlayerId: string;
      readonly existingPlayerId: string;
    };

export interface AppleAccountRepository {
  signInOrCreate(input: {
    readonly issuer: string;
    readonly subject: string;
    readonly idempotencyKey: string;
    readonly now: Date;
  }): Promise<PlayerProfile>;

  linkGuest(input: {
    readonly guestPlayerId: string;
    readonly issuer: string;
    readonly subject: string;
    readonly idempotencyKey: string;
    readonly resolution?: LinkResolution | undefined;
    readonly now: Date;
  }): Promise<AppleLinkResult>;
}

export class AppleCredentialValidationError extends Error {}
export class AppleIdentityVerificationError extends Error {}
export class AccountLinkAuthorizationError extends Error {}
export class AccountLinkDecisionRequiredError extends Error {
  public constructor(
    public readonly conflictId: string,
    public readonly guestPlayerId: string,
    public readonly existingPlayerId: string,
  ) {
    super("an explicit save conflict decision is required");
  }
}
export class AccountIdempotencyConflictError extends Error {}

export class AppleAccountService {
  public constructor(
    private readonly verifier: AppleIdentityVerifier,
    private readonly repository: AppleAccountRepository,
    private readonly tokenIssuer: SessionTokenIssuer,
    private readonly now: () => Date,
  ) {}

  public async signIn(
    credential: AppleCredentialRequest,
    idempotencyKey: string,
  ): Promise<{ readonly player: PlayerProfile; readonly tokens: SessionTokens }> {
    validate(credential, idempotencyKey);
    const timestamp = this.now();
    const identity = await this.verify(credential, timestamp);
    const player = await this.repository.signInOrCreate({
      ...identity,
      idempotencyKey,
      now: timestamp,
    });
    return { player, tokens: await this.tokenIssuer.issue(player.playerId, timestamp) };
  }

  public async linkGuest(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly credential: AppleCredentialRequest;
    readonly idempotencyKey: string;
    readonly resolution?: LinkResolution | undefined;
  }): Promise<{ readonly player: PlayerProfile; readonly tokens: SessionTokens }> {
    if (input.principal.sessionKind !== "guest") {
      throw new AccountLinkAuthorizationError("only a guest session can use guest linking");
    }
    validate(input.credential, input.idempotencyKey);
    validateResolution(input.resolution);
    const timestamp = this.now();
    const identity = await this.verify(input.credential, timestamp);
    const result = await this.repository.linkGuest({
      guestPlayerId: input.principal.playerId,
      ...identity,
      idempotencyKey: input.idempotencyKey,
      resolution: input.resolution,
      now: timestamp,
    });
    if (result.kind === "decisionRequired") {
      throw new AccountLinkDecisionRequiredError(
        result.conflictId,
        result.guestPlayerId,
        result.existingPlayerId,
      );
    }
    return {
      player: result.player,
      tokens: await this.tokenIssuer.issue(result.player.playerId, timestamp),
    };
  }

  private async verify(credential: AppleCredentialRequest, now: Date): Promise<VerifiedAppleIdentity> {
    try {
      return await this.verifier.verify(credential, now);
    } catch {
      throw new AppleIdentityVerificationError("Apple identity could not be verified");
    }
  }
}

function validate(credential: AppleCredentialRequest, idempotencyKey: string): void {
  if (credential.identityToken.length < 20 || credential.identityToken.length > 16_384) {
    throw new AppleCredentialValidationError("identityToken length is invalid");
  }
  if (!/^[A-Za-z0-9._~-]{16,256}$/.test(credential.nonce)) {
    throw new AppleCredentialValidationError("nonce is invalid");
  }
  if (credential.authorizationCode !== undefined && (
    credential.authorizationCode.length < 8 || credential.authorizationCode.length > 4_096
  )) {
    throw new AppleCredentialValidationError("authorizationCode length is invalid");
  }
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(idempotencyKey)) {
    throw new AppleCredentialValidationError("idempotency key is invalid");
  }
}

function validateResolution(resolution: LinkResolution | undefined): void {
  if (resolution === undefined) return;
  if (!isUuid(resolution.conflictId)) {
    throw new AppleCredentialValidationError("conflictId must be a UUID");
  }
  if (resolution.saveChoice !== "preferGuestSave" && resolution.saveChoice !== "preferExistingSave") {
    throw new AppleCredentialValidationError("saveChoice is invalid");
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
