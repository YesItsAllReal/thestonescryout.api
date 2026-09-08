import type { AccountService } from "../accounts/account-service.js";
import type { AppleAccountService } from "../accounts/apple-account-service.js";
import type { GuestSessionService } from "../accounts/guest-session-service.js";
import type { AdRewardService, AppStoreNotificationService, PurchaseService } from "../commerce/commerce-service.js";
import type { ContentCatalogService, RemoteConfigurationService } from "../content/content-service.js";
import type { EconomyService } from "../economy/economy-service.js";
import type { EntitlementService } from "../economy/entitlement-service.js";
import type { SaveService } from "../saves/save-service.js";
import type { SessionLifecycleService } from "../auth/session-lifecycle-service.js";
import type { OfflineCommandSyncService } from "../sync/offline-command-sync-service.js";
import { createGetAccountHandler, createDeleteAccountHandler } from "../http/account-handlers.js";
import { createApiRouter, type ApiRoute } from "../http/api-router.js";
import { createAppleLinkHandler, createAppleSignInHandler } from "../http/apple-account-handlers.js";
import { createAdRewardVerificationHandler, createAppStoreNotificationHandler, createPurchaseVerificationHandler } from "../http/commerce-handlers.js";
import { createContentCatalogHandler, createRemoteConfigurationHandler } from "../http/content-handlers.js";
import { createGetEconomyHandler, createGetEntitlementsHandler, createRewardClaimHandler, createSpendHandler } from "../http/economy-handlers.js";
import { createGuestSessionHandler } from "../http/guest-session-handler.js";
import { createHealthHandler } from "../http/health-handler.js";
import type { AuthenticatedHandlerDependencies, HttpHandler } from "../http/http-types.js";
import { createGetSaveHandler, createPutSaveHandler } from "../http/save-handlers.js";
import { createRefreshSessionHandler, createRevokeSessionHandler } from "../http/session-handlers.js";
import { createOfflineSyncHandler } from "../http/offline-sync-handler.js";

export interface ApplicationServices {
  readonly guestSession: GuestSessionService;
  readonly sessionLifecycle: SessionLifecycleService;
  readonly offlineSync: OfflineCommandSyncService;
  readonly appleAccount: AppleAccountService;
  readonly account: AccountService;
  readonly save: SaveService;
  readonly economy: EconomyService;
  readonly entitlement: EntitlementService;
  readonly purchase: PurchaseService;
  readonly appStoreNotification: AppStoreNotificationService;
  readonly adReward: AdRewardService;
  readonly contentCatalog: ContentCatalogService;
  readonly remoteConfiguration: RemoteConfigurationService;
}

export function createApplicationHandler(input: {
  readonly services: ApplicationServices;
  readonly dependencies: AuthenticatedHandlerDependencies;
}): HttpHandler {
  const { services, dependencies } = input;
  const publicDependencies = {
    rateLimiter: dependencies.rateLimiter,
    logger: dependencies.logger,
    now: dependencies.now,
  };
  const routes: ApiRoute[] = [
    { method: "GET", path: "/health", handler: createHealthHandler(dependencies.logger) },
    { method: "POST", path: "/v1/guest/session", handler: createGuestSessionHandler({ service: services.guestSession, ...publicDependencies }) },
    { method: "POST", path: "/v1/session/refresh", handler: createRefreshSessionHandler(services.sessionLifecycle, publicDependencies) },
    { method: "POST", path: "/v1/session/revoke", handler: createRevokeSessionHandler(services.sessionLifecycle, dependencies) },
    { method: "POST", path: "/v1/sync/commands", handler: createOfflineSyncHandler(services.offlineSync, dependencies) },
    { method: "POST", path: "/v1/auth/apple", handler: createAppleSignInHandler(services.appleAccount, publicDependencies) },
    { method: "POST", path: "/v1/account/link", handler: createAppleLinkHandler(services.appleAccount, dependencies) },
    { method: "GET", path: "/v1/account", handler: createGetAccountHandler(services.account, dependencies) },
    { method: "DELETE", path: "/v1/account", handler: createDeleteAccountHandler(services.account, dependencies) },
    { method: "GET", path: "/v1/save", handler: createGetSaveHandler(services.save, dependencies) },
    { method: "PUT", path: "/v1/save", handler: createPutSaveHandler(services.save, dependencies) },
    { method: "GET", path: "/v1/economy", handler: createGetEconomyHandler(services.economy, dependencies) },
    { method: "POST", path: "/v1/spend", handler: createSpendHandler(services.economy, dependencies) },
    { method: "POST", path: "/v1/rewards/claim", handler: createRewardClaimHandler(services.economy, dependencies) },
    { method: "GET", path: "/v1/entitlements", handler: createGetEntitlementsHandler(services.entitlement, dependencies) },
    { method: "POST", path: "/v1/purchases/verify", handler: createPurchaseVerificationHandler(services.purchase, dependencies) },
    { method: "POST", path: "/v1/app-store/notifications", handler: createAppStoreNotificationHandler(services.appStoreNotification, publicDependencies) },
    { method: "POST", path: "/v1/ads/reward/verify", handler: createAdRewardVerificationHandler(services.adReward, dependencies) },
    { method: "GET", path: "/v1/content/catalog", handler: createContentCatalogHandler(services.contentCatalog, publicDependencies) },
    { method: "GET", path: "/v1/config", handler: createRemoteConfigurationHandler(services.remoteConfiguration, publicDependencies) },
  ];
  return createApiRouter({ routes, logger: dependencies.logger });
}
