import type { ModelClient, ModelHealth } from "../model/client.js";

/** A check is reused this long, so Today asking every few seconds stays cheap (AC-013.5). */
export const STATUS_TTL_MS = 15_000;
/** A runtime that does not answer a health check in this time is offline. */
const CHECK_TIMEOUT_MS = 2_000;

export interface GemmaStatus extends ModelHealth {
  /** When the runtime was last asked, epoch milliseconds. */
  readonly checkedAt: number;
  /**
   * Set while a model that one job depends on cannot answer although the primary one can (the
   * fine-tuned bookmaker not pulled): Today must not read plain "online" while every card of that
   * job falls back to rule odds.
   */
  readonly warning?: string;
}

/** A runtime whose health matters to one job, next to the primary model's. */
export interface WatchedModel {
  /** How the warning names it, e.g. "The fine-tuned bookmaker". */
  readonly label: string;
  readonly model: ModelClient;
}

export interface StatusOptions {
  readonly watched?: readonly WatchedModel[];
  /** Called when the warning appears or changes (once per change, for one log line). */
  readonly onWarning?: (message: string) => void;
}

/**
 * Gemma's status for Today (AC-013.5): online, waking up or offline. The runtime is asked at most
 * once per `ttlMs`, so the status on screen is never older than that plus the 30 s client poll,
 * well inside the 60 s the requirement allows.
 */
export class GemmaStatusMonitor {
  private last: GemmaStatus | undefined;
  private inFlight: Promise<GemmaStatus> | undefined;
  private lastWarning = "";

  constructor(
    private readonly model: ModelClient,
    private readonly now: () => number,
    private readonly ttlMs: number = STATUS_TTL_MS,
    private readonly options: StatusOptions = {},
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
    const [health, ...watched] = await Promise.all([
      this.healthOf(this.model),
      ...(this.options.watched ?? []).map((entry) => this.healthOf(entry.model)),
    ]);
    const warning = (this.options.watched ?? [])
      .map((entry, index) => ({ entry, health: watched[index] }))
      .filter(({ health: other }) => other?.state === "offline")
      .map(
        ({ entry, health: other }) =>
          `${entry.label} is not available (${other?.detail ?? "no answer"}), so its cards use rule odds.`,
      )
      .join(" ");
    if (warning !== "" && warning !== this.lastWarning) {
      this.options.onWarning?.(warning);
    }
    this.lastWarning = warning;
    this.last = {
      ...health,
      checkedAt: this.now(),
      ...(warning === "" ? {} : { warning }),
    };
    return this.last;
  }

  private async healthOf(model: ModelClient): Promise<ModelHealth> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ModelHealth>((resolve) => {
      timer = setTimeout(() => {
        resolve({ state: "offline", detail: "no answer" });
      }, CHECK_TIMEOUT_MS);
      timer.unref();
    });
    try {
      return await Promise.race([model.health(), timeout]);
    } catch {
      return { state: "offline", detail: "health check failed" };
    } finally {
      clearTimeout(timer);
    }
  }
}
