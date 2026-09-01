import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  GuestSessionService,
  GuestSessionValidationError,
  type GuestPlayerRepository,
  type PlayerProfile,
  type SessionTokenIssuer,
} from "../src/accounts/guest-session-service.js";
import { Sha256InstallationIdHasher } from "../src/accounts/sha256-installation-id-hasher.js";

class MemoryGuestRepository implements GuestPlayerRepository {
  private readonly playersByInstallation = new Map<string, PlayerProfile>();

  public async findOrCreateGuest(input: Parameters<GuestPlayerRepository["findOrCreateGuest"]>[0]): Promise<PlayerProfile> {
    const existing = this.playersByInstallation.get(input.installationIdHash);
    if (existing !== undefined) return existing;
    const player: PlayerProfile = {
      playerId: randomUUID(),
      accountKind: "guest",
      createdAt: input.now.toISOString(),
      deletionState: "active",
    };
    this.playersByInstallation.set(input.installationIdHash, player);
    return player;
  }
}

class FakeTokenIssuer implements SessionTokenIssuer {
  public async issue(playerId: string, now: Date) {
    return {
      accessToken: `access.${playerId}`,
      refreshToken: `refresh.${playerId}`,
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
  }
}

const request = {
  installationId: "00000000-0000-4000-8000-000000000006",
  locale: "en-US",
  appBuild: 1,
  platform: "ios" as const,
};

test("creates an opaque guest session without retaining the raw installation id", async () => {
  const repository = new MemoryGuestRepository();
  const service = new GuestSessionService(
    repository,
    new FakeTokenIssuer(),
    new Sha256InstallationIdHasher(),
    () => new Date("2026-08-31T12:00:00.000Z"),
  );

  const response = await service.create(request, "request-create-0001");

  assert.equal(response.player.accountKind, "guest");
  assert.notEqual(response.player.playerId, request.installationId);
  assert.equal(response.tokens.accessToken, `access.${response.player.playerId}`);
});

test("retries and concurrent create attempts resolve to one guest player", async () => {
  const service = new GuestSessionService(
    new MemoryGuestRepository(),
    new FakeTokenIssuer(),
    new Sha256InstallationIdHasher(),
    () => new Date("2026-08-31T12:00:00.000Z"),
  );

  const [first, second] = await Promise.all([
    service.create(request, "request-create-0002"),
    service.create(request, "request-create-0002"),
  ]);

  assert.equal(first.player.playerId, second.player.playerId);
});

test("rejects malformed client identity before persistence", async () => {
  const service = new GuestSessionService(
    new MemoryGuestRepository(),
    new FakeTokenIssuer(),
    new Sha256InstallationIdHasher(),
    () => new Date(),
  );

  await assert.rejects(
    service.create({ ...request, installationId: "device-serial-number" }, "request-create-0003"),
    GuestSessionValidationError,
  );
});
