import { randomUUID } from "node:crypto";

import {
  GuestSessionIdempotencyConflictError,
  type GuestPlayerRepository,
  type PlayerProfile,
} from "./guest-session-service.js";

interface StoredIdempotencyRequest {
  readonly fingerprint: string;
  readonly player: PlayerProfile;
}

export class MemoryGuestPlayerRepository implements GuestPlayerRepository {
  private readonly playersByInstallation = new Map<string, PlayerProfile>();
  private readonly requestsByKey = new Map<string, StoredIdempotencyRequest>();

  public async findOrCreateGuest(
    input: Parameters<GuestPlayerRepository["findOrCreateGuest"]>[0],
  ): Promise<PlayerProfile> {
    const fingerprint = fingerprintFor(input);
    const replay = this.requestsByKey.get(input.idempotencyKey);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint) {
        throw new GuestSessionIdempotencyConflictError(
          "idempotency key was reused for a different request",
        );
      }
      return replay.player;
    }

    const player = this.playersByInstallation.get(input.installationIdHash) ?? {
      playerId: randomUUID(),
      accountKind: "guest",
      createdAt: input.now.toISOString(),
      deletionState: "active",
    } satisfies PlayerProfile;

    this.playersByInstallation.set(input.installationIdHash, player);
    this.requestsByKey.set(input.idempotencyKey, { fingerprint, player });
    return player;
  }
}

function fingerprintFor(
  input: Parameters<GuestPlayerRepository["findOrCreateGuest"]>[0],
): string {
  return JSON.stringify([
    input.installationIdHash,
    input.locale,
    input.appBuild,
    input.platform,
  ]);
}
