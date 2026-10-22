export interface FailureLimiterOptions {
  /** Failures tolerated per window; the one after this many starts the block. */
  readonly maxFailures: number;
  readonly windowMs: number;
  readonly blockMs: number;
  /** Upper bound on remembered clients, so a flood of addresses cannot grow memory. */
  readonly maxTracked: number;
}

export const DEFAULT_LIMITS: FailureLimiterOptions = {
  maxFailures: 10,
  windowMs: 60_000,
  blockMs: 60_000,
  maxTracked: 1000,
};

interface Entry {
  failures: number[];
  blockedUntil: number;
}

/**
 * Counts unauthenticated failures per client address (AC-001.5). More than `maxFailures` inside
 * `windowMs` blocks that address for `blockMs`. Only failures are recorded; the caller never
 * consults the limiter for a request that carries a valid session.
 */
export class FailureLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number,
    private readonly options: FailureLimiterOptions = DEFAULT_LIMITS,
  ) {}

  isBlocked(client: string): boolean {
    const entry = this.entries.get(client);
    return entry !== undefined && entry.blockedUntil > this.now();
  }

  recordFailure(client: string): void {
    const now = this.now();
    const entry = this.entries.get(client) ?? { failures: [], blockedUntil: 0 };
    entry.failures = entry.failures.filter((at) => at > now - this.options.windowMs);
    entry.failures.push(now);
    if (entry.failures.length > this.options.maxFailures) {
      entry.blockedUntil = now + this.options.blockMs;
      entry.failures = [];
    }
    this.entries.delete(client);
    this.entries.set(client, entry);
    this.evict(now);
  }

  /**
   * Keeps at most `maxTracked` clients: idle ones go first, then the least recently active
   * unblocked ones, and a blocked client only as a last resort.
   */
  private evict(now: number): void {
    if (this.entries.size <= this.options.maxTracked) {
      return;
    }
    const isBlocked = (entry: Entry): boolean => entry.blockedUntil > now;
    const isIdle = (entry: Entry): boolean =>
      !isBlocked(entry) && entry.failures.every((at) => at <= now - this.options.windowMs);
    const passes = [isIdle, (entry: Entry) => !isBlocked(entry), () => true];
    for (const qualifies of passes) {
      for (const [client, entry] of this.entries) {
        if (this.entries.size <= this.options.maxTracked) {
          return;
        }
        if (qualifies(entry)) {
          this.entries.delete(client);
        }
      }
    }
  }
}
