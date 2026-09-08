import {
  AdRewardService,
  AppStoreNotificationService,
  CommerceIdempotencyConflictError,
  CommerceOwnershipError,
  CommerceProductNotFoundError,
  CommerceValidationError,
  CommerceVerificationError,
  PurchaseService,
  type AdPlacement,
  type AdRewardChoice,
  type CommerceGrantResult,
} from "../commerce/commerce-service.js";
import type { AuthenticatedHandlerDependencies, HttpHandler } from "./http-types.js";
import {
  authenticateRequest,
  hasOnlyKeys,
  limitPublicRequest,
  loggedProblem,
  logSuccess,
  parseJsonObject,
} from "./handler-support.js";
import { header, json } from "./responses.js";
import { publicLedgerEntries } from "./transport-mappers.js";

export function createPurchaseVerificationHandler(
  service: PurchaseService,
  dependencies: AuthenticatedHandlerDependencies,
): HttpHandler {
  return async (request) => {
    const route = "/v1/purchases/verify";
    const context = await authenticateRequest(request, route, dependencies);
    if (context.kind === "response") return context.response;
    try {
      const body = parseJsonObject(request.body);
      if (
        !hasOnlyKeys(body, ["signedTransaction", "clientBuild", "contentVersion"]) ||
        typeof body.signedTransaction !== "string" || typeof body.clientBuild !== "number" ||
        typeof body.contentVersion !== "string"
      ) throw new SyntaxError("invalid purchase verification request");
      const result = await service.verifyPurchase({
        principal: context.principal,
        signedTransaction: body.signedTransaction,
        clientBuild: body.clientBuild,
        contentVersion: body.contentVersion,
        idempotencyKey: header(request.headers, "idempotency-key") ?? "",
      });
      logSuccess(dependencies.logger, route, context.requestId, 200);
      return json(200, context.requestId, publicCommerceGrant(result));
    } catch (error: unknown) {
      return mapCommerceError(error, route, context.requestId, dependencies);
    }
  };
}

export function createAppStoreNotificationHandler(
  service: AppStoreNotificationService,
  dependencies: Pick<AuthenticatedHandlerDependencies, "rateLimiter" | "logger" | "now">,
): HttpHandler {
  return async (request) => {
    const route = "/v1/app-store/notifications";
    const context = await limitPublicRequest(request, route, dependencies);
    if (context.kind === "response") return context.response;
    try {
      const body = parseJsonObject(request.body);
      if (!hasOnlyKeys(body, ["signedPayload"]) || typeof body.signedPayload !== "string") {
        throw new SyntaxError("invalid App Store notification request");
      }
      const result = await service.process(body.signedPayload);
      logSuccess(dependencies.logger, route, context.requestId, 200);
      return json(200, context.requestId, result);
    } catch (error: unknown) {
      if (error instanceof SyntaxError || error instanceof CommerceValidationError) {
        return loggedProblem(dependencies.logger, route, context.requestId, 400, "Request validation failed", "/problems/validation");
      }
      if (error instanceof CommerceVerificationError) {
        return loggedProblem(dependencies.logger, route, context.requestId, 401, "Provider verification failed", "/problems/provider-verification");
      }
      return loggedProblem(dependencies.logger, route, context.requestId, 500, "Service failure", "/problems/server-error");
    }
  };
}

export function createAdRewardVerificationHandler(
  service: AdRewardService,
  dependencies: AuthenticatedHandlerDependencies,
): HttpHandler {
  return async (request) => {
    const route = "/v1/ads/reward/verify";
    const context = await authenticateRequest(request, route, dependencies);
    if (context.kind === "response") return context.response;
    try {
      const body = parseJsonObject(request.body);
      if (
        !hasOnlyKeys(body, ["placement", "rewardChoice", "claimId", "verificationPayload", "clientBuild", "contentVersion"]) ||
        !isPlacement(body.placement) || !isRewardChoice(body.rewardChoice) ||
        typeof body.claimId !== "string" || typeof body.verificationPayload !== "string" ||
        typeof body.clientBuild !== "number" || typeof body.contentVersion !== "string"
      ) throw new SyntaxError("invalid ad reward verification request");
      const result = await service.verifyReward({
        principal: context.principal,
        placement: body.placement,
        rewardChoice: body.rewardChoice,
        claimId: body.claimId,
        verificationPayload: body.verificationPayload,
        clientBuild: body.clientBuild,
        contentVersion: body.contentVersion,
        idempotencyKey: header(request.headers, "idempotency-key") ?? "",
      });
      logSuccess(dependencies.logger, route, context.requestId, 200);
      return json(200, context.requestId, publicCommerceGrant(result));
    } catch (error: unknown) {
      return mapCommerceError(error, route, context.requestId, dependencies);
    }
  };
}

function mapCommerceError(
  error: unknown,
  route: string,
  requestId: string,
  dependencies: AuthenticatedHandlerDependencies,
) {
  if (error instanceof SyntaxError || error instanceof CommerceValidationError || error instanceof CommerceProductNotFoundError) {
    return loggedProblem(dependencies.logger, route, requestId, 400, "Request validation failed", "/problems/validation");
  }
  if (error instanceof CommerceVerificationError) {
    return loggedProblem(dependencies.logger, route, requestId, 401, "Provider verification failed", "/problems/provider-verification");
  }
  if (error instanceof CommerceOwnershipError) {
    return loggedProblem(dependencies.logger, route, requestId, 403, "Verified event ownership mismatch", "/problems/forbidden");
  }
  if (error instanceof CommerceIdempotencyConflictError) {
    return loggedProblem(dependencies.logger, route, requestId, 409, "Idempotency key conflict", "/problems/idempotency-conflict");
  }
  return loggedProblem(dependencies.logger, route, requestId, 500, "Service failure", "/problems/server-error");
}

function publicCommerceGrant(result: CommerceGrantResult) {
  return {
    status: result.status,
    balance: result.balance,
    ledgerEntries: publicLedgerEntries(result.ledgerEntries),
    ...(result.entitlement === undefined ? {} : { entitlement: result.entitlement }),
  };
}

function isPlacement(value: unknown): value is AdPlacement {
  return value === "storeEnergy" || value === "storeCoins" || value === "energyEmpty";
}

function isRewardChoice(value: unknown): value is AdRewardChoice {
  return value === "energy20" || value === "coins100";
}
