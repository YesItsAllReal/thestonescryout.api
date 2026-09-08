import assert from "node:assert/strict";
import test from "node:test";

import { AccountCognitoPrincipalResolver } from "../src/auth/account-cognito-principal-resolver.js";

const playerId = "66666666-6666-4666-8666-666666666666";

test("principal resolver derives account session kind from active Dynamo profile", async () => {
  const resolver = new AccountCognitoPrincipalResolver({
    async getByPlayerId(value) {
      return { playerId: value, accountKind: "apple", displayName: null, locale: "en-US", createdAt: "2026-09-03T00:00:00.000Z", linkedProviders: ["apple"], deletionState: "active" };
    },
  });
  assert.deepEqual(await resolver.resolve({ issuer: "https://issuer.example", subject: "opaque-sub", username: playerId }), {
    playerId,
    sessionKind: "account",
  });
});

test("principal resolver rejects deletion-pending profiles", async () => {
  const resolver = new AccountCognitoPrincipalResolver({
    async getByPlayerId(value) {
      return { playerId: value, accountKind: "guest", displayName: null, locale: "en-US", createdAt: "2026-09-03T00:00:00.000Z", linkedProviders: [], deletionState: "requested" };
    },
  });
  assert.equal(await resolver.resolve({ issuer: "https://issuer.example", subject: "opaque-sub", username: playerId }), undefined);
});
