import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { formatPairingBanner, pairingTargets } from "../src/server/auth/banner.js";
import { PAIRING_TTL_MS, SESSION_TTL_MS } from "../src/server/auth/store.js";
import {
  LAN_ADDRESS,
  LOCAL_HOST,
  LOCAL_ORIGIN,
  PORT,
  PUBLIC_HOST,
  PUBLIC_ORIGIN,
  SECRET,
  appRoutes,
  cookieHeaderFrom,
  createHarness,
  type Harness,
} from "./helpers.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let harness: Harness;
afterEach(async () => {
  await harness.close();
});

async function setup(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  harness = await createHarness({ features: appRoutes, ...options });
  return harness;
}

function setCookieOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  return String(Array.isArray(header) ? header[0] : header);
}

describe("AC-001.1: a new pairing token", () => {
  it("is at least 128 bits, unique, valid for 10 minutes", async () => {
    await setup();
    const first = harness.store.issuePairingToken();
    const second = harness.store.issuePairingToken();
    expect(Buffer.from(first.token, "base64url").length).toBeGreaterThanOrEqual(16);
    expect(first.token).not.toBe(second.token);
    expect(first.expiresAt - harness.clock.current).toBe(PAIRING_TTL_MS);
    expect(PAIRING_TTL_MS).toBe(10 * MINUTE);
  });

  it("is stored only as a SHA-256 hash", async () => {
    await setup();
    const { token } = harness.store.issuePairingToken();
    const rows = harness.db.prepare("SELECT * FROM pairing").all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("leaves existing sessions valid", async () => {
    await setup();
    const cookie = await harness.pairDevice();
    harness.store.issuePairingToken();
    const response = await harness.request({
      method: "GET",
      url: "/api/today",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
  });

  it("supersedes the previous token, so only one token is live", async () => {
    await setup();
    const older = harness.store.issuePairingToken();
    harness.store.issuePairingToken();
    const response = await harness.request({ method: "GET", url: `/pair?token=${older.token}` });
    expect(response.statusCode).toBe(401);
  });

  it("prints the pairing URLs and a QR code for the phone", () => {
    const banner = formatPairingBanner({
      token: "TOKEN",
      expiresAt: Date.UTC(2026, 9, 22, 8, 10),
      targets: pairingTargets({
        port: PORT,
        lanAddress: LAN_ADDRESS,
        publicOrigins: [PUBLIC_ORIGIN],
      }),
    });
    expect(banner).toContain(`http://127.0.0.1:${PORT}/pair?token=TOKEN`);
    expect(banner).toContain(`http://${LAN_ADDRESS}:${PORT}/pair?token=TOKEN`);
    expect(banner).toContain(`${PUBLIC_ORIGIN}/pair?token=TOKEN`);
    expect(banner).toContain("10 minutes");
    expect(banner).toMatch(/[▀▄█]/);
  });
});

describe("AC-001.2: exchanging the token", () => {
  it("sets an HttpOnly, SameSite=Strict cookie and redirects to a URL without the token", async () => {
    await setup();
    const { token } = harness.store.issuePairingToken();
    const response = await harness.request({ method: "GET", url: `/pair?token=${token}` });
    expect(response.statusCode).toBe(303);
    expect(response.headers["location"]).toBe("/");
    const cookie = setCookieOf(response);
    expect(cookie).toMatch(/^sib_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(cookie).not.toContain("Secure");
    expect(JSON.stringify(response.headers)).not.toContain(token);
  });

  it("stores the session id only as a SHA-256 hash", async () => {
    await setup();
    const cookie = await harness.pairDevice();
    const sessionId = cookie.split("=")[1] ?? "";
    const rows = harness.db.prepare("SELECT id_hash FROM sessions").all() as { id_hash: string }[];
    expect(rows).toEqual([{ id_hash: createHash("sha256").update(sessionId).digest("hex") }]);
  });

  it("lets three devices pair with one token and refuses the fourth", async () => {
    await setup();
    const { token } = harness.store.issuePairingToken();
    const statuses: number[] = [];
    for (let device = 0; device < 4; device += 1) {
      const response = await harness.request({ method: "GET", url: `/pair?token=${token}` });
      statuses.push(response.statusCode);
      if (device === 3) {
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
    }
    expect(statuses).toEqual([303, 303, 303, 401]);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 3 });
  });

  it.each([
    ["no token", "/pair"],
    ["an empty token", "/pair?token="],
    ["a malformed token", "/pair?token=short"],
    ["a repeated token parameter", `/pair?token=${"a".repeat(43)}&token=${"b".repeat(43)}`],
    ["an unknown token", `/pair?token=${"A".repeat(43)}`],
  ])("refuses %s with 401 and no cookie", async (_label, url) => {
    await setup();
    harness.store.issuePairingToken();
    const response = await harness.request({ method: "GET", url });
    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("prints one console line per pairing with time, client address and user agent", async () => {
    await setup();
    const { token } = harness.store.issuePairingToken();
    const response = await harness.request({
      method: "GET",
      url: `/pair?token=${token}`,
      remoteAddress: "192.168.1.77",
      headers: { "user-agent": "Mozilla/5.0 (iPhone) \u001b[31mevil" },
    });
    expect(harness.printed).toHaveLength(1);
    const line = harness.printed[0] ?? "";
    expect(line).toContain("2026-10-22 10:00:00");
    expect(line).toContain("192.168.1.77");
    expect(line).toContain("Mozilla/5.0 (iPhone)");
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain(token);
    expect(line).not.toContain(cookieHeaderFrom(response).split("=")[1] ?? "unreachable");
  });

  it("a paired device can then use the app", async () => {
    await setup();
    const cookie = await harness.pairDevice();
    const response = await harness.request({
      method: "GET",
      url: "/api/today",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("AC-001.3: no session, no app data", () => {
  it.each([
    ["a page", "GET", "/"],
    ["an API route", "GET", "/api/today"],
    ["a photo file", "GET", "/photos/0b8c9e3a"],
    ["the health check", "GET", "/healthz"],
    ["an unknown path", "GET", "/does-not-exist"],
    ["a HEAD request", "HEAD", "/"],
    ["an OPTIONS request", "OPTIONS", "/api/today"],
  ])("answers %s with 401 and no data", async (_label, method, url) => {
    await setup();
    const response = await harness.request({ method, url });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(SECRET);
    expect(response.headers["content-type"]).toContain("application/problem+json");
  });

  it("answers an unauthenticated POST with 401 before looking at app data", async () => {
    await setup();
    const response = await harness.request({
      method: "POST",
      url: "/api/cards",
      headers: { origin: LOCAL_ORIGIN },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(SECRET);
  });

  it.each([
    ["a made-up cookie", `sib_session=${"x".repeat(43)}`],
    ["a malformed cookie", "sib_session=not-a-session"],
    ["another cookie name", `other=${"x".repeat(43)}`],
  ])("rejects %s", async (_label, cookie) => {
    await setup();
    await harness.pairDevice();
    const response = await harness.request({
      method: "GET",
      url: "/api/today",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(401);
  });

  it("serves the same routes to a paired device", async () => {
    await setup();
    const cookie = await harness.pairDevice();
    for (const url of ["/", "/api/today", "/photos/0b8c9e3a"]) {
      const response = await harness.request({ method: "GET", url, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(SECRET);
    }
  });

  it("accepts the session cookie next to other cookies", async () => {
    await setup();
    const cookie = await harness.pairDevice();
    const response = await harness.request({
      method: "GET",
      url: "/api/today",
      headers: { cookie: `theme=dark; sib_session=${"y".repeat(43)}; ${cookie}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it("sets the security headers on every response, errors included", async () => {
    await setup();
    const cookie = await harness.pairDevice();
    const responses = [
      await harness.request({ method: "GET", url: "/api/today", headers: { cookie } }),
      await harness.request({ method: "GET", url: "/api/today" }),
      await harness.request({ method: "GET", url: "/nope", headers: { cookie } }),
      await harness.request({
        method: "GET",
        url: "/api/today",
        headers: { host: "evil.example" },
      }),
    ];
    expect(responses.map((response) => response.statusCode)).toEqual([200, 401, 404, 421]);
    for (const response of responses) {
      expect(response.headers["content-security-policy"]).toBe(
        "default-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'",
      );
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
    }
  });
});

describe("AC-001.4: Origin check on POST, PUT and DELETE", () => {
  const mutating = [
    ["POST", "/api/cards"],
    ["PUT", "/api/cards/1"],
    ["DELETE", "/api/bets/1"],
  ] as const;

  it.each(mutating)("%s without an Origin header is rejected with 403", async (method, url) => {
    await setup();
    const cookie = await harness.pairDevice();
    const response = await harness.request({ method, url, headers: { cookie } });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(SECRET);
  });

  it.each(mutating)("%s with a foreign Origin is rejected with 403", async (method, url) => {
    await setup();
    const cookie = await harness.pairDevice();
    for (const origin of [
      "https://evil.example",
      "null",
      "http://localhost:9999",
      "http://localhost",
    ]) {
      const response = await harness.request({ method, url, headers: { cookie, origin } });
      expect(response.statusCode).toBe(403);
    }
  });

  it.each(mutating)("%s with an allowlisted host over http succeeds", async (method, url) => {
    await setup();
    const cookie = await harness.pairDevice();
    for (const origin of [
      LOCAL_ORIGIN,
      `http://127.0.0.1:${PORT}`,
      `http://${LAN_ADDRESS}:${PORT}`,
    ]) {
      const response = await harness.request({ method, url, headers: { cookie, origin } });
      expect(response.statusCode).toBe(200);
    }
  });

  it("rejects an https origin that is not in config.publicOrigins", async () => {
    await setup();
    const cookie = await harness.pairDevice();
    const response = await harness.request({
      method: "POST",
      url: "/api/cards",
      headers: { cookie, origin: PUBLIC_ORIGIN, host: LOCAL_HOST },
    });
    expect(response.statusCode).toBe(403);
  });

  it("accepts an origin listed in config.publicOrigins", async () => {
    await setup({ publicOrigins: [PUBLIC_ORIGIN] });
    const cookie = await harness.pairDevice({ host: PUBLIC_HOST });
    const response = await harness.request({
      method: "POST",
      url: "/api/cards",
      headers: { cookie, origin: PUBLIC_ORIGIN, host: PUBLIC_HOST },
    });
    expect(response.statusCode).toBe(200);
  });

  it("does not require an Origin on GET", async () => {
    await setup();
    const cookie = await harness.pairDevice();
    const response = await harness.request({
      method: "GET",
      url: "/api/today",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("AC-001.5: rate limit on unauthenticated failures", () => {
  async function fail(count: number, remoteAddress: string): Promise<number[]> {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < count; attempt += 1) {
      const response = await harness.request({ method: "GET", url: "/api/today", remoteAddress });
      statuses.push(response.statusCode);
    }
    return statuses;
  }

  it("blocks an address after more than 10 failures in a minute, for a minute", async () => {
    await setup();
    expect(await fail(11, "192.168.1.50")).toEqual(Array<number>(11).fill(401));
    expect(await fail(2, "192.168.1.50")).toEqual([429, 429]);
    const blocked = await harness.request({
      method: "GET",
      url: "/api/today",
      remoteAddress: "192.168.1.50",
    });
    expect(blocked.headers["retry-after"]).toBe("60");

    harness.clock.advance(59_000);
    expect(await fail(1, "192.168.1.50")).toEqual([429]);
    harness.clock.advance(1_001);
    expect(await fail(1, "192.168.1.50")).toEqual([401]);
  });

  it("does not block at 10 failures", async () => {
    await setup();
    expect(await fail(10, "192.168.1.50")).toEqual(Array<number>(10).fill(401));
    expect(await fail(1, "192.168.1.50")).toEqual([401]);
  });

  it("counts failures per address and per minute", async () => {
    await setup();
    await fail(10, "192.168.1.50");
    expect(await fail(1, "192.168.1.51")).toEqual([401]);
    harness.clock.advance(61_000);
    expect(await fail(10, "192.168.1.50")).toEqual(Array<number>(10).fill(401));
  });

  it("blocks a valid pairing token from a blocked address too", async () => {
    await setup();
    await fail(11, "192.168.1.50");
    const { token } = harness.store.issuePairingToken();
    const response = await harness.request({
      method: "GET",
      url: `/pair?token=${token}`,
      remoteAddress: "192.168.1.50",
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("counts failed pairings", async () => {
    await setup();
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await harness.request({
        method: "GET",
        url: `/pair?token=${"A".repeat(43)}`,
        remoteAddress: "192.168.1.50",
      });
    }
    const response = await harness.request({
      method: "GET",
      url: "/pair",
      remoteAddress: "192.168.1.50",
    });
    expect(response.statusCode).toBe(429);
  });

  it("never blocks a valid session, even from a blocked address", async () => {
    await setup();
    const cookie = await harness.pairDevice({}, "192.168.1.50");
    await fail(30, "192.168.1.50");
    expect(await fail(1, "192.168.1.50")).toEqual([429]);
    for (let request = 0; request < 30; request += 1) {
      const response = await harness.request({
        method: "GET",
        url: "/api/today",
        headers: { cookie },
        remoteAddress: "192.168.1.50",
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it("does not count requests with a valid session", async () => {
    await setup();
    const cookie = await harness.pairDevice({}, "192.168.1.50");
    for (let request = 0; request < 40; request += 1) {
      await harness.request({
        method: "GET",
        url: "/nope",
        headers: { cookie },
        remoteAddress: "192.168.1.50",
      });
    }
    expect(await fail(1, "192.168.1.50")).toEqual([401]);
  });
});

describe("AC-001.6: forget devices", () => {
  it("revokes every session and the unexpired token through the API", async () => {
    await setup();
    const phone = await harness.pairDevice();
    const laptop = await harness.pairDevice();
    const { token } = harness.store.issuePairingToken();

    const response = await harness.request({
      method: "POST",
      url: "/api/devices/forget",
      headers: { cookie: phone, origin: LOCAL_ORIGIN },
    });
    expect(response.statusCode).toBe(204);
    expect(setCookieOf(response)).toContain("Max-Age=0");

    for (const cookie of [phone, laptop]) {
      const after = await harness.request({
        method: "GET",
        url: "/api/today",
        headers: { cookie },
      });
      expect(after.statusCode).toBe(401);
    }
    const pair = await harness.request({ method: "GET", url: `/pair?token=${token}` });
    expect(pair.statusCode).toBe(401);
  });

  it("revokes every session and the unexpired token through the store (sib forget-devices)", async () => {
    await setup();
    const cookie = await harness.pairDevice();
    const { token } = harness.store.issuePairingToken();
    harness.store.forgetDevices();
    expect(
      (await harness.request({ method: "GET", url: "/api/today", headers: { cookie } })).statusCode,
    ).toBe(401);
    expect((await harness.request({ method: "GET", url: `/pair?token=${token}` })).statusCode).toBe(
      401,
    );
  });

  it("needs a session and a matching Origin", async () => {
    await setup();
    const cookie = await harness.pairDevice();
    const noSession = await harness.request({
      method: "POST",
      url: "/api/devices/forget",
      headers: { origin: LOCAL_ORIGIN },
    });
    const noOrigin = await harness.request({
      method: "POST",
      url: "/api/devices/forget",
      headers: { cookie },
    });
    expect([noSession.statusCode, noOrigin.statusCode]).toEqual([401, 403]);
    expect(
      (await harness.request({ method: "GET", url: "/api/today", headers: { cookie } })).statusCode,
    ).toBe(200);
  });

  it("lets a new pairing work afterwards", async () => {
    await setup();
    await harness.pairDevice();
    harness.store.forgetDevices();
    const cookie = await harness.pairDevice();
    expect(
      (await harness.request({ method: "GET", url: "/api/today", headers: { cookie } })).statusCode,
    ).toBe(200);
  });
});

describe("AC-001.7: no token or session id in the logs", () => {
  it("the /pair request log line has no token and no query string", async () => {
    await setup({ logger: true });
    const { token } = harness.store.issuePairingToken();
    const response = await harness.request({
      method: "GET",
      url: `/pair?token=${token}`,
      headers: { "user-agent": "test-agent" },
    });
    expect(response.statusCode).toBe(303);
    const output = harness.logLines.join("");
    expect(output).toContain('"url":"/pair?[redacted]"');
    expect(output).toContain("incoming request");
    expect(output).toContain("request completed");
    expect(output).not.toContain(token);
  });

  it("session ids never appear: not from Set-Cookie, not from the Cookie header", async () => {
    await setup({ logger: true });
    const cookie = await harness.pairDevice();
    const sessionId = cookie.split("=")[1] ?? "unreachable";
    await harness.request({ method: "GET", url: "/api/today", headers: { cookie } });
    await harness.request({ method: "GET", url: "/nope?x=1", headers: { cookie } });
    await harness.request({
      method: "GET",
      url: "/api/today",
      headers: { cookie: `sib_session=${"z".repeat(43)}` },
    });
    const output = harness.logLines.join("");
    expect(output.length).toBeGreaterThan(0);
    expect(output).not.toContain(sessionId);
    expect(output).not.toContain("z".repeat(43));
  });

  it("unknown paths and malformed URLs neither log nor echo the query string", async () => {
    await setup({ logger: true });
    const cookie = await harness.pairDevice();
    const guess = "Q".repeat(43);
    const notFound = await harness.request({
      method: "GET",
      url: `/nope?token=${guess}`,
      headers: { cookie },
    });
    const badUrl = await harness.request({
      method: "GET",
      url: `/%zz?token=${guess}`,
      headers: { cookie },
    });
    expect([notFound.statusCode, badUrl.statusCode]).toEqual([404, 400]);
    expect(notFound.body + badUrl.body).not.toContain(guess);
    expect(harness.logLines.join("")).not.toContain(guess);
    expect(badUrl.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("failed and blocked pairings leave no token in the logs either", async () => {
    await setup({ logger: true });
    const guess = "G".repeat(43);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await harness.request({ method: "GET", url: `/pair?token=${guess}` });
    }
    await harness.request({ method: "GET", url: `/nope?token=${guess}` });
    await harness.request({ method: "GET", url: `/%zz?token=${guess}` });
    const output = harness.logLines.join("");
    expect(output).toContain("rate limited");
    expect(output).not.toContain(guess);
  });
});

describe("AC-001.8: expiry", () => {
  it("a pairing token older than 10 minutes is invalid", async () => {
    await setup();
    const fresh = harness.store.issuePairingToken();
    harness.clock.advance(PAIRING_TTL_MS - 1);
    const stillValid = await harness.request({ method: "GET", url: `/pair?token=${fresh.token}` });
    expect(stillValid.statusCode).toBe(303);

    const stale = harness.store.issuePairingToken();
    harness.clock.advance(PAIRING_TTL_MS);
    const expired = await harness.request({ method: "GET", url: `/pair?token=${stale.token}` });
    expect(expired.statusCode).toBe(401);
  });

  it("a session older than 30 days is invalid", async () => {
    await setup();
    const cookie = await harness.pairDevice();
    harness.clock.advance(SESSION_TTL_MS - 1);
    expect(
      (await harness.request({ method: "GET", url: "/api/today", headers: { cookie } })).statusCode,
    ).toBe(200);
    harness.clock.advance(1);
    expect(
      (await harness.request({ method: "GET", url: "/api/today", headers: { cookie } })).statusCode,
    ).toBe(401);
    expect(SESSION_TTL_MS).toBe(30 * DAY);
  });

  it("using a session does not extend it", async () => {
    await setup();
    const cookie = await harness.pairDevice();
    for (let day = 0; day < 29; day += 1) {
      harness.clock.advance(DAY);
      await harness.request({ method: "GET", url: "/api/today", headers: { cookie } });
    }
    harness.clock.advance(DAY);
    expect(
      (await harness.request({ method: "GET", url: "/api/today", headers: { cookie } })).statusCode,
    ).toBe(401);
  });

  it("issuing a token deletes expired and revoked rows", async () => {
    await setup();
    await harness.pairDevice();
    harness.clock.advance(SESSION_TTL_MS + PAIRING_TTL_MS);
    harness.store.issuePairingToken();
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM pairing").get()).toEqual({ n: 1 });
  });
});

describe("AC-001.9: Host allowlist", () => {
  it.each([
    ["an unknown host", "evil.example:8787"],
    ["an unknown host without a port", "evil.example"],
    ["the right host on the wrong port", "localhost:9999"],
    ["localhost without the port", "localhost"],
    ["a DNS-rebinding name", "127.0.0.1.evil.example:8787"],
    ["the public host when none is configured", PUBLIC_HOST],
  ])("answers %s with 421 and no data, even with a session", async (_label, host) => {
    await setup();
    const cookie = await harness.pairDevice();
    for (const url of ["/api/today", "/pair?token=x", "/"]) {
      const response = await harness.request({ method: "GET", url, headers: { cookie, host } });
      expect(response.statusCode).toBe(421);
      expect(response.body).not.toContain(SECRET);
    }
  });

  it("accepts localhost, 127.0.0.1 and every interface address", async () => {
    await setup();
    const cookie = await harness.pairDevice();
    for (const host of [
      `localhost:${PORT}`,
      `127.0.0.1:${PORT}`,
      `${LAN_ADDRESS}:${PORT}`,
      `LOCALHOST:${PORT}`,
    ]) {
      const response = await harness.request({
        method: "GET",
        url: "/api/today",
        headers: { cookie, host },
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it("accepts config.allowedHosts, with or without a port", async () => {
    await setup({ allowedHosts: ["10.0.0.5", "laptop.lan:9000"] });
    const cookie = await harness.pairDevice();
    for (const host of [`10.0.0.5:${PORT}`, "laptop.lan:9000"]) {
      const response = await harness.request({
        method: "GET",
        url: "/api/today",
        headers: { cookie, host },
      });
      expect(response.statusCode).toBe(200);
    }
    const wrong = await harness.request({
      method: "GET",
      url: "/api/today",
      headers: { cookie, host: "10.0.0.5" },
    });
    expect(wrong.statusCode).toBe(421);
  });

  it("accepts the host of a public origin", async () => {
    await setup({ publicOrigins: [PUBLIC_ORIGIN] });
    const cookie = await harness.pairDevice({ host: PUBLIC_HOST });
    const response = await harness.request({
      method: "GET",
      url: "/api/today",
      headers: { cookie, host: PUBLIC_HOST },
    });
    expect(response.statusCode).toBe(200);
  });

  it("does not count 421 answers towards the rate limit", async () => {
    await setup();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await harness.request({
        method: "GET",
        url: "/",
        headers: { host: "evil.example" },
        remoteAddress: "192.168.1.60",
      });
    }
    const { token } = harness.store.issuePairingToken();
    const response = await harness.request({
      method: "GET",
      url: `/pair?token=${token}`,
      remoteAddress: "192.168.1.60",
    });
    expect(response.statusCode).toBe(303);
  });
});

describe("AC-001.10: Secure cookie over an https public origin", () => {
  it("sets Secure when pairing through an https public origin", async () => {
    await setup({ publicOrigins: [PUBLIC_ORIGIN] });
    const { token } = harness.store.issuePairingToken();
    const response = await harness.request({
      method: "GET",
      url: `/pair?token=${token}`,
      headers: { host: PUBLIC_HOST },
    });
    expect(response.statusCode).toBe(303);
    const cookie = setCookieOf(response);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("does not set Secure when pairing over plain http on the LAN", async () => {
    await setup({ publicOrigins: [PUBLIC_ORIGIN] });
    const { token } = harness.store.issuePairingToken();
    const response = await harness.request({
      method: "GET",
      url: `/pair?token=${token}`,
      headers: { host: `${LAN_ADDRESS}:${PORT}` },
    });
    expect(setCookieOf(response)).not.toContain("Secure");
  });

  it("does not set Secure for an http public origin", async () => {
    await setup({ publicOrigins: ["http://bookie.lan:8787"] });
    const { token } = harness.store.issuePairingToken();
    const response = await harness.request({
      method: "GET",
      url: `/pair?token=${token}`,
      headers: { host: "bookie.lan:8787" },
    });
    expect(setCookieOf(response)).not.toContain("Secure");
  });

  it("clears the Secure cookie with a Secure cookie", async () => {
    await setup({ publicOrigins: [PUBLIC_ORIGIN] });
    const cookie = await harness.pairDevice({ host: PUBLIC_HOST });
    const response = await harness.request({
      method: "POST",
      url: "/api/devices/forget",
      headers: { cookie, host: PUBLIC_HOST, origin: PUBLIC_ORIGIN },
    });
    expect(setCookieOf(response)).toContain("Secure");
  });
});
