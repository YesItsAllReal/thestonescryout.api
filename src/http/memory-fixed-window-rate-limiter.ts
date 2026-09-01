import type { RateLimiter } from "./http-types.js";

interface WindowState {
  readonly startedAtMs: number;
  count: number;
}

export class MemoryFixedWindowRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, WindowState>();

  public constructor(
    private readonly maximumRequests: number,
    private readonly windowSeconds: number,
  ) {
    if (!Number.isSafeInteger(maximumRequests) || maximumRequests < 1) {
      throw new RangeError("maximumRequests must be a positive integer");
    }
    if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
      throw new RangeError("windowSeconds must be a positive integer");
    }
  }

  public async allow(input: Parameters<RateLimiter["allow"]>[0]) {
    const key = `${input.route}\u0000${input.discriminator}`;
    const nowMs = input.now.getTime();
    const existing = this.windows.get(key);
    const windowMs = this.windowSeconds * 1_000;
    if (existing === undefined || nowMs - existing.startedAtMs >= windowMs) {
      this.windows.set(key, { startedAtMs: nowMs, count: 1 });
      return { allowed: true } as const;
    }
    if (existing.count >= this.maximumRequests) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.startedAtMs + windowMs - nowMs) / 1_000)),
      } as const;
    }
    existing.count += 1;
    return { allowed: true } as const;
  }
}
