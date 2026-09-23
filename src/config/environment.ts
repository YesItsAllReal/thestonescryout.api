export type RuntimeEnvironment = "development" | "staging" | "production";

export interface RuntimeConfiguration {
  readonly environment: RuntimeEnvironment;
  readonly playerTableName: string;
  readonly tokenIssuer: string;
  readonly tokenAudience: string;
  // appleAudience is optional — when absent, Apple sign-in routes return 503
  // and the Lambda starts normally. Deployment is blocked until the exact
  // Sign in with Apple-enabled App ID is confirmed in the Apple Developer portal.
  readonly appleAudience: string | undefined;
  readonly cognitoUserPoolId: string;
  readonly cognitoClientId: string;
  readonly refreshLifetimeSeconds: number;
  readonly guestStartingCoins: number;
  readonly guestStartingGems: number;
  readonly guestStartingEnergy: number;
  readonly accountLinkContentVersion: string | undefined;
  readonly accountDeletionEnabled: boolean;
  readonly economyReadEnabled: boolean;
  readonly entitlementsReadEnabled: boolean;
}

export class EnvironmentConfigurationError extends Error {}

export function loadRuntimeConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeConfiguration {
  const runtimeEnvironment = required(environment, "SCO_ENVIRONMENT");
  if (!isRuntimeEnvironment(runtimeEnvironment)) {
    throw new EnvironmentConfigurationError("SCO_ENVIRONMENT must be development, staging, or production");
  }

  const tokenIssuer = required(environment, "SCO_TOKEN_ISSUER");
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(tokenIssuer);
  } catch {
    throw new EnvironmentConfigurationError("SCO_TOKEN_ISSUER must be an absolute HTTPS URL");
  }
  if (issuerUrl.protocol !== "https:" || issuerUrl.username !== "" || issuerUrl.password !== "") {
    throw new EnvironmentConfigurationError("SCO_TOKEN_ISSUER must be an absolute HTTPS URL");
  }

  const cognitoUserPoolId = required(environment, "SCO_COGNITO_USER_POOL_ID");
  if (!isValidPoolId(cognitoUserPoolId)) {
    throw new EnvironmentConfigurationError("SCO_COGNITO_USER_POOL_ID must be in the format <region>_<id>");
  }

  const cognitoClientId = required(environment, "SCO_COGNITO_CLIENT_ID");
  const tokenAudience   = required(environment, "SCO_TOKEN_AUDIENCE");

  // Fix 4: SCO_TOKEN_AUDIENCE and SCO_COGNITO_CLIENT_ID must be the same value —
  // the Cognito access token's client_id claim is verified against the audience.
  if (tokenAudience !== cognitoClientId) {
    throw new EnvironmentConfigurationError(
      "SCO_TOKEN_AUDIENCE and SCO_COGNITO_CLIENT_ID must be identical",
    );
  }

  // Issue 5: require the exact Cognito issuer URL — no alternate hosts, ports,
  // paths, query strings, or fragments. The only accepted form is:
  // https://cognito-idp.<region>.amazonaws.com/<poolId>
  const poolRegion = cognitoUserPoolId.split("_")[0]!;
  const expectedIssuer = `https://cognito-idp.${poolRegion}.amazonaws.com/${cognitoUserPoolId}`;
  const normalizedIssuer = issuerUrl.toString().replace(/\/$/, "");
  if (
    normalizedIssuer !== expectedIssuer ||
    issuerUrl.port !== "" ||
    issuerUrl.search !== "" ||
    issuerUrl.hash !== ""
  ) {
    throw new EnvironmentConfigurationError(
      "SCO_TOKEN_ISSUER must be the exact Cognito issuer URL for SCO_COGNITO_USER_POOL_ID",
    );
  }

  // Issue 6: 7,776,000 seconds (90 days) is the application-approved safety
  // maximum for this project. It is not Cognito's universal maximum.
  // The development value is 2,592,000 seconds (30 days), matching the
  // sco-dev-mobile app client's RefreshTokenValidity setting.
  // Changing Cognito's RefreshTokenValidity requires changing this value in the
  // same deployment — they must remain in sync.
  const REFRESH_LIFETIME_MAX = 7_776_000; // 90 days in seconds
  const refreshLifetimeRaw = required(environment, "SCO_REFRESH_LIFETIME_SECONDS");
  const refreshLifetimeSeconds = Number(refreshLifetimeRaw);
  if (!Number.isSafeInteger(refreshLifetimeSeconds) || refreshLifetimeSeconds < 1 ||
      refreshLifetimeSeconds > REFRESH_LIFETIME_MAX) {
    throw new EnvironmentConfigurationError(
      `SCO_REFRESH_LIFETIME_SECONDS must be an integer between 1 and ${REFRESH_LIFETIME_MAX}`,
    );
  }

  // Fix 5: starting balances from trusted environment configuration.
  // Bounds match the RemoteEconomyConfiguration safe ranges in the OpenAPI contract.
  const guestStartingCoins  = requiredBoundedInt(environment, "SCO_GUEST_STARTING_COINS",  0, 10_000);
  const guestStartingGems   = requiredBoundedInt(environment, "SCO_GUEST_STARTING_GEMS",   0, 1_000);
  const guestStartingEnergy = requiredBoundedInt(environment, "SCO_GUEST_STARTING_ENERGY", 0, 500);

  // SCO_APPLE_AUDIENCE is optional. When absent, Apple sign-in routes return
  // 503 and the Lambda starts normally. Set it only after confirming that the
  // App ID is Sign in with Apple-enabled in the Apple Developer portal.
  const appleAudienceRaw = environment["SCO_APPLE_AUDIENCE"]?.trim();
  const appleAudience = (appleAudienceRaw !== undefined && appleAudienceRaw !== "")
    ? appleAudienceRaw
    : undefined;
  const accountLinkContentVersion=optionalIdentifier(environment,"SCO_ACCOUNT_LINK_CONTENT_VERSION",64);
  const accountDeletionEnabled=optionalBoolean(environment,"SCO_ACCOUNT_DELETION_ENABLED");
  const economyReadEnabled=optionalBoolean(environment,"SCO_ECONOMY_READ_ENABLED");
  const entitlementsReadEnabled=optionalBoolean(environment,"SCO_ENTITLEMENTS_READ_ENABLED");
  if(accountDeletionEnabled&&appleAudience===undefined)throw new EnvironmentConfigurationError("SCO_ACCOUNT_DELETION_ENABLED requires SCO_APPLE_AUDIENCE");

  return {
    environment: runtimeEnvironment,
    playerTableName: required(environment, "SCO_PLAYER_TABLE_NAME"),
    tokenIssuer: normalizedIssuer,
    tokenAudience,
    appleAudience,
    cognitoUserPoolId,
    cognitoClientId,
    refreshLifetimeSeconds,
    guestStartingCoins,
    guestStartingGems,
    guestStartingEnergy,
    accountLinkContentVersion,
    accountDeletionEnabled,
    economyReadEnabled,
    entitlementsReadEnabled,
  };
}

function optionalIdentifier(environment:Readonly<Record<string,string|undefined>>,name:string,max:number):string|undefined{const value=environment[name]?.trim();if(value===undefined||value==="")return undefined;if(value.length>max||!/^[A-Za-z0-9._-]+$/.test(value))throw new EnvironmentConfigurationError(`${name} is invalid`);return value;}
function optionalBoolean(environment:Readonly<Record<string,string|undefined>>,name:string):boolean{const value=environment[name]?.trim();if(value===undefined||value===""||value==="false")return false;if(value==="true")return true;throw new EnvironmentConfigurationError(`${name} must be true or false`);}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") {
    throw new EnvironmentConfigurationError(`${name} is required`);
  }
  return value;
}

function requiredBoundedInt(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  min: number,
  max: number,
): number {
  const raw = required(environment, name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new EnvironmentConfigurationError(
      `${name} must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}

// Pool ID format: <region>_<alphanumeric-id>
function isValidPoolId(value: string): boolean {
  return /^[a-z]{2}-[a-z]+-\d+_[A-Za-z0-9]+$/.test(value);
}

function isRuntimeEnvironment(value: string): value is RuntimeEnvironment {
  return value === "development" || value === "staging" || value === "production";
}
