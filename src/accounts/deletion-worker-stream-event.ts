export interface DeletionJobStreamRecord {
  /** DynamoDB Streams partial-batch responses require the sequence number. */
  readonly itemIdentifier: string;
  readonly playerId: string;
  readonly state: string;
}

const playerIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readDeletionJobStreamRecords(event: unknown): readonly DeletionJobStreamRecord[] {
  if (event === null || typeof event !== "object" || Array.isArray(event) ||
      !Array.isArray((event as Record<string, unknown>).Records)) throw new Error("deletion worker event is invalid");
  return ((event as { Records: unknown[] }).Records).map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("deletion worker record is invalid");
    const record = value as Record<string, unknown>;
    const dynamodb = record.dynamodb as {
      Keys?: Record<string, { S?: string }>;
      NewImage?: Record<string, { S?: string }>;
      SequenceNumber?: string;
    } | undefined;
    const itemIdentifier = dynamodb?.SequenceNumber;
    if (typeof itemIdentifier !== "string" || itemIdentifier === "") throw new Error("deletion worker record is invalid");

    // DynamoDB TTL eventually removes the completed marker. The mapping's key
    // filter also matches that REMOVE event, so acknowledge only the exact job
    // key shape without trying to process a NewImage that cannot exist.
    if (record.eventName === "REMOVE") {
      const pk = dynamodb?.Keys?.pk?.S;
      const sk = dynamodb?.Keys?.sk?.S;
      const playerId = typeof pk === "string" && pk.startsWith("DELETION#") ? pk.slice("DELETION#".length) : "";
      if (sk !== "REQUEST" || !playerIdPattern.test(playerId)) throw new Error("deletion worker record is invalid");
      return { itemIdentifier, playerId, state: "removed" };
    }

    const image = dynamodb?.NewImage;
    if (image?.entityType?.S !== "DeletionJob" ||
        typeof image.playerId?.S !== "string" || typeof image.state?.S !== "string") {
      throw new Error("deletion worker record is invalid");
    }
    return { itemIdentifier, playerId: image.playerId.S, state: image.state.S };
  });
}
