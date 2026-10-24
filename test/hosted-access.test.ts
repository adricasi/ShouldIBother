import { afterEach, describe, expect, it } from "vitest";

import { formatPairingBanner, pairingTargets } from "../src/server/auth/banner.js";
import { SESSION_RENEW_AFTER_MS } from "../src/server/auth/store.js";
import { SESSION_TTL_MS } from "../src/server/auth/store.js";

import { SECRET, appRoutes, createHarness, type Harness } from "./helpers.js";

const ORIGIN = "https://sib.example.com";
const HOST = "sib.example.com";
const DAY = 24 * 60 * 60 * 1000;
const PROXY = "172.18.0.2"; // Caddy on the Compose network
const PROXY_NET = "172.18.0.0/24";

let harness: Harness;
afterEach(async () => {
  await harness.close();
});

async function hosted(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  harness = await createHarness({
    features: appRoutes,
    hostedOrigin: ORIGIN,
    // The deploy kit gives Caddy a fixed address on a fixed subnet and names it in SIB_TRUSTED_PROXY.
    trustedProxy: [PROXY_NET],
    ...options,
  });
  return harness;
}

/** A request as Caddy forwards it: the public Host, and the client address in X-Forwarded-For. */
function viaCaddy(
  options: { url: string; method?: "GET" | "POST"; headers?: Record<string, string> } & {
    client?: string;
    payload?: unknown;
  },
) {
  return harness.app.inject({
    method: options.method ?? "GET",
    url: options.url,
    remoteAddress: PROXY,
    headers: {
      host: HOST,
      "x-forwarded-for": options.client ?? "203.0.113.7",
      "x-forwarded-proto": "https",
      ...options.headers,
    },
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });
}

const post = (token: string, headers: Record<string, string> = {}, client?: string) =>
  viaCaddy({
    method: "POST",
    url: "/pair",
    payload: { token },
    ...(client === undefined ? {} : { client }),
    headers: { origin: ORIGIN, ...headers },
  });

function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const header = response.headers["set-cookie"] as string | string[] | undefined;
  return header === undefined ? [] : Array.isArray(header) ? header : [header];
}

describe("AC-032.3: the pairing page, the token in the URL fragment", () => {
  it("GET /pair is a page with a Pair this phone button that spends nothing", async () => {
    await hosted();
    const { token } = harness.store.issuePairingToken();
    const response = await viaCaddy({ url: `/pair?token=${token}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain("Pair this phone");
    expect(response.body).toContain('<script src="/pair.js" defer></script>');
    expect(response.body).not.toContain(token);
    expect(setCookies(response)).toEqual([]);
    // The query token was not used up: the page ignores it, and it still pairs.
    expect((await post(token)).statusCode).toBe(204);
  });

  it("serves the page under the CSP: a script and a style file, no inline code", async () => {
    await hosted();
    const page = await viaCaddy({ url: "/pair" });
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(page.body).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(page.body).not.toMatch(/<style|style=|onclick=/);
    const script = await viaCaddy({ url: "/pair.js" });
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("text/javascript");
    expect(script.body).toContain("window.location.hash");
    expect(script.body).toContain('method: "POST"');
    expect((await viaCaddy({ url: "/pair.css" })).headers["content-type"]).toContain("text/css");
  });

  it("takes the token out of the address bar only after the pairing worked", async () => {
    await hosted();
    const script = (await viaCaddy({ url: "/pair.js" })).body;
    expect(script.indexOf("replaceState")).toBeGreaterThan(script.indexOf("response.ok"));
    expect(script.indexOf("replaceState")).toBeLessThan(script.indexOf("location.replace"));
    expect(script.match(/replaceState/g)).toHaveLength(1);
  });

  it("tells an unpaired browser to run sib pair on the server", async () => {
    await hosted();
    const response = await viaCaddy({ url: "/api/today" });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ detail: string }>().detail).toContain("`sib pair` on the server");
  });

  it("sends Referrer-Policy: no-referrer on every response", async () => {
    await hosted();
    for (const url of ["/pair", "/pair.js", "/api/today", "/nothing-here"]) {
      const response = await viaCaddy({ url });
      expect(response.headers["referrer-policy"], url).toBe("no-referrer");
    }
    const wrongHost = await harness.app.inject({ url: "/pair", headers: { host: "evil.example" } });
    expect(wrongHost.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("POST /pair with the token sets a __Host- cookie: Secure, HttpOnly, SameSite=Strict, Path=/, 30 days", async () => {
    await hosted();
    const { token } = harness.store.issuePairingToken();
    const response = await post(token);
    expect(response.statusCode).toBe(204);
    const [cookie] = setCookies(response);
    expect(cookie).toMatch(/^__Host-sib_session=[A-Za-z0-9_-]{43};/);
    for (const attribute of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"]) {
      expect(cookie?.split("; ")).toContain(attribute);
    }
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(SESSION_TTL_MS).toBe(30 * DAY);
    expect(cookie).not.toContain("Domain");
    const session = cookie?.split(";")[0] ?? "";
    const today = await viaCaddy({ url: "/api/today", headers: { cookie: session } });
    expect(today.statusCode).toBe(200);
    expect(today.body).toContain(SECRET);
  });

  it("checks the Origin of the POST", async () => {
    await hosted();
    const { token } = harness.store.issuePairingToken();
    for (const origin of ["https://evil.example", "http://sib.example.com", "null"]) {
      const response = await post(token, { origin });
      expect(response.statusCode, origin).toBe(403);
    }
    const missing = await harness.app.inject({
      method: "POST",
      url: "/pair",
      remoteAddress: PROXY,
      headers: { host: HOST },
      payload: { token },
    });
    expect(missing.statusCode).toBe(403);
    expect((await post(token)).statusCode).toBe(204);
  });

  it("answers every wrong token the same: 401 and a counted failure", async () => {
    await hosted();
    harness.store.issuePairingToken();
    for (const token of ["x", "A".repeat(43), ""]) {
      const response = await post(token);
      expect(response.statusCode).toBe(401);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(setCookies(response)).toEqual([]);
    }
    const malformed = await viaCaddy({
      method: "POST",
      url: "/pair",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      payload: '{"token": 1, "extra": true}',
    });
    expect(malformed.statusCode).toBe(401);
  });

  it("a link is good for the devices it was made for, then used up", async () => {
    await hosted();
    const { token } = harness.store.issuePairingToken(3);
    for (let device = 0; device < 3; device += 1) {
      expect((await post(token, {}, `203.0.113.${10 + device}`)).statusCode).toBe(204);
    }
    expect((await post(token, {}, "203.0.113.99")).statusCode).toBe(401);
  });

  it("rate limits the pairing POST per client address, whatever the outcome", async () => {
    await hosted({ pairAttemptsPerMinute: 3 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await post("bad")).statusCode).toBe(401);
    }
    const limited = await post("bad");
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // Another address is not affected; the same address is free again after the window.
    expect((await post("bad", {}, "203.0.113.50")).statusCode).toBe(401);
    harness.clock.advance(61_000);
    expect((await post("bad")).statusCode).toBe(401);
  });

  it("counts a broken body too, and still sends the security headers on its error", async () => {
    await hosted({ pairAttemptsPerMinute: 2 });
    const broken = () =>
      viaCaddy({
        method: "POST",
        url: "/pair",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        payload: "{not json",
      });
    const first = await broken();
    expect(first.statusCode).toBe(400);
    expect(first.headers["referrer-policy"]).toBe("no-referrer");
    expect(first.body).not.toContain("not json");
    await broken();
    expect((await broken()).statusCode).toBe(429);
  });

  it("keeps the existing failure limit: 10 failures a minute block the address", async () => {
    await hosted({ pairAttemptsPerMinute: 100 });
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await viaCaddy({ url: "/api/today" });
    }
    expect((await viaCaddy({ url: "/api/today" })).statusCode).toBe(429);
    expect((await viaCaddy({ url: "/api/today", client: "203.0.113.8" })).statusCode).toBe(401);
  });
});

describe("AC-032.3: Host and Origin are exactly SIB_PUBLIC_ORIGIN", () => {
  it("answers 421 to any other Host, loopback and LAN names included", async () => {
    await hosted();
    for (const host of [
      "localhost:8787",
      "127.0.0.1:8787",
      "192.168.1.20:8787",
      "evil.example",
      "sib.example.com:8787",
      "sib.example.com.evil.example",
    ]) {
      const response = await harness.app.inject({ url: "/pair", headers: { host } });
      expect(response.statusCode, host).toBe(421);
    }
    expect((await viaCaddy({ url: "/pair" })).statusCode).toBe(200);
  });

  it("ignores config.allowedHosts and config.publicOrigins in hosted mode", async () => {
    await hosted({
      allowedHosts: ["192.168.1.20"],
      publicOrigins: ["https://other.example.com"],
    });
    const host = await harness.app.inject({ url: "/pair", headers: { host: "other.example.com" } });
    expect(host.statusCode).toBe(421);
  });

  it("refuses state-changing requests from another origin even with a session", async () => {
    await hosted();
    const { token } = harness.store.issuePairingToken();
    const session = (setCookies(await post(token))[0] ?? "").split(";")[0] ?? "";
    const base = { method: "POST" as const, url: "/api/cards", headers: { cookie: session } };
    expect(
      (await viaCaddy({ ...base, headers: { ...base.headers, origin: "http://127.0.0.1:8787" } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await viaCaddy({ ...base, headers: { ...base.headers, origin: ORIGIN } })).statusCode,
    ).toBe(200);
  });
});

describe("AC-032.3: the client address is the one the trusted proxy reports", () => {
  it("rate limits by X-Forwarded-For when the peer is a private proxy address", async () => {
    await hosted();
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await viaCaddy({ url: "/api/today", client: "203.0.113.7" });
    }
    expect((await viaCaddy({ url: "/api/today", client: "203.0.113.7" })).statusCode).toBe(429);
    expect((await viaCaddy({ url: "/api/today", client: "198.51.100.4" })).statusCode).toBe(401);
  });

  /** True when the forwarded address, not the peer, is the one the limiter blocks. */
  async function limitedByForwarded(peer: string, forwarded: string): Promise<boolean> {
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await harness.app.inject({
        url: "/api/today",
        remoteAddress: peer,
        headers: { host: HOST, "x-forwarded-for": forwarded },
      });
    }
    // Another peer (the proxy) now reports the same forwarded address.
    const byForwarded = await harness.app.inject({
      url: "/api/today",
      remoteAddress: PROXY,
      headers: { host: HOST, "x-forwarded-for": forwarded },
    });
    return byForwarded.statusCode === 429;
  }

  it("believes X-Forwarded-For only from the configured proxy addresses", async () => {
    await hosted({ trustedProxy: [PROXY_NET, "127.0.0.1"] });
    expect(await limitedByForwarded("172.18.0.9", "203.0.113.21")).toBe(true);
    expect(await limitedByForwarded("127.0.0.1", "203.0.113.22")).toBe(true);
    // Private and public peers that are not on the list cannot choose their address either.
    expect(await limitedByForwarded("10.1.2.3", "203.0.113.23")).toBe(false);
    expect(await limitedByForwarded("172.20.0.5", "203.0.113.24")).toBe(false);
    expect(await limitedByForwarded("192.168.5.5", "203.0.113.25")).toBe(false);
    expect(await limitedByForwarded("198.51.100.77", "203.0.113.26")).toBe(false);
  });

  it("spoofing case 1: with no trusted proxy configured, the header is ignored and the peer is the client", async () => {
    await hosted({ trustedProxy: [] });
    // A client that rotates the header cannot get a fresh allowance: it is still the one peer.
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await harness.app.inject({
        url: "/api/today",
        remoteAddress: "198.51.100.77",
        headers: { host: HOST, "x-forwarded-for": `203.0.113.${attempt}` },
      });
    }
    const blocked = await harness.app.inject({
      url: "/api/today",
      remoteAddress: "198.51.100.77",
      headers: { host: HOST, "x-forwarded-for": "203.0.113.200" },
    });
    expect(blocked.statusCode).toBe(429);
    // And it cannot lock out someone else by claiming their address: the other peer is free.
    const other = await harness.app.inject({
      url: "/api/today",
      remoteAddress: "198.51.100.88",
      headers: { host: HOST, "x-forwarded-for": "198.51.100.77" },
    });
    expect(other.statusCode).toBe(401);
  });

  it("spoofing case 2: a peer outside the list cannot borrow a trusted address or hide behind one", async () => {
    await hosted({ trustedProxy: ["172.18.0.2"] });
    // Locking out the proxy's own forwarded client addresses is not possible from outside.
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await harness.app.inject({
        url: "/api/today",
        remoteAddress: "198.51.100.77",
        headers: { host: HOST, "x-forwarded-for": "203.0.113.50" },
      });
    }
    const victim = await harness.app.inject({
      url: "/api/today",
      remoteAddress: "172.18.0.2",
      headers: { host: HOST, "x-forwarded-for": "203.0.113.50" },
    });
    expect(victim.statusCode).toBe(401);
    // The listed proxy is honoured, a neighbour on the same subnet is not.
    expect(await limitedByForwarded("172.18.0.2", "203.0.113.51")).toBe(true);
    expect(await limitedByForwarded("172.18.0.3", "203.0.113.52")).toBe(false);
  });

  it("a forged first entry in X-Forwarded-For does not hide the client", async () => {
    await hosted();
    // Caddy appends the real address; the entry the client wrote comes first and is never used.
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await viaCaddy({ url: "/api/today", client: `1.1.1.${attempt}, 203.0.113.30` });
    }
    expect(
      (await viaCaddy({ url: "/api/today", client: "9.9.9.9, 203.0.113.30" })).statusCode,
    ).toBe(429);
  });
});

describe("AC-032.3: a device stays remembered, renewed on use", () => {
  async function pairHosted(): Promise<string> {
    const { token } = harness.store.issuePairingToken();
    return (setCookies(await post(token))[0] ?? "").split(";")[0] ?? "";
  }

  it("renews the session and the cookie at most once a day, with no absolute cap", async () => {
    await hosted();
    const session = await pairHosted();
    const use = () => viaCaddy({ url: "/api/today", headers: { cookie: session } });

    harness.clock.advance(DAY - 60_000);
    const early = await use();
    expect(setCookies(early)).toEqual([]);

    harness.clock.advance(2 * 60_000);
    const renewed = await use();
    const [cookie] = setCookies(renewed);
    expect(cookie?.split(";")[0]).toBe(session);
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(cookie).toContain("Secure");
    expect(setCookies(await use())).toEqual([]);

    // A phone used every other day is still signed in after three months.
    for (let day = 0; day < 45; day += 1) {
      harness.clock.advance(2 * DAY);
      expect((await use()).statusCode).toBe(200);
    }
  });

  it("signs a device out when it is not used for 30 days", async () => {
    await hosted();
    const session = await pairHosted();
    harness.clock.advance(SESSION_TTL_MS + 1);
    expect((await viaCaddy({ url: "/api/today", headers: { cookie: session } })).statusCode).toBe(
      401,
    );
  });

  it("sib forget-devices ends every session", async () => {
    await hosted();
    const session = await pairHosted();
    harness.store.forgetDevices();
    expect((await viaCaddy({ url: "/api/today", headers: { cookie: session } })).statusCode).toBe(
      401,
    );
  });

  it("accepts only the __Host- cookie", async () => {
    await hosted();
    const session = await pairHosted();
    const plain = session.replace("__Host-", "");
    expect((await viaCaddy({ url: "/api/today", headers: { cookie: plain } })).statusCode).toBe(
      401,
    );
  });

  it("the store renews a session only when the last renewal is older than a day", () => {
    expect(SESSION_RENEW_AFTER_MS).toBe(DAY);
  });
});

describe("AC-032.7: the container's health check", () => {
  const health = (remoteAddress: string, headers: Record<string, string> = {}) =>
    harness.app.inject({ url: "/healthz", remoteAddress, headers });

  it("answers 204 with no body and no session from 127.0.0.1 and ::1, whatever the Host", async () => {
    await hosted();
    for (const peer of ["127.0.0.1", "::1"]) {
      const response = await health(peer, { host: "127.0.0.1:8787" });
      expect(response.statusCode, peer).toBe(204);
      expect(response.body).toBe("");
    }
    expect((await health("127.0.0.1", { host: HOST })).statusCode).toBe(204);
  });

  it("keeps the 401 for everyone else, a forwarded client included", async () => {
    await hosted();
    expect((await health(PROXY, { host: HOST })).statusCode).toBe(401);
    expect((await health("203.0.113.9", { host: HOST })).statusCode).toBe(401);
    // Caddy on the same machine: a request it forwarded carries the client's address.
    expect(
      (await health("127.0.0.1", { host: HOST, "x-forwarded-for": "203.0.113.9" })).statusCode,
    ).toBe(401);
    expect(
      (await health("127.0.0.1", { host: HOST, forwarded: "for=203.0.113.9" })).statusCode,
    ).toBe(401);
  });

  it("opens nothing else without a session from loopback", async () => {
    await hosted();
    const response = await harness.app.inject({
      url: "/api/today",
      remoteAddress: "127.0.0.1",
      headers: { host: HOST },
    });
    expect(response.statusCode).toBe(401);
  });

  it("exempts only /healthz from the Host allowlist: every other path from loopback keeps the 421", async () => {
    await hosted();
    for (const url of ["/api/today", "/pair", "/", "/healthz/", "/healthz?x=1", "/photos/1"]) {
      const response = await harness.app.inject({
        url,
        remoteAddress: "127.0.0.1",
        headers: { host: "127.0.0.1:8787" },
      });
      expect(response.statusCode, url).toBe(421);
    }
    // Not a safe method, and not from loopback: the Host allowlist answers.
    const post = await harness.app.inject({
      method: "POST",
      url: "/healthz",
      remoteAddress: "127.0.0.1",
      headers: { host: "127.0.0.1:8787" },
    });
    expect(post.statusCode).toBe(421);
    const outside = await harness.app.inject({
      url: "/healthz",
      remoteAddress: "203.0.113.9",
      headers: { host: "127.0.0.1:8787" },
    });
    expect(outside.statusCode).toBe(421);
  });
});

describe("AC-032.3: sib pair prints the public link with the token in the fragment", () => {
  it("prints <origin>/pair#t=<token> and a QR code, and no ?token= link", () => {
    const targets = pairingTargets({
      port: 8787,
      lanAddress: "192.168.1.20",
      publicOrigins: ["https://x.example"],
      hostedOrigin: ORIGIN,
    });
    expect(targets).toEqual([{ kind: "hosted", label: "Hosted", origin: ORIGIN }]);
    const banner = formatPairingBanner({ token: "T".repeat(43), expiresAt: 1, targets });
    expect(banner).toContain(`${ORIGIN}/pair#t=${"T".repeat(43)}`);
    expect(banner).not.toContain("?token=");
    expect(banner).not.toContain("127.0.0.1");
    expect(banner).toContain("Scan with the phone camera");
    expect(banner).toMatch(/[▀▄█]/);
  });
});
