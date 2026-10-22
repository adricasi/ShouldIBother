import type { ModelClient, ModelHealth } from "../model/client.js";

/** A check is reused this long, so Today asking every few seconds stays cheap (AC-013.5). */
export const STATUS_TTL_MS = 15_000;
/** A runtime that does not answer a health check in this time is offline. */
const CHECK_TIMEOUT_MS = 2_000;

export interface GemmaStatus extends ModelHealth {
  /** When the runtime was last asked, epoch milliseconds. */
  readonly checkedAt: number;
}

/**
 * Gemma's status for Today (AC-013.5): online, waking up or offline. The runtime is asked at most
 * once per `ttlMs`, so the status on screen is never older than that plus the 30 s client poll,
 * well inside the 60 s the requirement allows.
 */
export class GemmaStatusMonitor {
  private last: GemmaStatus | undefined;
  private inFlight: Promise<GemmaStatus> | undefined;

  constructor(
    private readonly model: ModelClient,
    private readonly now: () => number,
    private readonly ttlMs: number = STATUS_TTL_MS,
  ) {}

  async get(): Promise<GemmaStatus> {
    const last = this.last;
    if (last !== undefined && this.now() - last.checkedAt < this.ttlMs) {
      return last;
    }
    this.inFlight ??= this.check().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async check(): Promise<GemmaStatus> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ModelHealth>((resolve) => {
      timer = setTimeout(() => {
        resolve({ state: "offline", detail: "no answer" });
      }, CHECK_TIMEOUT_MS);
      timer.unref();
    });
    let health: ModelHealth;
    try {
      health = await Promise.race([this.model.health(), timeout]);
    } catch {
      health = { state: "offline", detail: "health check failed" };
    } finally {
      clearTimeout(timer);
    }
    this.last = { ...health, checkedAt: this.now() };
    return this.last;
  }
}
