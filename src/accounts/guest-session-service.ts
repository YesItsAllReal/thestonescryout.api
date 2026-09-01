export type ClientPlatform = "ios" | "android";

export interface GuestSessionRequest {
  installationId: string;
  locale: string;
  appBuild: number;
  platform: ClientPlatform;
}

export interface PlayerProfile {
  playerId: string;
  accountKind: "guest";
  createdAt: string;
  deletionState: "active";
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export interface GuestSessionResponse {
  player: PlayerProfile;
  tokens: SessionTokens;
}

export interface GuestPlayerRepository {
  findOrCreateGuest(input: {
    installationIdHash: string;
    idempotencyKey: string;
    locale: string;
    appBuild: number;
    platform: ClientPlatform;
    now: Date;
  }): Promise<PlayerProfile>;
}

export interface SessionTokenIssuer {
  issue(playerId: string, now: Date): Promise<SessionTokens>;
}

export interface InstallationIdHasher {
  hash(installationId: string): string;
}

export class GuestSessionValidationError extends Error {}

export class GuestSessionService {
  public constructor(
    private readonly repository: GuestPlayerRepository,
    private readonly tokenIssuer: SessionTokenIssuer,
    private readonly installationIdHasher: InstallationIdHasher,
    private readonly now: () => Date,
  ) {}

  public async create(
    request: GuestSessionRequest,
    idempotencyKey: string,
  ): Promise<GuestSessionResponse> {
    validate(request, idempotencyKey);
    const timestamp = this.now();
    const player = await this.repository.findOrCreateGuest({
      installationIdHash: this.installationIdHasher.hash(request.installationId),
      idempotencyKey,
      locale: request.locale,
      appBuild: request.appBuild,
      platform: request.platform,
      now: timestamp,
    });
    const tokens = await this.tokenIssuer.issue(player.playerId, timestamp);
    return { player, tokens };
  }
}

function validate(request: GuestSessionRequest, idempotencyKey: string): void {
  if (!isUuid(request.installationId)) {
    throw new GuestSessionValidationError("installationId must be a UUID");
  }
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(idempotencyKey)) {
    throw new GuestSessionValidationError("idempotency key is invalid");
  }
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(request.locale)) {
    throw new GuestSessionValidationError("locale is invalid");
  }
  if (!Number.isSafeInteger(request.appBuild) || request.appBuild < 1) {
    throw new GuestSessionValidationError("appBuild must be a positive integer");
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
