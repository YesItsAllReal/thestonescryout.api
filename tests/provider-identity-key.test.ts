import assert from "node:assert/strict";
import test from "node:test";
import { providerIdentityKey } from "../src/accounts/provider-identity-key.js";

test("provider keys are deterministic and contain no raw identity", () => {
  const subject = "000742.private-provider-subject.0123";
  const first = providerIdentityKey("https://appleid.apple.com", subject);
  assert.deepEqual(first, providerIdentityKey("https://appleid.apple.com/", subject));
  assert.match(first.pk, /^PROVIDER#[a-f0-9]{64}#[a-f0-9]{64}$/);
  assert.equal(first.pk.includes(subject) || first.pk.includes("appleid"), false);
});

test("different subjects cannot share a provider mapping key", () => {
  assert.notEqual(providerIdentityKey("https://appleid.apple.com", "subject-one").pk,
    providerIdentityKey("https://appleid.apple.com", "subject-two").pk);
});

test("provider keys reject unsafe issuer and subject input", () => {
  assert.throws(() => providerIdentityKey("http://appleid.apple.com", "subject"));
  assert.throws(() => providerIdentityKey("https://user@appleid.apple.com", "subject"));
  assert.throws(() => providerIdentityKey("https://appleid.apple.com", "bad\u0000subject"));
});
