import type { LinkSaveChoice } from "./apple-account-service.js";
import type { PlayerProfile } from "./guest-session-service.js";
import type { GameSave } from "../saves/save-service.js";

export interface ReconciliationBalance { readonly coins:number; readonly gems:number; readonly energy:number; readonly energyUpdatedAt:string; readonly revision:number }
export interface ReconciliationSave extends GameSave { readonly deviceIdHash:string }
export interface ReconciliationLedgerEntry { readonly ledgerEntryId:string; readonly resource:"coins"|"gems"|"energy"; readonly delta:number; readonly sourceReference:string; readonly verifiedGrantKey?:string }
export interface ReconciliationEntitlement { readonly productId:string; readonly transactionId:string; readonly state:"active"|"revoked"|"refunded"; readonly purchasedAt:string; readonly stateEffectiveAt:string; readonly environment:"sandbox"|"production" }
export interface EconomyReconciliation { readonly balance:ReconciliationBalance; readonly ledgerReasonCodes:readonly string[] }
export interface EconomyReconciliationPolicy { reconcile(input:{readonly survivorPlayerId:string;readonly guest:ReconciliationBalance;readonly existing:ReconciliationBalance;readonly guestLedger:readonly ReconciliationLedgerEntry[];readonly existingLedger:readonly ReconciliationLedgerEntry[]}):EconomyReconciliation }
export interface AccountLinkState { readonly guest:PlayerProfile;readonly existing:PlayerProfile;readonly guestSave?:ReconciliationSave;readonly existingSave?:ReconciliationSave;readonly guestBalance:ReconciliationBalance;readonly existingBalance:ReconciliationBalance;readonly guestLedger?:readonly ReconciliationLedgerEntry[];readonly existingLedger?:readonly ReconciliationLedgerEntry[];readonly guestEntitlements:readonly ReconciliationEntitlement[];readonly existingEntitlements:readonly ReconciliationEntitlement[];readonly guestUnlockIds:readonly string[];readonly existingUnlockIds:readonly string[] }
export interface AccountLinkPlan { readonly survivorPlayerId:string;readonly retiredPlayerId:string;readonly selectedSave?:ReconciliationSave;readonly economy:EconomyReconciliation;readonly entitlements:readonly ReconciliationEntitlement[];readonly unlockIds:readonly string[] }
export class AccountLinkReconciliationError extends Error {}

export function planAccountLinkReconciliation(state:AccountLinkState,choice:LinkSaveChoice,policy:EconomyReconciliationPolicy):AccountLinkPlan {
  validateState(state,choice);
  // Provider ownership stays with the existing Apple account. Save choice only
  // selects board progress and cannot select identity or economy ownership.
  const survivorPlayerId=state.existing.playerId;
  const economy=policy.reconcile({survivorPlayerId,guest:state.guestBalance,existing:state.existingBalance,guestLedger:state.guestLedger??[],existingLedger:state.existingLedger??[]});
  validateEconomyResult(economy,state);
  const selectedSave=choice==="preferGuestSave"?state.guestSave:state.existingSave;
  return {survivorPlayerId,retiredPlayerId:state.guest.playerId,...(selectedSave===undefined?{}:{selectedSave}),economy,
    entitlements:reconcileEntitlements(state),unlockIds:[...new Set([...state.guestUnlockIds,...state.existingUnlockIds])].sort()};
}

function validateState(state:AccountLinkState,choice:LinkSaveChoice):void {
  if(choice!=="preferGuestSave"&&choice!=="preferExistingSave")throw new AccountLinkReconciliationError("save choice is invalid");
  if(!validPlayer(state.guest)||!validPlayer(state.existing)||state.guest.playerId===state.existing.playerId||state.guest.accountKind!=="guest"||state.existing.accountKind!=="apple"||state.guest.deletionState!=="active"||state.existing.deletionState!=="active")throw new AccountLinkReconciliationError("account link players are invalid");
  validateBalance(state.guestBalance);validateBalance(state.existingBalance);
  if(state.guestSave!==undefined)validateSave(state.guestSave);if(state.existingSave!==undefined)validateSave(state.existingSave);
  for(const entry of [...(state.guestLedger??[]),...(state.existingLedger??[])])validateLedger(entry);
  for(const item of [...state.guestEntitlements,...state.existingEntitlements])validateEntitlement(item);
  for(const id of [...state.guestUnlockIds,...state.existingUnlockIds])if(!safeId(id,128))throw new AccountLinkReconciliationError("unlock ID is invalid");
}
function validateEconomyResult(value:EconomyReconciliation,state:AccountLinkState):void {
  validateBalance(value.balance);
  if(value.balance.revision!==Math.max(state.guestBalance.revision,state.existingBalance.revision)+1||value.ledgerReasonCodes.length<1||value.ledgerReasonCodes.length>16||new Set(value.ledgerReasonCodes).size!==value.ledgerReasonCodes.length||value.ledgerReasonCodes.some(x=>!safeId(x,64)))throw new AccountLinkReconciliationError("economy reconciliation must be auditable");
}
function reconcileEntitlements(state:AccountLinkState):readonly ReconciliationEntitlement[]{
  const byTransaction=new Map<string,ReconciliationEntitlement>(),byProduct=new Map<string,ReconciliationEntitlement>();
  for(const item of [...state.existingEntitlements,...state.guestEntitlements]){
    const transaction=byTransaction.get(item.transactionId),product=byProduct.get(item.productId);
    if(transaction!==undefined&&!same(transaction,item))throw new AccountLinkReconciliationError("entitlement transaction state conflicts");
    if(product!==undefined&&!same(product,item))throw new AccountLinkReconciliationError("entitlement product state conflicts");
    byTransaction.set(item.transactionId,item);byProduct.set(item.productId,item);
  }
  return [...byTransaction.values()].sort((a,b)=>a.transactionId.localeCompare(b.transactionId));
}
function validateBalance(x:ReconciliationBalance){if(![x.coins,x.gems,x.energy].every(amount)||!instant(x.energyUpdatedAt)||!Number.isSafeInteger(x.revision)||x.revision<1)throw new AccountLinkReconciliationError("economy balance is invalid");}
function validateSave(x:ReconciliationSave){if(x.slot!=="primary"||!Number.isSafeInteger(x.revision)||x.revision<1||!Number.isSafeInteger(x.schemaVersion)||x.schemaVersion<1||!instant(x.updatedAt)||!/^[a-f0-9]{64}$/.test(x.deviceIdHash)||x.snapshot===null||typeof x.snapshot!=="object"||Array.isArray(x.snapshot))throw new AccountLinkReconciliationError("save is invalid");}
function validateLedger(x:ReconciliationLedgerEntry){if(!safeId(x.ledgerEntryId,128)||!safeId(x.sourceReference,255)||!Number.isSafeInteger(x.delta)||x.delta===0||(x.resource!=="coins"&&x.resource!=="gems"&&x.resource!=="energy")||(x.verifiedGrantKey!==undefined&&!safeId(x.verifiedGrantKey,255)))throw new AccountLinkReconciliationError("ledger entry is invalid");}
function validateEntitlement(x:ReconciliationEntitlement){if(!safeId(x.productId,255)||!safeId(x.transactionId,255)||(x.state!=="active"&&x.state!=="revoked"&&x.state!=="refunded")||(x.environment!=="sandbox"&&x.environment!=="production")||!instant(x.purchasedAt)||!instant(x.stateEffectiveAt)||Date.parse(x.stateEffectiveAt)<Date.parse(x.purchasedAt))throw new AccountLinkReconciliationError("entitlement is invalid");}
function validPlayer(x:PlayerProfile){return uuid(x.playerId)&&instant(x.createdAt);}function same(a:ReconciliationEntitlement,b:ReconciliationEntitlement){return a.productId===b.productId&&a.transactionId===b.transactionId&&a.state===b.state&&a.purchasedAt===b.purchasedAt&&a.stateEffectiveAt===b.stateEffectiveAt&&a.environment===b.environment;}function amount(x:number){return Number.isSafeInteger(x)&&x>=0;}function safeId(x:string,max:number){return x.length>=1&&x.length<=max&&/^[A-Za-z0-9._:-]+$/.test(x);}function instant(x:string){return Number.isFinite(Date.parse(x));}function uuid(x:string){return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);}
