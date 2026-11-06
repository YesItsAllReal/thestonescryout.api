import assert from "node:assert/strict";
import test from "node:test";

import { CommerceValidationError, CommerceVerificationError } from "../src/commerce/commerce-service.js";
import { DevelopmentAdMobCompletionVerifier, DevelopmentAdRewardCatalog } from "../src/commerce/development-ad-reward.js";

const playerId = "00000000-0000-4000-8000-000000000901";
const claimId = "00000000-0000-4000-8000-000000000902";
const envelope = {
  provider: "google-admob",
  claimID: claimId,
  responseIdentifier: "test-response-0001",
  adUnitID: "ca-app-pub-3940256099942544/1712485313",
  earnedCallback: true,
};

test("development verifier accepts only the official Google rewarded test unit", async () => {
  const completion = await new DevelopmentAdMobCompletionVerifier().verify(
    JSON.stringify(envelope),
    new Date("2026-11-06T00:00:00.000Z"),
    { playerId, claimId },
  );
  assert.deepEqual(completion, {
    provider: "google-admob-test",
    providerEventId: "test-response-0001",
    claimId,
    playerId,
  });
});

test("development verifier rejects production units, changed claims, and unearned callbacks", async () => {
  const verifier = new DevelopmentAdMobCompletionVerifier();
  const verify = (override: Record<string, unknown>, expectedClaim = claimId) => verifier.verify(
    JSON.stringify({ ...envelope, ...override }),
    new Date(),
    { playerId, claimId: expectedClaim },
  );
  await assert.rejects(verify({ adUnitID: "ca-app-pub-production/rewarded" }), CommerceVerificationError);
  await assert.rejects(verify({ earnedCallback: false }), CommerceVerificationError);
  await assert.rejects(verify({}, "00000000-0000-4000-8000-000000000903"), CommerceVerificationError);
  await assert.rejects(verify({ extra: "unexpected" }), CommerceVerificationError);
});

test("development reward catalog enforces exact placement and approved values", async () => {
  const catalog = new DevelopmentAdRewardCatalog();
  assert.deepEqual(await catalog.resolve("storeEnergy", "energy20"), [{ resource: "energy", delta: 20 }]);
  assert.deepEqual(await catalog.resolve("energyEmpty", "energy20"), [{ resource: "energy", delta: 20 }]);
  assert.deepEqual(await catalog.resolve("storeCoins", "coins100"), [{ resource: "coins", delta: 100 }]);
  await assert.rejects(catalog.resolve("storeEnergy", "coins100"), CommerceValidationError);
});
