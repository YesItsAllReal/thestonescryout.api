import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AccountDeletionWorker } from "../accounts/account-deletion-worker.js";
import { DynamoDbAccountDeletionCleanup } from "../accounts/dynamodb-account-deletion-cleanup.js";
import { readDeletionJobStreamRecords } from "../accounts/deletion-worker-stream-event.js";

const tableName = process.env.SCO_PLAYER_TABLE_NAME?.trim();
if (tableName === undefined || tableName === "") throw new Error("SCO_PLAYER_TABLE_NAME is required");

const repository = new DynamoDbAccountDeletionCleanup(
  DynamoDBDocumentClient.from(new DynamoDBClient({})),
  tableName,
);
// One atomic step per stream record. Updating the durable job emits the next
// record; failures leave both the data and job unchanged for stream retry.
const worker = new AccountDeletionWorker(repository, () => new Date(), 1);

/** Internal asynchronous invocation only; never attach this handler to API Gateway. */
export async function handler(event: unknown): Promise<
  { readonly completed: boolean; readonly steps: number } |
  { readonly batchItemFailures: readonly { readonly itemIdentifier: string }[] }
> {
  if (event !== null && typeof event === "object" && !Array.isArray(event) &&
      typeof (event as Record<string, unknown>).playerId === "string") {
    return worker.run((event as { playerId: string }).playerId);
  }
  const records = readDeletionJobStreamRecords(event);
  const failures: { itemIdentifier: string }[] = [];
  for (const record of records) {
    try {
      if (record.state === "requested" || record.state === "processing") await worker.run(record.playerId);
    } catch {
      failures.push({ itemIdentifier: record.itemIdentifier });
    }
  }
  return { batchItemFailures: failures };
}
