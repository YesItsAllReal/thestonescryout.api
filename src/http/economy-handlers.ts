import {
  EconomyClaimRejectedError,
  EconomyIdempotencyConflictError,
  EconomyInsufficientFundsError,
  EconomyNotFoundError,
  EconomyRevisionConflictError,
  EconomyService,
  EconomyValidationError,
  type EconomyMutationResult,
  type RewardClaimType,
  type SpendAction,
} from "../economy/economy-service.js";
import { EntitlementService } from "../economy/entitlement-service.js";
import type { AuthenticatedHandlerDependencies, HttpHandler } from "./http-types.js";
import { authenticateRequest, hasOnlyKeys, loggedProblem, logSuccess, parseJsonObject } from "./handler-support.js";
import { header, json, problemWithFields } from "./responses.js";
import { publicLedgerEntries } from "./transport-mappers.js";

export function createGetEconomyHandler(service: EconomyService, dependencies: AuthenticatedHandlerDependencies): HttpHandler {
  return async (request) => {
    const route = "/v1/economy";
    const context = await authenticateRequest(request, route, dependencies);
    if (context.kind === "response") return context.response;
    try {
      const balance = await service.getBalance(context.principal);
      logSuccess(dependencies.logger, route, context.requestId, 200);
      return json(200, context.requestId, balance);
    } catch (error: unknown) {
      return mapEconomyError(error, route, context.requestId, dependencies);
    }
  };
}

export function createSpendHandler(service: EconomyService, dependencies: AuthenticatedHandlerDependencies): HttpHandler {
  return async (request) => {
    const route = "/v1/spend";
    const context = await authenticateRequest(request, route, dependencies);
    if (context.kind === "response") return context.response;
    try {
      const body = parseJsonObject(request.body);
      if (
        !hasOnlyKeys(body, ["action", "referenceId", "expectedRevision", "clientBuild", "contentVersion"]) ||
        !isSpendAction(body.action) || typeof body.referenceId !== "string" ||
        typeof body.expectedRevision !== "number" || typeof body.clientBuild !== "number" ||
        typeof body.contentVersion !== "string"
      ) throw new SyntaxError("invalid spend request");
      const result = await service.spend({
        principal: context.principal,
        action: body.action,
        referenceId: body.referenceId,
        expectedRevision: body.expectedRevision,
        clientBuild: body.clientBuild,
        contentVersion: body.contentVersion,
        idempotencyKey: header(request.headers, "idempotency-key") ?? "",
      });
      logSuccess(dependencies.logger, route, context.requestId, 200);
      return json(200, context.requestId, publicMutation(result));
    } catch (error: unknown) {
      return mapEconomyError(error, route, context.requestId, dependencies);
    }
  };
}

export function createRewardClaimHandler(service: EconomyService, dependencies: AuthenticatedHandlerDependencies): HttpHandler {
  return async (request) => {
    const route = "/v1/rewards/claim";
    const context = await authenticateRequest(request, route, dependencies);
    if (context.kind === "response") return context.response;
    try {
      const body = parseJsonObject(request.body);
      if (
        !hasOnlyKeys(body, ["claimType", "claimId", "claimToken", "clientBuild", "contentVersion"]) ||
        !isClaimType(body.claimType) || typeof body.claimId !== "string" ||
        (body.claimToken !== undefined && typeof body.claimToken !== "string") ||
        typeof body.clientBuild !== "number" || typeof body.contentVersion !== "string"
      ) throw new SyntaxError("invalid reward claim request");
      const result = await service.claimReward({
        principal: context.principal,
        claimType: body.claimType,
        claimId: body.claimId,
        ...(body.claimToken === undefined ? {} : { claimToken: body.claimToken }),
        clientBuild: body.clientBuild,
        contentVersion: body.contentVersion,
        idempotencyKey: header(request.headers, "idempotency-key") ?? "",
      });
      logSuccess(dependencies.logger, route, context.requestId, 200);
      return json(200, context.requestId, publicMutation(result));
    } catch (error: unknown) {
      return mapEconomyError(error, route, context.requestId, dependencies);
    }
  };
}

export function createGetEntitlementsHandler(service: EntitlementService, dependencies: AuthenticatedHandlerDependencies): HttpHandler {
  return async (request) => {
    const route = "/v1/entitlements";
    const context = await authenticateRequest(request, route, dependencies);
    if (context.kind === "response") return context.response;
    try {
      const entitlements = await service.list(context.principal);
      logSuccess(dependencies.logger, route, context.requestId, 200);
      return json(200, context.requestId, { entitlements });
    } catch {
      return loggedProblem(dependencies.logger, route, context.requestId, 500, "Service failure", "/problems/server-error");
    }
  };
}

function mapEconomyError(error: unknown, route: string, requestId: string, dependencies: AuthenticatedHandlerDependencies) {
  if (error instanceof SyntaxError || error instanceof EconomyValidationError) {
    return loggedProblem(dependencies.logger, route, requestId, 400, "Request validation failed", "/problems/validation");
  }
  if (error instanceof EconomyClaimRejectedError) {
    return loggedProblem(dependencies.logger, route, requestId, 403, "Reward claim rejected", "/problems/claim-rejected");
  }
  if (error instanceof EconomyNotFoundError) {
    return loggedProblem(dependencies.logger, route, requestId, 404, "Economy not found", "/problems/not-found");
  }
  if (error instanceof EconomyRevisionConflictError) {
    dependencies.logger.info({ event: "http_request", route, requestId, status: 409 });
    return problemWithFields(409, requestId, "Economy revision conflict", "/problems/economy-revision-conflict", { currentRevision: error.currentRevision });
  }
  if (error instanceof EconomyInsufficientFundsError) {
    return loggedProblem(dependencies.logger, route, requestId, 409, "Insufficient funds", "/problems/insufficient-funds");
  }
  if (error instanceof EconomyIdempotencyConflictError) {
    return loggedProblem(dependencies.logger, route, requestId, 409, "Idempotency key conflict", "/problems/idempotency-conflict");
  }
  return loggedProblem(dependencies.logger, route, requestId, 500, "Service failure", "/problems/server-error");
}

function publicMutation(result: EconomyMutationResult) {
  return {
    balance: result.balance,
    ledgerEntries: publicLedgerEntries(result.ledgerEntries),
  };
}

function isSpendAction(value: unknown): value is SpendAction {
  return value === "inventoryExpansion" || value === "storeOffer" || value === "energyRefill" || value === "cooldownSkip";
}

function isClaimType(value: unknown): value is RewardClaimType {
  return value === "order" || value === "spotlight" || value === "dailyGift" || value === "quiz" || value === "ad" || value === "event";
}
