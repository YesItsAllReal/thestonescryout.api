import { AccountLinkReconciliationError,type EconomyReconciliationPolicy,type ReconciliationLedgerEntry } from "../accounts/account-link-reconciliation.js";

export class LedgerReconciliationPolicy implements EconomyReconciliationPolicy {
  public reconcile(input:Parameters<EconomyReconciliationPolicy["reconcile"]>[0]) {
    assertReconstructs(input.guestLedger,input.guest);
    assertReconstructs(input.existingLedger,input.existing);
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
    const balance={coins:input.existing.originCoins,gems:input.existing.originGems,energy:input.existing.originEnergy,originCoins:input.existing.originCoins,originGems:input.existing.originGems,originEnergy:input.existing.originEnergy,energyUpdatedAt:input.existing.energyUpdatedAt,revision:Math.max(input.guest.revision,input.existing.revision)+1};
    for(const entry of entries.values()) balance[entry.resource]+=entry.delta;
    if(balance.coins<0||balance.gems<0||balance.energy<0) throw new AccountLinkReconciliationError("ledger reconstruction produced a negative balance");
    return {balance,ledgerReasonCodes:["ACCOUNT_LINK_RECONCILIATION"]};
  }
}
function validate(x:ReconciliationLedgerEntry){if(!x.ledgerEntryId||!x.sourceReference||!Number.isSafeInteger(x.delta)||x.delta===0)throw new AccountLinkReconciliationError("ledger entry is invalid");}
function assertReconstructs(entries:readonly ReconciliationLedgerEntry[],balance:{coins:number;gems:number;energy:number;originCoins:number;originGems:number;originEnergy:number}){const sum={coins:balance.originCoins,gems:balance.originGems,energy:balance.originEnergy};for(const entry of entries){validate(entry);sum[entry.resource]+=entry.delta;}if(sum.coins!==balance.coins||sum.gems!==balance.gems||sum.energy!==balance.energy)throw new AccountLinkReconciliationError("ledger does not reconstruct authoritative balance");}
