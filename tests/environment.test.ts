import assert from "node:assert/strict";
import test from "node:test";

import {
  EnvironmentConfigurationError,
  loadRuntimeConfiguration,
} from "../src/config/environment.js";

// Valid complete configuration used as a baseline.
const VALID: Record<string, string> = {
  SCO_ENVIRONMENT: "development",
  SCO_PLAYER_TABLE_NAME: "example-player-table",
  SCO_TOKEN_ISSUER: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ExamplePool",
  SCO_TOKEN_AUDIENCE: "example-client-id",
  SCO_APPLE_AUDIENCE: "com.example.application",
  SCO_COGNITO_USER_POOL_ID: "us-east-1_ExamplePool",
  SCO_COGNITO_CLIENT_ID: "example-client-id",
  SCO_REFRESH_LIFETIME_SECONDS: "2592000",
  SCO_GUEST_STARTING_COINS: "100",
  SCO_GUEST_STARTING_GEMS: "5",
  SCO_GUEST_STARTING_ENERGY: "40",
};

test("runtime configuration loads all fields correctly", () => {
  assert.deepEqual(loadRuntimeConfiguration(VALID), {
    environment: "development",
    playerTableName: "example-player-table",
    tokenIssuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ExamplePool",
    tokenAudience: "example-client-id",
    appleAudience: "com.example.application",
    cognitoUserPoolId: "us-east-1_ExamplePool",
    cognitoClientId: "example-client-id",
    refreshLifetimeSeconds: 2_592_000,
    guestStartingCoins: 100,
    guestStartingGems: 5,
    guestStartingEnergy: 40,
    accountLinkContentVersion: undefined,
    accountDeletionEnabled: false,
    economyReadEnabled: false,
    entitlementsReadEnabled: false,
  });
});

test("runtime configuration returns undefined appleAudience when SCO_APPLE_AUDIENCE is absent", () => {
  const { SCO_APPLE_AUDIENCE: _, ...withoutApple } = VALID;
  const config = loadRuntimeConfiguration(withoutApple);
  assert.equal(config.appleAudience, undefined);
});

test("runtime configuration returns undefined appleAudience when SCO_APPLE_AUDIENCE is empty", () => {
  const config = loadRuntimeConfiguration({ ...VALID, SCO_APPLE_AUDIENCE: "  " });
  assert.equal(config.appleAudience, undefined);
});

test("runtime configuration normalizes trailing slash on issuer", () => {
  const config = loadRuntimeConfiguration({
    ...VALID,
    SCO_TOKEN_ISSUER: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ExamplePool/",
  });
  assert.equal(config.tokenIssuer, "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ExamplePool");
});

test("runtime configuration fails closed without exposing environment values", () => {
  assert.throws(
    () => loadRuntimeConfiguration({ ...VALID, SCO_TOKEN_ISSUER: "http://unsafe.example.test/us-east-1_ExamplePool" }),
    (error: unknown) => error instanceof EnvironmentConfigurationError &&
      error.message === "SCO_TOKEN_ISSUER must be an absolute HTTPS URL",
  );
});

// Fix 4: cross-consistency checks.

test("rejects when SCO_TOKEN_AUDIENCE and SCO_COGNITO_CLIENT_ID differ", () => {
  assert.throws(
    () => loadRuntimeConfiguration({ ...VALID, SCO_TOKEN_AUDIENCE: "different-client" }),
    (error: unknown) => error instanceof EnvironmentConfigurationError &&
      error.message === "SCO_TOKEN_AUDIENCE and SCO_COGNITO_CLIENT_ID must be identical",
  );
});

test("rejects when SCO_TOKEN_ISSUER does not match the exact Cognito issuer URL", () => {
  assert.throws(
    () => loadRuntimeConfiguration({
      ...VALID,
      SCO_TOKEN_ISSUER: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_WrongPool",
      SCO_TOKEN_AUDIENCE: "example-client-id",
    }),
    (error: unknown) => error instanceof EnvironmentConfigurationError &&
      error.message === "SCO_TOKEN_ISSUER must be the exact Cognito issuer URL for SCO_COGNITO_USER_POOL_ID",
  );
});

test("rejects an issuer URL with a query string", () => {
  assert.throws(
    () => loadRuntimeConfiguration({
      ...VALID,
      SCO_TOKEN_ISSUER: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ExamplePool?foo=bar",
    }),
    (error: unknown) => error instanceof EnvironmentConfigurationError,
  );
});

test("rejects an issuer URL with a non-amazonaws host", () => {
  assert.throws(
    () => loadRuntimeConfiguration({
      ...VALID,
      SCO_TOKEN_ISSUER: "https://evil.example.com/us-east-1_ExamplePool",
    }),
    (error: unknown) => error instanceof EnvironmentConfigurationError,
  );
});

test("rejects a malformed pool ID", () => {
  assert.throws(
    () => loadRuntimeConfiguration({ ...VALID, SCO_COGNITO_USER_POOL_ID: "notavalidpoolid" }),
    (error: unknown) => error instanceof EnvironmentConfigurationError &&
      error.message === "SCO_COGNITO_USER_POOL_ID must be in the format <region>_<id>",
  );
});

// Fix 5: starting balance bounds.

test("rejects starting coins above the safe maximum", () => {
  assert.throws(
    () => loadRuntimeConfiguration({ ...VALID, SCO_GUEST_STARTING_COINS: "10001" }),
    (error: unknown) => error instanceof EnvironmentConfigurationError &&
      error.message.includes("SCO_GUEST_STARTING_COINS"),
  );
});

test("rejects starting gems above the safe maximum", () => {
  assert.throws(
    () => loadRuntimeConfiguration({ ...VALID, SCO_GUEST_STARTING_GEMS: "1001" }),
    (error: unknown) => error instanceof EnvironmentConfigurationError &&
      error.message.includes("SCO_GUEST_STARTING_GEMS"),
  );
});

test("rejects starting energy above the safe maximum", () => {
  assert.throws(
    () => loadRuntimeConfiguration({ ...VALID, SCO_GUEST_STARTING_ENERGY: "501" }),
    (error: unknown) => error instanceof EnvironmentConfigurationError &&
      error.message.includes("SCO_GUEST_STARTING_ENERGY"),
  );
});

test("rejects SCO_REFRESH_LIFETIME_SECONDS above the 90-day maximum", () => {
  assert.throws(
    () => loadRuntimeConfiguration({ ...VALID, SCO_REFRESH_LIFETIME_SECONDS: "7776001" }),
    (error: unknown) => error instanceof EnvironmentConfigurationError &&
      error.message.includes("SCO_REFRESH_LIFETIME_SECONDS"),
  );
});

test("accepts SCO_REFRESH_LIFETIME_SECONDS at the 90-day maximum", () => {
  const config = loadRuntimeConfiguration({ ...VALID, SCO_REFRESH_LIFETIME_SECONDS: "7776000" });
  assert.equal(config.refreshLifetimeSeconds, 7_776_000);
});

test("rejects non-integer starting balance", () => {
  assert.throws(
    () => loadRuntimeConfiguration({ ...VALID, SCO_GUEST_STARTING_COINS: "1.5" }),
    (error: unknown) => error instanceof EnvironmentConfigurationError,
  );
});

test("accepts zero starting balances", () => {
  const config = loadRuntimeConfiguration({
    ...VALID,
    SCO_GUEST_STARTING_COINS: "0",
    SCO_GUEST_STARTING_GEMS: "0",
    SCO_GUEST_STARTING_ENERGY: "0",
  });
  assert.equal(config.guestStartingCoins, 0);
  assert.equal(config.guestStartingGems, 0);
  assert.equal(config.guestStartingEnergy, 0);
});

test("optional account-link content version and deletion flag load safely",()=>{const config=loadRuntimeConfiguration({...VALID,SCO_ACCOUNT_LINK_CONTENT_VERSION:"starter-1",SCO_ACCOUNT_DELETION_ENABLED:"true"});assert.equal(config.accountLinkContentVersion,"starter-1");assert.equal(config.accountDeletionEnabled,true);});
test("optional read-route rollout gates default off and require exact booleans",()=>{const defaults=loadRuntimeConfiguration(VALID);assert.equal(defaults.economyReadEnabled,false);assert.equal(defaults.entitlementsReadEnabled,false);const enabled=loadRuntimeConfiguration({...VALID,SCO_ECONOMY_READ_ENABLED:"true",SCO_ENTITLEMENTS_READ_ENABLED:"true"});assert.equal(enabled.economyReadEnabled,true);assert.equal(enabled.entitlementsReadEnabled,true);assert.throws(()=>loadRuntimeConfiguration({...VALID,SCO_ECONOMY_READ_ENABLED:"1"}),/true or false/);assert.throws(()=>loadRuntimeConfiguration({...VALID,SCO_ENTITLEMENTS_READ_ENABLED:"yes"}),/true or false/);});
test("account deletion cannot be enabled without Apple federation",()=>{const {SCO_APPLE_AUDIENCE:_,...withoutApple}=VALID;assert.throws(()=>loadRuntimeConfiguration({...withoutApple,SCO_ACCOUNT_DELETION_ENABLED:"true"}),/requires SCO_APPLE_AUDIENCE/);});
test("invalid optional activation values fail closed",()=>{assert.throws(()=>loadRuntimeConfiguration({...VALID,SCO_ACCOUNT_DELETION_ENABLED:"yes"}));assert.throws(()=>loadRuntimeConfiguration({...VALID,SCO_ACCOUNT_LINK_CONTENT_VERSION:"unsafe/value"}));});
