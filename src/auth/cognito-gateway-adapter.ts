import { randomBytes } from "node:crypto";

import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  AdminSetUserPasswordCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

import {
  CognitoSessionRejectedError,
  type CognitoIssuedTokens,
  type CognitoSessionGateway,
} from "./cognito-session-provider.js";

export class CognitoGatewayConfigurationError extends Error {}
export class CognitoUserOwnershipError extends Error {}
export class CognitoUnsupportedUserStateError extends Error {}

// Only these two statuses are safe to proceed with.
const ALLOWED_USER_STATUSES = new Set(["FORCE_CHANGE_PASSWORD", "CONFIRMED"]);

// Fetch timeout for public Cognito API calls (ms).
const PUBLIC_API_TIMEOUT_MS = 10_000;

export class CognitoGatewayAdapter implements CognitoSessionGateway {
  private readonly region: string;

  public constructor(
    private readonly client: CognitoIdentityProviderClient,
    private readonly userPoolId: string,
    private readonly clientId: string,
  ) {
    if (!isValidPoolId(userPoolId)) {
      throw new CognitoGatewayConfigurationError("userPoolId must be in the format <region>_<id>");
    }
    if (clientId.trim() === "") {
      throw new CognitoGatewayConfigurationError("clientId is required");
    }
    this.region = userPoolId.split("_")[0]!;
  }

  public async startCustomAuthentication(input: { readonly playerId: string }): Promise<CognitoIssuedTokens> {
    if (!isUuid(input.playerId)) {
      throw new CognitoGatewayConfigurationError("playerId must be a valid UUID");
    }
    await this.ensureConfirmedUser(input.playerId);
    return this.initiateAndRespond(input.playerId);
  }

  public async refreshWithRotation(refreshToken: string): Promise<CognitoIssuedTokens> {
    // GetTokensFromRefreshToken is a public API authenticated by the token itself.
    // No IAM authorization is required or used.
    const result = await this.cognitoPublicPost(
      "AmazonCognitoIdentityProviderService.GetTokensFromRefreshToken",
      { RefreshToken: refreshToken, ClientId: this.clientId },
    );
    return extractTokens(result);
  }

  public async revoke(refreshToken: string): Promise<void> {
    // RevokeToken is a public API authenticated by the token itself.
    // No IAM authorization is required or used.
    // Already-invalid tokens are treated as successfully revoked.
    await this.cognitoPublicPost(
      "AmazonCognitoIdentityProviderService.RevokeToken",
      { Token: refreshToken, ClientId: this.clientId },
      ["InvalidParameterException"],
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async ensureConfirmedUser(playerId: string): Promise<void> {
    try {
      await this.client.send(new AdminCreateUserCommand({
        UserPoolId: this.userPoolId,
        Username: playerId,
        MessageAction: "SUPPRESS",
        TemporaryPassword: discardedPassword(),
      }));
      // User created in FORCE_CHANGE_PASSWORD — confirm immediately.
      await this.setConfirmed(playerId);
    } catch (error) {
      if (!isNamed(error, "UsernameExistsException")) throw error;
      // User already exists — verify ownership and resume if not yet confirmed.
      await this.resumeIfNeeded(playerId);
    }
  }

  private async setConfirmed(playerId: string): Promise<void> {
    await this.client.send(new AdminSetUserPasswordCommand({
      UserPoolId: this.userPoolId,
      Username: playerId,
      // A second random password is generated and immediately discarded.
      // Cognito retains only a non-retrievable verifier. The player never
      // chooses, receives, or uses this value.
      Password: discardedPassword(),
      Permanent: true,
    }));
  }

  private async resumeIfNeeded(playerId: string): Promise<void> {
    const result = await this.client.send(new AdminGetUserCommand({
      UserPoolId: this.userPoolId,
      Username: playerId,
    }));

    // The Cognito username must be the exact player UUID — no substitution.
    if (result.Username !== playerId) {
      throw new CognitoUserOwnershipError(
        "existing Cognito username does not match the expected player",
      );
    }

    const status = result.UserStatus;

    // Only FORCE_CHANGE_PASSWORD and CONFIRMED are safe to proceed with.
    // Any other status (UNCONFIRMED, RESET_REQUIRED, ARCHIVED, COMPROMISED,
    // UNKNOWN, or missing) must fail closed.
    if (status === undefined || !ALLOWED_USER_STATUSES.has(status)) {
      throw new CognitoUnsupportedUserStateError(
        `Cognito user is in an unsupported state and cannot be used`,
      );
    }

    if (status === "FORCE_CHANGE_PASSWORD") {
      // AdminCreateUser succeeded on a prior attempt but AdminSetUserPassword
      // did not. Resume confirmation without recreating the user.
      await this.setConfirmed(playerId);
    }
    // CONFIRMED — nothing to do. Never reset a confirmed user's verifier.
  }

  private async initiateAndRespond(playerId: string): Promise<CognitoIssuedTokens> {
    const initResult = await this.client.send(new AdminInitiateAuthCommand({
      UserPoolId: this.userPoolId,
      ClientId: this.clientId,
      AuthFlow: "CUSTOM_AUTH",
      AuthParameters: { USERNAME: playerId },
    }));

    if (initResult.ChallengeName !== "CUSTOM_CHALLENGE" || initResult.Session === undefined) {
      throw new CognitoSessionRejectedError("unexpected Cognito auth challenge state");
    }

    // ChallengeParameters contains the proof from CreateAuthChallenge.
    // This value must never be logged.
    const proof = initResult.ChallengeParameters?.["proof"];
    if (typeof proof !== "string" || proof.length === 0) {
      throw new CognitoSessionRejectedError("Cognito challenge did not return a proof");
    }

    const respondResult = await this.client.send(new AdminRespondToAuthChallengeCommand({
      UserPoolId: this.userPoolId,
      ClientId: this.clientId,
      ChallengeName: "CUSTOM_CHALLENGE",
      Session: initResult.Session,
      // The ANSWER value must never be logged.
      ChallengeResponses: { USERNAME: playerId, ANSWER: proof },
    }));

    if (respondResult.AuthenticationResult === undefined) {
      throw new CognitoSessionRejectedError("Cognito did not issue tokens after challenge");
    }
    return extractTokens(respondResult.AuthenticationResult);
  }

  private async cognitoPublicPost(
    target: string,
    body: Record<string, string>,
    ignoredErrorTypes: string[] = [],
  ): Promise<unknown> {
    const endpoint = `https://cognito-idp.${this.region}.amazonaws.com/`;
    let response: Response;
    try {
      // Fix 8: bounded timeout — map timeout/network failures to generic errors
      // without logging tokens or request/response bodies.
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.1",
          "X-Amz-Target": target,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PUBLIC_API_TIMEOUT_MS),
      });
    } catch {
      // Swallow all network/timeout details — never log body or token values.
      throw new CognitoSessionRejectedError("Cognito public API request failed");
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new CognitoSessionRejectedError("Cognito public API returned a non-JSON response");
    }
    if (!response.ok) {
      const errorType = (json as Record<string, unknown>)["__type"];
      if (typeof errorType === "string" && ignoredErrorTypes.includes(errorType)) return json;
      throw new CognitoSessionRejectedError("Cognito public API rejected the request");
    }
    return json;
  }
}

function discardedPassword(): string {
  // 40 random hex characters. Cryptographically random, never stored, never returned.
  return randomBytes(20).toString("hex");
}

function isNamed(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null &&
    (error as { name?: string }).name === name;
}

// Pool ID format: <region>_<alphanumeric-id>
// Region must be a non-empty string; the underscore separator is required.
function isValidPoolId(value: string): boolean {
  return /^[a-z]{2}-[a-z]+-\d+_[A-Za-z0-9]+$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function extractTokens(result: unknown): CognitoIssuedTokens {
  if (
    typeof result !== "object" || result === null ||
    typeof (result as Record<string, unknown>)["AccessToken"] !== "string" ||
    typeof (result as Record<string, unknown>)["RefreshToken"] !== "string" ||
    typeof (result as Record<string, unknown>)["ExpiresIn"] !== "number"
  ) {
    throw new CognitoSessionRejectedError("Cognito token response is malformed");
  }
  const r = result as Record<string, unknown>;
  return {
    accessToken:      r["AccessToken"]  as string,
    refreshToken:     r["RefreshToken"] as string,
    expiresInSeconds: r["ExpiresIn"]    as number,
  };
}
