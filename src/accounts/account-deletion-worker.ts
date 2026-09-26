export type AccountDeletionStep = "progressed" | "completed";

export interface AccountDeletionCleanupRepository {
  processNext(playerId: string, now: Date): Promise<AccountDeletionStep>;
}

/**
 * Runs bounded deletion work. The durable repository advances exactly one
 * atomic cleanup step at a time, so a timeout can safely retry the same job.
 */
export class AccountDeletionWorker {
  public constructor(
    private readonly repository: AccountDeletionCleanupRepository,
    private readonly now: () => Date,
    private readonly maximumSteps = 25,
  ) {
    if (!Number.isSafeInteger(maximumSteps) || maximumSteps < 1 || maximumSteps > 100) {
      throw new Error("deletion worker step limit is invalid");
    }
  }

  public async run(playerId: string): Promise<{ readonly completed: boolean; readonly steps: number }> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(playerId)) {
      throw new Error("deletion worker player identifier is invalid");
    }
    for (let steps = 1; steps <= this.maximumSteps; steps++) {
      if (await this.repository.processNext(playerId, this.now()) === "completed") {
        return { completed: true, steps };
      }
    }
    return { completed: false, steps: this.maximumSteps };
  }
}
