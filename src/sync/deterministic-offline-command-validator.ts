import type { JsonValue } from "../saves/save-service.js";
import { OfflineSyncValidationError,type OfflineCommand,type OfflineCommandBatch,type OfflineCommandValidator,type ValidatedCommandBatch } from "./offline-command-sync-service.js";

export interface OfflineCheckpoint { readonly revision:number;readonly finalHash:string;readonly state:JsonValue }
export interface OfflineCheckpointReader { load(playerId:string):Promise<OfflineCheckpoint|undefined> }
export interface ApprovedCommandRules { readonly contentVersion:string;readonly minimumBuild:number;readonly maximumBuild?:number }
export interface ApprovedCommandRulesRepository { load(contentVersion:string):Promise<ApprovedCommandRules|undefined> }
export interface RewardCandidate { readonly claimType:string;readonly claimId:string }
export interface DeterministicCommandEngine { apply(input:{readonly state:JsonValue;readonly command:OfflineCommand;readonly rules:ApprovedCommandRules;readonly now:Date}):Promise<{readonly state:JsonValue;readonly rewards:readonly RewardCandidate[]}> }
export interface OfflineRewardRules { resolve(input:{readonly playerId:string;readonly candidate:RewardCandidate;readonly contentVersion:string;readonly now:Date}):Promise<{readonly grantKey:string;readonly resource:"coins"|"gems"|"energy";readonly amount:number;readonly reasonCode:string;readonly sourceReference:string}> }

export class DeterministicOfflineCommandValidator implements OfflineCommandValidator {
  public constructor(private readonly checkpoints:OfflineCheckpointReader,private readonly rules:ApprovedCommandRulesRepository,private readonly engine:DeterministicCommandEngine,private readonly rewards:OfflineRewardRules){}
  public async validate(input:{readonly playerId:string;readonly batch:OfflineCommandBatch;readonly now:Date}):Promise<ValidatedCommandBatch>{
    const checkpoint=await this.checkpoints.load(input.playerId);
    if((checkpoint?.revision??0)!==input.batch.expectedCheckpointRevision||(checkpoint?.finalHash??"0".repeat(64))!==input.batch.baseHash)throw new OfflineSyncValidationError("offline checkpoint conflict");
    const rules=await this.rules.load(input.batch.contentVersion);
    if(rules===undefined||rules.contentVersion!==input.batch.contentVersion||input.batch.clientBuild<rules.minimumBuild||(rules.maximumBuild!==undefined&&input.batch.clientBuild>rules.maximumBuild))throw new OfflineSyncValidationError("content rules are unavailable for this client");
    let state:JsonValue=checkpoint===undefined?{}:checkpoint.state;const grants=new Map<string,ValidatedCommandBatch["grants"][number]>();
    for(const command of input.batch.commands){const applied=await this.engine.apply({state,command,rules,now:input.now});state=applied.state;for(const candidate of applied.rewards){const grant=await this.rewards.resolve({playerId:input.playerId,candidate,contentVersion:rules.contentVersion,now:input.now});if(!/^[A-Za-z0-9._:-]{1,128}$/.test(grant.grantKey)||!Number.isSafeInteger(grant.amount)||grant.amount<=0)throw new OfflineSyncValidationError("server reward rule is invalid");const prior=grants.get(grant.grantKey);if(prior!==undefined&&JSON.stringify(prior)!==JSON.stringify(grant))throw new OfflineSyncValidationError("reward grant identity conflicts");grants.set(grant.grantKey,grant);}}
    return{finalHash:input.batch.commands.at(-1)!.commandHash,acceptedCommandCount:input.batch.commands.length,checkpoint:state,grants:[...grants.values()]};
  }
}
