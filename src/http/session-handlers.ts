import {
  SessionCredentialInvalidError,
  SessionCredentialOwnershipError,
  SessionLifecycleService,
  SessionLifecycleValidationError,
} from "../auth/session-lifecycle-service.js";
import type { AuthenticatedHandlerDependencies, HttpHandler } from "./http-types.js";
import { authenticateRequest, hasOnlyKeys, limitPublicRequest, loggedProblem, logSuccess, parseJsonObject } from "./handler-support.js";
import { json } from "./responses.js";

const refreshRoute = "/v1/session/refresh";
const revokeRoute = "/v1/session/revoke";

export function createRefreshSessionHandler(
  service: SessionLifecycleService,
  dependencies: Pick<AuthenticatedHandlerDependencies, "rateLimiter" | "logger" | "now">,
): HttpHandler {
  return async (request) => {
    const limited = await limitPublicRequest(request, refreshRoute, dependencies);
    if (limited.kind === "response") return limited.response;
    try {
      const tokens = await service.refresh(parseRefreshToken(request.body));
      logSuccess(dependencies.logger, refreshRoute, limited.requestId, 200);
      return json(200, limited.requestId, tokens);
    } catch (error: unknown) {
      if (error instanceof SyntaxError || error instanceof SessionLifecycleValidationError) {
        return loggedProblem(dependencies.logger, refreshRoute, limited.requestId, 400, "Request validation failed", "/problems/validation");
      }
      if (error instanceof SessionCredentialInvalidError) {
        return loggedProblem(dependencies.logger, refreshRoute, limited.requestId, 401, "Authentication required", "/problems/authentication-required");
      }
      return loggedProblem(dependencies.logger, refreshRoute, limited.requestId, 500, "Service failure", "/problems/server-error");
    }
  };
}

export function createRevokeSessionHandler(
  service: SessionLifecycleService,
  dependencies: AuthenticatedHandlerDependencies,
): HttpHandler {
  return async (request) => {
    const context = await authenticateRequest(request, revokeRoute, dependencies);
    if (context.kind === "response") return context.response;
    try {
      await service.revoke(context.principal, parseRefreshToken(request.body));
      logSuccess(dependencies.logger, revokeRoute, context.requestId, 204);
      return {
        statusCode: 204,
        headers: { "x-request-id": context.requestId },
        body: "",
      };
    } catch (error: unknown) {
      if (error instanceof SyntaxError || error instanceof SessionLifecycleValidationError) {
        return loggedProblem(dependencies.logger, revokeRoute, context.requestId, 400, "Request validation failed", "/problems/validation");
      }
      if (error instanceof SessionCredentialInvalidError) {
        return loggedProblem(dependencies.logger, revokeRoute, context.requestId, 401, "Authentication required", "/problems/authentication-required");
      }
      if (error instanceof SessionCredentialOwnershipError) {
        return loggedProblem(dependencies.logger, revokeRoute, context.requestId, 403, "Operation forbidden", "/problems/forbidden");
      }
      return loggedProblem(dependencies.logger, revokeRoute, context.requestId, 500, "Service failure", "/problems/server-error");
    }
  };
}

function parseRefreshToken(body: string | undefined): string {
  const value = parseJsonObject(body);
  if (!hasOnlyKeys(value, ["refreshToken"]) || typeof value.refreshToken !== "string") {
    throw new SyntaxError("invalid session credential request");
  }
  return value.refreshToken;
}
