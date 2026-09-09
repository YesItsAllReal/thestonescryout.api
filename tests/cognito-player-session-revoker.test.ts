import assert from "node:assert/strict";
import test from "node:test";

import {
  AdminUserGlobalSignOutCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

import {
  CognitoPlayerSessionRevoker,
  PlayerSessionRevocationError,
  PlayerSessionRevokerConfigurationError,
} from "../src/auth/cognito-player-session-revoker.js";

const poolId = "us-east-1_SDheytSys";
const playerId = "55555555-5555-4555-8555-555555555555";

class ScriptedClient {
  public readonly commands: unknown[] = [];
  public constructor(private readonly response: unknown | Error = {}) {}

  public async send(command: unknown): Promise<unknown> {
    this.commands.push(command);
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}

function revoker(client: ScriptedClient): CognitoPlayerSessionRevoker {
  return new CognitoPlayerSessionRevoker(
    client as unknown as CognitoIdentityProviderClient,
    poolId,
  );
}

function namedError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

test("revokeAll sends AdminUserGlobalSignOut for the player-owned shadow username", async () => {
  const client = new ScriptedClient();
  await revoker(client).revokeAll(playerId);

  assert.equal(client.commands.length, 1);
  assert.ok(client.commands[0] instanceof AdminUserGlobalSignOutCommand);
  const command = client.commands[0] as AdminUserGlobalSignOutCommand;
  assert.deepEqual(command.input, { UserPoolId: poolId, Username: playerId });
});

test("revokeAll rejects a malformed player identifier before any provider call", async () => {
  const client = new ScriptedClient();
  await assert.rejects(revoker(client).revokeAll("not-a-player"), PlayerSessionRevocationError);
  assert.equal(client.commands.length, 0);
});

test("constructor rejects a malformed user pool ID", () => {
  const client = new ScriptedClient();
  assert.throws(
    () => new CognitoPlayerSessionRevoker(
      client as unknown as CognitoIdentityProviderClient,
      "wrong-pool",
    ),
    PlayerSessionRevokerConfigurationError,
  );
});

test("missing Cognito shadow user is an idempotent revocation success", async () => {
  const client = new ScriptedClient(namedError("UserNotFoundException"));
  await assert.doesNotReject(revoker(client).revokeAll(playerId));
});

test("provider service and throttling failures fail closed with an opaque error", async () => {
  for (const name of ["InternalErrorException", "TooManyRequestsException"]) {
    const sensitiveDetail = `provider detail for ${playerId}`;
    const client = new ScriptedClient(namedError(name, sensitiveDetail));
    const error = await revoker(client).revokeAll(playerId).catch((value: unknown) => value);
    assert.ok(error instanceof PlayerSessionRevocationError);
    assert.equal(error.message.includes(name), false);
    assert.equal(error.message.includes(playerId), false);
    assert.equal(error.message.includes(sensitiveDetail), false);
  }
});

test("unexpected and network failures do not falsely report revocation success", async () => {
  for (const error of [namedError("UnexpectedLambdaException"), new Error("network secret")]) {
    await assert.rejects(revoker(new ScriptedClient(error)).revokeAll(playerId), PlayerSessionRevocationError);
  }
});
