import {
  AccountDeletionAuthorizationError,
  AccountDeletionIdempotencyConflictError,
  AccountDeletionValidationError,
  AccountNotFoundError,
  AccountService,
  type AccountDeletionRequest,
} from "../accounts/account-service.js";
import type { AuthenticatedHandlerDependencies, HttpHandler } from "./http-types.js";
import { authenticateRequest, hasOnlyKeys, loggedProblem, logSuccess, parseJsonObject } from "./handler-support.js";
import { header, json } from "./responses.js";

const route = "/v1/account";

export function createGetAccountHandler(
  service: AccountService,
  dependencies: AuthenticatedHandlerDependencies,
): HttpHandler {
  return async (request) => {
    const context = await authenticateRequest(request, route, dependencies);
    if (context.kind === "response") return context.response;
    try {
      const profile = await service.getProfile(context.principal);
      logSuccess(dependencies.logger, route, context.requestId, 200);
      return json(200, context.requestId, profile);
    } catch (error: unknown) {
      if (error instanceof AccountNotFoundError) {
        return loggedProblem(dependencies.logger, route, context.requestId, 404, "Account not found", "/problems/not-found");
      }
      return loggedProblem(dependencies.logger, route, context.requestId, 500, "Service failure", "/problems/server-error");
    }
  };
}

export function createDeleteAccountHandler(
  service: AccountService,
  dependencies: AuthenticatedHandlerDependencies,
): HttpHandler {
  return async (request) => {
    const context = await authenticateRequest(request, route, dependencies);
    if (context.kind === "response") return context.response;
    try {
      const deletionRequest = parseDeletionRequest(request.body);
      const receipt = await service.requestDeletion({
        principal: context.principal,
        request: deletionRequest,
        idempotencyKey: header(request.headers, "idempotency-key") ?? "",
      });
      logSuccess(dependencies.logger, route, context.requestId, 202);
      return json(202, context.requestId, receipt);
    } catch (error: unknown) {
      if (error instanceof SyntaxError || error instanceof AccountDeletionValidationError) {
        return loggedProblem(dependencies.logger, route, context.requestId, 400, "Request validation failed", "/problems/validation");
      }
      if (error instanceof AccountDeletionAuthorizationError) {
        return loggedProblem(dependencies.logger, route, context.requestId, 403, "Reauthentication required", "/problems/reauthentication-required");
      }
      if (error instanceof AccountNotFoundError) {
        return loggedProblem(dependencies.logger, route, context.requestId, 404, "Account not found", "/problems/not-found");
      }
      if (error instanceof AccountDeletionIdempotencyConflictError) {
        return loggedProblem(dependencies.logger, route, context.requestId, 409, "Idempotency key conflict", "/problems/idempotency-conflict");
      }
      return loggedProblem(dependencies.logger, route, context.requestId, 500, "Service failure", "/problems/server-error");
    }
  };
}

function parseDeletionRequest(body: string | undefined): AccountDeletionRequest {
  const value = parseJsonObject(body);
  if (!hasOnlyKeys(value, ["confirmation", "reauthentication"]) || value.confirmation !== "deleteAccount") {
    throw new SyntaxError("invalid deletion request");
  }
  if (value.reauthentication === undefined) return { confirmation: "deleteAccount" };
  if (typeof value.reauthentication !== "object" || value.reauthentication === null || Array.isArray(value.reauthentication)) {
    throw new SyntaxError("invalid reauthentication");
  }
  const reauthentication = value.reauthentication as Record<string, unknown>;
  if (!hasOnlyKeys(reauthentication, ["provider", "credential"]) || reauthentication.provider !== "apple") {
    throw new SyntaxError("invalid reauthentication provider");
  }
  if (typeof reauthentication.credential !== "object" || reauthentication.credential === null || Array.isArray(reauthentication.credential)) {
    throw new SyntaxError("invalid reauthentication credential");
  }
  const credential = reauthentication.credential as Record<string, unknown>;
  if (
    !hasOnlyKeys(credential, ["identityToken", "nonce", "authorizationCode"]) ||
    typeof credential.identityToken !== "string" ||
    typeof credential.nonce !== "string" ||
    (credential.authorizationCode !== undefined && typeof credential.authorizationCode !== "string")
  ) {
    throw new SyntaxError("invalid reauthentication credential");
  }
  return {
    confirmation: "deleteAccount",
    reauthentication: {
      provider: "apple",
      identityToken: credential.identityToken,
      nonce: credential.nonce,
      ...(credential.authorizationCode === undefined ? {} : { authorizationCode: credential.authorizationCode }),
    },
  };
}
