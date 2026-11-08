import {
  GuestSessionIdempotencyConflictError,
  GuestSessionService,
  GuestSessionValidationError,
  type GuestSessionRequest,
} from "../accounts/guest-session-service.js";
import type { HttpHandler, RateLimiter, StructuredLogger } from "./http-types.js";
import { header, json, problem, requestIdFrom } from "./responses.js";

const route = "/v1/guest/session";

export function createGuestSessionHandler(input: {
  readonly service: GuestSessionService;
  readonly rateLimiter: RateLimiter;
  readonly logger: StructuredLogger;
  readonly now: () => Date;
}): HttpHandler {
  return async (request) => {
    const requestId = requestIdFrom(request.headers);
    const rateLimit = await input.rateLimiter.allow({
      route,
      discriminator: request.requestContext?.http?.sourceIp ?? "unknown",
      now: input.now(),
    });
    if (!rateLimit.allowed) {
      const retryAfter = rateLimit.retryAfterSeconds ?? 60;
      input.logger.info({ event: "http_request", route, requestId, status: 429 });
      return problem(429, requestId, "Request rate exceeded", "/problems/rate-limited", undefined, retryAfter);
    }

    try {
      const idempotencyKey = header(request.headers, "idempotency-key") ?? "";
      const body = parseBody(request.body);
      const response = await input.service.create(body, idempotencyKey);
      input.logger.info({ event: "http_request", route, requestId, status: 201 });
      return json(201, requestId, response);
    } catch (error: unknown) {
      if (error instanceof GuestSessionValidationError || error instanceof SyntaxError) {
        input.logger.info({ event: "http_request", route, requestId, status: 400, failureClass: "request_validation" });
        return problem(400, requestId, "Request validation failed", "/problems/validation");
      }
      if (error instanceof GuestSessionIdempotencyConflictError) {
        input.logger.info({ event: "http_request", route, requestId, status: 409, failureClass: "idempotency_conflict" });
        return problem(409, requestId, "Idempotency key conflict", "/problems/idempotency-conflict");
      }
      input.logger.error({ event: "http_request_failed", route, requestId, status: 500, failureClass: "guest_session_service" });
      return problem(500, requestId, "Service failure", "/problems/server-error");
    }
  };
}

function parseBody(body: string | undefined): GuestSessionRequest {
  if (body === undefined) throw new SyntaxError("missing JSON body");
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SyntaxError("JSON body must be an object");
  }
  const candidate = parsed as Record<string, unknown>;
  const expected = ["installationId", "locale", "appBuild", "platform"];
  if (Object.keys(candidate).some((key) => !expected.includes(key))) {
    throw new SyntaxError("JSON body contains an unknown property");
  }
  if (
    typeof candidate.installationId !== "string" ||
    typeof candidate.locale !== "string" ||
    typeof candidate.appBuild !== "number" ||
    (candidate.platform !== "ios" && candidate.platform !== "android")
  ) {
    throw new SyntaxError("JSON body has invalid property types");
  }
  return {
    installationId: candidate.installationId,
    locale: candidate.locale,
    appBuild: candidate.appBuild,
    platform: candidate.platform,
  };
}
