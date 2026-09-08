import assert from "node:assert/strict";
import test from "node:test";

import { handler } from "../src/lambda/cognito-triggers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function event(triggerSource: string, overrides: Record<string, unknown> = {}) {
  return {
    triggerSource,
    request: { userNotFound: false, session: [], ...overrides },
    response: {},
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

test("dispatcher throws on unexpected triggerSource", async () => {
  await assert.rejects(
    handler(event("PreSignUp_SignUp") as never),
    /unexpected triggerSource/,
  );
});

// ---------------------------------------------------------------------------
// DefineAuthChallenge
// ---------------------------------------------------------------------------

test("DefineAuth issues a challenge on an empty session", async () => {
  const result = await handler(event("DefineAuthChallenge_Authentication", { session: [] }));
  assert.equal(result.response.challengeName, "CUSTOM_CHALLENGE");
  assert.equal(result.response.issueTokens, false);
  assert.equal(result.response.failAuthentication, false);
});

test("DefineAuth fails closed for userNotFound", async () => {
  const result = await handler(event("DefineAuthChallenge_Authentication", { userNotFound: true, session: [] }));
  assert.equal(result.response.failAuthentication, true);
  assert.equal(result.response.issueTokens, false);
});

test("DefineAuth issues tokens after exactly one successful challenge", async () => {
  const result = await handler(event("DefineAuthChallenge_Authentication", {
    session: [{ challengeName: "CUSTOM_CHALLENGE", challengeResult: true }],
  }));
  assert.equal(result.response.issueTokens, true);
  assert.equal(result.response.failAuthentication, false);
});

test("DefineAuth rejects a failed challenge attempt", async () => {
  const result = await handler(event("DefineAuthChallenge_Authentication", {
    session: [{ challengeName: "CUSTOM_CHALLENGE", challengeResult: false }],
  }));
  assert.equal(result.response.failAuthentication, true);
  assert.equal(result.response.issueTokens, false);
});

test("DefineAuth rejects repeated successful challenges", async () => {
  const result = await handler(event("DefineAuthChallenge_Authentication", {
    session: [
      { challengeName: "CUSTOM_CHALLENGE", challengeResult: true },
      { challengeName: "CUSTOM_CHALLENGE", challengeResult: true },
    ],
  }));
  assert.equal(result.response.failAuthentication, true);
  assert.equal(result.response.issueTokens, false);
});

test("DefineAuth fails closed on any non-CUSTOM_CHALLENGE session entry", async () => {
  // Fix 1: unexpected challenge types must fail closed, not start a new challenge.
  const result = await handler(event("DefineAuthChallenge_Authentication", {
    session: [{ challengeName: "PASSWORD_VERIFIER", challengeResult: true }],
  }));
  assert.equal(result.response.failAuthentication, true);
  assert.equal(result.response.issueTokens, false);
});

test("DefineAuth fails closed on a session entry with a missing challengeName", async () => {
  const result = await handler(event("DefineAuthChallenge_Authentication", {
    session: [{ challengeResult: true }],
  }));
  assert.equal(result.response.failAuthentication, true);
  assert.equal(result.response.issueTokens, false);
});

test("DefineAuth fails closed on a session entry with a non-boolean challengeResult", async () => {
  const result = await handler(event("DefineAuthChallenge_Authentication", {
    session: [{ challengeName: "CUSTOM_CHALLENGE", challengeResult: "yes" }],
  }));
  assert.equal(result.response.failAuthentication, true);
  assert.equal(result.response.issueTokens, false);
});

// ---------------------------------------------------------------------------
// CreateAuthChallenge
// ---------------------------------------------------------------------------

test("CreateAuth generates a 64-character hex proof", async () => {
  const result = await handler(event("CreateAuthChallenge_Authentication", {
    challengeName: "CUSTOM_CHALLENGE",
  }));
  const proof = result.response.publicChallengeParameters?.["proof"];
  assert.ok(typeof proof === "string" && /^[a-f0-9]{64}$/.test(proof));
  assert.equal(result.response.privateChallengeParameters?.["proof"], proof);
});

test("CreateAuth generates a different proof on each invocation", async () => {
  const e1 = event("CreateAuthChallenge_Authentication", { challengeName: "CUSTOM_CHALLENGE" });
  const e2 = event("CreateAuthChallenge_Authentication", { challengeName: "CUSTOM_CHALLENGE" });
  const [r1, r2] = await Promise.all([handler(e1 as never), handler(e2 as never)]);
  assert.notEqual(
    r1.response.publicChallengeParameters?.["proof"],
    r2.response.publicChallengeParameters?.["proof"],
  );
});

test("CreateAuth returns empty parameters for userNotFound", async () => {
  const result = await handler(event("CreateAuthChallenge_Authentication", {
    userNotFound: true,
    challengeName: "CUSTOM_CHALLENGE",
  }));
  assert.deepEqual(result.response.publicChallengeParameters,  {});
  assert.deepEqual(result.response.privateChallengeParameters, {});
});

test("CreateAuth throws on unexpected challengeName", async () => {
  await assert.rejects(
    handler(event("CreateAuthChallenge_Authentication", { challengeName: "PASSWORD_VERIFIER" }) as never),
    /unexpected challengeName/,
  );
});

// ---------------------------------------------------------------------------
// VerifyAuthChallengeResponse
// ---------------------------------------------------------------------------

test("VerifyAuth accepts a matching proof", async () => {
  const proof = "a".repeat(64);
  const result = await handler(event("VerifyAuthChallengeResponse_Authentication", {
    privateChallengeParameters: { proof },
    challengeAnswer: proof,
  }));
  assert.equal(result.response.answerCorrect, true);
});

test("VerifyAuth rejects a wrong answer", async () => {
  const result = await handler(event("VerifyAuthChallengeResponse_Authentication", {
    privateChallengeParameters: { proof: "a".repeat(64) },
    challengeAnswer: "b".repeat(64),
  }));
  assert.equal(result.response.answerCorrect, false);
});

test("VerifyAuth rejects an empty answer", async () => {
  const result = await handler(event("VerifyAuthChallengeResponse_Authentication", {
    privateChallengeParameters: { proof: "a".repeat(64) },
    challengeAnswer: "",
  }));
  assert.equal(result.response.answerCorrect, false);
});

test("VerifyAuth rejects a length-mismatched answer without throwing", async () => {
  // timingSafeEqual throws on unequal buffer lengths — the guard must prevent that.
  const result = await handler(event("VerifyAuthChallengeResponse_Authentication", {
    privateChallengeParameters: { proof: "a".repeat(64) },
    challengeAnswer: "a".repeat(32),
  }));
  assert.equal(result.response.answerCorrect, false);
});

test("VerifyAuth rejects a missing proof in privateChallengeParameters", async () => {
  const result = await handler(event("VerifyAuthChallengeResponse_Authentication", {
    privateChallengeParameters: {},
    challengeAnswer: "a".repeat(64),
  }));
  assert.equal(result.response.answerCorrect, false);
});
