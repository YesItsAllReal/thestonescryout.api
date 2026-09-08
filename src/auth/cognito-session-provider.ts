import { createHash } from "node:crypto";

import type { SessionTokenIssuer, SessionTokens } from "../accounts/guest-session-service.js";
import {
  SessionCredentialInvalidError,
  SessionCredentialOwnershipError,
  type SessionLifecycleProvider,
} from "./session-lifecycle-service.js";

export interface CognitoIssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
}

export interface CognitoSessionGateway {
  startCustomAuthentication(input: {
    readonly playerId: string;
  }): Promise<CognitoIssuedTokens>;
  refreshWithRotation(refreshToken: string): Promise<CognitoIssuedTokens>;
  revoke(refreshToken: string): Promise<void>;
}

export interface RefreshCredentialRegistry {
  register(input: {
    readonly credentialHash: string;
    readonly playerId: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<void>;
  // Issue 3: replacementExpiresAt removed — rotation inherits the original
  // family expiration from the stored record. Callers must not supply it to
  // avoid accidentally extending the session lifetime.
  rotate(input: {
    readonly previousCredentialHash: string;
    readonly replacementCredentialHash: string;
    readonly now: Date;
    readonly replacementRawToken?: string;
  }): Promise<void>;
  assertOwnedBy(input: {
    readonly credentialHash: string;
    readonly playerId: string;
    readonly now: Date;
  }): Promise<void>;
  markRevoked(input: {
    readonly credentialHash: string;
    readonly now: Date;
  }): Promise<void>;
}

export class CognitoSessionRejectedError extends Error {}
export class RefreshCredentialRejectedError extends Error {}
export class RefreshCredentialOwnershipMismatchError extends Error {}
export class CognitoSessionConfigurationError extends Error {}

export class CognitoSessionProvider implements SessionTokenIssuer, SessionLifecycleProvider {
  public constructor(
    private readonly gateway: CognitoSessionGateway,
    private readonly registry: RefreshCredentialRegistry,
    private readonly refreshLifetimeSeconds: number,
  ) {
    if (!Number.isSafeInteger(refreshLifetimeSeconds) || refreshLifetimeSeconds < 1) {
      throw new CognitoSessionConfigurationError("refresh lifetime must be a positive integer");
    }
  }

  public async issue(playerId: string, now: Date): Promise<SessionTokens> {
    const issued = await this.gateway.startCustomAuthentication({ playerId });
    const tokens = mapTokens(issued, now);
    try {
      await this.registry.register({
        credentialHash: hashCredential(tokens.refreshToken),
        playerId,
        expiresAt: addSeconds(now, this.refreshLifetimeSeconds),
        now,
      });
    } catch (error) {
      // Issue 2: registration failed after Cognito issued valid tokens. The
      // refresh token is valid but unregistered — best-effort revoke it so it
      // cannot be used. Never return tokens whose registration failed.
      await this.gateway.revoke(tokens.refreshToken).catch(() => {
        // Revocation is best-effort — swallow errors, rethrow the original.
      });
      throw error;
    }
    return tokens;
  }

  public async refresh(input: { refreshToken: string; now: Date }): Promise<SessionTokens> {
    try {
      const issued = await this.gateway.refreshWithRotation(input.refreshToken);
      const tokens = mapTokens(issued, input.now);
      // Issue 3: replacementExpiresAt removed from the rotate call.
      await this.registry.rotate({
        previousCredentialHash: hashCredential(input.refreshToken),
        replacementCredentialHash: hashCredential(tokens.refreshToken),
        replacementRawToken: tokens.refreshToken,
        now: input.now,
      });
      return tokens;
    } catch (error) {
      if (error instanceof CognitoSessionRejectedError || error instanceof RefreshCredentialRejectedError) {
        throw new SessionCredentialInvalidError("refresh credential was rejected");
      }
      throw error;
    }
  }

  public async revoke(input: { playerId: string; refreshToken: string; now: Date }): Promise<void> {
    const credentialHash = hashCredential(input.refreshToken);
    try {
      await this.registry.assertOwnedBy({ credentialHash, playerId: input.playerId, now: input.now });
    } catch (error) {
      if (error instanceof RefreshCredentialOwnershipMismatchError) {
        throw new SessionCredentialOwnershipError("refresh credential ownership mismatch");
      }
      if (error instanceof RefreshCredentialRejectedError) return;
      throw error;
    }

    try {
      await this.gateway.revoke(input.refreshToken);
    } catch (error) {
      // Provider revocation is idempotent when Cognito reports an already-invalid token.
      if (!(error instanceof CognitoSessionRejectedError)) throw error;
    }
    await this.registry.markRevoked({ credentialHash, now: input.now });
  }
}

function mapTokens(value: CognitoIssuedTokens, now: Date): SessionTokens {
  if (!validToken(value.accessToken) || !validToken(value.refreshToken) ||
      !Number.isSafeInteger(value.expiresInSeconds) || value.expiresInSeconds < 1 ||
      value.expiresInSeconds > 86_400) {
    throw new CognitoSessionRejectedError("Cognito returned an invalid token response");
  }
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: addSeconds(now, value.expiresInSeconds).toISOString(),
  };
}

function validToken(value: string): boolean {
  return value.length >= 20 && value.length <= 8192 && !/\s/.test(value);
}

function hashCredential(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function addSeconds(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * 1000);
}
