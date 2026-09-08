import type { LedgerEntry } from "../economy/economy-service.js";

export function publicLedgerEntries(entries: readonly LedgerEntry[]) {
  return entries.map((entry) => ({
    ledgerEntryId: entry.ledgerEntryId,
    resource: entry.resource,
    delta: entry.delta,
    reasonCode: entry.reasonCode,
    sourceReference: entry.sourceReference,
    balanceAfter: entry.balanceAfter,
    createdAt: entry.createdAt,
  }));
}
