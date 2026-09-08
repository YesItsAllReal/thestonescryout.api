import { createHash, randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AccountIdempotencyConflictError, type AppleAccountRepository, type AppleLinkResult } from "./apple-account-service.js";
import type { PlayerProfile } from "./guest-session-service.js";
import { providerIdentityKey } from "./provider-identity-key.js";

type Client = Pick<DynamoDBDocumentClient, "send">;
type Input = Parameters<AppleAccountRepository["linkGuest"]>[0];

export class DynamoDbAppleLinkRepository implements Pick<AppleAccountRepository, "linkGuest"> {
  public constructor(private readonly client: Client, private readonly tableName: string,
    private readonly createId: () => string = randomUUID, private readonly ttlSeconds = 900) {}

  public async linkGuest(input: Input): Promise<AppleLinkResult> {
    const hash = sha256(JSON.stringify([input.guestPlayerId, input.issuer, input.subject]));
    const idem = { pk: `IDEMPOTENCY#PLAYER#${input.guestPlayerId}#${sha256(input.idempotencyKey)}`, sk: "RESULT" };
    const replay = await this.get(idem);
    if (replay !== undefined) return replayResult(replay, hash);
    const guest = await this.player(input.guestPlayerId);
    if (guest.accountKind !== "guest" || guest.deletionState !== "active") throw new Error("active guest player was not found");
    const provider = providerIdentityKey(input.issuer, input.subject);
    const mapping = await this.get({ pk: provider.pk, sk: provider.sk });
    if (mapping === undefined || mapping.playerId === input.guestPlayerId) return this.link(input, guest, provider, idem, hash, mapping !== undefined);
    if (mapping.entityType !== "ProviderMapping" || mapping.recordVersion !== 1 || typeof mapping.playerId !== "string") throw new Error("stored provider mapping is invalid");
    return this.conflict(input, mapping.playerId, provider, idem, hash);
  }

  private async link(input: Input, guest: PlayerProfile, provider: ReturnType<typeof providerIdentityKey>, idem: Record<string,string>, hash: string, mappingExists: boolean): Promise<AppleLinkResult> {
    const player = { ...guest, accountKind: "apple" as const };
    const createdAt = input.now.toISOString(), auditId = this.createId();
    const items: ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"] = [
      { Update: { TableName: this.tableName, Key: { pk: `PLAYER#${input.guestPlayerId}`, sk: "PROFILE" },
        UpdateExpression: "SET accountKind = :apple, linkedProviders = :providers",
        ConditionExpression: "entityType = :player AND recordVersion = :version AND accountKind = :guest AND deletionState = :active",
        ExpressionAttributeValues: { ":apple":"apple", ":providers":["apple"], ":player":"Player", ":version":1, ":guest":"guest", ":active":"active" } } },
      ...(!mappingExists ? [{ Put: { TableName: this.tableName, Item: { ...provider, entityType:"ProviderMapping", recordVersion:1, provider:"apple", playerId:input.guestPlayerId }, ConditionExpression:"attribute_not_exists(pk)" } }] : []),
      { Put: { TableName:this.tableName, Item:audit(input.guestPlayerId, createdAt, auditId, "APPLE_IDENTITY_LINKED"), ConditionExpression:"attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
      { Put: { TableName:this.tableName, Item:idemItem(idem,input,hash,{kind:"linked",player},this.ttlSeconds), ConditionExpression:"attribute_not_exists(pk)" } },
    ];
    await this.client.send(new TransactWriteCommand({ TransactItems: items }));
    return { kind:"linked", player };
  }

  private async conflict(input: Input, existingPlayerId: string, provider: ReturnType<typeof providerIdentityKey>, idem: Record<string,string>, hash: string): Promise<AppleLinkResult> {
    const conflictId=this.createId(), createdAt=input.now.toISOString();
    const result={kind:"decisionRequired" as const,conflictId,guestPlayerId:input.guestPlayerId,existingPlayerId};
    await this.client.send(new TransactWriteCommand({TransactItems:[
      {Put:{TableName:this.tableName,Item:{pk:`LINK_CONFLICT#${conflictId}`,sk:"REQUEST",entityType:"AccountLinkConflict",recordVersion:1,conflictId,guestPlayerId:input.guestPlayerId,existingPlayerId,providerPk:provider.pk,status:"pending",createdAt,expiresAtEpochSeconds:Math.floor(input.now.getTime()/1000)+this.ttlSeconds},ConditionExpression:"attribute_not_exists(pk)"}},
      {Put:{TableName:this.tableName,Item:audit(input.guestPlayerId,createdAt,this.createId(),"ACCOUNT_LINK_DECISION_REQUIRED"),ConditionExpression:"attribute_not_exists(pk) AND attribute_not_exists(sk)"}},
      {Put:{TableName:this.tableName,Item:idemItem(idem,input,hash,result,this.ttlSeconds),ConditionExpression:"attribute_not_exists(pk)"}},
    ]}));
    return result;
  }

  private async get(key: Record<string,string>): Promise<Record<string,unknown>|undefined> { return (await this.client.send(new GetCommand({TableName:this.tableName,Key:key,ConsistentRead:true}))).Item; }
  private async player(id:string):Promise<PlayerProfile>{const x=await this.get({pk:`PLAYER#${id}`,sk:"PROFILE"});if(x?.entityType!=="Player"||x.recordVersion!==1||x.playerId!==id||(x.accountKind!=="guest"&&x.accountKind!=="apple"&&x.accountKind!=="google")||typeof x.createdAt!=="string"||(x.deletionState!=="active"&&x.deletionState!=="requested"&&x.deletionState!=="processing"))throw new Error("stored player is invalid");return{playerId:id,accountKind:x.accountKind,createdAt:x.createdAt,deletionState:x.deletionState};}
}
function replayResult(x:Record<string,unknown>,hash:string):AppleLinkResult{if(x.entityType!=="Idempotency"||x.operation!=="apple.link"||x.recordVersion!==1||x.requestHash!==hash)throw new AccountIdempotencyConflictError("idempotency key was reused for different input");return x.result as AppleLinkResult;}
function idemItem(key:Record<string,string>,input:Input,hash:string,result:AppleLinkResult,ttl:number){return{...key,entityType:"Idempotency",recordVersion:1,operation:"apple.link",requestHash:hash,result,status:"completed",createdAt:input.now.toISOString(),expiresAtEpochSeconds:Math.floor(input.now.getTime()/1000)+ttl};}
function audit(playerId:string,createdAt:string,id:string,action:string){return{pk:`PLAYER#${playerId}`,sk:`AUDIT#${createdAt}#${id}`,entityType:"AuditEvent",recordVersion:1,auditEventId:id,playerId,action,createdAt};}
function sha256(x:string){return createHash("sha256").update(x,"utf8").digest("hex");}
