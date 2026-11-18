import { Environment, SignedDataVerifier, Type, VerificationException, VerificationStatus } from "@apple/app-store-server-library";
import { APPLE_ROOT_CA_G3 } from "./apple-root-ca.js";
import {
  CommerceProductNotFoundError,
  CommerceVerificationUnavailableError,
  type AppAccountTokenMatcher,
  type AppStoreTransactionVerifier,
  type CommerceProductCatalog,
  type StoreEnvironment,
  type VerifiedAppStoreTransaction,
} from "./commerce-service.js";

export const APP_STORE_BUNDLE_ID = "com.itsallrealministries.stonescryout";
export const ENERGY_REFILL_PRODUCT_ID = "org.itsallreal.unearthed.energy.refill";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSACTION_ID = /^[1-9][0-9]{0,31}$/;
const CLOCK_SKEW_MS = 300_000;

export type ApplePurchaseConfiguration =
  | { readonly environment: "sandbox" }
  | { readonly environment: "production"; readonly appAppleId: number };

export const appStoreProductCatalog: CommerceProductCatalog = {
  async get(productId) {
    if (productId !== ENERGY_REFILL_PRODUCT_ID) return undefined;
    return { productId, kind: "consumable", grants: [{ resource: "energy", delta: 100 }] };
  },
};

export const playerAppAccountTokenMatcher: AppAccountTokenMatcher = {
  async matches(playerId, token) {
    return UUID.test(token) && token.toLowerCase() === playerId.toLowerCase();
  },
};

export function createAppleTransactionVerifier(config: ApplePurchaseConfiguration): AppStoreTransactionVerifier {
  const environment = config.environment === "sandbox" ? Environment.SANDBOX : Environment.PRODUCTION;
  const verifier = new SignedDataVerifier(
    [Buffer.from(APPLE_ROOT_CA_G3, "base64")],
    true,
    environment,
    APP_STORE_BUNDLE_ID,
    config.environment === "production" ? config.appAppleId : undefined,
  );
  return new AppleTransactionVerifier(verifier, config.environment);
}

export class AppleTransactionVerifier implements AppStoreTransactionVerifier {
  public constructor(
    private readonly verifier: Pick<SignedDataVerifier, "verifyAndDecodeTransaction">,
    private readonly environment: StoreEnvironment,
  ) {}

  public async verify(jws: string, now: Date): Promise<VerifiedAppStoreTransaction> {
    // Keep format and algorithm checks ahead of certificate processing.
    if (jws.length > 32_768) throw new Error("Invalid StoreKit JWS length");
    const parts = jws.split(".");
    const header = parts[0];
    if (parts.length !== 3 || header === undefined ||
        parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)) ||
        JSON.parse(Buffer.from(header, "base64url").toString("utf8"))?.alg !== "ES256") {
      throw new Error("Invalid StoreKit JWS format");
    }

    let transaction;
    try {
      transaction = await this.verifier.verifyAndDecodeTransaction(jws);
    } catch (error: unknown) {
      if (error instanceof VerificationException && error.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) {
        throw new CommerceVerificationUnavailableError("Apple verification is temporarily unavailable");
      }
      throw error;
    }

    const { appAccountToken, bundleId, environment, originalTransactionId, productId, purchaseDate, signedDate, transactionId } = transaction;
    const expectedEnvironment = this.environment === "sandbox" ? Environment.SANDBOX : Environment.PRODUCTION;
    if (productId !== ENERGY_REFILL_PRODUCT_ID) {
      throw new CommerceProductNotFoundError("transaction product is not recognized");
    }
    if (bundleId !== APP_STORE_BUNDLE_ID || environment !== expectedEnvironment ||
        transaction.type !== Type.CONSUMABLE || transaction.quantity !== 1 ||
        transaction.revocationDate !== undefined || transaction.revocationReason !== undefined ||
        transactionId === undefined || !TRANSACTION_ID.test(transactionId) ||
        originalTransactionId === undefined || !TRANSACTION_ID.test(originalTransactionId) ||
        appAccountToken === undefined || !UUID.test(appAccountToken) ||
        !validTimestamp(purchaseDate) || !validTimestamp(signedDate) ||
        purchaseDate > signedDate || signedDate > now.getTime() + CLOCK_SKEW_MS) {
      throw new Error("Invalid StoreKit transaction claims");
    }
    return {
      transactionId, originalTransactionId, productId, appAccountToken,
      environment: this.environment,
      purchasedAt: new Date(purchaseDate).toISOString(),
    };
  }
}

function validTimestamp(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
}
