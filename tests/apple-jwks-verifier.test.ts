import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from "jose";

import { AppleJwksVerifier } from "../src/accounts/apple-jwks-verifier.js";

const issuer = "https://appleid.apple.com";
const audience = "com.example.stonescryout";
const subject = "000742.abc123def456.0123";
const nonce = "caller-nonce-value-0000001";
const now = new Date("2026-09-02T18:00:00.000Z");

const keys = await generateKeyPair("RS256");
const publicJwk = await exportJWK(keys.publicKey);
publicJwk.kid = "apple-test-key";
publicJwk.use = "sig";
const localKeys = createLocalJWKSet({ keys: [publicJwk] }) as JWTVerifyGetKey;

test("Apple JWKS verifier accepts a signed token bound to issuer, audience, and nonce", async () => {
  const identity = await verifier().verify({ identityToken: await token(), nonce }, now);
  assert.deepEqual(identity, { issuer, subject });
});

test("Apple JWKS verifier rejects wrong issuer or audience", async () => {
  await assert.rejects(verifier().verify({
    identityToken: await token({ issuer: "https://issuer.example.test" }),
    nonce,
  }, now));
  await assert.rejects(verifier().verify({
    identityToken: await token({ audience: "another.application" }),
    nonce,
  }, now));
});

test("Apple JWKS verifier rejects expired identity tokens", async () => {
  await assert.rejects(verifier().verify({
    identityToken: await token({ expiresAt: Math.floor(now.getTime() / 1000) - 10 }),
    nonce,
  }, now));
});

test("Apple JWKS verifier requires the SHA-256 bound caller nonce", async () => {
  const identityToken = await token();
  await assert.rejects(verifier().verify({ identityToken, nonce: "different-nonce-value-001" }, now));
});

test("Apple JWKS verifier rejects missing or malformed subjects", async () => {
  await assert.rejects(verifier().verify({ identityToken: await token({ subject: "" }), nonce }, now));
  await assert.rejects(verifier().verify({
    identityToken: await token({ subject: `bad\u0000subject` }),
    nonce,
  }, now));
});

test("Apple JWKS verifier rejects unsupported algorithms", async () => {
  const ecKeys = await generateKeyPair("ES256");
  const identityToken = await new SignJWT({ nonce: nonceHash() })
    .setProtectedHeader({ alg: "ES256", kid: "other" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(Math.floor(now.getTime() / 1000) - 10)
    .setExpirationTime(Math.floor(now.getTime() / 1000) + 300)
    .sign(ecKeys.privateKey);
  await assert.rejects(verifier().verify({ identityToken, nonce }, now));
});

function verifier(): AppleJwksVerifier {
  return new AppleJwksVerifier(audience, localKeys);
}

async function token(overrides: {
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly expiresAt?: number;
} = {}): Promise<string> {
  return new SignJWT({ nonce: nonceHash() })
    .setProtectedHeader({ alg: "RS256", kid: "apple-test-key" })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setSubject(overrides.subject ?? subject)
    .setIssuedAt(Math.floor(now.getTime() / 1000) - 10)
    .setExpirationTime(overrides.expiresAt ?? Math.floor(now.getTime() / 1000) + 300)
    .sign(keys.privateKey);
}

function nonceHash(): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}
