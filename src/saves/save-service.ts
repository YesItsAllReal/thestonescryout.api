import type { AuthenticatedPrincipal } from "../auth/authentication.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface GameSave {
  readonly slot: string;
  readonly revision: number;
  readonly schemaVersion: number;
  readonly snapshot: JsonValue;
  readonly updatedAt: string;
}

export interface SaveWriteRequest {
  readonly slot: string;
  readonly expectedRevision: number;
  readonly schemaVersion: number;
  readonly snapshot: JsonValue;
  readonly deviceId: string;
}

export interface SaveConflictMetadata {
  readonly slot: string;
  readonly currentRevision: number;
  readonly currentSchemaVersion?: number | undefined;
  readonly currentUpdatedAt?: string | undefined;
}

export type SaveWriteResult =
  | { readonly kind: "saved"; readonly save: GameSave }
  | { readonly kind: "conflict"; readonly conflict: SaveConflictMetadata };

export interface SaveRepository {
  get(playerId: string, slot: string): Promise<GameSave | undefined>;
  putConditionally(input: {
    readonly playerId: string;
    readonly slot: string;
    readonly expectedRevision: number;
    readonly schemaVersion: number;
    readonly snapshot: JsonValue;
    readonly deviceIdHash: string;
    readonly idempotencyKey: string;
    readonly now: Date;
  }): Promise<SaveWriteResult>;
}

export interface SaveDeviceIdHasher {
  hash(deviceId: string): string;
}

export class SaveNotFoundError extends Error {}
export class SaveValidationError extends Error {}
export class SaveIdempotencyConflictError extends Error {}
export class SaveRevisionConflictError extends Error {
  public constructor(public readonly conflict: SaveConflictMetadata) {
    super("save revision does not match the current server revision");
  }
}

export class SaveService {
  public constructor(
    private readonly repository: SaveRepository,
    private readonly deviceIdHasher: SaveDeviceIdHasher,
    private readonly now: () => Date,
  ) {}

  public async get(principal: AuthenticatedPrincipal, slot: string): Promise<GameSave> {
    validateSlot(slot);
    const save = await this.repository.get(principal.playerId, slot);
    if (save === undefined) throw new SaveNotFoundError("save was not found");
    return save;
  }

  public async put(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly request: SaveWriteRequest;
    readonly idempotencyKey: string;
  }): Promise<GameSave> {
    validateWrite(input.request, input.idempotencyKey);
    const result = await this.repository.putConditionally({
      playerId: input.principal.playerId,
      slot: input.request.slot,
      expectedRevision: input.request.expectedRevision,
      schemaVersion: input.request.schemaVersion,
      snapshot: input.request.snapshot,
      deviceIdHash: this.deviceIdHasher.hash(input.request.deviceId),
      idempotencyKey: input.idempotencyKey,
      now: this.now(),
    });
    if (result.kind === "conflict") throw new SaveRevisionConflictError(result.conflict);
    return result.save;
  }
}

function validateWrite(request: SaveWriteRequest, idempotencyKey: string): void {
  validateSlot(request.slot);
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
    throw new SaveValidationError("expectedRevision must be a nonnegative integer");
  }
  if (!Number.isSafeInteger(request.schemaVersion) || request.schemaVersion < 1 || request.schemaVersion > 10_000) {
    throw new SaveValidationError("schemaVersion is invalid");
  }
  if (!isUuid(request.deviceId)) {
    throw new SaveValidationError("deviceId must be a random UUID");
  }
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(idempotencyKey)) {
    throw new SaveValidationError("idempotency key is invalid");
  }
  if (request.snapshot === null || Array.isArray(request.snapshot) || typeof request.snapshot !== "object") {
    throw new SaveValidationError("snapshot must be a JSON object");
  }
  validateJson(request.snapshot, 0);
  // Leaves room below DynamoDB's 400 KiB item limit for keys and metadata.
  if (Buffer.byteLength(JSON.stringify(request.snapshot), "utf8") > 307_200) {
    throw new SaveValidationError("snapshot exceeds the local API size limit");
  }
}

function validateSlot(slot: string): void {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(slot)) throw new SaveValidationError("slot is invalid");
}

function validateJson(value: JsonValue, depth: number): void {
  if (depth > 64) throw new SaveValidationError("snapshot nesting is too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SaveValidationError("snapshot contains a non-finite number");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || key.length > 128) throw new SaveValidationError("snapshot key length is invalid");
    validateJson(item, depth + 1);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
