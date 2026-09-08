import {
  AuthenticationRequiredError,
  requirePrincipal,
  type AuthenticatedPrincipal,
} from "../auth/authentication.js";
import type {
  AuthenticatedHandlerDependencies,
  HttpRequest,
  HttpResponse,
  StructuredLogger,
} from "./http-types.js";
import { header, problem, requestIdFrom } from "./responses.js";

export type AuthenticatedContextResult =
  | { readonly kind: "authorized"; readonly principal: AuthenticatedPrincipal; readonly requestId: string }
  | { readonly kind: "response"; readonly response: HttpResponse };

export type PublicContextResult =
  | { readonly kind: "allowed"; readonly requestId: string }
  | { readonly kind: "response"; readonly response: HttpResponse };

export async function limitPublicRequest(
  request: HttpRequest,
  route: string,
  dependencies: Pick<AuthenticatedHandlerDependencies, "rateLimiter" | "logger" | "now">,
): Promise<PublicContextResult> {
  const requestId = requestIdFrom(request.headers);
  const limited = await dependencies.rateLimiter.allow({
    route,
    discriminator: request.requestContext?.http?.sourceIp ?? "unknown",
    now: dependencies.now(),
  });
  if (limited.allowed) return { kind: "allowed", requestId };
  return {
    kind: "response",
    response: loggedProblem(
      dependencies.logger,
      route,
      requestId,
      429,
      "Request rate exceeded",
      "/problems/rate-limited",
      limited.retryAfterSeconds ?? 60,
    ),
  };
}

export async function authenticateRequest(
  request: HttpRequest,
  route: string,
  dependencies: AuthenticatedHandlerDependencies,
): Promise<AuthenticatedContextResult> {
  const requestId = requestIdFrom(request.headers);
  const limited = await dependencies.rateLimiter.allow({
    route,
    discriminator: request.requestContext?.http?.sourceIp ?? "unknown",
    now: dependencies.now(),
  });
  if (!limited.allowed) {
    return {
      kind: "response",
      response: loggedProblem(
        dependencies.logger,
        route,
        requestId,
        429,
        "Request rate exceeded",
        "/problems/rate-limited",
        limited.retryAfterSeconds ?? 60,
      ),
    };
  }
  try {
    const principal = await requirePrincipal({
      authorizationHeader: header(request.headers, "authorization"),
      verifier: dependencies.tokenVerifier,
      now: dependencies.now(),
    });
    return { kind: "authorized", principal, requestId };
  } catch (error: unknown) {
    if (!(error instanceof AuthenticationRequiredError)) throw error;
    return {
      kind: "response",
      response: loggedProblem(
        dependencies.logger,
        route,
        requestId,
        401,
        "Authentication required",
        "/problems/authentication-required",
      ),
    };
  }
}

export function parseJsonObject(body: string | undefined): Record<string, unknown> {
  if (body === undefined) throw new SyntaxError("missing JSON body");
  const value: unknown = JSON.parse(body);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SyntaxError("JSON body must be an object");
  }
  return value as Record<string, unknown>;
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function loggedProblem(
  logger: StructuredLogger,
  route: string,
  requestId: string,
  status: number,
  title: string,
  type: string,
  retryAfterSeconds?: number,
): HttpResponse {
  const event = { event: "http_request", route, requestId, status };
  if (status >= 500) logger.error(event); else logger.info(event);
  return problem(status, requestId, title, type, undefined, retryAfterSeconds);
}

export function logSuccess(
  logger: StructuredLogger,
  route: string,
  requestId: string,
  status: number,
): void {
  logger.info({ event: "http_request", route, requestId, status });
}
