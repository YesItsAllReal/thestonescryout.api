import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import test from "node:test";
import { Environment, SignedDataVerifier, Type, VerificationException, VerificationStatus, type JWSTransactionDecodedPayload } from "@apple/app-store-server-library";
import { GetCommand, PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { importPKCS8, SignJWT } from "jose";
import {
  APP_STORE_BUNDLE_ID, ENERGY_REFILL_PRODUCT_ID, AppleTransactionVerifier,
  appStoreProductCatalog, createAppleTransactionVerifier, playerAppAccountTokenMatcher,
} from "../src/commerce/apple-transaction-verifier.js";
import { PurchaseService, type AppStoreTransactionVerifier } from "../src/commerce/commerce-service.js";
import { DynamoDbCommerceRepository } from "../src/commerce/dynamodb-commerce-repository.js";
import { createPurchaseVerificationHandler } from "../src/http/commerce-handlers.js";
import { MemoryFixedWindowRateLimiter } from "../src/http/memory-fixed-window-rate-limiter.js";
import { chain, leafKey } from "./fixtures/apple-test-chain.js";

const playerId = "00000000-0000-4000-8000-000000000ab1";
const otherPlayerId = "00000000-0000-4000-8000-000000000ab2";
const transactionId = "2000000123456789";
const signedDate = Date.parse(new X509Certificate(Buffer.from(chain[0]!, "base64")).validFrom) + 60_000;
const now = () => new Date(signedDate + 60_000);
const payload: JWSTransactionDecodedPayload = {
  bundleId: APP_STORE_BUNDLE_ID, productId: ENERGY_REFILL_PRODUCT_ID, appAccountToken: playerId.toUpperCase(),
  transactionId, originalTransactionId: transactionId, environment: Environment.SANDBOX,
  purchaseDate: signedDate - 1000, signedDate, type: Type.CONSUMABLE, quantity: 1,
};
const key = await importPKCS8(leafKey, "ES256");

type ClaimOverrides = { [Claim in keyof JWSTransactionDecodedPayload]?: JWSTransactionDecodedPayload[Claim] | undefined };

function sign(overrides: ClaimOverrides = {}, certificates = chain) {
  return new SignJWT({ ...payload, ...overrides }).setProtectedHeader({ alg: "ES256", x5c: certificates }).sign(key);
}

function offlineVerifier(environment: "sandbox" | "production" = "sandbox") {
  // Check the complete synthetic trust path and JWS offline. The Lambda factory always enables OCSP.
  return new AppleTransactionVerifier(new SignedDataVerifier(
    [Buffer.from(chain[2]!, "base64")], false,
    environment === "sandbox" ? Environment.SANDBOX : Environment.PRODUCTION,
    APP_STORE_BUNDLE_ID, environment === "production" ? 123456789 : undefined,
  ), environment);
}

class ScriptedDynamo {
  readonly commands: (GetCommand | PutCommand | TransactWriteCommand)[] = [];
  readonly responses: ({ Item?: Record<string, unknown> } | Error)[] = [];

  async send(command: GetCommand | PutCommand | TransactWriteCommand) {
    this.commands.push(command);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error("Unexpected DynamoDB request");
    return response;
  }
}

function harness(verifier: AppStoreTransactionVerifier = offlineVerifier()) {
  const db = new ScriptedDynamo();
  const logs: unknown[] = [];
  const repository = new DynamoDbCommerceRepository(db as unknown as DynamoDBDocumentClient, "test-players");
  const handler = createPurchaseVerificationHandler(
    new PurchaseService(verifier, playerAppAccountTokenMatcher, appStoreProductCatalog, repository, now),
    {
      now, rateLimiter: new MemoryFixedWindowRateLimiter(100, 60),
      logger: { info: (event) => logs.push(event), error: (event) => logs.push(event) },
      tokenVerifier: {
        async verify(token) {
          return { playerId: token === "other-token" ? otherPlayerId : playerId, sessionKind: "account", issuer: "test", audience: "test" };
        },
      },
    },
  );
  return {
    db, logs,
    submit: (signedTransaction: string, idempotencyKey = "test-purchase-01", token = "player-token") => handler({
      headers: { authorization: "Bearer " + token, "idempotency-key": idempotencyKey },
      body: JSON.stringify({ signedTransaction, clientBuild: 1, contentVersion: "starter-1" }),
    }),
  };
}

const balance = {
  entityType: "Balance", recordVersion: 1, playerId, coins: 50, gems: 10, energy: 20,
  energyUpdatedAt: now().toISOString(), revision: 1,
};

test("verified sandbox refill commits a 100 energy grant once and replays both ways", async () => {
  const { db, logs, submit } = harness();
  const jws = await sign();
  db.responses.push({}, {}, { Item: balance }, {});
  const first = await submit(jws);
  assert.equal(first.statusCode, 200, first.body);
  const result = JSON.parse(first.body);
  assert.equal(result.status, "granted");
  assert.equal(result.balance.energy, 120);
  assert.equal(result.balance.coins, 50);
  assert.equal(result.balance.gems, 10);
  assert.equal(result.entitlement, undefined);
  assert.equal(result.ledgerEntries.length, 1);
  assert.equal(result.ledgerEntries[0].resource, "energy");
  assert.equal(result.ledgerEntries[0].delta, 100);

  const write = db.commands[3];
  assert.ok(write instanceof TransactWriteCommand);
  const items = write.input.TransactItems!;
  assert.equal(items.length, 4);
  assert.equal(items[1]?.Update?.ExpressionAttributeValues?.[":energy"], 120);
  const claim = items[0]!.Put!.Item!;
  assert.equal(claim.pk, "TRANSACTION#sandbox#" + transactionId);
  const receipt = items[3]!.Put!.Item!;
  db.responses.push({ Item: receipt });
  assert.deepEqual(JSON.parse((await submit(jws)).body), result);

  db.responses.push({}, { Item: claim }, { Item: { ...balance, energy: 120, revision: 2 } }, {});
  const retry = await submit(jws, "test-purchase-02");
  assert.equal(retry.statusCode, 200, retry.body);
  assert.deepEqual(JSON.parse(retry.body), { ...result, status: "duplicate" });
  assert.equal(db.commands.filter((command) => command instanceof TransactWriteCommand).length, 1);
  assert.ok(db.commands.at(-1) instanceof PutCommand);
  const logText = JSON.stringify(logs);
  for (const sensitive of [jws, transactionId, playerId, "player-token", "test-purchase-01"]) {
    assert.equal(logText.includes(sensitive), false);
  }
});

test("production verifies its own signed environment and uses a distinct transaction claim", async () => {
  const sandbox = harness();
  const production = harness(offlineVerifier("production"));
  const sandboxJws = await sign();
  const productionJws = await sign({ environment: Environment.PRODUCTION });
  assert.equal((await production.submit(sandboxJws)).statusCode, 401);
  assert.equal((await sandbox.submit(productionJws)).statusCode, 401);
  assert.equal(sandbox.db.commands.length, 0);
  assert.equal(production.db.commands.length, 0);
  production.db.responses.push({}, {}, { Item: balance }, {});
  assert.equal((await production.submit(productionJws)).statusCode, 200);
  const write = production.db.commands[3];
  assert.ok(write instanceof TransactWriteCommand);
  assert.equal(write.input.TransactItems?.[0]?.Put?.Item?.pk, "TRANSACTION#production#" + transactionId);
});

test("rejects malformed, oversized, tampered, untrusted and ineligible transactions before DynamoDB", async () => {
  const { db, submit } = harness();
  const jws = await sign();
  const [header, body, signature] = jws.split(".");
  const corruptedSignature = (signature!.startsWith("A") ? "B" : "A") + signature!.slice(1);
  const cases: [string, string, number][] = [
    ["short payload", "bad", 400],
    ["oversized payload", "x".repeat(32_769), 400],
    ["malformed JWS", "not-a-valid-compact-JWS", 401],
    ["invalid signature", [header, body, corruptedSignature].join("."), 401],
    ["invalid chain", await sign({}, [chain[0]!, chain[0]!, chain[2]!]), 401],
    ["wrong bundle", await sign({ bundleId: "com.example.wrong" }), 401],
    ["unknown product", await sign({ productId: "com.example.unknown" }), 400],
    ["missing account token", await sign({ appAccountToken: undefined }), 401],
    ["invalid account token", await sign({ appAccountToken: "invalid" }), 401],
    ["invalid transaction ID", await sign({ transactionId: "invalid" }), 401],
    ["invalid original ID", await sign({ originalTransactionId: "" }), 401],
    ["invalid purchase date", await sign({ purchaseDate: 0 }), 401],
    ["future purchase", await sign({ signedDate: now().getTime() + 600_000, purchaseDate: now().getTime() + 500_000 }), 401],
    ["revoked purchase", await sign({ revocationDate: signedDate }), 401],
    ["wrong type", await sign({ type: Type.NON_CONSUMABLE }), 401],
    ["multiple units", await sign({ quantity: 2 }), 401],
    ["local environment", await sign({ environment: Environment.XCODE }), 401],
  ];
  for (const [label, submitted, status] of cases) {
    assert.equal((await submit(submitted)).statusCode, status, label);
  }
  assert.equal((await submit(jws, "test-purchase-01", "other-token")).statusCode, 403);
  assert.equal(db.commands.length, 0);
  const pinned = harness(createAppleTransactionVerifier({ environment: "sandbox" }));
  assert.equal((await pinned.submit(jws)).statusCode, 401, "operational trust rejects the synthetic root");
  assert.equal(pinned.db.commands.length, 0);
  assert.equal(await appStoreProductCatalog.get("com.example.unknown"), undefined);
});

test("retryable Apple errors and DynamoDB failures surface safely", async () => {
  const unavailable = harness(new AppleTransactionVerifier({
    async verifyAndDecodeTransaction() {
      throw new VerificationException(VerificationStatus.RETRYABLE_VERIFICATION_FAILURE, new Error("sensitive provider detail"));
    },
  }, "sandbox"));
  const jws = await sign();
  assert.equal((await unavailable.submit(jws)).statusCode, 503);
  assert.equal(unavailable.db.commands.length, 0);
  assert.equal(JSON.stringify(unavailable.logs).includes("sensitive provider detail"), false);

  const database = harness();
  database.db.responses.push({}, {}, { Item: balance }, new Error("sensitive repository detail"));
  assert.equal((await database.submit(jws)).statusCode, 500);
  assert.equal(database.db.commands.length, 4);
  assert.equal(JSON.stringify(database.logs).includes("sensitive repository detail"), false);
});
