import assert from "node:assert/strict";
import test from "node:test";
import type { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createAwsIdentityServices } from "../src/app/aws-identity-services.js";
import { DynamoRefreshRegistry } from "../src/auth/dynamo-refresh-registry.js";
import { CognitoSessionProvider } from "../src/auth/cognito-session-provider.js";

test("AWS identity factory composes concrete services without network access", () => {
  let calls = 0;
  const stubClient = { async send() { calls++; return {}; } };

  const services = createAwsIdentityServices({
    documentClient: stubClient as unknown as DynamoDBDocumentClient,
    cognitoClient:  stubClient as unknown as CognitoIdentityProviderClient,
    configuration: {
      playerTableName: "players",
      guestStartingBalance: { coins: 100, gems: 5, energy: 40 },
      tokenIssuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool",
      tokenAudience: "test-client-id",
      appleAudience: "com.example.app",
      cognitoUserPoolId: "us-east-1_TestPool",
      cognitoClientId: "test-client-id",
      refreshLifetimeSeconds: 2_592_000,
    },
    deletionAuthorizer: { async authorize() {} },
    sessionRevoker:     { async revokeAll() {} },
    now: () => new Date(),
  });

  assert.equal(calls, 0);
  assert.ok(services.guestSession);
  assert.ok(services.appleAccount, "appleAccount must be defined when appleAudience is provided");
  assert.ok(services.account);
  assert.ok(services.save);
  assert.ok(services.tokenVerifier);
  assert.ok(services.sessionLifecycle);
});

test("AWS identity factory returns undefined appleAccount when appleAudience is absent", () => {
  const stubClient = { async send() { return {}; } };

  const services = createAwsIdentityServices({
    documentClient: stubClient as unknown as DynamoDBDocumentClient,
    cognitoClient:  stubClient as unknown as CognitoIdentityProviderClient,
    configuration: {
      playerTableName: "players",
      guestStartingBalance: { coins: 0, gems: 0, energy: 0 },
      tokenIssuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool",
      tokenAudience: "test-client-id",
      appleAudience: undefined,
      cognitoUserPoolId: "us-east-1_TestPool",
      cognitoClientId: "test-client-id",
      refreshLifetimeSeconds: 2_592_000,
    },
    deletionAuthorizer: { async authorize() {} },
    sessionRevoker:     { async revokeAll() {} },
    now: () => new Date(),
  });

  assert.equal(services.appleAccount, undefined);
  assert.ok(services.guestSession, "other services must still be available");
});

test("Issue 2: refresh compensation gateway is wired to the registry", () => {
  // Verify that the same CognitoGatewayAdapter instance is passed to both
  // CognitoSessionProvider and DynamoRefreshRegistry so compensation runs
  // in production, not only in direct unit tests.
  let revokedToken: string | undefined;
  const stubbedCognito = {
    async send() { return {}; },
  };

  // We cannot inspect private fields directly, so we verify the wiring
  // indirectly: trigger a rotation DynamoDB failure and confirm the gateway's
  // revoke is called via the registry's compensation path.
  let dbCallCount = 0;
  const stubbedDynamo = {
    async send(cmd: unknown) {
      dbCallCount++;
      // First call: GetCommand for readRequired — return an active record.
      if (dbCallCount === 1) {
        return {
          Item: {
            entityType: "RefreshCredential",
            recordVersion: 1,
            playerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            status: "active",
            expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 86_400,
          },
        };
      }
      // Second call: TransactWriteCommand — simulate DynamoDB failure.
      const dbError = new Error("DynamoDB unavailable");
      throw dbError;
    },
  };

  // Patch fetch to capture the revoke call.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: unknown, options: unknown) => {
    const body = JSON.parse((options as { body: string }).body) as Record<string, unknown>;
    if (typeof body["Token"] === "string") {
      revokedToken = body["Token"] as string;
    }
    return { ok: true, json: async () => ({}) } as Response;
  };

  const services = createAwsIdentityServices({
    documentClient: stubbedDynamo as unknown as DynamoDBDocumentClient,
    cognitoClient:  stubbedCognito as unknown as CognitoIdentityProviderClient,
    configuration: {
      playerTableName: "players",
      guestStartingBalance: { coins: 0, gems: 0, energy: 0 },
      tokenIssuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool",
      tokenAudience: "test-client-id",
      appleAudience: "com.example.app",
      cognitoUserPoolId: "us-east-1_TestPool",
      cognitoClientId: "test-client-id",
      refreshLifetimeSeconds: 2_592_000,
    },
    deletionAuthorizer: { async authorize() {} },
    sessionRevoker:     { async revokeAll() {} },
    now: () => new Date(),
  });

  // Access the internal sessionProvider via the sessionLifecycle service.
  // We trigger refresh which calls registry.rotate with a replacementRawToken.
  const rawRefreshToken = "raw-refresh-token-value-for-wiring-test-0001";
  const replacementRaw  = "replacement-raw-token-for-wiring-test-0002";

  // Stub the gateway's refreshWithRotation to return a known replacement token.
  // We do this by patching fetch to return a token response for GetTokensFromRefreshToken.
  globalThis.fetch = async (_url: unknown, options: unknown) => {
    const body = JSON.parse((options as { body: string }).body) as Record<string, unknown>;
    const target = (options as { headers: Record<string, string> }).headers["X-Amz-Target"] ?? "";
    if (target.includes("GetTokensFromRefreshToken")) {
      return {
        ok: true,
        json: async () => ({
          AccessToken:  "access-token-value-00000001",
          RefreshToken: replacementRaw,
          ExpiresIn:    3600,
        }),
      } as Response;
    }
    if (target.includes("RevokeToken") && typeof body["Token"] === "string") {
      revokedToken = body["Token"] as string;
      return { ok: true, json: async () => ({}) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  };

  const refreshPromise = services.sessionLifecycle
    .refresh(rawRefreshToken)
    .catch(() => { /* DynamoDB error expected */ });

  return refreshPromise.then(() => {
    globalThis.fetch = originalFetch;
    assert.equal(revokedToken, replacementRaw,
      "compensation gateway must revoke the replacement token when DynamoDB rotation fails");
  });
});
