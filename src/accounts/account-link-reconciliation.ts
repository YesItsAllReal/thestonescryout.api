import type { LinkSaveChoice } from "./apple-account-service.js";
import type { PlayerProfile } from "./guest-session-service.js";
import type { GameSave } from "../saves/save-service.js";

export interface ReconciliationBalance { readonly coins:number; readonly gems:number; readonly energy:number; readonly revision:number }
export interface ReconciliationLedgerEntry { readonly ledgerEntryId:string;readonly resource:"coins"|"gems"|"energy";readonly delta:number;readonly sourceReference:string;readonly verifiedGrantKey?:string }
export interface ReconciliationEntitlement { readonly productId:string; readonly transactionId:string; readonly state:"active"|"revoked"|"refunded" }
export interface EconomyReconciliation { readonly balance:ReconciliationBalance; readonly ledgerReasonCodes:readonly string[] }
export interface EconomyReconciliationPolicy { reconcile(input:{readonly survivorPlayerId:string;readonly guest:ReconciliationBalance;readonly existing:ReconciliationBalance;readonly guestLedger:readonly ReconciliationLedgerEntry[];readonly existingLedger:readonly ReconciliationLedgerEntry[]}):EconomyReconciliation }
export interface AccountLinkState { readonly guest:PlayerProfile;readonly existing:PlayerProfile;readonly guestSave?:GameSave;readonly existingSave?:GameSave;readonly guestBalance:ReconciliationBalance;readonly existingBalance:ReconciliationBalance;readonly guestLedger?:readonly ReconciliationLedgerEntry[];readonly existingLedger?:readonly ReconciliationLedgerEntry[];readonly guestEntitlements:readonly ReconciliationEntitlement[];readonly existingEntitlements:readonly ReconciliationEntitlement[];readonly guestUnlockIds:readonly string[];readonly existingUnlockIds:readonly string[] }
export interface AccountLinkPlan { readonly survivorPlayerId:string;readonly retiredPlayerId:string;readonly selectedSave?:GameSave;readonly economy:EconomyReconciliation;readonly entitlements:readonly ReconciliationEntitlement[];readonly unlockIds:readonly string[] }
export class AccountLinkReconciliationError extends Error {}

export function planAccountLinkReconciliation(state:AccountLinkState, choice:LinkSaveChoice, policy:EconomyReconciliationPolicy):AccountLinkPlan {
  validatePlayers(state);
  // The verified provider mapping already owns the existing account. Save choice
  // selects only board progress; it must never select identity/economy ownership.
  const survivorPlayerId=state.existing.playerId;
  const economy=policy.reconcile({survivorPlayerId,guest:state.guestBalance,existing:state.existingBalance,guestLedger:state.guestLedger??[],existingLedger:state.existingLedger??[]});
  for(const value of [economy.balance.coins,economy.balance.gems,economy.balance.energy]) if(!Number.isSafeInteger(value)||value<0) throw new AccountLinkReconciliationError("economy policy produced an invalid balance");
  if(!Number.isSafeInteger(economy.balance.revision)||economy.balance.revision<1||economy.ledgerReasonCodes.length===0) throw new AccountLinkReconciliationError("economy reconciliation must be auditable");
  const byTransaction=new Map<string,ReconciliationEntitlement>();
  for(const item of [...state.existingEntitlements,...state.guestEntitlements]) {
    const prior=byTransaction.get(item.transactionId);
    if(prior!==undefined&&(prior.productId!==item.productId||prior.state!==item.state)) throw new AccountLinkReconciliationError("entitlement transaction state conflicts");
    byTransaction.set(item.transactionId,item);
  }
  return {survivorPlayerId,retiredPlayerId:state.guest.playerId,
    ...(choice==="preferGuestSave"?(state.guestSave?{selectedSave:state.guestSave}:{}):(state.existingSave?{selectedSave:state.existingSave}:{})),economy,
    entitlements:[...byTransaction.values()].sort((a,b)=>a.transactionId.localeCompare(b.transactionId)),unlockIds:[...new Set([...state.guestUnlockIds,...state.existingUnlockIds])].sort()};
}
function validatePlayers(state:AccountLinkState){if(state.guest.playerId===state.existing.playerId||state.guest.accountKind!=="guest"||state.guest.deletionState!=="active"||state.existing.deletionState!=="active")throw new AccountLinkReconciliationError("account link players are invalid");}
