import type { SessionTokens } from "../accounts/guest-session-service.js";
import type { AuthenticatedPrincipal } from "./authentication.js";

export interface SessionLifecycleProvider {
  refresh(input: { readonly refreshToken: string; readonly now: Date }): Promise<SessionTokens>;
  revoke(input: {
    readonly playerId: string;
    readonly refreshToken: string;
    readonly now: Date;
  }): Promise<void>;
}

export class SessionCredentialInvalidError extends Error {}
export class SessionCredentialOwnershipError extends Error {}
export class SessionLifecycleValidationError extends Error {}

export class SessionLifecycleService {
  public constructor(
    private readonly provider: SessionLifecycleProvider,
    private readonly now: () => Date,
  ) {}

  public async refresh(refreshToken: string): Promise<SessionTokens> {
    validateRefreshToken(refreshToken);
    return this.provider.refresh({ refreshToken, now: this.now() });
  }

  public async revoke(principal: AuthenticatedPrincipal, refreshToken: string): Promise<void> {
    validateRefreshToken(refreshToken);
    await this.provider.revoke({
      playerId: principal.playerId,
      refreshToken,
      now: this.now(),
    });
  }
}

function validateRefreshToken(value: string): void {
  if (value.length < 20 || value.length > 8192 || /\s/.test(value)) {
    throw new SessionLifecycleValidationError("refresh token is invalid");
  }
}
