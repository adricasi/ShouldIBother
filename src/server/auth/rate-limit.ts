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

  /** Whole seconds until a blocked client may try again (at least 1), or 0 when not blocked. */
  retryAfterSeconds(client: string): number {
    const entry = this.entries.get(client);
    if (entry === undefined || entry.blockedUntil <= this.now()) {
      return 0;
    }
    return Math.max(1, Math.ceil((entry.blockedUntil - this.now()) / 1000));
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

/**
 * At most `limit` requests per `windowMs` for each key, kept in memory only (nothing is written
 * anywhere, and a restart forgets it). A request that is refused is not counted, so waiting out
 * the window always works. The place search uses it per session (AC-024.4).
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly now: () => number,
    private readonly limit: number,
    private readonly windowMs: number = 60_000,
    /** Upper bound on remembered keys, so a flood of sessions cannot grow memory. */
    private readonly maxTracked: number = 1000,
  ) {}

  /** Counts the request and returns 0, or returns the whole seconds to wait (at least 1) and counts nothing. */
  take(key: string): number {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => at > now - this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil(((recent[0] ?? now) + this.windowMs - now) / 1000));
    }
    recent.push(now);
    // Re-insert so the least recently used key is the first one in the map.
    this.hits.delete(key);
    this.hits.set(key, recent);
    this.evict(now);
    return 0;
  }

  private evict(now: number): void {
    for (const [key, times] of this.hits) {
      if (this.hits.size <= this.maxTracked) {
        return;
      }
      if (times.every((at) => at <= now - this.windowMs)) {
        this.hits.delete(key);
      }
    }
    for (const key of this.hits.keys()) {
      if (this.hits.size <= this.maxTracked) {
        return;
      }
      this.hits.delete(key);
    }
  }
}
