import {
  EconomyClaimRejectedError,
  EconomyValidationError,
  type EconomyReason,
  type EconomyResource,
  type EconomySpendRules,
  type ResourceMutation,
  type RewardClaimType,
  type RewardClaimVerifier,
  type SpendAction,
} from "./economy-service.js";

export interface TrustedSpendRule {
  readonly action: SpendAction;
  readonly referenceId: string;
  readonly mutations: readonly ResourceMutation[];
  readonly reasonCode: "STORE_SPEND" | "INVENTORY_EXPANSION";
  readonly sourceReference: string;
}

export interface VerifiedRewardEvidence {
  readonly claimType: RewardClaimType;
  readonly claimId: string;
  readonly rewardId: "dailyGift" | "rewardedCoins" | "rewardedEnergy";
  readonly sourceReference: string;
}

export interface RewardEvidenceVerifier {
  verify(input: {
    readonly playerId: string;
    readonly claimType: RewardClaimType;
    readonly claimId: string;
    readonly claimToken?: string | undefined;
    readonly now: Date;
  }): Promise<VerifiedRewardEvidence>;
}

export interface ApprovedRewardConfiguration {
  readonly dailyGiftCoins: number;
  readonly dailyGiftEnergy: number;
  readonly rewardedCoins: number;
  readonly rewardedEnergy: number;
}

export class ConfiguredEconomySpendRules implements EconomySpendRules {
  private readonly rules = new Map<string, TrustedSpendRule>();

  public constructor(values: readonly TrustedSpendRule[]) {
    for (const value of values) {
      validateRule(value);
      const key = ruleKey(value.action, value.referenceId);
      if (this.rules.has(key)) throw new EconomyValidationError("duplicate trusted spend rule");
      this.rules.set(key, Object.freeze({ ...value, mutations: Object.freeze([...value.mutations]) }));
    }
  }

  public async resolve(input: { readonly action: SpendAction; readonly referenceId: string; readonly now: Date }) {
    const rule = this.rules.get(ruleKey(input.action, input.referenceId));
    if (rule === undefined) throw new EconomyValidationError("spend rule is not configured");
    return { mutations: rule.mutations, reasonCode: rule.reasonCode, sourceReference: rule.sourceReference };
  }
}

export class ConfiguredRewardClaimVerifier implements RewardClaimVerifier {
  public constructor(
    private readonly evidence: RewardEvidenceVerifier,
    private readonly configuration: ApprovedRewardConfiguration,
  ) {
    for (const value of Object.values(configuration)) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 1_000) {
        throw new EconomyValidationError("reward configuration is outside safe bounds");
      }
    }
  }

  public async verify(input: Parameters<RewardClaimVerifier["verify"]>[0]) {
    let verified: VerifiedRewardEvidence;
    try { verified = await this.evidence.verify(input); }
    catch { throw new EconomyClaimRejectedError("reward evidence could not be verified"); }
    if (verified.claimType !== input.claimType || verified.claimId !== input.claimId ||
        !validReference(verified.sourceReference)) {
      throw new EconomyClaimRejectedError("reward evidence does not match the request");
    }
    return rewardFor(verified, this.configuration);
  }
}

function rewardFor(evidence: VerifiedRewardEvidence, config: ApprovedRewardConfiguration): {
  readonly mutations: readonly ResourceMutation[];
  readonly reasonCode: Exclude<EconomyReason, "ENERGY_REGEN" | "STORE_SPEND" | "INVENTORY_EXPANSION">;
  readonly sourceReference: string;
} {
  if (evidence.rewardId === "dailyGift" && evidence.claimType === "dailyGift") {
    return { mutations: nonZero([["coins", config.dailyGiftCoins], ["energy", config.dailyGiftEnergy]]), reasonCode: "DAILY_GIFT", sourceReference: evidence.sourceReference };
  }
  if (evidence.rewardId === "rewardedCoins" && evidence.claimType === "ad") {
    return { mutations: nonZero([["coins", config.rewardedCoins]]), reasonCode: "AD_REWARD", sourceReference: evidence.sourceReference };
  }
  if (evidence.rewardId === "rewardedEnergy" && evidence.claimType === "ad") {
    return { mutations: nonZero([["energy", config.rewardedEnergy]]), reasonCode: "AD_REWARD", sourceReference: evidence.sourceReference };
  }
  throw new EconomyClaimRejectedError("reward evidence is not approved for this claim type");
}

function nonZero(values: readonly (readonly [EconomyResource, number])[]): ResourceMutation[] {
  const mutations = values.filter(([, value]) => value > 0).map(([resource, delta]) => ({ resource, delta }));
  if (mutations.length === 0) throw new EconomyClaimRejectedError("approved reward has no grant");
  return mutations;
}

function validateRule(rule: TrustedSpendRule): void {
  if (!validReference(rule.referenceId) || !validReference(rule.sourceReference) ||
      rule.mutations.length < 1 || rule.mutations.length > 3 ||
      !rule.mutations.some((value) => value.delta < 0)) {
    throw new EconomyValidationError("trusted spend rule is invalid");
  }
  for (const mutation of rule.mutations) {
    if (!Number.isSafeInteger(mutation.delta) || mutation.delta === 0 ||
        (mutation.resource !== "coins" && mutation.resource !== "gems" && mutation.resource !== "energy")) {
      throw new EconomyValidationError("trusted spend mutation is invalid");
    }
  }
}

function validReference(value: string): boolean { return /^[A-Za-z0-9._:-]{1,128}$/.test(value); }
function ruleKey(action: SpendAction, referenceId: string): string { return `${action}\u0000${referenceId}`; }
