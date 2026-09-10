import assert from "node:assert/strict";
import test from "node:test";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { planAccountLinkReconciliation, type AccountLinkState } from "../src/accounts/account-link-reconciliation.js";
import { buildAccountLinkTransaction } from "../src/accounts/dynamodb-account-link-transaction.js";
import { LedgerReconciliationPolicy } from "../src/economy/ledger-reconciliation-policy.js";

const guest="11111111-aaaa-4111-8111-111111111111";
const survivor="22222222-bbbb-4222-8222-222222222222";
const now=new Date("2026-09-10T12:00:00.000Z");
const entitlement={productId:"pack.archive",transactionId:"tx-1",state:"active" as const,purchasedAt:"2026-09-01T00:00:00.000Z",stateEffectiveAt:"2026-09-01T00:00:00.000Z",environment:"sandbox" as const};
const state:AccountLinkState={
 guest:{playerId:guest,accountKind:"guest",createdAt:"2026-01-01T00:00:00.000Z",deletionState:"active"},
 existing:{playerId:survivor,accountKind:"apple",createdAt:"2026-01-02T00:00:00.000Z",deletionState:"active"},
 guestInstallationIdHash:"a".repeat(64),
 guestSave:{slot:"primary",revision:2,schemaVersion:1,snapshot:{board:"guest"},updatedAt:"2026-09-09T00:00:00.000Z",deviceIdHash:"b".repeat(64)},
 existingSave:{slot:"primary",revision:4,schemaVersion:1,snapshot:{board:"existing"},updatedAt:"2026-09-08T00:00:00.000Z",deviceIdHash:"c".repeat(64)},
 guestBalance:{coins:10,gems:2,energy:3,energyUpdatedAt:"2026-09-09T00:00:00.000Z",revision:2},
 existingBalance:{coins:20,gems:3,energy:4,energyUpdatedAt:"2026-09-08T00:00:00.000Z",revision:4},
 guestLedger:[{ledgerEntryId:"g1",resource:"coins",delta:10,sourceReference:"start"},{ledgerEntryId:"g2",resource:"gems",delta:2,sourceReference:"start"},{ledgerEntryId:"g3",resource:"energy",delta:3,sourceReference:"start"}],
 existingLedger:[{ledgerEntryId:"e1",resource:"coins",delta:20,sourceReference:"start"},{ledgerEntryId:"e2",resource:"gems",delta:3,sourceReference:"start"},{ledgerEntryId:"e3",resource:"energy",delta:4,sourceReference:"start"}],
 guestEntitlements:[entitlement],existingEntitlements:[],guestUnlockIds:["archive-1"],existingUnlockIds:["starter"],
};

function command(choice:"preferGuestSave"|"preferExistingSave"="preferGuestSave"){
 const plan=planAccountLinkReconciliation(state,choice,new LedgerReconciliationPolicy());
 return buildAccountLinkTransaction({tableName:"players",conflictId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",providerPk:`PROVIDER#${"d".repeat(64)}#${"e".repeat(64)}`,choice,idempotencyKey:"link-resolution-1001",now,clientBuild:42,contentVersion:"starter-1",auditEventId:"audit-1",ledgerEntryIds:["ledger-1","ledger-2","ledger-3"],state,plan});
}

test("account-link transaction binds identity, profiles, installation, balances, and ticket atomically",()=>{
 const built=command();assert.ok(built instanceof TransactWriteCommand);const items=built.input.TransactItems!;
 assert.equal(items[0]?.Update?.ConditionExpression?.includes("expiresAtEpochSeconds"),true);
 assert.equal(items.some(x=>x.Update?.Key?.sk==="PROFILE"&&x.Update.UpdateExpression?.includes("accountState = :merged")),true);
 assert.equal(items.some(x=>x.ConditionCheck?.Key?.pk===`PROVIDER#${"d".repeat(64)}#${"e".repeat(64)}`),true);
 assert.equal(items.some(x=>x.Delete?.Key?.pk===`INSTALLATION#${"a".repeat(64)}`),true);
 assert.equal(items.some(x=>x.Update?.Key?.sk==="BALANCE"),true);
});

test("preferring guest save conditionally replaces only survivor save and preserves device provenance",()=>{
 const items=command().input.TransactItems!;const save=items.find(x=>x.Put?.Item?.entityType==="Save")?.Put!;
 assert.equal(save.Item?.playerId,survivor);assert.equal(save.Item?.revision,5);assert.equal(save.Item?.deviceIdHash,"b".repeat(64));
 assert.equal(save.ConditionExpression?.includes("revision = :revision"),true);
});

test("transaction transfers guest entitlement and unlock ownership with conditional source removal",()=>{
 const items=command().input.TransactItems!;
 assert.equal(items.some(x=>x.Delete?.Key?.sk==="ENTITLEMENT#pack.archive"),true);
 assert.equal(items.some(x=>x.Put?.Item?.pk===`PLAYER#${survivor}`&&x.Put.Item?.sk==="ENTITLEMENT#pack.archive"),true);
 assert.equal(items.some(x=>x.Update?.Key?.pk==="TRANSACTION#sandbox#tx-1"&&x.Update.UpdateExpression?.includes("playerId = :survivorId")),true);
 assert.equal(items.some(x=>x.Delete?.Key?.sk==="UNLOCK#archive-1"),true);
});

test("transaction hashes replay keys and records a bounded reconciliation audit",()=>{
 const json=JSON.stringify(command().input.TransactItems);assert.equal(json.includes("link-resolution-1001"),false);
 const items=command().input.TransactItems!;assert.equal(items.some(x=>x.Put?.Item?.action==="ACCOUNT_LINK_RECONCILED"),true);
 assert.equal(items.some(x=>String(x.Put?.Item?.pk).startsWith("IDEMPOTENCY#PLAYER#")&&String(x.Put?.Item?.pk).endsWith("#"+"link-resolution-1001")),false);
});
test("reconciliation ledger entries carry trusted client and content context",()=>{const entries=command().input.TransactItems!.filter(x=>x.Put?.Item?.entityType==="LedgerEntry");assert.equal(entries.length,3);assert.equal(entries.every(x=>x.Put?.Item?.reasonCode==="ACCOUNT_LINK_RECONCILIATION"&&x.Put.Item?.clientBuild===42&&x.Put.Item?.contentVersion==="starter-1"),true);});
test("transaction refuses a reconciliation that exceeds DynamoDB's 100 action limit",()=>{const many={...state,guestUnlockIds:Array.from({length:47},(_,i)=>`unlock-${i}`)};const plan=planAccountLinkReconciliation(many,"preferExistingSave",new LedgerReconciliationPolicy());assert.throws(()=>buildAccountLinkTransaction({tableName:"players",conflictId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",providerPk:`PROVIDER#${"d".repeat(64)}#${"e".repeat(64)}`,choice:"preferExistingSave",idempotencyKey:"link-resolution-1001",now,clientBuild:42,contentVersion:"starter-1",auditEventId:"audit-1",ledgerEntryIds:["ledger-1","ledger-2","ledger-3"],state:many,plan}),/transaction limit/);});
