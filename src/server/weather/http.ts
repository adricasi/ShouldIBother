import {
  DisallowedHostError,
  OPEN_METEO_ALLOWED_HOSTS,
  assertAllowedUrl,
} from "../../domain/open-meteo.js";

import { WeatherUnavailableError } from "./client.js";

/** Open-Meteo's free tier allows 10,000 calls a day; the app's own budget is 1,000 (NFR-006). */
export const DAILY_CALL_BUDGET = 1000;

/** One try gives up after 2 s; all tries of one request share a 5 s deadline (AC-004.1). */
export const ATTEMPT_TIMEOUT_MS = 2000;
export const REQUEST_DEADLINE_MS = 5000;
export const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 200;
const BACKOFF_JITTER_MS = 100;

/** What the client writes to the log for every request that leaves the laptop (NFR-006). */
export interface CallLogEntry {
  readonly event: "open-meteo-call";
  readonly host: string;
  readonly path: string;
  readonly attempt: number;
  readonly outcome: "ok" | "http-error" | "network-error";
  readonly status?: number;
  readonly callsToday: number;
  readonly ms: number;
}

/** Counts requests per Madrid day; the store behind it survives restarts. */
export interface CallCounter {
  /** Counts one request and returns today's total; throws when the daily budget is spent. */
  take(): number;
}

export interface OpenMeteoHttpOptions {
  readonly fetch?: typeof fetch;
  readonly counter: CallCounter;
  readonly log?: (entry: CallLogEntry) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Test seam: milliseconds clock for the log. */
  readonly clock?: () => number;
  /** The allowed hosts; the production list unless a test narrows it. */
  readonly allowedHosts?: readonly string[];
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function causeMessage(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error ? cause.message : "";
}

/**
 * HTTPS GET of JSON from Open-Meteo, and nothing else: the host must be on the allowlist
 * (AC-014.7), redirects are errors (a 3xx cannot take a request to another host), every try has a
 * timeout, and failures retry with backoff and jitter inside one deadline. Every request is
 * counted and logged (NFR-006). Household data never goes into a URL except the coordinates, which
 * the caller rounds to 2 decimals (AC-014.1).
 */
export class OpenMeteoHttp {
  private readonly doFetch: typeof fetch;
  private readonly counter: CallCounter;
  private readonly log: (entry: CallLogEntry) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly clock: () => number;
  private readonly allowedHosts: readonly string[];

  constructor(options: OpenMeteoHttpOptions) {
    this.doFetch = options.fetch ?? fetch;
    this.counter = options.counter;
    this.log = options.log ?? (() => undefined);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.clock = options.clock ?? Date.now;
    this.allowedHosts = options.allowedHosts ?? OPEN_METEO_ALLOWED_HOSTS;
  }

  async getJson(url: string): Promise<unknown> {
    // Before anything else, so a wrong host never costs a request or a budget unit.
    assertAllowedUrl(url, this.allowedHosts);
    const target = new URL(url);
    const deadline = AbortSignal.timeout(REQUEST_DEADLINE_MS);
    let failure = "no attempt was made";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !deadline.aborted; attempt += 1) {
      const callsToday = this.counter.take();
      const startedAt = this.clock();
      const entry = (outcome: CallLogEntry["outcome"], status?: number): CallLogEntry => ({
        event: "open-meteo-call",
        host: target.hostname,
        path: target.pathname,
        attempt,
        outcome,
        ...(status === undefined ? {} : { status }),
        callsToday,
        ms: this.clock() - startedAt,
      });
      try {
        const signal = AbortSignal.any([deadline, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]);
        const response = await this.doFetch(url, {
          redirect: "error",
          signal,
          headers: { accept: "application/json" },
        });
        if (!response.ok) {
          this.log(entry("http-error", response.status));
          failure = `Open-Meteo answered ${response.status}`;
          if (!isRetryableStatus(response.status)) {
            throw new WeatherUnavailableError(failure);
          }
        } else {
          const body: unknown = await response.json();
          this.log(entry("ok", response.status));
          return body;
        }
      } catch (error) {
        if (error instanceof WeatherUnavailableError || error instanceof DisallowedHostError) {
          throw error;
        }
        if (error instanceof SyntaxError) {
          throw new WeatherUnavailableError("Open-Meteo answered something that is not JSON");
        }
        this.log(entry("network-error"));
        const reason = causeMessage(error) || (error instanceof Error ? error.message : "failed");
        failure = `Open-Meteo could not be reached: ${reason}`;
        if (reason.includes("redirect")) {
          // A redirect will not change on a retry; refusing it is the point of `redirect: "error"`.
          throw new WeatherUnavailableError(failure);
        }
      }
      if (attempt < MAX_ATTEMPTS && !deadline.aborted) {
        await this.sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1) + this.random() * BACKOFF_JITTER_MS);
      }
    }
    throw new WeatherUnavailableError(failure);
  }
}
