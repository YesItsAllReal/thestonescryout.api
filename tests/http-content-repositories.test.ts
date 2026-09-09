import assert from "node:assert/strict";
import test from "node:test";
import { ContentUnavailableError } from "../src/content/content-service.js";
import { HttpContentCatalogRepository, HttpRemoteConfigurationRepository } from "../src/content/http-content-repositories.js";

const catalog = { catalogVersion: "catalog-1", channel: "development", packs: [] };

test("HTTP catalog repository fetches a deterministic same-origin static path", async () => {
  let requested: URL | undefined;
  let init: RequestInit | undefined;
  const fetcher = (async (input: URL | RequestInfo, requestInit?: RequestInit) => {
    requested = input as URL;
    init = requestInit;
    return new Response(JSON.stringify(catalog), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const repository = new HttpContentCatalogRepository({
    baseUrl: "https://cdn.example.test/game/", environment: "development", fetch: fetcher,
  });
  const result = await repository.get({ platform: "ios", appBuild: 42, locale: "en-US", channel: "development" });
  assert.deepEqual(result, catalog);
  assert.equal(requested?.toString(), "https://cdn.example.test/game/catalogs/development/ios/en-US/latest.json");
  assert.equal(init?.method, "GET");
  assert.equal(init?.redirect, "error");
  assert.ok(init?.signal instanceof AbortSignal);
});

test("HTTP configuration repository includes the injected environment in its path", async () => {
  let requested = "";
  const fetcher = (async (input: URL | RequestInfo) => {
    requested = input.toString();
    return new Response("{}", { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  }) as typeof fetch;
  const repository = new HttpRemoteConfigurationRepository({
    baseUrl: "https://cdn.example.test", environment: "staging", fetch: fetcher,
  });
  assert.deepEqual(await repository.get({ platform: "android", appBuild: 7, locale: "fr-CA" }), {});
  assert.equal(requested, "https://cdn.example.test/config/staging/android/fr-CA/latest.json");
});

test("HTTP content repositories map 404 to unavailable content without parsing a body", async () => {
  const fetcher = (async () => new Response("not json", { status: 404 })) as typeof fetch;
  const repository = new HttpContentCatalogRepository({ baseUrl: "https://cdn.example.test", environment: "development", fetch: fetcher });
  assert.equal(await repository.get({ platform: "ios", appBuild: 1, locale: "en", channel: "development" }), undefined);
});

test("HTTP content repositories fail closed on network, status, type, and JSON errors", async () => {
  const request = { platform: "ios" as const, appBuild: 1, locale: "en", channel: "development" as const };
  const cases: Array<typeof fetch> = [
    (async () => { throw new Error("network details"); }) as typeof fetch,
    (async () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } })) as typeof fetch,
    (async () => new Response("{}", { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch,
    (async () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
    (async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
  ];
  for (const fetcher of cases) {
    const repository = new HttpContentCatalogRepository({ baseUrl: "https://cdn.example.test", environment: "development", fetch: fetcher });
    await assert.rejects(repository.get(request), ContentUnavailableError);
  }
});

test("HTTP content repositories enforce declared and actual response-size limits", async () => {
  const request = { platform: "ios" as const, appBuild: 1, locale: "en", channel: "development" as const };
  const declared = (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": "2048" } })) as typeof fetch;
  const actual = (async () => new Response(JSON.stringify({ value: "x".repeat(2000) }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  for (const fetcher of [declared, actual]) {
    const repository = new HttpContentCatalogRepository({ baseUrl: "https://cdn.example.test", environment: "development", fetch: fetcher, maximumResponseBytes: 1024 });
    await assert.rejects(repository.get(request), /too large/);
  }
});

test("HTTP content repository construction rejects unsafe origins and bounds", () => {
  assert.throws(() => new HttpContentCatalogRepository({ baseUrl: "http://cdn.example.test", environment: "development" }), /absolute HTTPS/);
  assert.throws(() => new HttpContentCatalogRepository({ baseUrl: "https://user@cdn.example.test", environment: "development" }), /absolute HTTPS/);
  assert.throws(() => new HttpContentCatalogRepository({ baseUrl: "https://cdn.example.test?secret=x", environment: "development" }), /absolute HTTPS/);
  assert.throws(() => new HttpContentCatalogRepository({ baseUrl: "https://cdn.example.test", environment: "development", timeoutMilliseconds: 31_000 }), /configuration/);
});
