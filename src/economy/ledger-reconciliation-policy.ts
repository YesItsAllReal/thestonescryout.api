import { AccountLinkReconciliationError,type EconomyReconciliationPolicy,type ReconciliationLedgerEntry } from "../accounts/account-link-reconciliation.js";

export class LedgerReconciliationPolicy implements EconomyReconciliationPolicy {
  public reconcile(input:Parameters<EconomyReconciliationPolicy["reconcile"]>[0]) {
    const entries=new Map<string,ReconciliationLedgerEntry>(),grants=new Map<string,ReconciliationLedgerEntry>();
    for(const entry of [...input.existingLedger,...input.guestLedger]) {
      validate(entry);
      const prior=entries.get(entry.ledgerEntryId);
      if(prior!==undefined&&JSON.stringify(prior)!==JSON.stringify(entry)) throw new AccountLinkReconciliationError("ledger entry identity conflicts");
      if(prior!==undefined) continue;
      if(entry.verifiedGrantKey!==undefined) {
        const grant=grants.get(entry.verifiedGrantKey);
        if(grant!==undefined) { if(grant.resource!==entry.resource||grant.delta!==entry.delta) throw new AccountLinkReconciliationError("verified grant conflicts"); continue; }
        grants.set(entry.verifiedGrantKey,entry);
      }
      entries.set(entry.ledgerEntryId,entry);
    }
    const balance={coins:0,gems:0,energy:0,energyUpdatedAt:input.existing.energyUpdatedAt,revision:Math.max(input.guest.revision,input.existing.revision)+1};
    for(const entry of entries.values()) balance[entry.resource]+=entry.delta;
    if(balance.coins<0||balance.gems<0||balance.energy<0) throw new AccountLinkReconciliationError("ledger reconstruction produced a negative balance");
    return {balance,ledgerReasonCodes:["ACCOUNT_LINK_RECONCILIATION"]};
  }
}
function validate(x:ReconciliationLedgerEntry){if(!x.ledgerEntryId||!x.sourceReference||!Number.isSafeInteger(x.delta)||x.delta===0)throw new AccountLinkReconciliationError("ledger entry is invalid");}
