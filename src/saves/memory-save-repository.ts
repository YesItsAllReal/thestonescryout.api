import {
  SaveIdempotencyConflictError,
  type GameSave,
  type SaveRepository,
  type SaveWriteResult,
} from "./save-service.js";

interface StoredWrite {
  readonly fingerprint: string;
  readonly result: SaveWriteResult;
}

export class MemorySaveRepository implements SaveRepository {
  private readonly saves = new Map<string, GameSave>();
  private readonly writes = new Map<string, StoredWrite>();

  public async get(playerId: string, slot: string): Promise<GameSave | undefined> {
    return this.saves.get(saveKey(playerId, slot));
  }

  public async putConditionally(
    input: Parameters<SaveRepository["putConditionally"]>[0],
  ): Promise<SaveWriteResult> {
    const fingerprint = JSON.stringify([
      input.playerId,
      input.slot,
      input.expectedRevision,
      input.schemaVersion,
      input.snapshot,
      input.deviceIdHash,
    ]);
    const idempotencyScope = `${input.playerId}\u0000${input.idempotencyKey}`;
    const replay = this.writes.get(idempotencyScope);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint) {
        throw new SaveIdempotencyConflictError("idempotency key was reused for a different save write");
      }
      return replay.result;
    }

    const key = saveKey(input.playerId, input.slot);
    const current = this.saves.get(key);
    const currentRevision = current?.revision ?? 0;
    let result: SaveWriteResult;
    if (currentRevision !== input.expectedRevision) {
      result = {
        kind: "conflict",
        conflict: {
          slot: input.slot,
          currentRevision,
          ...(current === undefined ? {} : {
            currentSchemaVersion: current.schemaVersion,
            currentUpdatedAt: current.updatedAt,
          }),
        },
      };
    } else {
      const save: GameSave = {
        slot: input.slot,
        revision: currentRevision + 1,
        schemaVersion: input.schemaVersion,
        snapshot: input.snapshot,
        updatedAt: input.now.toISOString(),
      };
      this.saves.set(key, save);
      result = { kind: "saved", save };
    }
    this.writes.set(idempotencyScope, { fingerprint, result });
    return result;
  }
}

function saveKey(playerId: string, slot: string): string {
  return `${playerId}\u0000${slot}`;
}
