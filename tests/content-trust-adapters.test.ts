import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { ConfiguredPublicUrlPolicy } from "../src/content/configured-public-url-policy.js";
import { canonicalJson, Ed25519DocumentVerifier } from "../src/content/ed25519-document-verifier.js";

const pair = generateKeyPairSync("ed25519");
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();

test("canonical JSON is deterministic across object insertion order", () => {
  const left = { z: [3, { b: true, a: "text" }], a: 1, nullable: null };
  const right = { nullable: null, a: 1, z: [3, { a: "text", b: true }] };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(canonicalJson(left), '{"a":1,"nullable":null,"z":[3,{"a":"text","b":true}]}');
});

test("Ed25519 verifier accepts only a configured key and exact canonical document", async () => {
  const document = { catalogVersion: "catalog-1", packs: [{ packId: "starter" }] };
  const signature = sign(null, Buffer.from(canonicalJson(document)), pair.privateKey).toString("base64url");
  const verifier = new Ed25519DocumentVerifier({ "content-key-1": publicKey });
  assert.equal(await verifier.verify({ document, keyId: "content-key-1", algorithm: "ed25519", signature }), true);
  assert.equal(await verifier.verify({ document: { ...document, catalogVersion: "catalog-2" }, keyId: "content-key-1", algorithm: "ed25519", signature }), false);
  assert.equal(await verifier.verify({ document, keyId: "unknown", algorithm: "ed25519", signature }), false);
  assert.equal(await verifier.verify({ document, keyId: "content-key-1", algorithm: "ed25519", signature: "invalid" }), false);
});

test("Ed25519 verifier rejects unsupported document values without throwing details", async () => {
  const verifier = new Ed25519DocumentVerifier({ "content-key-1": publicKey });
  assert.equal(await verifier.verify({ document: { invalid: Number.NaN }, keyId: "content-key-1", algorithm: "ed25519", signature: "a".repeat(86) }), false);
  assert.throws(() => canonicalJson({ invalid: undefined }), /unsupported/);
  assert.throws(() => canonicalJson({ invalid: 1n }), /unsupported/);
});

test("Ed25519 verifier construction rejects empty, malformed, and wrong-type keys", () => {
  assert.throws(() => new Ed25519DocumentVerifier({}), /not configured/);
  assert.throws(() => new Ed25519DocumentVerifier({ "unsafe/key": publicKey }), /configuration/);
  assert.throws(() => new Ed25519DocumentVerifier({ key: "not-a-key" }), /configuration/);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.throws(() => new Ed25519DocumentVerifier({ key: rsa }), /configuration/);
});

test("URL policy allows only content beneath the configured HTTPS path", () => {
  const policy = new ConfiguredPublicUrlPolicy("https://cdn.example.test/game", ["https://www.example.test"]);
  assert.equal(policy.allows("https://cdn.example.test/game/packs/starter.zip", "content"), true);
  assert.equal(policy.allows("https://cdn.example.test/game", "content"), false);
  assert.equal(policy.allows("https://cdn.example.test/other/file.zip", "content"), false);
  assert.equal(policy.allows("https://cdn.example.test/game/file.zip?token=secret", "content"), false);
  assert.equal(policy.allows("http://cdn.example.test/game/file.zip", "content"), false);
  assert.equal(policy.allows("https://user@cdn.example.test/game/file.zip", "content"), false);
});

test("URL policy uses exact origins for external links", () => {
  const policy = new ConfiguredPublicUrlPolicy("https://cdn.example.test", ["https://www.example.test", "https://support.example.test:8443"]);
  assert.equal(policy.allows("https://www.example.test/privacy?locale=en", "externalLink"), true);
  assert.equal(policy.allows("https://support.example.test:8443/help", "externalLink"), true);
  assert.equal(policy.allows("https://support.example.test/help", "externalLink"), false);
  assert.equal(policy.allows("https://www.example.test.evil.invalid/privacy", "externalLink"), false);
  assert.equal(policy.allows("https://www.example.test/privacy#section", "externalLink"), false);
});

test("URL policy construction rejects unsafe configuration", () => {
  assert.throws(() => new ConfiguredPublicUrlPolicy("http://cdn.example.test", []), /HTTPS/);
  assert.throws(() => new ConfiguredPublicUrlPolicy("https://user@cdn.example.test", []), /HTTPS/);
  assert.throws(() => new ConfiguredPublicUrlPolicy("https://cdn.example.test", ["https://links.example.test/path"]), /absolute HTTPS/);
});
