import type { AuthenticatedPrincipal } from "../auth/authentication.js";
import type { EconomyBalance, LedgerEntry, ResourceMutation } from "../economy/economy-service.js";
import type { Entitlement } from "../economy/entitlement-service.js";

export type StoreEnvironment = "sandbox" | "production";

export interface VerifiedAppStoreTransaction {
  readonly transactionId: string;
  readonly originalTransactionId: string;
  readonly productId: string;
  readonly appAccountToken: string;
  readonly environment: StoreEnvironment;
  readonly purchasedAt: string;
}

export interface AppStoreTransactionVerifier {
  verify(signedTransaction: string, now: Date): Promise<VerifiedAppStoreTransaction>;
}

export interface AppAccountTokenMatcher {
  matches(playerId: string, appAccountToken: string): Promise<boolean>;
}

export interface CommerceProduct {
  readonly productId: string;
  readonly kind: "consumable" | "nonConsumable";
  readonly grants: readonly ResourceMutation[];
}

export interface CommerceProductCatalog {
  get(productId: string): Promise<CommerceProduct | undefined>;
}

export interface VerifiedAppStoreNotification {
  readonly notificationId: string;
  readonly notificationType: "REFUND" | "REVOKE";
  readonly transactionId: string;
  readonly productId: string;
  readonly environment: StoreEnvironment;
  readonly effectiveAt: string;
}

export interface AppStoreNotificationVerifier {
  verify(signedPayload: string, now: Date): Promise<VerifiedAppStoreNotification>;
}

export type AdPlacement = "storeEnergy" | "storeCoins" | "energyEmpty";
export type AdRewardChoice = "energy20" | "coins100";

export interface VerifiedAdCompletion {
  readonly provider: string;
  readonly providerEventId: string;
  readonly claimId: string;
  readonly playerId: string;
}

export interface AdCompletionVerifier {
  verify(payload: string, now: Date): Promise<VerifiedAdCompletion>;
}

export interface AdRewardCatalog {
  resolve(placement: AdPlacement, rewardChoice: AdRewardChoice): Promise<readonly ResourceMutation[]>;
}

export interface CommerceGrantResult {
  readonly status: "granted" | "duplicate";
  readonly balance: EconomyBalance;
  readonly ledgerEntries: readonly LedgerEntry[];
  readonly entitlement?: Entitlement | undefined;
}

export interface CommerceNotificationResult {
  readonly status: "applied" | "duplicate" | "ignored";
  readonly transactionState: "refunded" | "revoked";
  readonly entitlement?: Entitlement | undefined;
}

export interface CommerceRepository {
  processPurchaseAtomically(input: {
    readonly playerId: string;
    readonly transaction: VerifiedAppStoreTransaction;
    readonly product: CommerceProduct;
    readonly idempotencyKey: string;
    readonly clientBuild: number;
    readonly contentVersion: string;
    readonly now: Date;
  }): Promise<CommerceGrantResult>;

  processNotificationAtomically(input: {
    readonly notification: VerifiedAppStoreNotification;
    readonly now: Date;
  }): Promise<CommerceNotificationResult>;

  processAdRewardAtomically(input: {
    readonly playerId: string;
    readonly completion: VerifiedAdCompletion;
    readonly mutations: readonly ResourceMutation[];
    readonly idempotencyKey: string;
    readonly clientBuild: number;
    readonly contentVersion: string;
    readonly now: Date;
  }): Promise<CommerceGrantResult>;
}

export class CommerceValidationError extends Error {}
export class CommerceVerificationError extends Error {}
export class CommerceOwnershipError extends Error {}
export class CommerceProductNotFoundError extends Error {}
export class CommerceIdempotencyConflictError extends Error {}

export class PurchaseService {
  public constructor(
    private readonly verifier: AppStoreTransactionVerifier,
    private readonly ownership: AppAccountTokenMatcher,
    private readonly products: CommerceProductCatalog,
    private readonly repository: CommerceRepository,
    private readonly now: () => Date,
  ) {}

  public async verifyPurchase(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly signedTransaction: string;
    readonly idempotencyKey: string;
    readonly clientBuild: number;
    readonly contentVersion: string;
  }): Promise<CommerceGrantResult> {
    validateSignedPayload(input.signedTransaction, "signedTransaction");
    validateClientContext(input);
    const timestamp = this.now();
    let transaction: VerifiedAppStoreTransaction;
    try {
      transaction = await this.verifier.verify(input.signedTransaction, timestamp);
    } catch {
      throw new CommerceVerificationError("App Store transaction could not be verified");
    }
    if (!await this.ownership.matches(input.principal.playerId, transaction.appAccountToken)) {
      throw new CommerceOwnershipError("transaction is not bound to the authenticated player");
    }
    const product = await this.products.get(transaction.productId);
    if (product === undefined) throw new CommerceProductNotFoundError("transaction product is not recognized");
    validateProduct(product);
    return this.repository.processPurchaseAtomically({
      playerId: input.principal.playerId,
      transaction,
      product,
      idempotencyKey: input.idempotencyKey,
      clientBuild: input.clientBuild,
      contentVersion: input.contentVersion,
      now: timestamp,
    });
  }
}

export class AppStoreNotificationService {
  public constructor(
    private readonly verifier: AppStoreNotificationVerifier,
    private readonly repository: CommerceRepository,
    private readonly now: () => Date,
  ) {}

  public async process(signedPayload: string): Promise<CommerceNotificationResult> {
    validateSignedPayload(signedPayload, "signedPayload");
    const timestamp = this.now();
    let notification: VerifiedAppStoreNotification;
    try {
      notification = await this.verifier.verify(signedPayload, timestamp);
    } catch {
      throw new CommerceVerificationError("App Store notification could not be verified");
    }
    return this.repository.processNotificationAtomically({ notification, now: timestamp });
  }
}

export class AdRewardService {
  public constructor(
    private readonly verifier: AdCompletionVerifier,
    private readonly rewards: AdRewardCatalog,
    private readonly repository: CommerceRepository,
    private readonly now: () => Date,
  ) {}

  public async verifyReward(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly placement: AdPlacement;
    readonly rewardChoice: AdRewardChoice;
    readonly claimId: string;
    readonly verificationPayload: string;
    readonly idempotencyKey: string;
    readonly clientBuild: number;
    readonly contentVersion: string;
  }): Promise<CommerceGrantResult> {
    validateReference(input.claimId, "claimId");
    validateSignedPayload(input.verificationPayload, "verificationPayload");
    validateClientContext(input);
    const timestamp = this.now();
    let completion: VerifiedAdCompletion;
    try {
      completion = await this.verifier.verify(input.verificationPayload, timestamp);
    } catch {
      throw new CommerceVerificationError("ad completion could not be verified");
    }
    if (completion.playerId !== input.principal.playerId || completion.claimId !== input.claimId) {
      throw new CommerceOwnershipError("ad completion is not bound to this player and claim");
    }
    const mutations = await this.rewards.resolve(input.placement, input.rewardChoice);
    if (mutations.length === 0 || mutations.some((value) => !Number.isSafeInteger(value.delta) || value.delta <= 0)) {
      throw new CommerceValidationError("ad reward configuration is invalid");
    }
    return this.repository.processAdRewardAtomically({
      playerId: input.principal.playerId,
      completion,
      mutations,
      idempotencyKey: input.idempotencyKey,
      clientBuild: input.clientBuild,
      contentVersion: input.contentVersion,
      now: timestamp,
    });
  }
}

function validateClientContext(input: { readonly idempotencyKey: string; readonly clientBuild: number; readonly contentVersion: string }): void {
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(input.idempotencyKey)) throw new CommerceValidationError("idempotency key is invalid");
  if (!Number.isSafeInteger(input.clientBuild) || input.clientBuild < 1) throw new CommerceValidationError("clientBuild is invalid");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.contentVersion)) throw new CommerceValidationError("contentVersion is invalid");
}

function validateSignedPayload(value: string, name: string): void {
  if (value.length < 20 || value.length > 32_768) throw new CommerceValidationError(`${name} length is invalid`);
}

function validateReference(value: string, name: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new CommerceValidationError(`${name} is invalid`);
}

function validateProduct(product: CommerceProduct): void {
  if (product.grants.some((grant) => !Number.isSafeInteger(grant.delta) || grant.delta <= 0)) {
    throw new CommerceValidationError("purchase product grant configuration is invalid");
  }
  if (product.kind === "consumable" && product.grants.length === 0) {
    throw new CommerceValidationError("consumable product has no grant");
  }
}
