import {
  AdminUserGlobalSignOutCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

import type { PlayerSessionRevoker } from "../accounts/account-service.js";

type CognitoClient = Pick<CognitoIdentityProviderClient, "send">;

export class PlayerSessionRevocationError extends Error {}
export class PlayerSessionRevokerConfigurationError extends Error {}

/**
 * Revokes every Cognito session for one server-owned shadow user.
 *
 * The player UUID is also the Cognito username. No token, provider subject, or
 * credential is accepted by this boundary, and provider failures are mapped to
 * an intentionally opaque application error.
 */
export class CognitoPlayerSessionRevoker implements PlayerSessionRevoker {
  public constructor(
    private readonly client: CognitoClient,
    private readonly userPoolId: string,
  ) {
    if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d+_[A-Za-z0-9]+$/.test(userPoolId)) {
      throw new PlayerSessionRevokerConfigurationError("Cognito user pool ID is invalid");
    }
  }

  public async revokeAll(playerId: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(playerId)) {
      throw new PlayerSessionRevocationError("player identifier is invalid");
    }

    try {
      await this.client.send(new AdminUserGlobalSignOutCommand({
        UserPoolId: this.userPoolId,
        Username: playerId,
      }));
    } catch (error) {
      // A missing shadow user has no provider sessions left to revoke, so this
      // is an idempotent terminal state. All other details stay private.
      if (isNamed(error, "UserNotFoundException")) return;
      throw new PlayerSessionRevocationError("player sessions could not be revoked");
    }
  }
}

function isNamed(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null &&
    (error as { name?: string }).name === name;
}
