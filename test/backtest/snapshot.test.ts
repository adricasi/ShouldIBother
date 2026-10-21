import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ATTRIBUTION,
  DisallowedHostError,
  SnapshotFormatError,
  archiveHours,
  assertAllowedUrl,
  buildRequestUrl,
  fetchJsonWithTimeout,
  fetchSnapshot,
  monthChunks,
  parseOpenMeteoResponse,
  parseSnapshot,
  readSnapshot,
  serializeSnapshot,
  writeSnapshot,
} from "../../src/backtest/index.js";
import {
  GRACIA,
  fakeOpenMeteo,
  syntheticSnapshot,
  type RecordedCall,
} from "./support/synthetic-weather.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request URLs", () => {
  const chunk = { startDate: "2026-04-01", endDate: "2026-04-30" };

  it("round coordinates to 2 decimals and use only the three allowed hosts", () => {
    const urls = (["previousRunsDay1", "historicalForecast", "archive"] as const).map((source) =>
      buildRequestUrl(source, GRACIA, chunk),
    );
    expect(urls.map((url) => new URL(url).hostname)).toEqual([
      "previous-runs-api.open-meteo.com",
      "historical-forecast-api.open-meteo.com",
      "archive-api.open-meteo.com",
    ]);
    for (const url of urls) {
      const params = new URL(url).searchParams;
      expect(params.get("latitude")).toBe("41.4");
      expect(params.get("longitude")).toBe("2.16");
      expect(params.get("timezone")).toBe("Europe/Madrid");
      expect(params.get("timeformat")).toBe("unixtime");
      assertAllowedUrl(url);
    }
  });

  it("asks Previous Runs for the day-1 variables and the archive for ET0 and sunset", () => {
    const previous = new URL(buildRequestUrl("previousRunsDay1", GRACIA, chunk));
    expect(previous.searchParams.get("hourly")).toContain("precipitation_previous_day1");
    expect(previous.searchParams.get("hourly")).not.toContain("et0");
    const archive = new URL(buildRequestUrl("archive", GRACIA, chunk));
    expect(archive.searchParams.get("hourly")).toContain("et0_fao_evapotranspiration");
    expect(archive.searchParams.get("daily")).toBe("sunset");
  });

  it("refuses other hosts and plain http", () => {
    expect(() => assertAllowedUrl("https://api.open-meteo.com/v1/forecast")).toThrow(
      DisallowedHostError,
    );
    expect(() => assertAllowedUrl("https://example.com/")).toThrow(DisallowedHostError);
    expect(() => assertAllowedUrl("http://archive-api.open-meteo.com/v1/archive")).toThrow(
      DisallowedHostError,
    );
  });

  it("splits a range into calendar months", () => {
    expect(monthChunks("2026-04-01", "2026-06-10")).toEqual([
      { startDate: "2026-04-01", endDate: "2026-04-30" },
      { startDate: "2026-05-01", endDate: "2026-05-31" },
      { startDate: "2026-06-01", endDate: "2026-06-10" },
    ]);
    expect(monthChunks("2026-02-15", "2026-02-20")).toEqual([
      { startDate: "2026-02-15", endDate: "2026-02-20" },
    ]);
  });
});

describe("fetchJsonWithTimeout", () => {
  it("refuses a non-allowlisted host before calling fetch", async () => {
    const stub = vi.fn();
    vi.stubGlobal("fetch", stub);
    await expect(fetchJsonWithTimeout("https://example.com/x")).rejects.toThrow(
      DisallowedHostError,
    );
    expect(stub).not.toHaveBeenCalled();
  });

  it("returns the parsed body and reports HTTP errors", async () => {
    const url = buildRequestUrl("archive", GRACIA, {
      startDate: "2026-04-01",
      endDate: "2026-04-01",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: 1 }), { status: 200 }))),
    );
    await expect(fetchJsonWithTimeout(url)).resolves.toEqual({ ok: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("busy", { status: 429 }))),
    );
    await expect(fetchJsonWithTimeout(url)).rejects.toThrow(/429/);
  });
});

describe("fetchSnapshot", () => {
  it("records attribution, the location and the archive's last complete day (AC-019.1)", async () => {
    const snapshot = await syntheticSnapshot({
      archiveLastDay: "2026-10-09",
      requestedEndDate: "2026-10-14",
    });
    expect(snapshot.attribution).toBe(ATTRIBUTION);
    expect(snapshot.license).toBe("CC BY 4.0");
    expect(snapshot.startDate).toBe("2026-04-01");
    expect(snapshot.endDate).toBe("2026-10-09");
    expect(snapshot.requestedEndDate).toBe("2026-10-14");
    expect(snapshot.location).toEqual({
      name: "Gràcia, Barcelona",
      latitude: 41.4,
      longitude: 2.16,
    });
    expect(snapshot.fetchedAt).toBe("2026-10-22T09:00:00Z");
  });

  it("makes one request per source and month, all to allowed hosts", async () => {
    const calls: RecordedCall[] = [];
    await fetchSnapshot({
      fetchJson: fakeOpenMeteo({}, calls),
      location: GRACIA,
      startDate: "2026-04-01",
      requestedEndDate: "2026-06-05",
      fetchedAt: "t",
    });
    expect(calls).toHaveLength(9);
    for (const call of calls) {
      assertAllowedUrl(call.url);
    }
  });

  it("stores hourly series ascending with whole-hour timestamps and a sunset per day", async () => {
    const snapshot = await syntheticSnapshot({ requestedEndDate: "2026-04-10" });
    const times = snapshot.archive.timesMs;
    expect(times).toHaveLength(10 * 24);
    expect(times.every((time, i) => i === 0 || time > (times[i - 1] ?? 0))).toBe(true);
    expect(Object.keys(snapshot.sunsetMsByDate)).toHaveLength(10);
    expect(snapshot.archive.values.et0_fao_evapotranspiration).toBeDefined();
    expect(snapshot.previousRunsDay1.values.et0_fao_evapotranspiration).toBeUndefined();
  });

  it("treats a variable the API did not return as unavailable (null)", async () => {
    const snapshot = await syntheticSnapshot({
      requestedEndDate: "2026-04-03",
      previousRunsOmit: ["precipitation_probability"],
    });
    expect(
      snapshot.previousRunsDay1.values.precipitation_probability?.every((v) => v === null),
    ).toBe(true);
  });

  it("fails clearly when the archive has no complete day", async () => {
    await expect(
      syntheticSnapshot({ archiveLastDay: "2026-03-01", requestedEndDate: "2026-04-03" }),
    ).rejects.toThrow(/no complete day/);
  });

  it("counts a day with a missing hour as incomplete", async () => {
    const holey = fakeOpenMeteo({});
    const snapshot = await fetchSnapshot({
      fetchJson: async (url) => {
        const body = (await holey(url)) as { hourly: Record<string, (number | null)[]> };
        if (url.startsWith("https://archive")) {
          body.hourly["precipitation"] = body.hourly["precipitation"]!.map((v, i, all) =>
            i === all.length - 5 ? null : v,
          );
        }
        return body;
      },
      location: GRACIA,
      startDate: "2026-04-01",
      requestedEndDate: "2026-04-05",
      fetchedAt: "t",
    });
    expect(snapshot.endDate).toBe("2026-04-04");
  });

  it("rejects a request range that ends before it starts", async () => {
    await expect(
      fetchSnapshot({
        fetchJson: fakeOpenMeteo(),
        location: GRACIA,
        startDate: "2026-04-05",
        requestedEndDate: "2026-04-01",
        fetchedAt: "t",
      }),
    ).rejects.toThrow(/before/);
  });
});

describe("parseOpenMeteoResponse", () => {
  it("rejects malformed responses", () => {
    expect(() => parseOpenMeteoResponse("nope", "archive")).toThrow(SnapshotFormatError);
    expect(() => parseOpenMeteoResponse({}, "archive")).toThrow(SnapshotFormatError);
    expect(() =>
      parseOpenMeteoResponse({ hourly: { time: [0], temperature_2m: [1, 2] } }, "archive"),
    ).toThrow(SnapshotFormatError);
    expect(() =>
      parseOpenMeteoResponse(
        { hourly: { time: [0], temperature_2m: ["x"] } },
        "historicalForecast",
      ),
    ).toThrow(SnapshotFormatError);
    expect(() => parseOpenMeteoResponse({ hourly: { time: ["a"] } }, "historicalForecast")).toThrow(
      SnapshotFormatError,
    );
    expect(() => parseOpenMeteoResponse({ hourly: { time: [0] } }, "archive")).toThrow(/daily/);
  });

  it("maps the day-1 suffix back to base variable names", () => {
    const parsed = parseOpenMeteoResponse(
      { hourly: { time: [3600], precipitation_previous_day1: [1.5] } },
      "previousRunsDay1",
    );
    expect(parsed.timesMs).toEqual([3_600_000]);
    expect(parsed.values.precipitation).toEqual([1.5]);
  });
});

describe("NFR-012: snapshot persistence", () => {
  it("serializes byte-identically for identical fetches", async () => {
    const [a, b] = await Promise.all([
      syntheticSnapshot({ requestedEndDate: "2026-05-20" }),
      syntheticSnapshot({ requestedEndDate: "2026-05-20" }),
    ]);
    expect(serializeSnapshot(a)).toBe(serializeSnapshot(b));
  });

  it("round-trips through disk byte for byte and writes the attribution README", async () => {
    const root = await mkdtemp(join(tmpdir(), "sib-snapshot-"));
    try {
      const snapshot = await syntheticSnapshot({ requestedEndDate: "2026-05-02" });
      const directory = await writeSnapshot(root, snapshot);
      expect(directory).toBe(join(root, "gracia-barcelona_2026-04-01_2026-05-02"));
      const loaded = await readSnapshot(directory);
      expect(serializeSnapshot(loaded)).toBe(serializeSnapshot(snapshot));
      expect(archiveHours(loaded)).toEqual(archiveHours(snapshot));
      const readme = await readFile(join(directory, "README.md"), "utf8");
      expect(readme).toContain(ATTRIBUTION);
      expect(readme).toContain("2026-05-02");
      const again = await writeSnapshot(root, snapshot);
      expect(await readFile(join(again, "snapshot.json"), "utf8")).toBe(
        serializeSnapshot(snapshot),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates a snapshot read from disk", async () => {
    const snapshot = await syntheticSnapshot({ requestedEndDate: "2026-04-03" });
    const json = JSON.parse(serializeSnapshot(snapshot)) as Record<string, unknown>;
    expect(parseSnapshot(json).endDate).toBe("2026-04-03");
    expect(() => parseSnapshot({ ...json, schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => parseSnapshot({ ...json, location: { name: "x" } })).toThrow(SnapshotFormatError);
    expect(() => parseSnapshot({ ...json, attribution: 3 })).toThrow(SnapshotFormatError);
    expect(() => parseSnapshot({ ...json, sunsetMsByDate: { "2026-04-01": "late" } })).toThrow(
      SnapshotFormatError,
    );
    expect(() => parseSnapshot({ ...json, sources: {} })).toThrow(SnapshotFormatError);
    expect(() => parseSnapshot({ ...json, archive: { timesMs: [1], values: {} } })).toThrow(
      /whole-hour/,
    );
    expect(() =>
      parseSnapshot({ ...json, archive: { timesMs: [7_200_000, 3_600_000], values: {} } }),
    ).toThrow(/ascending/);
    expect(() => parseSnapshot(null)).toThrow(SnapshotFormatError);
  });
});
