import assert from "node:assert/strict";
import test from "node:test";

import {
  ContentCatalogService,
  ContentIntegrityError,
  ContentPolicyError,
  RemoteConfigurationService,
  type PublicUrlPolicy,
  type SignedContentCatalog,
  type SignedDocumentVerifier,
  type SignedRemoteConfiguration,
} from "../src/content/content-service.js";
import {
  MemoryContentCatalogRepository,
  MemoryRemoteConfigurationRepository,
} from "../src/content/memory-content-repositories.js";

const validSignature = "a".repeat(64);
const signatures: SignedDocumentVerifier = {
  async verify(input) { return input.signature === validSignature; },
};
const urls: PublicUrlPolicy = {
  allows(value, purpose) {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return false;
    return purpose === "content"
      ? parsed.hostname === "cdn.stones.example"
      : parsed.hostname === "www.stones.example";
  },
};

const catalog: SignedContentCatalog = {
  catalogVersion: "catalog-1",
  channel: "production",
  publishedAt: "2026-08-31T17:00:00.000Z",
  packs: [{
    packId: "starter-en",
    version: "1.0.0",
    minimumAppBuild: 1,
    locale: "en-US",
    type: "starter",
    displayName: "Starter",
    compressedSize: 1_000,
    uncompressedSize: 2_000,
    sha256: "b".repeat(64),
    downloadUrl: "https://cdn.stones.example/packs/starter-en-1.zip",
    publishedAt: "2026-08-31T17:00:00.000Z",
    editorialStatus: "approved",
  }],
  keyId: "content-key-1",
  signatureAlgorithm: "ed25519",
  signature: validSignature,
};

const config: SignedRemoteConfiguration = {
  configVersion: "config-1",
  minimumAppBuild: 1,
  activeCatalogVersion: "catalog-1",
  featureFlags: {
    googleSignIn: false,
    rewardedAds: false,
    weekendDig: false,
    quizzes: true,
    gameCenter: true,
    remoteContent: true,
    purchases: true,
    accountSync: true,
    ministryLinks: true,
  },
  economy: {
    startingCoins: 250,
    startingGems: 25,
    startingEnergy: 80,
    energyCap: 100,
    energyRegenerationSeconds: 120,
    dailyGiftCoins: 50,
    dailyGiftEnergy: 20,
    rewardedCoins: 100,
    rewardedEnergy: 20,
    rewardedDailyCap: 5,
  },
  maintenanceMessage: null,
  links: {
    privacyUrl: "https://www.stones.example/privacy",
    termsUrl: "https://www.stones.example/terms",
    supportUrl: "https://www.stones.example/support",
  },
  publishedAt: "2026-08-31T17:00:00.000Z",
  keyId: "config-key-1",
  signatureAlgorithm: "ed25519",
  signature: validSignature,
};

const request = { platform: "ios" as const, appBuild: 1, locale: "en-US", channel: "production" as const };

test("serves a signed catalog containing a permanent approved starter pack", async () => {
  const result = await new ContentCatalogService(
    new MemoryContentCatalogRepository(catalog),
    signatures,
    urls,
  ).get(request);
  assert.equal(result.catalogVersion, "catalog-1");
  assert.equal(result.packs[0]?.type, "starter");
});

test("rejects a catalog when its detached signature verification fails", async () => {
  await assert.rejects(
    new ContentCatalogService(
      new MemoryContentCatalogRepository({ ...catalog, signature: "c".repeat(64) }),
      signatures,
      urls,
    ).get(request),
    ContentIntegrityError,
  );
});

test("rejects content downloads outside the approved HTTPS CDN policy", async () => {
  const unsafe = {
    ...catalog,
    packs: [{ ...catalog.packs[0]!, downloadUrl: "http://untrusted.example/pack.zip" }],
  };
  await assert.rejects(
    new ContentCatalogService(new MemoryContentCatalogRepository(unsafe), signatures, urls).get(request),
    ContentPolicyError,
  );
});

test("rejects a remote catalog that removes the starter pack", async () => {
  await assert.rejects(
    new ContentCatalogService(
      new MemoryContentCatalogRepository({ ...catalog, packs: [{ ...catalog.packs[0]!, type: "campaign" }] }),
      signatures,
      urls,
    ).get(request),
    ContentPolicyError,
  );
});

test("serves signed configuration only after enforcing client-safe bounds", async () => {
  const result = await new RemoteConfigurationService(
    new MemoryRemoteConfigurationRepository(config),
    signatures,
    urls,
  ).get({ platform: "ios", appBuild: 1, locale: "en-US" });
  assert.equal(result.economy.energyCap, 100);
  assert.equal(result.featureFlags.accountSync, true);
});

test("rejects unsafe economy values even when the document signature is accepted", async () => {
  const unsafe = { ...config, economy: { ...config.economy, rewardedDailyCap: 10_000 } };
  await assert.rejects(
    new RemoteConfigurationService(
      new MemoryRemoteConfigurationRepository(unsafe),
      signatures,
      urls,
    ).get({ platform: "ios", appBuild: 1, locale: "en-US" }),
    ContentPolicyError,
  );
});

test("rejects configuration links outside the approved HTTPS external-link policy", async () => {
  const unsafe = { ...config, links: { ...config.links, supportUrl: "https://lookalike.example/support" } };
  await assert.rejects(
    new RemoteConfigurationService(
      new MemoryRemoteConfigurationRepository(unsafe),
      signatures,
      urls,
    ).get({ platform: "ios", appBuild: 1, locale: "en-US" }),
    ContentPolicyError,
  );
});
