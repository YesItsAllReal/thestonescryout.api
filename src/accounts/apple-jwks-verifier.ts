import { createHash, timingSafeEqual } from "node:crypto";

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

import type {
  AppleCredentialRequest,
  AppleIdentityVerifier,
  VerifiedAppleIdentity,
} from "./apple-account-service.js";

const appleIssuer = "https://appleid.apple.com" as const;
const appleJwksUrl = new URL("https://appleid.apple.com/auth/keys");

export class AppleJwksVerifier implements AppleIdentityVerifier {
  private readonly keyResolver: JWTVerifyGetKey;

  public constructor(
    private readonly audience: string,
    keyResolver?: JWTVerifyGetKey,
  ) {
    if (audience.trim() === "") throw new Error("Apple identity-token audience is required");
    this.keyResolver = keyResolver ?? createRemoteJWKSet(appleJwksUrl);
  }

  public async verify(
    credential: AppleCredentialRequest,
    now: Date,
  ): Promise<VerifiedAppleIdentity> {
    let payload;
    try {
      ({ payload } = await jwtVerify(credential.identityToken, this.keyResolver, {
        issuer: appleIssuer,
        audience: this.audience,
        algorithms: ["RS256"],
        currentDate: now,
        clockTolerance: 5,
      }));
    } catch {
      throw new Error("Apple identity token verification failed");
    }

    if (!isAppleSubject(payload.sub) || typeof payload.nonce !== "string" ||
        !constantTimeEqual(payload.nonce, sha256(credential.nonce))) {
      throw new Error("Apple identity token claims are invalid");
    }

    return { issuer: appleIssuer, subject: payload.sub };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isAppleSubject(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 255 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}
