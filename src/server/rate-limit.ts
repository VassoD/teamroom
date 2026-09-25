export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

interface Window {
  count: number;
  resetAt: number;
}

const SWEEP_EVERY_N_HITS = 500;

/**
 * Fixed-window counter kept in memory. Limits apply per server process: if
 * several processes share one data directory, each enforces its own limits.
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private hits = 0;

  constructor(
    private readonly rule: RateLimitRule,
    private readonly now: () => number = Date.now
  ) {}

  /** Returns the seconds to wait when the key is over its limit, otherwise null. */
  hit(key: string): number | null {
    const timestamp = this.now();
    this.sweepOccasionally(timestamp);

    const current = this.windows.get(key);
    if (!current || current.resetAt <= timestamp) {
      this.windows.set(key, { count: 1, resetAt: timestamp + this.rule.windowMs });
      return null;
    }
    if (current.count >= this.rule.limit) {
      return Math.ceil((current.resetAt - timestamp) / 1000);
    }
    current.count += 1;
    return null;
  }

  private sweepOccasionally(timestamp: number): void {
    this.hits += 1;
    if (this.hits % SWEEP_EVERY_N_HITS !== 0) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= timestamp) this.windows.delete(key);
    }
  }
}
