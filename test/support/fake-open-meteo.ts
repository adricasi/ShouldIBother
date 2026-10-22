import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { windowHourStarts } from "../../src/domain/outcomes.js";
import { HOUR_MS, addDays, madridDateOf, madridWallTimeToEpochMs } from "../../src/domain/time.js";
import { HOURLY_VARIABLES } from "../../src/server/weather/open-meteo.js";
import {
  fakeForecastHours,
  type FakeWeatherProfile,
  FAKE_WEATHER_PROFILES,
} from "../../src/server/weather/fake.js";

export type ServerMode = "ok" | "http-500" | "http-404" | "hang" | "redirect" | "not-json";

/**
 * A real HTTP server that answers like the Open-Meteo forecast API (names are the UNVERIFIED
 * ones of `src/server/weather/open-meteo.ts`). The client under test still builds its real
 * https://api.open-meteo.com URLs: `transport` sends them to this server, so the allowlist, the
 * query, `redirect: "error"`, timeouts and parsing all run for real.
 */
export class FakeOpenMeteo {
  readonly requests: URL[] = [];
  mode: ServerMode = "ok";
  profile: FakeWeatherProfile = FAKE_WEATHER_PROFILES.mild;
  /** Hours starting at or after this instant answer null (the analysis is not there yet). */
  nullFromMs: number | undefined;
  /** Fails this many requests with a 503 before answering normally. */
  failFirst = 0;
  /** Status of those failures, and the `Retry-After` seconds they carry, if any. */
  failStatus = 503;
  retryAfterSeconds: number | undefined;
  /** Open-Meteo variables the answer leaves null in every hour (a gap in the model data). */
  nullVariables: string[] = [];
  private server: Server | undefined;
  private port = 0;
  /** The URL the client would have called, as the server saw it, per request. */
  readonly hostsSeen: string[] = [];

  constructor(private readonly now: () => number) {}

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** Sends https://<open-meteo host>/... to this server, whatever the host. */
  readonly transport: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    this.hostsSeen.push(url.hostname);
    return fetch(`http://127.0.0.1:${this.port}${url.pathname}${url.search}`, init);
  };

  get forecastRequests(): URL[] {
    return this.requests.filter((url) => url.searchParams.has("forecast_days"));
  }

  get recordedRequests(): URL[] {
    return this.requests.filter((url) => url.searchParams.has("start_date"));
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://fake");
    this.requests.push(url);
    if (this.failFirst > 0) {
      this.failFirst -= 1;
      response
        .writeHead(this.failStatus, {
          ...(this.retryAfterSeconds === undefined
            ? {}
            : { "retry-after": String(this.retryAfterSeconds) }),
        })
        .end("busy");
      return;
    }
    switch (this.mode) {
      case "http-500":
        response.writeHead(500).end("boom");
        return;
      case "http-404":
        response
          .writeHead(404, { "content-type": "application/json" })
          .end(JSON.stringify({ error: true, reason: "Not found" }));
        return;
      case "hang":
        return; // never answers: the client's timeout fires
      case "redirect":
        response.writeHead(302, { location: "https://evil.example/steal" }).end();
        return;
      case "not-json":
        response.writeHead(200, { "content-type": "text/html" }).end("<html>captive portal</html>");
        return;
      case "ok":
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(this.body(url)));
    }
  }

  private body(url: URL): unknown {
    const startDate = url.searchParams.get("start_date");
    const endDate = url.searchParams.get("end_date");
    const midnight = madridWallTimeToEpochMs(madridDateOf(this.now()), "00:00");
    const pastHours = Number(url.searchParams.get("past_days") ?? "0") * 24;
    const first =
      startDate === null
        ? midnight - pastHours * HOUR_MS
        : madridWallTimeToEpochMs(startDate, "00:00");
    const end =
      endDate === null
        ? midnight + Number(url.searchParams.get("forecast_days") ?? "3") * 24 * HOUR_MS
        : madridWallTimeToEpochMs(addDays(endDate, 1), "00:00");
    const starts = windowHourStarts({ startMs: first, endMs: end });
    // The profile's rain is counted from today's midnight, as before; earlier hours are dry.
    const hours = fakeForecastHours(
      this.profile,
      startDate === null ? midnight : first,
      starts.length - (startDate === null ? pastHours : 0),
      startDate === null ? pastHours : 0,
    );
    const column = (pick: (index: number) => number): (number | null)[] =>
      hours.map((hour, index) =>
        this.nullFromMs !== undefined && hour.startsAt >= this.nullFromMs ? null : pick(index),
      );
    const unless = <T extends Record<string, unknown>>(hourly: T): T =>
      Object.fromEntries(
        Object.entries(hourly).map(([name, values]) => [
          name,
          this.nullVariables.includes(name) ? (values as unknown[]).map(() => null) : values,
        ]),
      ) as T;
    const at = (index: number) => hours[index]!;
    return {
      hourly: unless({
        time: hours.map((hour) => hour.startsAt / 1000),
        [HOURLY_VARIABLES.temperatureC]: column((i) => at(i).temperatureC),
        [HOURLY_VARIABLES.dewPointC]: column((i) => at(i).dewPointC),
        [HOURLY_VARIABLES.relativeHumidityPct]: column((i) => at(i).relativeHumidityPct),
        [HOURLY_VARIABLES.precipitationMm]: column((i) => at(i).precipitationMm),
        [HOURLY_VARIABLES.precipitationProbabilityPct]: column(
          (i) => at(i).precipitationProbabilityPct,
        ),
        [HOURLY_VARIABLES.windKmh]: column((i) => at(i).windKmh),
        [HOURLY_VARIABLES.gustKmh]: column((i) => at(i).gustKmh),
        [HOURLY_VARIABLES.weatherCode]: column((i) => at(i).weatherCode),
        [HOURLY_VARIABLES.sunshineSeconds]: column((i) => at(i).sunshineSeconds),
        [HOURLY_VARIABLES.isDay]: column((i) => (at(i).isDay ? 1 : 0)),
        [HOURLY_VARIABLES.et0Mm]: column(() => 0.1),
      }),
    };
  }
}
