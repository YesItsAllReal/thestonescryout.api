export interface DeletionJobStreamRecord {
  /** DynamoDB Streams partial-batch responses require the sequence number. */
  readonly itemIdentifier: string;
  readonly playerId: string;
  readonly state: string;
}

export function readDeletionJobStreamRecords(event: unknown): readonly DeletionJobStreamRecord[] {
  if (event === null || typeof event !== "object" || Array.isArray(event) ||
      !Array.isArray((event as Record<string, unknown>).Records)) throw new Error("deletion worker event is invalid");
  return ((event as { Records: unknown[] }).Records).map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("deletion worker record is invalid");
    const record = value as Record<string, unknown>;
    const dynamodb = record.dynamodb as {
      NewImage?: Record<string, { S?: string }>;
      SequenceNumber?: string;
    } | undefined;
    const image = dynamodb?.NewImage;
    const itemIdentifier = dynamodb?.SequenceNumber;
    if (typeof itemIdentifier !== "string" || itemIdentifier === "" || image?.entityType?.S !== "DeletionJob" ||
        typeof image.playerId?.S !== "string" || typeof image.state?.S !== "string") {
      throw new Error("deletion worker record is invalid");
    }
    return { itemIdentifier, playerId: image.playerId.S, state: image.state.S };
  });
}
