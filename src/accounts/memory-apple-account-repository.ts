import { randomUUID } from "node:crypto";

import {
  AccountIdempotencyConflictError,
  type AppleAccountRepository,
  type AppleLinkResult,
} from "./apple-account-service.js";
import type { PlayerProfile } from "./guest-session-service.js";

interface StoredRequest<T> {
  readonly fingerprint: string;
  readonly result: T;
}

interface StoredConflict {
  readonly guestPlayerId: string;
  readonly existingPlayerId: string;
  readonly providerKey: string;
}

export class MemoryAppleAccountRepository implements AppleAccountRepository {
  private readonly players = new Map<string, PlayerProfile>();
  private readonly playerIdByProvider = new Map<string, string>();
  private readonly signIns = new Map<string, StoredRequest<PlayerProfile>>();
  private readonly links = new Map<string, StoredRequest<AppleLinkResult>>();
  private readonly conflicts = new Map<string, StoredConflict>();

  public addPlayer(player: PlayerProfile): void {
    this.players.set(player.playerId, player);
  }

  public associateAppleIdentity(issuer: string, subject: string, playerId: string): void {
    if (!this.players.has(playerId)) throw new Error("player must exist before provider association");
    this.playerIdByProvider.set(providerKey(issuer, subject), playerId);
  }

  public async signInOrCreate(
    input: Parameters<AppleAccountRepository["signInOrCreate"]>[0],
  ): Promise<PlayerProfile> {
    const fingerprint = JSON.stringify([input.issuer, input.subject]);
    const replay = this.signIns.get(input.idempotencyKey);
    if (replay !== undefined) return replayOrThrow(replay, fingerprint);

    const key = providerKey(input.issuer, input.subject);
    const existingId = this.playerIdByProvider.get(key);
    const existing = existingId === undefined ? undefined : this.players.get(existingId);
    const player = existing ?? {
      playerId: randomUUID(),
      accountKind: "apple",
      createdAt: input.now.toISOString(),
      deletionState: "active",
    } satisfies PlayerProfile;
    this.players.set(player.playerId, player);
    this.playerIdByProvider.set(key, player.playerId);
    this.signIns.set(input.idempotencyKey, { fingerprint, result: player });
    return player;
  }

  public async linkGuest(
    input: Parameters<AppleAccountRepository["linkGuest"]>[0],
  ): Promise<AppleLinkResult> {
    const fingerprint = JSON.stringify([
      input.guestPlayerId,
      input.issuer,
      input.subject,
    ]);
    const replay = this.links.get(input.idempotencyKey);
    if (replay !== undefined) return replayOrThrow(replay, fingerprint);

    const guest = this.players.get(input.guestPlayerId);
    if (guest === undefined || guest.accountKind !== "guest" || guest.deletionState !== "active") {
      throw new Error("active guest player was not found");
    }
    const key = providerKey(input.issuer, input.subject);
    const existingId = this.playerIdByProvider.get(key);
    let result: AppleLinkResult;
    if (existingId === undefined || existingId === input.guestPlayerId) {
      const linked = { ...guest, accountKind: "apple" } satisfies PlayerProfile;
      this.players.set(linked.playerId, linked);
      this.playerIdByProvider.set(key, linked.playerId);
      result = { kind: "linked", player: linked };
    } else {
      const conflictId = randomUUID();
      this.conflicts.set(conflictId, {
        guestPlayerId: input.guestPlayerId,
        existingPlayerId: existingId,
        providerKey: key,
      });
      result = {
        kind: "decisionRequired",
        conflictId,
        guestPlayerId: input.guestPlayerId,
        existingPlayerId: existingId,
      };
    }
    this.links.set(input.idempotencyKey, { fingerprint, result });
    return result;
  }

  public async resolveLinkConflict(
    input: Parameters<AppleAccountRepository["resolveLinkConflict"]>[0],
  ): Promise<{ readonly kind: "linked"; readonly player: PlayerProfile }> {
    const fingerprint = JSON.stringify([
      input.guestPlayerId,
      input.issuer,
      input.subject,
      input.resolution,
    ]);
    const replay = this.links.get(input.idempotencyKey);
    if (replay !== undefined) {
      const result = replayOrThrow(replay, fingerprint);
      if (result.kind !== "linked") throw new Error("stored resolution result is invalid");
      return result;
    }
    const result = this.resolve(
      input.resolution.conflictId,
      input.resolution.saveChoice,
      input.guestPlayerId,
      providerKey(input.issuer, input.subject),
    );
    this.links.set(input.idempotencyKey, { fingerprint, result });
    return result;
  }

  private resolve(
    conflictId: string,
    saveChoice: "preferGuestSave" | "preferExistingSave",
    guestPlayerId: string,
    key: string,
  ): { readonly kind: "linked"; readonly player: PlayerProfile } {
    const conflict = this.conflicts.get(conflictId);
    if (
      conflict === undefined ||
      conflict.guestPlayerId !== guestPlayerId ||
      conflict.providerKey !== key
    ) {
      throw new Error("link conflict is invalid or expired");
    }
    // This adapter does not store board snapshots. The choice is validated by
    // the service contract but cannot select identity ownership: the account
    // already bound to the verified Apple identity always survives.
    void saveChoice;
    const selected = this.players.get(conflict.existingPlayerId);
    if (selected === undefined) throw new Error("existing player was not found");
    const linked = { ...selected, accountKind: "apple" } satisfies PlayerProfile;
    this.players.set(linked.playerId, linked);
    this.playerIdByProvider.set(key, linked.playerId);
    this.conflicts.delete(conflictId);
    return { kind: "linked", player: linked };
  }
}

function providerKey(issuer: string, subject: string): string {
  return `${issuer}\u0000${subject}`;
}

function replayOrThrow<T>(stored: StoredRequest<T>, fingerprint: string): T {
  if (stored.fingerprint !== fingerprint) {
    throw new AccountIdempotencyConflictError("idempotency key was reused for different input");
  }
  return stored.result;
}
