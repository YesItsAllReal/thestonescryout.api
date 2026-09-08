import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthenticatedPrincipal } from "../auth/authentication.js";
import type { JsonValue } from "../saves/save-service.js";

export type OfflineCommandType="SpawnFromSpawner"|"MoveItem"|"MergeItems"|"SellItem"|"UndoLastSale"|"UnlockCell"|"ConsumeOrderItems"|"ClaimBoardReward"|"MoveToInventory"|"MoveFromInventory"|"RechargeSpawner";
export interface OfflineCommand { readonly commandId:string;readonly sequence:number;readonly previousHash:string;readonly commandHash:string;readonly type:OfflineCommandType;readonly payload:JsonValue }
export interface OfflineCommandBatch { readonly expectedCheckpointRevision:number;readonly baseHash:string;readonly clientBuild:number;readonly contentVersion:string;readonly commands:readonly OfflineCommand[] }
export interface ValidatedCommandBatch { readonly finalHash:string;readonly acceptedCommandCount:number;readonly checkpoint:JsonValue;readonly grants:readonly {readonly grantKey:string;readonly resource:"coins"|"gems"|"energy";readonly amount:number;readonly reasonCode:string;readonly sourceReference:string}[] }
export interface OfflineCommandValidator { validate(input:{readonly playerId:string;readonly batch:OfflineCommandBatch;readonly now:Date}):Promise<ValidatedCommandBatch> }
export interface OfflineSyncRepository { applyValidated(input:{readonly playerId:string;readonly expectedCheckpointRevision:number;readonly baseHash:string;readonly idempotencyKey:string;readonly validated:ValidatedCommandBatch;readonly now:Date}):Promise<{readonly checkpointRevision:number;readonly finalHash:string;readonly acceptedCommandCount:number}> }
export class OfflineSyncValidationError extends Error {}
export class OfflineSyncIdempotencyConflictError extends Error {}
export class OfflineSyncCheckpointConflictError extends Error {
  public constructor(public readonly currentRevision:number){super("offline checkpoint changed");}
}

export class OfflineCommandSyncService {
  public constructor(private readonly validator:OfflineCommandValidator,private readonly repository:OfflineSyncRepository,private readonly now:()=>Date){}
  public async sync(principal:AuthenticatedPrincipal,batch:OfflineCommandBatch,idempotencyKey:string){validateBatch(batch,idempotencyKey);const validated=await this.validator.validate({playerId:principal.playerId,batch,now:this.now()});if(validated.finalHash!==batch.commands.at(-1)?.commandHash||validated.acceptedCommandCount!==batch.commands.length)throw new OfflineSyncValidationError("validator result does not match batch");return this.repository.applyValidated({playerId:principal.playerId,expectedCheckpointRevision:batch.expectedCheckpointRevision,baseHash:batch.baseHash,idempotencyKey,validated,now:this.now()});}
}
export function offlineCommandHash(command:Omit<OfflineCommand,"commandHash">,contentVersion:string):string{return createHash("sha256").update(JSON.stringify([command.commandId,command.sequence,command.previousHash,command.type,command.payload,contentVersion]),"utf8").digest("hex");}
const commandTypes=new Set<string>(["SpawnFromSpawner","MoveItem","MergeItems","SellItem","UndoLastSale","UnlockCell","ConsumeOrderItems","ClaimBoardReward","MoveToInventory","MoveFromInventory","RechargeSpawner"]);
const authorityKeys=new Set(["amount","delta","balance","balanceAfter","resource","reasonCode","ledgerEntryId"]);
function validateBatch(batch:OfflineCommandBatch,key:string){if(!/^[A-Za-z0-9._-]{8,128}$/.test(key)||!Number.isSafeInteger(batch.expectedCheckpointRevision)||batch.expectedCheckpointRevision<0||!Number.isSafeInteger(batch.clientBuild)||batch.clientBuild<1||!/^[A-Za-z0-9._-]{1,64}$/.test(batch.contentVersion)||!/^[a-f0-9]{64}$/.test(batch.baseHash)||batch.commands.length<1||batch.commands.length>500)throw new OfflineSyncValidationError("offline command batch is invalid");let prior=batch.baseHash;const ids=new Set<string>();for(let i=0;i<batch.commands.length;i++){const c=batch.commands[i]!;if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(c.commandId)||ids.has(c.commandId)||c.sequence!==i+1||c.previousHash!==prior||!commandTypes.has(c.type)||c.payload===null||typeof c.payload!=="object"||Array.isArray(c.payload)||hasAuthorityField(c.payload))throw new OfflineSyncValidationError("offline command chain is invalid");const expected=offlineCommandHash(c,batch.contentVersion);if(!equal(c.commandHash,expected))throw new OfflineSyncValidationError("offline command hash is invalid");ids.add(c.commandId);prior=c.commandHash;}}
function hasAuthorityField(value:JsonValue):boolean{if(value===null||typeof value!=="object")return false;if(Array.isArray(value))return value.some(hasAuthorityField);return Object.entries(value).some(([key,item])=>authorityKeys.has(key)||hasAuthorityField(item));}
function equal(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
