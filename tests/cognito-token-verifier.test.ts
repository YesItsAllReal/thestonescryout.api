import assert from "node:assert/strict";
import test from "node:test";

import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from "jose";

import {
  CognitoTokenVerificationError,
  CognitoTokenVerifier,
} from "../src/auth/cognito-token-verifier.js";

const issuer = "https://cognito-idp.us-east-1.amazonaws.com/example_pool";
const clientId = "example-mobile-client";
const playerId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-09-02T16:00:00.000Z");

const keys = await generateKeyPair("RS256");
const publicJwk = await exportJWK(keys.publicKey);
publicJwk.kid = "test-key";
publicJwk.use = "sig";
const localKeys = createLocalJWKSet({ keys: [publicJwk] }) as JWTVerifyGetKey;

test("Cognito verifier returns only trusted player and session claims", async () => {
  const token = await signedToken();
  const principal = await verifier().verify(token, now);

  assert.deepEqual(principal, {
    playerId,
    sessionKind: "guest",
    issuer,
    audience: clientId,
  });
});

test("Cognito verifier requires access-token use and exact app client binding", async () => {
  await assert.rejects(
    verifier().verify(await signedToken({ token_use: "id" }), now),
    CognitoTokenVerificationError,
  );
  await assert.rejects(
    verifier().verify(await signedToken({ client_id: "another-client" }), now),
    CognitoTokenVerificationError,
  );
});

test("Cognito verifier rejects expired tokens using the supplied trusted clock", async () => {
  const token = await signedToken({}, { expiresAt: Math.floor(now.getTime() / 1000) - 10 });
  await assert.rejects(verifier().verify(token, now), CognitoTokenVerificationError);
});

test("Cognito verifier never substitutes provider subject for a missing player ID", async () => {
  const token = await signedToken({ player_id: undefined, sub: playerId });
  await assert.rejects(verifier().verify(token, now), CognitoTokenVerificationError);
});

test("free-tier resolver maps a signed backend username through authoritative storage", async () => {
  const resolved = await new CognitoTokenVerifier(issuer, clientId, localKeys, {
    async resolve(input) {
      assert.deepEqual(input, { issuer, subject: "cognito-user-subject", username: playerId });
      return { playerId, sessionKind: "account" };
    },
  }).verify(await signedToken({ player_id: undefined, session_kind: undefined, username: playerId }), now);

  assert.equal(resolved.playerId, playerId);
  assert.equal(resolved.sessionKind, "account");
});

test("free-tier resolver rejects non-UUID Cognito usernames before storage lookup", async () => {
  let calls = 0;
  const mapped = new CognitoTokenVerifier(issuer, clientId, localKeys, {
    async resolve() { calls++; return { playerId, sessionKind: "guest" }; },
  });
  await assert.rejects(mapped.verify(await signedToken({ username: "caller-selected" }), now), CognitoTokenVerificationError);
  assert.equal(calls, 0);
});

test("Cognito verifier rejects an invalid signature and unsupported algorithm", async () => {
  const otherKeys = await generateKeyPair("ES256");
  const token = await new SignJWT(baseClaims())
    .setProtectedHeader({ alg: "ES256", kid: "other" })
    .setIssuer(issuer)
    .setIssuedAt(Math.floor(now.getTime() / 1000) - 10)
    .setExpirationTime(Math.floor(now.getTime() / 1000) + 300)
    .sign(otherKeys.privateKey);

  await assert.rejects(verifier().verify(token, now), CognitoTokenVerificationError);
});

function verifier(): CognitoTokenVerifier {
  return new CognitoTokenVerifier(issuer, clientId, localKeys);
}

async function signedToken(
  claimOverrides: Record<string, unknown> = {},
  times: { readonly expiresAt?: number } = {},
): Promise<string> {
  const claims = { ...baseClaims(), ...claimOverrides };
  for (const [key, value] of Object.entries(claims)) {
    if (value === undefined) delete claims[key];
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setIssuedAt(Math.floor(now.getTime() / 1000) - 10)
    .setExpirationTime(times.expiresAt ?? Math.floor(now.getTime() / 1000) + 300)
    .sign(keys.privateKey);
}

function baseClaims(): Record<string, unknown> {
  return {
    sub: "cognito-user-subject",
    token_use: "access",
    client_id: clientId,
    player_id: playerId,
    session_kind: "guest",
    username: playerId,
  };
}
