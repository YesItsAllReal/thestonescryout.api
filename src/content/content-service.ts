export type ClientPlatform = "ios" | "android";
export type ContentChannel = "development" | "staging" | "production";
export type ContentPackType = "starter" | "campaign" | "character" | "archive" | "art" | "event" | "localization" | "balance";

export interface ContentPackDescriptor {
  readonly packId: string;
  readonly version: string;
  readonly minimumAppBuild: number;
  readonly maximumAppBuild?: number | undefined;
  readonly locale: string;
  readonly type: ContentPackType;
  readonly displayName: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly sha256: string;
  readonly downloadUrl: string;
  readonly publishedAt: string;
  readonly editorialStatus: "approved";
}

export interface SignedContentCatalog {
  readonly catalogVersion: string;
  readonly channel: ContentChannel;
  readonly publishedAt: string;
  readonly packs: readonly ContentPackDescriptor[];
  readonly keyId: string;
  readonly signatureAlgorithm: "ed25519";
  readonly signature: string;
}

export interface ContentCatalogRequest {
  readonly platform: ClientPlatform;
  readonly appBuild: number;
  readonly locale: string;
  readonly channel: ContentChannel;
}

export interface ContentCatalogRepository {
  get(request: ContentCatalogRequest): Promise<SignedContentCatalog | undefined>;
}

export interface SignedDocumentVerifier {
  verify(input: {
    readonly document: unknown;
    readonly keyId: string;
    readonly algorithm: "ed25519";
    readonly signature: string;
  }): Promise<boolean>;
}

export interface PublicUrlPolicy {
  allows(url: string, purpose: "content" | "externalLink"): boolean;
}

export interface FeatureFlags {
  readonly googleSignIn: boolean;
  readonly rewardedAds: boolean;
  readonly weekendDig: boolean;
  readonly quizzes: boolean;
  readonly gameCenter: boolean;
  readonly remoteContent: boolean;
  readonly purchases: boolean;
  readonly accountSync: boolean;
  readonly ministryLinks: boolean;
}

export interface RemoteEconomyConfiguration {
  readonly startingCoins: number;
  readonly startingGems: number;
  readonly startingEnergy: number;
  readonly energyCap: number;
  readonly energyRegenerationSeconds: number;
  readonly dailyGiftCoins: number;
  readonly dailyGiftEnergy: number;
  readonly rewardedCoins: number;
  readonly rewardedEnergy: number;
  readonly rewardedDailyCap: number;
}

export interface SignedRemoteConfiguration {
  readonly configVersion: string;
  readonly minimumAppBuild: number;
  readonly activeCatalogVersion: string;
  readonly featureFlags: FeatureFlags;
  readonly economy: RemoteEconomyConfiguration;
  readonly maintenanceMessage: string | null;
  readonly links: {
    readonly privacyUrl: string;
    readonly termsUrl: string;
    readonly supportUrl: string;
  };
  readonly publishedAt: string;
  readonly keyId: string;
  readonly signatureAlgorithm: "ed25519";
  readonly signature: string;
}

export interface RemoteConfigurationRepository {
  get(input: { readonly platform: ClientPlatform; readonly appBuild: number; readonly locale: string }): Promise<SignedRemoteConfiguration | undefined>;
}

export class ContentRequestValidationError extends Error {}
export class ContentUnavailableError extends Error {}
export class ContentIntegrityError extends Error {}
export class ContentPolicyError extends Error {}

export class ContentCatalogService {
  public constructor(
    private readonly repository: ContentCatalogRepository,
    private readonly signatures: SignedDocumentVerifier,
    private readonly urls: PublicUrlPolicy,
  ) {}

  public async get(request: ContentCatalogRequest): Promise<SignedContentCatalog> {
    validateRequest(request);
    const catalog = await this.repository.get(request);
    if (catalog === undefined) throw new ContentUnavailableError("content catalog is unavailable");
    if (!await this.signatures.verify({
      document: unsignedCatalog(catalog),
      keyId: catalog.keyId,
      algorithm: catalog.signatureAlgorithm,
      signature: catalog.signature,
    })) {
      throw new ContentIntegrityError("content catalog signature is invalid");
    }
    validateCatalog(catalog, this.urls);
    if (catalog.channel !== request.channel) throw new ContentPolicyError("catalog channel does not match the request");
    return catalog;
  }
}

export class RemoteConfigurationService {
  public constructor(
    private readonly repository: RemoteConfigurationRepository,
    private readonly signatures: SignedDocumentVerifier,
    private readonly urls: PublicUrlPolicy,
  ) {}

  public async get(input: { readonly platform: ClientPlatform; readonly appBuild: number; readonly locale: string }): Promise<SignedRemoteConfiguration> {
    validateRequest({ ...input, channel: "production" });
    const config = await this.repository.get(input);
    if (config === undefined) throw new ContentUnavailableError("remote configuration is unavailable");
    if (!await this.signatures.verify({
      document: unsignedConfiguration(config),
      keyId: config.keyId,
      algorithm: config.signatureAlgorithm,
      signature: config.signature,
    })) {
      throw new ContentIntegrityError("remote configuration signature is invalid");
    }
    validateConfiguration(config, input.appBuild, this.urls);
    return config;
  }
}

function validateRequest(request: ContentCatalogRequest): void {
  if (!Number.isSafeInteger(request.appBuild) || request.appBuild < 1) throw new ContentRequestValidationError("appBuild is invalid");
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(request.locale)) throw new ContentRequestValidationError("locale is invalid");
}

function validateCatalog(catalog: SignedContentCatalog, urls: PublicUrlPolicy): void {
  validateVersion(catalog.catalogVersion, "catalogVersion");
  validateSignatureFields(catalog.keyId, catalog.signature);
  validateDate(catalog.publishedAt, "catalog publishedAt");
  if (catalog.packs.length > 1_000) throw new ContentPolicyError("catalog contains too many packs");
  const ids = new Set<string>();
  let starterCount = 0;
  for (const pack of catalog.packs) {
    validateVersion(pack.packId, "packId");
    validateVersion(pack.version, "pack version");
    if (ids.has(pack.packId)) throw new ContentPolicyError("catalog pack IDs must be unique");
    ids.add(pack.packId);
    if (pack.type === "starter") starterCount += 1;
    if (!Number.isSafeInteger(pack.minimumAppBuild) || pack.minimumAppBuild < 1) throw new ContentPolicyError("pack minimum build is invalid");
    if (pack.maximumAppBuild !== undefined && pack.maximumAppBuild < pack.minimumAppBuild) throw new ContentPolicyError("pack build range is invalid");
    if (!/^[a-f0-9]{64}$/.test(pack.sha256)) throw new ContentPolicyError("pack checksum is invalid");
    if (!Number.isSafeInteger(pack.compressedSize) || !Number.isSafeInteger(pack.uncompressedSize) || pack.compressedSize < 1 || pack.uncompressedSize < pack.compressedSize || pack.uncompressedSize > 1_073_741_824) {
      throw new ContentPolicyError("pack size is invalid");
    }
    if (!urls.allows(pack.downloadUrl, "content")) throw new ContentPolicyError("content download URL is not allowed");
    validateDate(pack.publishedAt, "pack publishedAt");
  }
  if (starterCount < 1) throw new ContentPolicyError("catalog must retain a starter pack");
}

function validateConfiguration(config: SignedRemoteConfiguration, appBuild: number, urls: PublicUrlPolicy): void {
  validateVersion(config.configVersion, "configVersion");
  validateVersion(config.activeCatalogVersion, "activeCatalogVersion");
  validateSignatureFields(config.keyId, config.signature);
  validateDate(config.publishedAt, "configuration publishedAt");
  if (!Number.isSafeInteger(config.minimumAppBuild) || config.minimumAppBuild < 1 || config.minimumAppBuild > appBuild) {
    throw new ContentPolicyError("configuration is incompatible with this app build");
  }
  const economy = config.economy;
  integerInRange(economy.startingCoins, 0, 10_000, "startingCoins");
  integerInRange(economy.startingGems, 0, 1_000, "startingGems");
  integerInRange(economy.energyCap, 1, 500, "energyCap");
  integerInRange(economy.startingEnergy, 0, economy.energyCap, "startingEnergy");
  integerInRange(economy.energyRegenerationSeconds, 30, 3_600, "energyRegenerationSeconds");
  integerInRange(economy.dailyGiftCoins, 0, 1_000, "dailyGiftCoins");
  integerInRange(economy.dailyGiftEnergy, 0, 200, "dailyGiftEnergy");
  integerInRange(economy.rewardedCoins, 0, 1_000, "rewardedCoins");
  integerInRange(economy.rewardedEnergy, 0, 200, "rewardedEnergy");
  integerInRange(economy.rewardedDailyCap, 0, 20, "rewardedDailyCap");
  if (config.maintenanceMessage !== null && config.maintenanceMessage.length > 500) throw new ContentPolicyError("maintenance message is too long");
  for (const url of Object.values(config.links)) {
    if (!urls.allows(url, "externalLink")) throw new ContentPolicyError("configuration link URL is not allowed");
  }
}

function unsignedCatalog(value: SignedContentCatalog): Omit<SignedContentCatalog, "signature"> {
  const { signature: _signature, ...unsigned } = value;
  return unsigned;
}

function unsignedConfiguration(value: SignedRemoteConfiguration): Omit<SignedRemoteConfiguration, "signature"> {
  const { signature: _signature, ...unsigned } = value;
  return unsigned;
}

function validateVersion(value: string, name: string): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new ContentPolicyError(`${name} is invalid`);
}

function validateSignatureFields(keyId: string, signature: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyId) || signature.length < 40 || signature.length > 512) {
    throw new ContentPolicyError("signature metadata is invalid");
  }
}

function integerInRange(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ContentPolicyError(`${name} is outside safe bounds`);
}

function validateDate(value: string, name: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ContentPolicyError(`${name} is invalid`);
  }
}
