import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AccountIdempotencyConflictError } from "../src/accounts/apple-account-service.js";
import { AccountLinkReconciliationError } from "../src/accounts/account-link-reconciliation.js";
import { DynamoDbAccountLinkRepository } from "../src/accounts/dynamodb-account-link-repository.js";
import { accountLinkResolutionRequestHash } from "../src/accounts/dynamodb-account-link-transaction.js";
import { providerIdentityKey } from "../src/accounts/provider-identity-key.js";

const guest="11111111-aaaa-4111-8111-111111111111",existing="22222222-bbbb-4222-8222-222222222222",now=new Date("2026-09-10T15:00:00.000Z");
const input={guestPlayerId:guest,issuer:"https://appleid.apple.com",subject:"private-subject",idempotencyKey:"resolution-key-1001",resolution:{conflictId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",saveChoice:"preferExistingSave" as const},now};
class Client{commands:unknown[]=[];constructor(private responses:Array<unknown|Error>){}async send(c:unknown){this.commands.push(c);const x=this.responses.shift();if(x instanceof Error)throw x;return x??{};}}
const providerPk=providerIdentityKey(input.issuer,input.subject).pk;
function profile(id:string,kind:"guest"|"apple"){return{entityType:"Player",recordVersion:1,playerId:id,accountKind:kind,accountState:"active",createdAt:"2026-01-01T00:00:00.000Z",deletionState:"active",...(kind==="guest"?{installationIdHash:"a".repeat(64),lastSeenBuild:42}:{})};}
function balance(id:string){return{entityType:"Balance",recordVersion:1,playerId:id,coins:10,gems:2,energy:3,originCoins:0,originGems:0,originEnergy:0,energyUpdatedAt:"2026-09-01T00:00:00.000Z",revision:1};}
function ledgers(id:string){return{Items:[{entityType:"LedgerEntry",recordVersion:1,playerId:id,ledgerEntryId:`${id}-c`,resource:"coins",delta:10,sourceReference:`start-${id}`},{entityType:"LedgerEntry",recordVersion:1,playerId:id,ledgerEntryId:`${id}-g`,resource:"gems",delta:2,sourceReference:`start-${id}`},{entityType:"LedgerEntry",recordVersion:1,playerId:id,ledgerEntryId:`${id}-e`,resource:"energy",delta:3,sourceReference:`start-${id}`} ]};}
function responses(final:unknown={}):Array<unknown|Error>{return[
 {},{Item:{entityType:"AccountLinkConflict",recordVersion:1,conflictId:input.resolution.conflictId,guestPlayerId:guest,existingPlayerId:existing,providerPk,status:"pending",expiresAtEpochSeconds:Math.floor(now.getTime()/1000)+60}},
 {Item:profile(guest,"guest")},{Item:profile(existing,"apple")},{Item:balance(guest)},{Item:balance(existing)},{},{},ledgers(guest),ledgers(existing),{Items:[]},{Items:[]},{Items:[]},{Items:[]},final,
 ];}
function repo(c:Client){let i=0;return new DynamoDbAccountLinkRepository(c as unknown as DynamoDBDocumentClient,"players","starter-1",()=>`id-${++i}`);}

test("repository strongly loads all account-link state and executes one atomic transaction",async()=>{const c=new Client(responses());const result=await repo(c).resolveLinkConflict(input);assert.equal(result.player.playerId,existing);assert.ok(c.commands.at(-1) instanceof TransactWriteCommand);assert.equal(c.commands.filter(x=>x instanceof GetCommand).length,8);assert.equal(c.commands.filter(x=>x instanceof QueryCommand).length,6);assert.equal(JSON.stringify(c.commands).includes(input.subject),false);});

test("repository rejects expired tickets before loading player state",async()=>{const c=new Client([{}, {Item:{entityType:"AccountLinkConflict",recordVersion:1,conflictId:input.resolution.conflictId,guestPlayerId:guest,existingPlayerId:existing,providerPk,status:"pending",expiresAtEpochSeconds:Math.floor(now.getTime()/1000)-1}}]);await assert.rejects(repo(c).resolveLinkConflict(input),AccountLinkReconciliationError);assert.equal(c.commands.length,2);});

test("repository rejects changed input under a completed idempotency key",async()=>{const c=new Client([{Item:{entityType:"Idempotency",recordVersion:1,operation:"apple.link.resolve",requestHash:"different",result:{kind:"linked",player:profile(existing,"apple")}}}]);await assert.rejects(repo(c).resolveLinkConflict(input),AccountIdempotencyConflictError);assert.equal(c.commands.length,1);});

test("repository recovers a concurrent identical winner after conditional transaction cancellation",async()=>{const cancelled=Object.assign(new Error("cancelled"),{name:"TransactionCanceledException",CancellationReasons:[{Code:"ConditionalCheckFailed"}]});const replay={entityType:"Idempotency",recordVersion:1,operation:"apple.link.resolve",requestHash:accountLinkResolutionRequestHash(guest,providerPk,input.resolution.conflictId,input.resolution.saveChoice),result:{kind:"linked",player:profile(existing,"apple")}};const c=new Client([...responses(cancelled),{Item:replay}]);const result=await repo(c).resolveLinkConflict(input);assert.equal(result.player.playerId,existing);assert.ok(c.commands.at(-1) instanceof GetCommand);});

test("repository propagates non-conditional transaction cancellation without misreporting a conflict",async()=>{const cancelled=Object.assign(new Error("service unavailable"),{name:"TransactionCanceledException",CancellationReasons:[{Code:"ProvisionedThroughputExceeded"}]});const c=new Client(responses(cancelled));await assert.rejects(repo(c).resolveLinkConflict(input),(error:unknown)=>error===cancelled);assert.ok(c.commands.at(-1) instanceof TransactWriteCommand);});

test("repository fails closed when a legacy balance lacks origin fields",async()=>{const scripted=responses();scripted[4]={Item:{...balance(guest),originCoins:undefined}};const c=new Client(scripted);await assert.rejects(repo(c).resolveLinkConflict(input),/origin backfill/);assert.equal(c.commands.some(x=>x instanceof TransactWriteCommand),false);});
