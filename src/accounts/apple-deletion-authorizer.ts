import type { AuthenticatedPrincipal } from "../auth/authentication.js";
import {
  AccountDeletionAuthorizationError,
  type AccountDeletionAuthorizer,
  type AccountDeletionProof,
} from "./account-service.js";
import type { AppleIdentityVerifier } from "./apple-account-service.js";
import { providerIdentityKey } from "./provider-identity-key.js";

export interface ProviderIdentityOwnershipResolver {
  resolvePlayerId(input: {
    readonly issuer: string;
    readonly subject: string;
  }): Promise<string | undefined>;
}

export class AppleAccountDeletionAuthorizer implements AccountDeletionAuthorizer {
  public constructor(
    private readonly verifier: AppleIdentityVerifier,
    private readonly ownership: ProviderIdentityOwnershipResolver,
  ) {}

  public async authorize(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly proof: AccountDeletionProof | undefined;
    readonly now: Date;
  }): Promise<{ readonly providerMappingKey: { readonly pk: string; readonly sk: string } }> {
    if (input.principal.sessionKind !== "account" || input.proof === undefined ||
        input.proof.provider !== "apple" || !validProof(input.proof)) {
      throw rejected();
    }

    try {
      const identity = await this.verifier.verify(input.proof, input.now);
      const owner = await this.ownership.resolvePlayerId(identity);
      if (owner !== input.principal.playerId) throw rejected();
      return { providerMappingKey: providerIdentityKey(identity.issuer, identity.subject) };
    } catch {
      throw rejected();
    }
  }
}

function validProof(proof: AccountDeletionProof): boolean {
  return proof.identityToken.length >= 20 && proof.identityToken.length <= 16_384 &&
    /^[A-Za-z0-9._~-]{16,256}$/.test(proof.nonce) &&
    (proof.authorizationCode === undefined ||
      (proof.authorizationCode.length >= 8 && proof.authorizationCode.length <= 4_096));
}

function rejected(): AccountDeletionAuthorizationError {
  return new AccountDeletionAuthorizationError("recent Apple authentication is required");
}
