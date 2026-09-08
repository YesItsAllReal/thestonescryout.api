import {
  AccountIdempotencyConflictError,
  AccountLinkAuthorizationError,
  AccountLinkDecisionRequiredError,
  AppleAccountService,
  AppleCredentialValidationError,
  AppleIdentityVerificationError,
  type AppleCredentialRequest,
  type LinkResolution,
} from "../accounts/apple-account-service.js";
import type { AuthenticatedHandlerDependencies, HttpHandler } from "./http-types.js";
import {
  authenticateRequest,
  hasOnlyKeys,
  limitPublicRequest,
  loggedProblem,
  logSuccess,
  parseJsonObject,
} from "./handler-support.js";
import { header, json, problemWithFields } from "./responses.js";

const signInRoute = "/v1/auth/apple";
const linkRoute = "/v1/account/link";

export function createAppleSignInHandler(
  service: AppleAccountService,
  dependencies: Pick<AuthenticatedHandlerDependencies, "rateLimiter" | "logger" | "now">,
): HttpHandler {
  return async (request) => {
    const context = await limitPublicRequest(request, signInRoute, dependencies);
    if (context.kind === "response") return context.response;
    try {
      const response = await service.signIn(
        parseAppleCredential(parseJsonObject(request.body)),
        header(request.headers, "idempotency-key") ?? "",
      );
      logSuccess(dependencies.logger, signInRoute, context.requestId, 200);
      return json(200, context.requestId, response);
    } catch (error: unknown) {
      return mapAppleError(error, signInRoute, context.requestId, dependencies.logger);
    }
  };
}

export function createAppleLinkHandler(
  service: AppleAccountService,
  dependencies: AuthenticatedHandlerDependencies,
): HttpHandler {
  return async (request) => {
    const context = await authenticateRequest(request, linkRoute, dependencies);
    if (context.kind === "response") return context.response;
    try {
      const body = parseJsonObject(request.body);
      if (!hasOnlyKeys(body, ["provider", "credential", "resolution"]) || body.provider !== "apple") {
        throw new SyntaxError("invalid account link request");
      }
      if (typeof body.credential !== "object" || body.credential === null || Array.isArray(body.credential)) {
        throw new SyntaxError("invalid account link credential");
      }
      const response = await service.linkGuest({
        principal: context.principal,
        credential: parseAppleCredential(body.credential as Record<string, unknown>),
        idempotencyKey: header(request.headers, "idempotency-key") ?? "",
        resolution: parseResolution(body.resolution),
      });
      logSuccess(dependencies.logger, linkRoute, context.requestId, 200);
      return json(200, context.requestId, response);
    } catch (error: unknown) {
      if (error instanceof AccountLinkDecisionRequiredError) {
        dependencies.logger.info({ event: "http_request", route: linkRoute, requestId: context.requestId, status: 409 });
        return problemWithFields(
          409,
          context.requestId,
          "Account link decision required",
          "/problems/account-link-decision-required",
          {
            conflictId: error.conflictId,
            allowedSaveChoices: ["preferGuestSave", "preferExistingSave"],
          },
        );
      }
      if (error instanceof AccountLinkAuthorizationError) {
        return loggedProblem(dependencies.logger, linkRoute, context.requestId, 403, "Guest session required", "/problems/forbidden");
      }
      return mapAppleError(error, linkRoute, context.requestId, dependencies.logger);
    }
  };
}

function mapAppleError(
  error: unknown,
  route: string,
  requestId: string,
  logger: AuthenticatedHandlerDependencies["logger"],
) {
  if (error instanceof SyntaxError || error instanceof AppleCredentialValidationError) {
    return loggedProblem(logger, route, requestId, 400, "Request validation failed", "/problems/validation");
  }
  if (error instanceof AppleIdentityVerificationError) {
    return loggedProblem(logger, route, requestId, 401, "Apple identity verification failed", "/problems/provider-verification");
  }
  if (error instanceof AccountIdempotencyConflictError) {
    return loggedProblem(logger, route, requestId, 409, "Idempotency key conflict", "/problems/idempotency-conflict");
  }
  return loggedProblem(logger, route, requestId, 500, "Service failure", "/problems/server-error");
}

function parseAppleCredential(value: Record<string, unknown>): AppleCredentialRequest {
  if (
    !hasOnlyKeys(value, ["identityToken", "nonce", "authorizationCode"]) ||
    typeof value.identityToken !== "string" ||
    typeof value.nonce !== "string" ||
    (value.authorizationCode !== undefined && typeof value.authorizationCode !== "string")
  ) {
    throw new SyntaxError("invalid Apple credential");
  }
  return {
    identityToken: value.identityToken,
    nonce: value.nonce,
    ...(value.authorizationCode === undefined ? {} : { authorizationCode: value.authorizationCode }),
  };
}

function parseResolution(value: unknown): LinkResolution | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SyntaxError("invalid link resolution");
  const resolution = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(resolution, ["conflictId", "saveChoice"]) ||
    typeof resolution.conflictId !== "string" ||
    (resolution.saveChoice !== "preferGuestSave" && resolution.saveChoice !== "preferExistingSave")
  ) {
    throw new SyntaxError("invalid link resolution");
  }
  return { conflictId: resolution.conflictId, saveChoice: resolution.saveChoice };
}
