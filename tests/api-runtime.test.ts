import assert from "node:assert/strict";
import test from "node:test";

import { createApplicationHandler, type ApplicationServices } from "../src/app/application.js";
import type { AccessTokenVerifier } from "../src/auth/authentication.js";
import { createApiRouter } from "../src/http/api-router.js";
import type { AuthenticatedHandlerDependencies, HttpRequest, StructuredLogger } from "../src/http/http-types.js";
import { MemoryFixedWindowRateLimiter } from "../src/http/memory-fixed-window-rate-limiter.js";
import { json } from "../src/http/responses.js";
import { adaptApiGatewayHttpApi } from "../src/lambda/api-gateway-http-api-adapter.js";

class CapturingLogger implements StructuredLogger {
  public readonly events: Array<Readonly<Record<string, string | number | boolean>>> = [];
  public info(event: Readonly<Record<string, string | number | boolean>>): void { this.events.push(event); }
  public error(event: Readonly<Record<string, string | number | boolean>>): void { this.events.push(event); }
}

test("API router dispatches by exact method and path", async () => {
  const logger = new CapturingLogger();
  const router = createApiRouter({
    logger,
    routes: [{
      method: "GET",
      path: "/example",
      handler: async () => json(200, "00000000-0000-4000-8000-000000000901", { matched: true }),
    }],
  });
  const response = await router({ rawPath: "/example", requestContext: { http: { method: "GET" } } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { matched: true });
});

test("API router distinguishes unknown routes from unsupported methods", async () => {
  const logger = new CapturingLogger();
  const router = createApiRouter({
    logger,
    routes: [{ method: "GET", path: "/known", handler: async () => json(200, crypto.randomUUID(), {}) }],
  });
  const unsupported = await router({ rawPath: "/known", requestContext: { http: { method: "POST" } } });
  const missing = await router({ rawPath: "/missing", requestContext: { http: { method: "GET" } } });
  assert.equal(unsupported.statusCode, 405);
  assert.equal(unsupported.headers.allow, "GET");
  assert.equal(missing.statusCode, 404);
});

test("API router rejects duplicate route definitions during composition", () => {
  const handler = async () => json(200, crypto.randomUUID(), {});
  assert.throws(() => createApiRouter({
    logger: new CapturingLogger(),
    routes: [
      { method: "GET", path: "/duplicate", handler },
      { method: "GET", path: "/duplicate", handler },
    ],
  }), /duplicate API route/);
});

test("API router converts an escaped handler failure to a privacy-safe 500", async () => {
  const logger = new CapturingLogger();
  const router = createApiRouter({
    logger,
    routes: [{ method: "GET", path: "/failure", handler: async () => { throw new Error("sensitive database detail"); } }],
  });
  const response = await router({ rawPath: "/failure", requestContext: { http: { method: "GET" } } });
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.includes("sensitive database detail"), false);
  assert.equal(JSON.stringify(logger.events).includes("sensitive database detail"), false);
});

test("API Gateway adapter maps base64 body, headers, cookies, query, and request context", async () => {
  let captured: HttpRequest | undefined;
  const lambda = adaptApiGatewayHttpApi(async (request) => {
    captured = request;
    return json(201, "00000000-0000-4000-8000-000000000902", { accepted: true });
  });
  const response = await lambda({
    version: "2.0",
    rawPath: "/v1/example",
    headers: { authorization: "Bearer test" },
    cookies: ["session=one", "preference=two"],
    queryStringParameters: { slot: "primary" },
    requestContext: { http: { method: "POST", sourceIp: "192.0.2.90" } },
    body: Buffer.from(JSON.stringify({ value: 1 }), "utf8").toString("base64"),
    isBase64Encoded: true,
  });
  assert.equal(captured?.rawPath, "/v1/example");
  assert.equal(captured?.body, JSON.stringify({ value: 1 }));
  assert.equal(captured?.headers?.cookie, "session=one; preference=two");
  assert.equal(captured?.queryStringParameters?.slot, "primary");
  assert.equal(captured?.requestContext?.http?.sourceIp, "192.0.2.90");
  assert.equal(response.statusCode, 201);
  assert.equal(response.isBase64Encoded, false);
});

test("application composition exposes health through the API Gateway adapter", async () => {
  const logger = new CapturingLogger();
  const tokenVerifier: AccessTokenVerifier = { async verify() { throw new Error("unused"); } };
  const dependencies: AuthenticatedHandlerDependencies = {
    tokenVerifier,
    rateLimiter: new MemoryFixedWindowRateLimiter(10, 60),
    logger,
    now: () => new Date("2026-09-01T13:00:00.000Z"),
  };
  // Health does not touch service ports; placeholders prove composition itself
  // does not eagerly access AWS/provider implementations.
  const services = {} as ApplicationServices;
  const lambda = adaptApiGatewayHttpApi(createApplicationHandler({ services, dependencies }));
  const response = await lambda({
    version: "2.0",
    rawPath: "/health",
    requestContext: { http: { method: "GET", sourceIp: "192.0.2.91" } },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { status: "ok" });
});
