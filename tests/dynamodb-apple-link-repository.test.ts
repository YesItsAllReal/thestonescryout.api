import assert from "node:assert/strict";
import test from "node:test";
import { TransactWriteCommand,type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbAppleLinkRepository } from "../src/accounts/dynamodb-apple-link-repository.js";
const guest="88888888-8888-4888-8888-888888888888",existing="99999999-9999-4999-8999-999999999999",now=new Date("2026-09-02T21:00:00Z");
const input={guestPlayerId:guest,issuer:"https://appleid.apple.com",subject:"private-subject",idempotencyKey:"apple-link-1001",now};
const profile={entityType:"Player",recordVersion:1,playerId:guest,accountKind:"guest",createdAt:now.toISOString(),deletionState:"active"};
class Client{commands:unknown[]=[];constructor(private responses:unknown[]){}async send(c:unknown){this.commands.push(c);return this.responses.shift()??{};}}
function repo(c:Client){let n=0;return new DynamoDbAppleLinkRepository(c as unknown as DynamoDBDocumentClient,"players",()=>n++===0?"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");}
test("unused Apple identity links guest, mapping, audit, and replay atomically",async()=>{const c=new Client([{}, {Item:profile},{},{}]);const result=await repo(c).linkGuest(input);assert.equal(result.kind,"linked");const tx=(c.commands[3] as TransactWriteCommand).input.TransactItems;assert.equal(tx?.length,4);assert.equal(tx?.[0]?.Update?.ConditionExpression?.includes("accountKind = :guest"),true);assert.match(String(tx?.[1]?.Put?.Item?.pk),/^PROVIDER#[a-f0-9]{64}#[a-f0-9]{64}$/);assert.equal(JSON.stringify(tx).includes(input.subject),false);});
test("owned Apple identity creates opaque durable decision ticket without changing profiles",async()=>{const c=new Client([{}, {Item:profile},{Item:{entityType:"ProviderMapping",recordVersion:1,playerId:existing}},{}]);const result=await repo(c).linkGuest(input);assert.equal(result.kind,"decisionRequired");const tx=(c.commands[3] as TransactWriteCommand).input.TransactItems;assert.equal(tx?.length,3);assert.equal(tx?.some(x=>x.Update!==undefined),false);assert.equal(tx?.[0]?.Put?.Item?.existingPlayerId,existing);assert.equal(tx?.[0]?.Put?.Item?.status,"pending");});
