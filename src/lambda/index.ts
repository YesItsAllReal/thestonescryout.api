import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { adaptApiGatewayHttpApi } from "./api-gateway-http-api-adapter.js";
import { createApiRouter } from "../http/api-router.js";
import { createAwsIdentityServices } from "../app/aws-identity-services.js";
import { MemoryFixedWindowRateLimiter } from "../http/memory-fixed-window-rate-limiter.js";
import type { AuthenticatedHandlerDependencies, HttpHandler, HttpRequest, StructuredLogger } from "../http/http-types.js";
import { loadRuntimeConfiguration } from "../config/environment.js";
import { createHealthHandler } from "../http/health-handler.js";
import { createGuestSessionHandler } from "../http/guest-session-handler.js";
import { createAppleSignInHandler, createAppleLinkHandler } from "../http/apple-account-handlers.js";
import { createGetAccountHandler } from "../http/account-handlers.js";
import { createGetSaveHandler, createPutSaveHandler } from "../http/save-handlers.js";
import { createRefreshSessionHandler, createRevokeSessionHandler } from "../http/session-handlers.js";
import { createGetEconomyHandler, createGetEntitlementsHandler } from "../http/economy-handlers.js";
import { EconomyService } from "../economy/economy-service.js";
import { EntitlementService } from "../economy/entitlement-service.js";
import { authenticateRequest, limitPublicRequest, loggedProblem } from "../http/handler-support.js";

// Fail closed: if any required environment variable is missing or invalid,
// the Lambda will throw at cold-start and return 500 for all requests.
// There is no in-memory fallback — a silent fallback would lose player
// sessions and progress after a Lambda restart.
const config = loadRuntimeConfiguration(process.env);

const logger: StructuredLogger = {
  info:  (event) => console.log(JSON.stringify({ level: "info",  ...event })),
  error: (event) => console.error(JSON.stringify({ level: "error", ...event })),
};

const now = () => new Date();

// Region is derived from the pool ID (format: "<region>_<id>").
// loadRuntimeConfiguration already validated cognitoUserPoolId format.
const awsRegion = config.cognitoUserPoolId.split("_")[0]!;

const documentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: awsRegion }),
);
const cognitoClient = new CognitoIdentityProviderClient({ region: awsRegion });

const identity = createAwsIdentityServices({
  documentClient,
  cognitoClient,
  configuration: {
    playerTableName: config.playerTableName,
    guestStartingBalance: {
      coins:  config.guestStartingCoins,
      gems:   config.guestStartingGems,
      energy: config.guestStartingEnergy,
    },
    tokenIssuer:            config.tokenIssuer,
    tokenAudience:          config.tokenAudience,
    appleAudience:          config.appleAudience,
    cognitoUserPoolId:      config.cognitoUserPoolId,
    cognitoClientId:        config.cognitoClientId,
    refreshLifetimeSeconds: config.refreshLifetimeSeconds,
  },
  // Account deletion is not deployable with a stub revoker.
  // The route is disabled with 503 below; this stub is never reached.
  deletionAuthorizer: {
    authorize: async () => { throw new Error("deletion authorizer not configured"); },
  },
  sessionRevoker: {
    revokeAll: async () => { throw new Error("session revoker not configured"); },
  },
  now,
});

const publicDeps = {
  rateLimiter: new MemoryFixedWindowRateLimiter(200, 60),
  logger,
  now,
};
const authDeps: AuthenticatedHandlerDependencies = {
  ...publicDeps,
  tokenVerifier: identity.tokenVerifier,
};

// Enable only authoritative balance reads. Mutation dependencies deliberately
// fail closed until approved spend and reward policies are configured.
const economy = new EconomyService(
  identity.persistence.economy,
  { resolve: async () => { throw new Error("spend rules are not configured"); } },
  { verify: async () => { throw new Error("reward verification is not configured"); } },
  now,
);
const entitlement = new EntitlementService(identity.persistence.entitlement);

// Issue 7: 503 handlers use the shared privacy-aware helpers so they apply
// rate limiting, require authentication where appropriate, and return the
// documented correlation-ID shape. Unauthenticated callers cannot reach
// authenticated 503 routes without a valid bearer token.

function publicNotAvailable(route: string): HttpHandler {
  return async (request: HttpRequest) => {
    const ctx = await limitPublicRequest(request, route, publicDeps);
    if (ctx.kind === "response") return ctx.response;
    return loggedProblem(logger, route, ctx.requestId, 503, "Service unavailable", "/problems/service-unavailable");
  };
}

function authenticatedNotAvailable(route: string): HttpHandler {
  return async (request: HttpRequest) => {
    const ctx = await authenticateRequest(request, route, authDeps);
    if (ctx.kind === "response") return ctx.response;
    return loggedProblem(logger, route, ctx.requestId, 503, "Service unavailable", "/problems/service-unavailable");
  };
}

// Routes intentionally kept unavailable in this deployment slice:
//   DELETE /v1/account          — reauthentication and provider-wide revocation are not composed
//   POST   /v1/spend            — the complete approved action/reference rule table is pending
//   POST   /v1/rewards/claim    — provider reward-evidence verification is pending
//   POST   /v1/purchases/verify — Checkpoint 7 provider verification is pending
//   POST   /v1/app-store/notifications — Checkpoint 7 provider verification is pending
//   POST   /v1/ads/reward/verify — Checkpoint 7 provider verification is pending
//   GET    /v1/content/catalog  — signing key and published content are not configured
//   GET    /v1/config           — signing key and published content are not configured
//   POST   /v1/sync/commands    — authoritative game-command execution rules are pending

const appHandler = createApiRouter({
  routes: [
    // Concrete implementations — deployed.
    { method: "GET",    path: "/health",             handler: createHealthHandler(logger) },
    { method: "POST",   path: "/v1/guest/session",   handler: createGuestSessionHandler({ service: identity.guestSession, ...publicDeps }) },
    { method: "POST",   path: "/v1/session/refresh", handler: createRefreshSessionHandler(identity.sessionLifecycle, publicDeps) },
    { method: "POST",   path: "/v1/session/revoke",  handler: createRevokeSessionHandler(identity.sessionLifecycle, authDeps) },
    // Apple routes: active when SCO_APPLE_AUDIENCE is configured and confirmed;
    // 503 otherwise. The Lambda starts normally either way.
    { method: "POST",   path: "/v1/auth/apple",      handler: identity.appleAccount !== undefined
        ? createAppleSignInHandler(identity.appleAccount, publicDeps)
        : publicNotAvailable("POST /v1/auth/apple") },
    { method: "POST",   path: "/v1/account/link",    handler: identity.appleAccount !== undefined
        ? createAppleLinkHandler(identity.appleAccount, authDeps)
        : authenticatedNotAvailable("POST /v1/account/link") },
    { method: "GET",    path: "/v1/account",         handler: createGetAccountHandler(identity.account, authDeps) },
    { method: "GET",    path: "/v1/save",            handler: createGetSaveHandler(identity.save, authDeps) },
    { method: "PUT",    path: "/v1/save",            handler: createPutSaveHandler(identity.save, authDeps) },
    { method: "GET",    path: "/v1/economy",         handler: createGetEconomyHandler(economy, authDeps) },
    { method: "GET",    path: "/v1/entitlements",    handler: createGetEntitlementsHandler(entitlement, authDeps) },

    // Not yet deployed — explicit 503 with appropriate access control.
    { method: "DELETE", path: "/v1/account",                 handler: authenticatedNotAvailable("DELETE /v1/account") },
    { method: "POST",   path: "/v1/spend",                   handler: authenticatedNotAvailable("POST /v1/spend") },
    { method: "POST",   path: "/v1/rewards/claim",           handler: authenticatedNotAvailable("POST /v1/rewards/claim") },
    { method: "POST",   path: "/v1/purchases/verify",        handler: authenticatedNotAvailable("POST /v1/purchases/verify") },
    { method: "POST",   path: "/v1/app-store/notifications", handler: publicNotAvailable("POST /v1/app-store/notifications") },
    { method: "POST",   path: "/v1/ads/reward/verify",       handler: authenticatedNotAvailable("POST /v1/ads/reward/verify") },
    { method: "GET",    path: "/v1/content/catalog",         handler: publicNotAvailable("GET /v1/content/catalog") },
    { method: "GET",    path: "/v1/config",                  handler: publicNotAvailable("GET /v1/config") },
    { method: "POST",   path: "/v1/sync/commands",           handler: authenticatedNotAvailable("POST /v1/sync/commands") },
  ],
  logger,
});

export const handler = adaptApiGatewayHttpApi(appHandler);
