import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthenticationRequiredError,
  requirePrincipal,
  type AccessTokenVerifier,
} from "../src/auth/authentication.js";

const verifier: AccessTokenVerifier = {
  async verify(token) {
    if (token !== "valid-token") throw new Error("invalid signature");
    return { playerId: "player-1", sessionKind: "guest", issuer: "test", audience: "test" };
  },
};

test("bearer authentication returns only a verified principal", async () => {
  const principal = await requirePrincipal({
    authorizationHeader: "Bearer valid-token",
    verifier,
    now: new Date(),
  });
  assert.equal(principal.playerId, "player-1");
});

test("missing and invalid bearer tokens have the same public error boundary", async () => {
  await assert.rejects(
    requirePrincipal({ authorizationHeader: undefined, verifier, now: new Date() }),
    AuthenticationRequiredError,
  );
  await assert.rejects(
    requirePrincipal({ authorizationHeader: "Bearer invalid-token", verifier, now: new Date() }),
    AuthenticationRequiredError,
  );
});
