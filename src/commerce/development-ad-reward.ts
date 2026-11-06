import {
  CommerceValidationError,
  CommerceVerificationError,
  type AdCompletionVerifier,
  type AdPlacement,
  type AdRewardCatalog,
  type AdRewardChoice,
  type VerifiedAdCompletion,
} from "./commerce-service.js";
import type { ResourceMutation } from "../economy/economy-service.js";

const googleRewardedTestUnit = "ca-app-pub-3940256099942544/1712485313";

interface DevelopmentAdMobEnvelope {
  readonly provider: "google-admob";
  readonly claimID: string;
  readonly responseIdentifier: string;
  readonly adUnitID: string;
  readonly earnedCallback: true;
}

export class DevelopmentAdMobCompletionVerifier implements AdCompletionVerifier {
  public async verify(
    payload: string,
    _now: Date,
    expected: { readonly playerId: string; readonly claimId: string },
  ): Promise<VerifiedAdCompletion> {
    const envelope = parseEnvelope(payload);
    if (envelope.claimID !== expected.claimId) {
      throw new CommerceVerificationError("test ad claim does not match");
    }
    return {
      provider: "google-admob-test",
      providerEventId: envelope.responseIdentifier,
      claimId: expected.claimId,
      playerId: expected.playerId,
    };
  }
}

export class DevelopmentAdRewardCatalog implements AdRewardCatalog {
  public async resolve(
    placement: AdPlacement,
    rewardChoice: AdRewardChoice,
  ): Promise<readonly ResourceMutation[]> {
    if (rewardChoice === "energy20" && (placement === "storeEnergy" || placement === "energyEmpty")) {
      return [{ resource: "energy", delta: 20 }];
    }
    if (rewardChoice === "coins100" && placement === "storeCoins") {
      return [{ resource: "coins", delta: 100 }];
    }
    throw new CommerceValidationError("reward choice is not valid for placement");
  }
}

function parseEnvelope(payload: string): DevelopmentAdMobEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new CommerceVerificationError("test ad payload is malformed");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CommerceVerificationError("test ad payload is malformed");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ["adUnitID", "claimID", "earnedCallback", "provider", "responseIdentifier"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new CommerceVerificationError("test ad payload shape is invalid");
  }
  if (
    record.provider !== "google-admob" ||
    record.adUnitID !== googleRewardedTestUnit ||
    record.earnedCallback !== true ||
    typeof record.claimID !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.claimID) ||
    typeof record.responseIdentifier !== "string" ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(record.responseIdentifier) ||
    record.responseIdentifier === "unavailable"
  ) {
    throw new CommerceVerificationError("test ad payload could not be verified");
  }
  return record as unknown as DevelopmentAdMobEnvelope;
}
