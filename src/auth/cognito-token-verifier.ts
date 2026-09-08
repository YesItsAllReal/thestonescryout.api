import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";

import type { AccessTokenVerifier, AuthenticatedPrincipal } from "./authentication.js";

export class CognitoTokenVerificationError extends Error {}

export interface CognitoPrincipalResolver {
  resolve(input: {
    readonly issuer: string;
    readonly subject: string;
    readonly username: string;
  }): Promise<Pick<AuthenticatedPrincipal, "playerId" | "sessionKind"> | undefined>;
}

export class CognitoTokenVerifier implements AccessTokenVerifier {
  private readonly issuer: string;
  private readonly keyResolver: JWTVerifyGetKey;

  public constructor(
    issuer: string,
    private readonly clientId: string,
    keyResolver?: JWTVerifyGetKey,
    private readonly principalResolver?: CognitoPrincipalResolver,
  ) {
    this.issuer = validateIssuer(issuer);
    if (clientId.trim() === "") throw new Error("Cognito client ID is required");
    this.keyResolver = keyResolver ?? createRemoteJWKSet(
      new URL(`${this.issuer}/.well-known/jwks.json`),
    );
  }

  public async verify(accessToken: string, now: Date): Promise<AuthenticatedPrincipal> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(accessToken, this.keyResolver, {
        issuer: this.issuer,
        algorithms: ["RS256"],
        currentDate: now,
        clockTolerance: 5,
      }));
    } catch {
      throw new CognitoTokenVerificationError("access token verification failed");
    }

    if (payload.token_use !== "access" || payload.client_id !== this.clientId) {
      throw new CognitoTokenVerificationError("access token claims are invalid");
    }
    const identity = this.principalResolver === undefined
      ? readEmbeddedIdentity(payload)
      : await this.resolveIdentity(payload.sub, payload.username);
    if (identity === undefined) {
      throw new CognitoTokenVerificationError("application identity claims are invalid");
    }

    return {
      playerId: identity.playerId,
      sessionKind: identity.sessionKind,
      issuer: this.issuer,
      audience: this.clientId,
    };
  }

  private async resolveIdentity(subject: unknown, username: unknown): Promise<Pick<AuthenticatedPrincipal, "playerId" | "sessionKind"> | undefined> {
    if (typeof subject !== "string" || subject.length < 1 || subject.length > 256 ||
        typeof username !== "string" || !isUuid(username)) return undefined;
    try {
      const identity = await this.principalResolver?.resolve({ issuer: this.issuer, subject, username });
      return identity !== undefined && isUuid(identity.playerId) && isSessionKind(identity.sessionKind)
        ? identity
        : undefined;
    } catch {
      throw new CognitoTokenVerificationError("application identity resolution failed");
    }
  }
}

function readEmbeddedIdentity(payload: JWTPayload): Pick<AuthenticatedPrincipal, "playerId" | "sessionKind"> | undefined {
  return isUuid(payload.player_id) && isSessionKind(payload.session_kind)
    ? { playerId: payload.player_id, sessionKind: payload.session_kind }
    : undefined;
}

function validateIssuer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Cognito issuer must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
      url.search !== "" || url.hash !== "") {
    throw new Error("Cognito issuer must be an absolute HTTPS URL");
  }
  return url.toString().replace(/\/$/, "");
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSessionKind(value: unknown): value is AuthenticatedPrincipal["sessionKind"] {
  return value === "guest" || value === "account";
}
