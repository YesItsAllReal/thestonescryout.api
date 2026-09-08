import assert from "node:assert/strict";
import test from "node:test";

import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  AdminSetUserPasswordCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

import { CognitoGatewayAdapter, CognitoUserOwnershipError } from "../src/auth/cognito-gateway-adapter.js";
import { CognitoSessionRejectedError } from "../src/auth/cognito-session-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POOL_ID   = "us-east-1_TestPool";
const CLIENT_ID = "test-client-id";
const PLAYER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROOF     = "a".repeat(64);

const ISSUED_TOKENS = {
  AuthenticationResult: {
    AccessToken:  "access-token-value-00000001",
    RefreshToken: "refresh-token-value-00000001",
    ExpiresIn:    3600,
  },
};

class ScriptedCognito {
  public readonly commands: unknown[] = [];
  public constructor(private readonly responses: Array<unknown | Error>) {}
  public async send(command: unknown): Promise<unknown> {
    this.commands.push(command);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response ?? {};
  }
}

function usernameExists(): Error {
  const e = new Error("exists"); e.name = "UsernameExistsException"; return e;
}

function adapter(client: ScriptedCognito): CognitoGatewayAdapter {
  return new CognitoGatewayAdapter(
    client as unknown as CognitoIdentityProviderClient,
    POOL_ID,
    CLIENT_ID,
  );
}

function initiateResponse(proof = PROOF) {
  return {
    ChallengeName: "CUSTOM_CHALLENGE",
    Session: "session-token-value",
    ChallengeParameters: { proof },
  };
}

// ---------------------------------------------------------------------------
// Normal issuance
// ---------------------------------------------------------------------------

test("startCustomAuthentication issues the full create→confirm→auth sequence", async () => {
  const client = new ScriptedCognito([
    {},                    // AdminCreateUser
    {},                    // AdminSetUserPassword
    initiateResponse(),    // AdminInitiateAuth
    ISSUED_TOKENS,         // AdminRespondToAuthChallenge
  ]);

  const tokens = await adapter(client).startCustomAuthentication({ playerId: PLAYER_ID });

  assert.equal(tokens.accessToken,  ISSUED_TOKENS.AuthenticationResult.AccessToken);
  assert.equal(tokens.refreshToken, ISSUED_TOKENS.AuthenticationResult.RefreshToken);
  assert.equal(tokens.expiresInSeconds, 3600);

  assert.equal(client.commands.length, 4);
  assert.ok(client.commands[0] instanceof AdminCreateUserCommand);
  assert.ok(client.commands[1] instanceof AdminSetUserPasswordCommand);
  assert.ok(client.commands[2] instanceof AdminInitiateAuthCommand);
  assert.ok(client.commands[3] instanceof AdminRespondToAuthChallengeCommand);
});

test("AdminCreateUser is called with MessageAction=SUPPRESS", async () => {
  const client = new ScriptedCognito([{}, {}, initiateResponse(), ISSUED_TOKENS]);
  await adapter(client).startCustomAuthentication({ playerId: PLAYER_ID });

  const cmd = client.commands[0] as AdminCreateUserCommand;
  assert.equal(cmd.input.MessageAction, "SUPPRESS");
  assert.equal(cmd.input.Username, PLAYER_ID);
});

test("AdminSetUserPassword is called with Permanent=true", async () => {
  const client = new ScriptedCognito([{}, {}, initiateResponse(), ISSUED_TOKENS]);
  await adapter(client).startCustomAuthentication({ playerId: PLAYER_ID });

  const cmd = client.commands[1] as AdminSetUserPasswordCommand;
  assert.equal(cmd.input.Permanent, true);
  assert.equal(cmd.input.Username, PLAYER_ID);
  // The password must not be empty and must not equal the player ID.
  assert.ok(typeof cmd.input.Password === "string" && cmd.input.Password.length > 0);
  assert.notEqual(cmd.input.Password, PLAYER_ID);
});

test("discarded passwords are different on each call", async () => {
  const client1 = new ScriptedCognito([{}, {}, initiateResponse(), ISSUED_TOKENS]);
  const client2 = new ScriptedCognito([{}, {}, initiateResponse(), ISSUED_TOKENS]);
  await adapter(client1).startCustomAuthentication({ playerId: PLAYER_ID });
  await adapter(client2).startCustomAuthentication({ playerId: PLAYER_ID });

  const pw1 = (client1.commands[1] as AdminSetUserPasswordCommand).input.Password;
  const pw2 = (client2.commands[1] as AdminSetUserPasswordCommand).input.Password;
  assert.notEqual(pw1, pw2);
});

// ---------------------------------------------------------------------------
// Partial creation recovery: AdminCreateUser succeeded, AdminSetUserPassword failed
// ---------------------------------------------------------------------------

test("retry after AdminSetUserPassword failure resumes confirmation without recreating", async () => {
  const client = new ScriptedCognito([
    usernameExists(),                                          // AdminCreateUser → exists
    { Username: PLAYER_ID, UserStatus: "FORCE_CHANGE_PASSWORD" }, // AdminGetUser
    {},                                                        // AdminSetUserPassword (resume)
    initiateResponse(),                                        // AdminInitiateAuth
    ISSUED_TOKENS,                                             // AdminRespondToAuthChallenge
  ]);

  const tokens = await adapter(client).startCustomAuthentication({ playerId: PLAYER_ID });
  assert.equal(tokens.accessToken, ISSUED_TOKENS.AuthenticationResult.AccessToken);

  assert.ok(client.commands[0] instanceof AdminCreateUserCommand);
  assert.ok(client.commands[1] instanceof AdminGetUserCommand);
  assert.ok(client.commands[2] instanceof AdminSetUserPasswordCommand);
  assert.ok(client.commands[3] instanceof AdminInitiateAuthCommand);
  assert.ok(client.commands[4] instanceof AdminRespondToAuthChallengeCommand);
});

// ---------------------------------------------------------------------------
// Partial creation recovery: user already CONFIRMED
// ---------------------------------------------------------------------------

test("retry when user is already CONFIRMED skips AdminSetUserPassword", async () => {
  const client = new ScriptedCognito([
    usernameExists(),                                    // AdminCreateUser → exists
    { Username: PLAYER_ID, UserStatus: "CONFIRMED" },   // AdminGetUser
    initiateResponse(),                                  // AdminInitiateAuth
    ISSUED_TOKENS,                                       // AdminRespondToAuthChallenge
  ]);

  await adapter(client).startCustomAuthentication({ playerId: PLAYER_ID });

  assert.ok(client.commands[0] instanceof AdminCreateUserCommand);
  assert.ok(client.commands[1] instanceof AdminGetUserCommand);
  // AdminSetUserPassword must NOT be called for a confirmed user.
  assert.ok(client.commands[2] instanceof AdminInitiateAuthCommand);
  assert.equal(client.commands.length, 4);
});

// ---------------------------------------------------------------------------
// Ownership mismatch
// ---------------------------------------------------------------------------

test("UsernameExistsException with mismatched username throws CognitoUserOwnershipError", async () => {
  const client = new ScriptedCognito([
    usernameExists(),
    { Username: "different-player-id", UserStatus: "CONFIRMED" },
  ]);

  await assert.rejects(
    adapter(client).startCustomAuthentication({ playerId: PLAYER_ID }),
    CognitoUserOwnershipError,
  );
});

// ---------------------------------------------------------------------------
// Challenge validation
// ---------------------------------------------------------------------------

test("missing proof in ChallengeParameters throws CognitoSessionRejectedError", async () => {
  const client = new ScriptedCognito([
    {},
    {},
    { ChallengeName: "CUSTOM_CHALLENGE", Session: "s", ChallengeParameters: {} },
  ]);

  await assert.rejects(
    adapter(client).startCustomAuthentication({ playerId: PLAYER_ID }),
    CognitoSessionRejectedError,
  );
});

test("unexpected ChallengeName throws CognitoSessionRejectedError", async () => {
  const client = new ScriptedCognito([
    {},
    {},
    { ChallengeName: "PASSWORD_VERIFIER", Session: "s", ChallengeParameters: {} },
  ]);

  await assert.rejects(
    adapter(client).startCustomAuthentication({ playerId: PLAYER_ID }),
    CognitoSessionRejectedError,
  );
});

test("missing AuthenticationResult in respond throws CognitoSessionRejectedError", async () => {
  const client = new ScriptedCognito([
    {},
    {},
    initiateResponse(),
    {},  // No AuthenticationResult
  ]);

  await assert.rejects(
    adapter(client).startCustomAuthentication({ playerId: PLAYER_ID }),
    CognitoSessionRejectedError,
  );
});

// ---------------------------------------------------------------------------
// Configuration validation
// ---------------------------------------------------------------------------

test("empty userPoolId throws at construction", () => {
  assert.throws(
    () => new CognitoGatewayAdapter({} as never, "", CLIENT_ID),
    /userPoolId must be in the format/,
  );
});

test("malformed userPoolId throws at construction", () => {
  assert.throws(
    () => new CognitoGatewayAdapter({} as never, "notavalidpoolid", CLIENT_ID),
    /userPoolId must be in the format/,
  );
});

test("empty clientId throws at construction", () => {
  assert.throws(
    () => new CognitoGatewayAdapter({} as never, POOL_ID, ""),
    /clientId is required/,
  );
});

// ---------------------------------------------------------------------------
// Fix 3: unsupported Cognito user states
// ---------------------------------------------------------------------------

test("UNCONFIRMED user status throws CognitoUnsupportedUserStateError", async () => {
  const { CognitoUnsupportedUserStateError } = await import("../src/auth/cognito-gateway-adapter.js");
  const client = new ScriptedCognito([
    usernameExists(),
    { Username: PLAYER_ID, UserStatus: "UNCONFIRMED" },
  ]);
  await assert.rejects(
    adapter(client).startCustomAuthentication({ playerId: PLAYER_ID }),
    CognitoUnsupportedUserStateError,
  );
});

test("RESET_REQUIRED user status throws CognitoUnsupportedUserStateError", async () => {
  const { CognitoUnsupportedUserStateError } = await import("../src/auth/cognito-gateway-adapter.js");
  const client = new ScriptedCognito([
    usernameExists(),
    { Username: PLAYER_ID, UserStatus: "RESET_REQUIRED" },
  ]);
  await assert.rejects(
    adapter(client).startCustomAuthentication({ playerId: PLAYER_ID }),
    CognitoUnsupportedUserStateError,
  );
});

test("missing UserStatus throws CognitoUnsupportedUserStateError", async () => {
  const { CognitoUnsupportedUserStateError } = await import("../src/auth/cognito-gateway-adapter.js");
  const client = new ScriptedCognito([
    usernameExists(),
    { Username: PLAYER_ID },
  ]);
  await assert.rejects(
    adapter(client).startCustomAuthentication({ playerId: PLAYER_ID }),
    CognitoUnsupportedUserStateError,
  );
});

// ---------------------------------------------------------------------------
// Fix 4: UUID validation
// ---------------------------------------------------------------------------

test("non-UUID playerId throws CognitoGatewayConfigurationError", async () => {
  const { CognitoGatewayConfigurationError } = await import("../src/auth/cognito-gateway-adapter.js");
  const client = new ScriptedCognito([]);
  await assert.rejects(
    adapter(client).startCustomAuthentication({ playerId: "not-a-uuid" }),
    CognitoGatewayConfigurationError,
  );
  assert.equal(client.commands.length, 0);
});
