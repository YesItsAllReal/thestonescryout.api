import { createHash } from "node:crypto";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { ValidatedCommandBatch } from "./offline-command-sync-service.js";

export interface OfflineSyncBalance {readonly coins:number;readonly gems:number;readonly energy:number;readonly revision:number;readonly energyUpdatedAt:string}
export class OfflineSyncTransactionLimitError extends Error {}
export function buildOfflineSyncTransaction(input:{readonly tableName:string;readonly playerId:string;readonly expectedCheckpointRevision:number;readonly baseHash:string;readonly currentBalance:OfflineSyncBalance;readonly idempotencyKey:string;readonly validated:ValidatedCommandBatch;readonly now:Date;readonly createId:()=>string}):TransactWriteCommandInput{
  const totals={coins:0,gems:0,energy:0};for(const grant of input.validated.grants)totals[grant.resource]+=grant.amount;
  const resources=(Object.entries(totals) as [keyof typeof totals,number][]).filter(([,delta])=>delta!==0);
  const actionCount=3+resources.length+input.validated.grants.length;if(actionCount>100)throw new OfflineSyncTransactionLimitError("offline reward batch exceeds DynamoDB transaction limit");
  const at=input.now.toISOString(),revision=input.expectedCheckpointRevision+1;
  const items:NonNullable<TransactWriteCommandInput["TransactItems"]>=[
    {Put:{TableName:input.tableName,Item:{pk:`PLAYER#${input.playerId}`,sk:"SYNC_CHECKPOINT",entityType:"OfflineSyncCheckpoint",recordVersion:1,playerId:input.playerId,revision,finalHash:input.validated.finalHash,state:input.validated.checkpoint,updatedAt:at},ConditionExpression:input.expectedCheckpointRevision===0?"attribute_not_exists(pk)":"revision = :checkpointRevision AND finalHash = :baseHash",...(input.expectedCheckpointRevision===0?{}:{ExpressionAttributeValues:{":checkpointRevision":input.expectedCheckpointRevision,":baseHash":input.baseHash}})}},
    {Put:{TableName:input.tableName,Item:{pk:`PLAYER#${input.playerId}`,sk:"BALANCE",entityType:"Balance",recordVersion:1,playerId:input.playerId,coins:input.currentBalance.coins+totals.coins,gems:input.currentBalance.gems+totals.gems,energy:input.currentBalance.energy+totals.energy,energyUpdatedAt:at,revision:input.currentBalance.revision+1},ConditionExpression:"revision = :balanceRevision",ExpressionAttributeValues:{":balanceRevision":input.currentBalance.revision}}},
    {Put:{TableName:input.tableName,Item:{pk:`IDEMPOTENCY#PLAYER#${input.playerId}#${hash(input.idempotencyKey)}`,sk:"RESULT",entityType:"Idempotency",recordVersion:1,operation:"offlineSync",requestHash:offlineSyncRequestHash(input.expectedCheckpointRevision,input.baseHash,input.validated.finalHash),result:{checkpointRevision:revision,finalHash:input.validated.finalHash,acceptedCommandCount:input.validated.acceptedCommandCount},createdAt:at},ConditionExpression:"attribute_not_exists(pk)"}},
  ];
  for(const grant of input.validated.grants)items.push({Put:{TableName:input.tableName,Item:{pk:`OFFLINE_GRANT#${hash(grant.grantKey)}`,sk:"CLAIM",entityType:"OfflineGrantClaim",recordVersion:1,playerId:input.playerId,grantKeyHash:hash(grant.grantKey),createdAt:at},ConditionExpression:"attribute_not_exists(pk)"}});
  for(const [resource,delta] of resources){const id=input.createId();items.push({Put:{TableName:input.tableName,Item:{pk:`PLAYER#${input.playerId}`,sk:`LEDGER#${at}#${id}`,entityType:"LedgerEntry",recordVersion:1,ledgerEntryId:id,playerId:input.playerId,resource,delta,reasonCode:"OFFLINE_SYNC_RECONCILIATION",sourceReference:input.validated.finalHash,balanceAfter:input.currentBalance[resource]+delta,createdAt:at,idempotencyKeyHash:hash(input.idempotencyKey)},ConditionExpression:"attribute_not_exists(pk) AND attribute_not_exists(sk)"}});}
  for(const value of [input.currentBalance.coins+totals.coins,input.currentBalance.gems+totals.gems,input.currentBalance.energy+totals.energy])if(!Number.isSafeInteger(value)||value<0)throw new Error("offline sync produced invalid balance");
  return{TransactItems:items};
}
function hash(value:string){return createHash("sha256").update(value,"utf8").digest("hex");}
export function offlineSyncRequestHash(revision:number,baseHash:string,finalHash:string){return hash(JSON.stringify([revision,baseHash,finalHash]));}
