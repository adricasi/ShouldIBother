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

  /** Drops idle entries first, then the least recently active ones, down to `maxTracked`. */
  private evict(now: number): void {
    if (this.entries.size <= this.options.maxTracked) {
      return;
    }
    for (const [client, entry] of this.entries) {
      const idle =
        entry.blockedUntil <= now &&
        entry.failures.every((at) => at <= now - this.options.windowMs);
      if (idle) {
        this.entries.delete(client);
      }
    }
    for (const client of this.entries.keys()) {
      if (this.entries.size <= this.options.maxTracked) {
        break;
      }
      this.entries.delete(client);
    }
  }
}
