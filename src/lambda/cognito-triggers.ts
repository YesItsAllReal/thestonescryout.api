import { randomBytes, timingSafeEqual } from "node:crypto";

// Minimal Cognito trigger event shape — only the fields this handler uses.
interface CognitoTriggerEvent {
  readonly triggerSource: string;
  readonly request: {
    readonly userNotFound?: boolean;
    readonly session?: ReadonlyArray<{
      readonly challengeName?: unknown;
      readonly challengeResult?: unknown;
    }>;
    readonly challengeName?: string;
    readonly challengeAnswer?: string;
    readonly privateChallengeParameters?: Readonly<Record<string, string>>;
  };
  response: {
    challengeName?: string;
    issueTokens?: boolean;
    failAuthentication?: boolean;
    publicChallengeParameters?: Record<string, string>;
    privateChallengeParameters?: Record<string, string>;
    answerCorrect?: boolean;
  };
}

export async function handler(event: CognitoTriggerEvent): Promise<CognitoTriggerEvent> {
  // Never log the event — it may contain ChallengeParameters, session tokens,
  // challenge answers, or user-not-found signals.
  switch (event.triggerSource) {
    case "DefineAuthChallenge_Authentication":          return defineAuth(event);
    case "CreateAuthChallenge_Authentication":          return createAuth(event);
    case "VerifyAuthChallengeResponse_Authentication":  return verifyAuth(event);
    default:
      throw new Error(`unexpected triggerSource: ${event.triggerSource}`);
  }
}

function defineAuth(event: CognitoTriggerEvent): CognitoTriggerEvent {
  // Fail closed for nonexistent users — same response as a wrong answer.
  if (event.request.userNotFound === true) {
    event.response.failAuthentication = true;
    event.response.issueTokens = false;
    return event;
  }

  const session = event.request.session ?? [];

  // Reject if any session entry is not a well-formed CUSTOM_CHALLENGE record.
  // An unexpected challenge type (PASSWORD_VERIFIER, SRP_A, etc.), a missing
  // challengeName, or a non-boolean challengeResult all indicate unexpected
  // history and must fail closed.
  for (const entry of session) {
    if (
      entry.challengeName !== "CUSTOM_CHALLENGE" ||
      typeof entry.challengeResult !== "boolean"
    ) {
      event.response.failAuthentication = true;
      event.response.issueTokens = false;
      return event;
    }
  }

  // All entries are well-formed CUSTOM_CHALLENGE records.
  const successCount = session.filter((s) => s.challengeResult === true).length;
  const failCount    = session.filter((s) => s.challengeResult === false).length;

  if (session.length === 0) {
    // First attempt — issue exactly one challenge.
    event.response.challengeName = "CUSTOM_CHALLENGE";
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
    return event;
  }

  if (successCount === 1 && failCount === 0 && session.length === 1) {
    // Exactly one successful challenge, no failures, no retries — issue tokens.
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
    return event;
  }

  // Any other history: failures, repeated attempts — reject.
  event.response.failAuthentication = true;
  event.response.issueTokens = false;
  return event;
}

function createAuth(event: CognitoTriggerEvent): CognitoTriggerEvent {
  // Fail closed for nonexistent users or unexpected trigger state.
  if (event.request.userNotFound === true) {
    event.response.publicChallengeParameters  = {};
    event.response.privateChallengeParameters = {};
    return event;
  }
  if (event.request.challengeName !== "CUSTOM_CHALLENGE") {
    throw new Error(`unexpected challengeName: ${event.request.challengeName ?? "(none)"}`);
  }

  // 256-bit cryptographically random proof. Never logged or stored outside
  // Cognito's server-side session state.
  const proof = randomBytes(32).toString("hex");

  // proof is placed in both parameters:
  // - privateChallengeParameters: held server-side by Cognito for VerifyAuthChallengeResponse
  // - publicChallengeParameters: returned to the AdminInitiateAuth caller (the API Lambda only)
  // The mobile client never calls AdminInitiateAuth and never sees this value.
  event.response.privateChallengeParameters = { proof };
  event.response.publicChallengeParameters  = { proof };
  return event;
}

function verifyAuth(event: CognitoTriggerEvent): CognitoTriggerEvent {
  // Never log challengeAnswer or privateChallengeParameters.
  const expected = event.request.privateChallengeParameters?.["proof"];
  const actual   = event.request.challengeAnswer;

  if (
    typeof expected !== "string" || expected.length === 0 ||
    typeof actual   !== "string" || actual.length   === 0 ||
    expected.length !== actual.length
  ) {
    // Length check is required before timingSafeEqual — it throws on unequal buffer lengths.
    event.response.answerCorrect = false;
    return event;
  }

  event.response.answerCorrect = timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(actual,   "utf8"),
  );
  return event;
}
