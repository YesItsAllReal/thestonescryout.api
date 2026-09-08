import type { AccountRepository } from "../accounts/account-service.js";
import type { CognitoPrincipalResolver } from "./cognito-token-verifier.js";

export class AccountCognitoPrincipalResolver implements CognitoPrincipalResolver {
  public constructor(private readonly accounts: Pick<AccountRepository, "getByPlayerId">) {}

  public async resolve(input: { issuer: string; subject: string; username: string }) {
    // issuer and subject have already passed signature-bound token validation.
    // The backend-created Cognito username is only a lookup key; DynamoDB remains
    // authoritative for player existence, deletion state, and session kind.
    const profile = await this.accounts.getByPlayerId(input.username);
    if (profile === undefined || profile.deletionState !== "active") return undefined;
    return {
      playerId: profile.playerId,
      sessionKind: profile.accountKind === "guest" ? "guest" as const : "account" as const,
    };
  }
}
