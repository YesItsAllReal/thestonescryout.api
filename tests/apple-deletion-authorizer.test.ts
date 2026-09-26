import assert from "node:assert/strict";
import test from "node:test";

import { AccountDeletionAuthorizationError } from "../src/accounts/account-service.js";
import { AppleAccountDeletionAuthorizer } from "../src/accounts/apple-deletion-authorizer.js";
import type { AppleIdentityVerifier } from "../src/accounts/apple-account-service.js";

const playerId = "00000000-0000-4000-8000-000000000201";
const principal = { playerId, sessionKind: "account" as const, issuer: "issuer", audience: "audience" };
const proof = { provider: "apple" as const, identityToken: "header.payload.signature-for-tests", nonce: "nonce-value-0000000001" };
const now = new Date("2026-09-08T20:00:00.000Z");
const identity = { issuer: "https://appleid.apple.com" as const, subject: "private-subject" };

function verifier(result: typeof identity | Error = identity): AppleIdentityVerifier {
  return { async verify() { if (result instanceof Error) throw result; return result; } };
}

test("fresh verified Apple identity authorizes deletion only for its mapped player", async () => {
  let resolved: unknown;
  const authorizer = new AppleAccountDeletionAuthorizer(verifier(), {
    async resolvePlayerId(value) { resolved = value; return playerId; },
  });
  const authorization = await authorizer.authorize({ principal, proof, now });
  assert.deepEqual(resolved, identity);
  assert.match(authorization.providerMappingKey.pk, /^PROVIDER#[a-f0-9]{64}#[a-f0-9]{64}$/);
  assert.equal(authorization.providerMappingKey.sk, "PLAYER");
  assert.equal(JSON.stringify(authorization).includes(identity.subject), false);
});

test("guest sessions and missing or malformed proofs fail before verification", async () => {
  let calls = 0;
  const authorizer = new AppleAccountDeletionAuthorizer({ async verify() { calls++; return identity; } }, {
    async resolvePlayerId() { return playerId; },
  });
  await assert.rejects(authorizer.authorize({ principal: { ...principal, sessionKind: "guest" }, proof, now }), AccountDeletionAuthorizationError);
  await assert.rejects(authorizer.authorize({ principal, proof: undefined, now }), AccountDeletionAuthorizationError);
  await assert.rejects(authorizer.authorize({ principal, proof: { ...proof, nonce: "short" }, now }), AccountDeletionAuthorizationError);
  assert.equal(calls, 0);
});

test("unmapped and cross-player Apple identities fail with the same opaque error", async () => {
  for (const owner of [undefined, "00000000-0000-4000-8000-000000000202"]) {
    const authorizer = new AppleAccountDeletionAuthorizer(verifier(), { async resolvePlayerId() { return owner; } });
    const error = await authorizer.authorize({ principal, proof, now }).catch((value: unknown) => value);
    assert.ok(error instanceof AccountDeletionAuthorizationError);
    assert.equal(error.message.includes(identity.subject), false);
    assert.equal(error.message.includes(String(owner)), false);
  }
});

test("verification and ownership-store failures expose no provider details", async () => {
  const cases = [
    new AppleAccountDeletionAuthorizer(verifier(new Error("raw identity token detail")), { async resolvePlayerId() { return playerId; } }),
    new AppleAccountDeletionAuthorizer(verifier(), { async resolvePlayerId() { throw new Error("mapping detail"); } }),
  ];
  for (const authorizer of cases) {
    const error = await authorizer.authorize({ principal, proof, now }).catch((value: unknown) => value);
    assert.ok(error instanceof AccountDeletionAuthorizationError);
    assert.equal(error.message.includes("detail"), false);
    assert.equal(error.message.includes(proof.identityToken), false);
  }
});
