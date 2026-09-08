import type { AuthenticatedPrincipal } from "../auth/authentication.js";

export type EconomyResource = "coins" | "gems" | "energy";
export type EconomyReason =
  | "ORDER_REWARD"
  | "SPOTLIGHT_REWARD"
  | "DAILY_GIFT"
  | "QUIZ_REWARD"
  | "AD_REWARD"
  | "IAP_GRANT"
  | "ENERGY_REGEN"
  | "STORE_SPEND"
  | "INVENTORY_EXPANSION"
  | "EVENT_REWARD"
  | "OFFLINE_SYNC_RECONCILIATION";

export interface EconomyBalance {
  readonly coins: number;
  readonly gems: number;
  readonly energy: number;
  readonly energyUpdatedAt: string;
  readonly revision: number;
}

export interface ResourceMutation {
  readonly resource: EconomyResource;
  readonly delta: number;
}

export interface LedgerEntry {
  readonly ledgerEntryId: string;
  readonly resource: EconomyResource;
  readonly delta: number;
  readonly reasonCode: EconomyReason;
  readonly sourceReference: string;
  readonly balanceAfter: number;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly clientBuild: number;
  readonly contentVersion: string;
}

export interface EconomyMutationResult {
  readonly balance: EconomyBalance;
  readonly ledgerEntries: readonly LedgerEntry[];
}

export type EconomyApplyResult =
  | { readonly kind: "applied"; readonly result: EconomyMutationResult }
  | { readonly kind: "revisionConflict"; readonly currentRevision: number };

export interface EconomyRepository {
  getBalance(playerId: string, now: Date): Promise<EconomyBalance>;
  applyAtomically(input: {
    readonly playerId: string;
    readonly expectedRevision?: number | undefined;
    readonly requestFingerprint: string;
    readonly uniqueGrantKey?: string | undefined;
    readonly mutations: readonly ResourceMutation[];
    readonly reasonCode: EconomyReason;
    readonly sourceReference: string;
    readonly idempotencyKey: string;
    readonly clientBuild: number;
    readonly contentVersion: string;
    readonly now: Date;
  }): Promise<EconomyApplyResult>;
}

export type SpendAction = "inventoryExpansion" | "storeOffer" | "energyRefill" | "cooldownSkip";

export interface EconomySpendRules {
  resolve(input: {
    readonly action: SpendAction;
    readonly referenceId: string;
    readonly now: Date;
  }): Promise<{
    readonly mutations: readonly ResourceMutation[];
    readonly reasonCode: "STORE_SPEND" | "INVENTORY_EXPANSION";
    readonly sourceReference: string;
  }>;
}

export type RewardClaimType = "order" | "spotlight" | "dailyGift" | "quiz" | "ad" | "event";

export interface RewardClaimVerifier {
  verify(input: {
    readonly playerId: string;
    readonly claimType: RewardClaimType;
    readonly claimId: string;
    readonly claimToken?: string | undefined;
    readonly now: Date;
  }): Promise<{
    readonly mutations: readonly ResourceMutation[];
    readonly reasonCode: Exclude<EconomyReason, "ENERGY_REGEN" | "STORE_SPEND" | "INVENTORY_EXPANSION">;
    readonly sourceReference: string;
  }>;
}

export class EconomyValidationError extends Error {}
export class EconomyNotFoundError extends Error {}
export class EconomyIdempotencyConflictError extends Error {}
export class EconomyInsufficientFundsError extends Error {}
export class EconomyClaimRejectedError extends Error {}
export class EconomyRevisionConflictError extends Error {
  public constructor(public readonly currentRevision: number) {
    super("economy revision does not match the current server revision");
  }
}

export class EconomyService {
  public constructor(
    private readonly repository: EconomyRepository,
    private readonly spendRules: EconomySpendRules,
    private readonly rewardVerifier: RewardClaimVerifier,
    private readonly now: () => Date,
  ) {}

  public async getBalance(principal: AuthenticatedPrincipal): Promise<EconomyBalance> {
    return this.repository.getBalance(principal.playerId, this.now());
  }

  public async spend(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly action: SpendAction;
    readonly referenceId: string;
    readonly expectedRevision: number;
    readonly idempotencyKey: string;
    readonly clientBuild: number;
    readonly contentVersion: string;
  }): Promise<EconomyMutationResult> {
    validateCommon(input);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new EconomyValidationError("expectedRevision is invalid");
    }
    const timestamp = this.now();
    const resolved = await this.spendRules.resolve({
      action: input.action,
      referenceId: input.referenceId,
      now: timestamp,
    });
    const mutations = normalizeMutations(resolved.mutations, "spend");
    if (!mutations.some((mutation) => mutation.delta < 0)) {
      throw new EconomyValidationError("spend rules must include a debit");
    }
    return this.apply({
      ...input,
      expectedRevision: input.expectedRevision,
      requestFingerprint: JSON.stringify(["spend", input.action, input.referenceId, input.expectedRevision, input.clientBuild, input.contentVersion]),
      mutations,
      reasonCode: resolved.reasonCode,
      sourceReference: resolved.sourceReference,
      now: timestamp,
    });
  }

  public async claimReward(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly claimType: RewardClaimType;
    readonly claimId: string;
    readonly claimToken?: string | undefined;
    readonly idempotencyKey: string;
    readonly clientBuild: number;
    readonly contentVersion: string;
  }): Promise<EconomyMutationResult> {
    validateCommon(input);
    validateReference(input.claimId, "claimId");
    if (input.claimToken !== undefined && (input.claimToken.length < 8 || input.claimToken.length > 16_384)) {
      throw new EconomyValidationError("claimToken length is invalid");
    }
    const timestamp = this.now();
    let verified: Awaited<ReturnType<RewardClaimVerifier["verify"]>>;
    try {
      verified = await this.rewardVerifier.verify({
        playerId: input.principal.playerId,
        claimType: input.claimType,
        claimId: input.claimId,
        claimToken: input.claimToken,
        now: timestamp,
      });
    } catch {
      throw new EconomyClaimRejectedError("reward claim could not be verified");
    }
    const mutations = normalizeMutations(verified.mutations, "reward");
    if (mutations.some((mutation) => mutation.delta <= 0)) {
      throw new EconomyClaimRejectedError("verified rewards must contain only positive grants");
    }
    return this.apply({
      ...input,
      requestFingerprint: JSON.stringify(["reward", input.claimType, input.claimId, input.claimToken ?? null, input.clientBuild, input.contentVersion]),
      uniqueGrantKey: `${input.claimType}:${input.claimId}`,
      mutations,
      reasonCode: verified.reasonCode,
      sourceReference: verified.sourceReference,
      now: timestamp,
    });
  }

  private async apply(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly expectedRevision?: number | undefined;
    readonly requestFingerprint: string;
    readonly uniqueGrantKey?: string | undefined;
    readonly mutations: readonly ResourceMutation[];
    readonly reasonCode: EconomyReason;
    readonly sourceReference: string;
    readonly idempotencyKey: string;
    readonly clientBuild: number;
    readonly contentVersion: string;
    readonly now: Date;
  }): Promise<EconomyMutationResult> {
    const result = await this.repository.applyAtomically({
      playerId: input.principal.playerId,
      expectedRevision: input.expectedRevision,
      requestFingerprint: input.requestFingerprint,
      uniqueGrantKey: input.uniqueGrantKey,
      mutations: input.mutations,
      reasonCode: input.reasonCode,
      sourceReference: input.sourceReference,
      idempotencyKey: input.idempotencyKey,
      clientBuild: input.clientBuild,
      contentVersion: input.contentVersion,
      now: input.now,
    });
    if (result.kind === "revisionConflict") {
      throw new EconomyRevisionConflictError(result.currentRevision);
    }
    return result.result;
  }
}

function validateCommon(input: {
  readonly referenceId?: string | undefined;
  readonly idempotencyKey: string;
  readonly clientBuild: number;
  readonly contentVersion: string;
}): void {
  if (input.referenceId !== undefined) validateReference(input.referenceId, "referenceId");
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(input.idempotencyKey)) throw new EconomyValidationError("idempotency key is invalid");
  if (!Number.isSafeInteger(input.clientBuild) || input.clientBuild < 1) throw new EconomyValidationError("clientBuild is invalid");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.contentVersion)) throw new EconomyValidationError("contentVersion is invalid");
}

function validateReference(value: string, name: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new EconomyValidationError(`${name} is invalid`);
}

function normalizeMutations(values: readonly ResourceMutation[], operation: string): ResourceMutation[] {
  const totals = new Map<EconomyResource, number>();
  for (const value of values) {
    if (!Number.isSafeInteger(value.delta) || value.delta === 0) {
      throw new EconomyValidationError(`${operation} mutation delta is invalid`);
    }
    totals.set(value.resource, (totals.get(value.resource) ?? 0) + value.delta);
  }
  const normalized = [...totals].filter(([, delta]) => delta !== 0).map(([resource, delta]) => ({ resource, delta }));
  if (normalized.length === 0) throw new EconomyValidationError(`${operation} has no mutations`);
  return normalized;
}
