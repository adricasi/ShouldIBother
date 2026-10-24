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
/** No answer of Open-Meteo is read past this size: a forecast is about 10 KB, a place list less. */
export const MAX_RESPONSE_BYTES = 256 * 1024;
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
  readonly attemptTimeoutMs?: number;
  readonly deadlineMs?: number;
  /** Tries per request (3 by default); the place search makes one, so a search costs one call. */
  readonly maxAttempts?: number;
  /** Largest answer read, in bytes (256 KB by default); a larger one is refused. */
  readonly maxResponseBytes?: number;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** `Retry-After` in whole seconds (the form Open-Meteo's rate limit uses), as milliseconds. */
function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * The body as text, or undefined when it is longer than `limit` bytes: refused by its declared
 * length before a byte is read, and by the count while reading, so a server that lies or sends no
 * length still cannot fill the memory.
 */
async function readCapped(response: Response, limit: number): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    return undefined;
  }
  if (response.body === null) {
    return "";
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
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
  private readonly attemptTimeoutMs: number;
  private readonly deadlineMs: number;
  private readonly maxAttempts: number;
  private readonly maxResponseBytes: number;

  constructor(options: OpenMeteoHttpOptions) {
    this.doFetch = options.fetch ?? fetch;
    this.counter = options.counter;
    this.log = options.log ?? (() => undefined);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.clock = options.clock ?? Date.now;
    this.allowedHosts = options.allowedHosts ?? OPEN_METEO_ALLOWED_HOSTS;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
    this.deadlineMs = options.deadlineMs ?? REQUEST_DEADLINE_MS;
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  }

  async getJson(url: string): Promise<unknown> {
    // Before anything else, so a wrong host never costs a request or a budget unit.
    assertAllowedUrl(url, this.allowedHosts);
    const target = new URL(url);
    const deadline = AbortSignal.timeout(this.deadlineMs);
    const deadlineAt = performance.now() + this.deadlineMs;
    const remainingMs = (): number => Math.max(0, deadlineAt - performance.now());
    let failure = "no attempt was made";

    for (let attempt = 1; attempt <= this.maxAttempts && !deadline.aborted; attempt += 1) {
      let waitMs = BACKOFF_BASE_MS * 2 ** (attempt - 1) + this.random() * BACKOFF_JITTER_MS;
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
        const signal = AbortSignal.any([deadline, AbortSignal.timeout(this.attemptTimeoutMs)]);
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
          // A server that says when to come back is obeyed, as long as that fits in the deadline.
          const asked = retryAfterMs(response);
          if (asked !== undefined) {
            if (asked > remainingMs()) {
              throw new WeatherUnavailableError(
                `${failure}, and asked us to wait ${asked / 1000} s`,
              );
            }
            waitMs = Math.max(waitMs, asked);
          }
        } else {
          const text = await readCapped(response, this.maxResponseBytes);
          if (text === undefined) {
            this.log(entry("http-error", response.status));
            throw new WeatherUnavailableError(
              `Open-Meteo answered more than ${this.maxResponseBytes / 1024} KB`,
            );
          }
          const body = JSON.parse(text) as unknown;
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
        // undici words a refused redirect "unexpected redirect"; the redirect test in
        // test/weather-client.test.ts pins that, so an undici change fails there, not silently.
        if (reason.includes("redirect")) {
          // A redirect will not change on a retry; refusing it is the point of `redirect: "error"`.
          throw new WeatherUnavailableError(failure);
        }
      }
      if (attempt < this.maxAttempts && !deadline.aborted) {
        await this.sleep(Math.min(waitMs, remainingMs()));
      }
    }
    throw new WeatherUnavailableError(failure);
  }
}
