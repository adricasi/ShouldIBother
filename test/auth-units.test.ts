import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildAllowlist } from "../src/server/auth/allowlist.js";
import { FailureLimiter } from "../src/server/auth/rate-limit.js";
import {
  findHashConstantTime,
  generateSecret,
  hashSecret,
  isWellFormedSecret,
} from "../src/server/auth/secrets.js";
import { AuthStore } from "../src/server/auth/store.js";
import { migrate, openDatabase } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";
import { forgetDevicesCommand, pairCommand } from "../src/server/main.js";
import type { Runtime } from "../src/server/runtime.js";

import { FakeClock, FAKE_INTERFACES, PORT, LAN_ADDRESS } from "./helpers.js";

describe("secrets (AC-001.1, NFR-001)", () => {
  it("generates 256-bit URL-safe values that never repeat", () => {
    const values = new Set(Array.from({ length: 500 }, () => generateSecret()));
    expect(values.size).toBe(500);
    for (const value of values) {
      expect(isWellFormedSecret(value)).toBe(true);
      expect(Buffer.from(value, "base64url")).toHaveLength(32);
    }
  });

  it("hashes with SHA-256", () => {
    expect(hashSecret("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
  });

  it.each([
    "",
    "short",
    "a".repeat(42),
    "a".repeat(44),
    `${"a".repeat(42)}=`,
    `${"a".repeat(42)} `,
  ])("rejects the malformed secret %j", (value) => {
    expect(isWellFormedSecret(value)).toBe(false);
  });

  it("finds the matching hash among several, or reports none", () => {
    const hashes = ["a", "b", "c"].map(hashSecret);
    expect(findHashConstantTime(hashes, hashSecret("b"))).toBe(1);
    expect(findHashConstantTime(hashes, hashSecret("zzz"))).toBe(-1);
    expect(findHashConstantTime([], hashSecret("a"))).toBe(-1);
  });

  it("ignores stored values of the wrong length instead of throwing", () => {
    expect(findHashConstantTime(["abcd", "zz", hashSecret("a")], hashSecret("a"))).toBe(2);
    expect(findHashConstantTime(["abcd"], hashSecret("a"))).toBe(-1);
  });
});

describe("FailureLimiter (AC-001.5)", () => {
  it("keeps its memory bounded under many addresses", () => {
    const clock = new FakeClock();
    const limiter = new FailureLimiter(clock.now, {
      maxFailures: 10,
      windowMs: 60_000,
      blockMs: 60_000,
      maxTracked: 50,
    });
    for (let address = 0; address < 500; address += 1) {
      limiter.recordFailure(`10.0.${Math.floor(address / 250)}.${address % 250}`);
    }
    expect(
      (limiter as unknown as { entries: Map<string, unknown> }).entries.size,
    ).toBeLessThanOrEqual(50);
  });

  it("forgets idle addresses first", () => {
    const clock = new FakeClock();
    const limiter = new FailureLimiter(clock.now, {
      maxFailures: 1,
      windowMs: 1_000,
      blockMs: 10_000,
      maxTracked: 2,
    });
    limiter.recordFailure("blocked");
    limiter.recordFailure("blocked");
    expect(limiter.isBlocked("blocked")).toBe(true);
    limiter.recordFailure("idle");
    clock.advance(2_000);
    limiter.recordFailure("new-1");
    limiter.recordFailure("new-2");
    expect(limiter.isBlocked("blocked")).toBe(true);
  });
});

describe("AuthStore with a fake clock", () => {
  it("refuses a token revoked by a newer one, and never issues a fourth session", () => {
    const clock = new FakeClock();
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    const store = new AuthStore(db, clock.now);
    const { token } = store.issuePairingToken();
    expect([1, 2, 3, 4].map(() => store.pair(token) !== null)).toEqual([true, true, true, false]);
    expect(db.prepare("SELECT sessions_created AS n FROM pairing").get()).toEqual({ n: 3 });
  });

  it("refreshes last_seen_at at most once a minute", () => {
    const clock = new FakeClock();
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    const store = new AuthStore(db, clock.now);
    const { token } = store.issuePairingToken();
    const session = store.pair(token);
    const lastSeen = (): number =>
      (db.prepare("SELECT last_seen_at AS t FROM sessions").get() as { t: number }).t;
    const created = lastSeen();
    clock.advance(30_000);
    expect(store.isValidSession(session?.sessionId ?? "")).toBe(true);
    expect(lastSeen()).toBe(created);
    clock.advance(31_000);
    store.isValidSession(session?.sessionId ?? "");
    expect(lastSeen()).toBe(clock.current);
  });
});

function runtimeFor(databasePath: string, clock: FakeClock): Runtime {
  const db = openDatabase(databasePath);
  migrate(db, MIGRATIONS);
  return {
    dataDir: dirname(databasePath),
    db,
    store: new AuthStore(db, clock.now),
    port: PORT,
    lanAddress: LAN_ADDRESS,
    config: { port: PORT, publicOrigins: [], allowedHosts: [] },
    allowlist: buildAllowlist({
      port: PORT,
      interfaces: FAKE_INTERFACES,
      allowedHosts: [],
      publicOrigins: [],
    }),
  };
}

describe("CLI commands share the server's database", () => {
  function withDatabaseFile(run: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "sib-cli-"));
    try {
      run(join(dir, "sib.db"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  }

  it("AC-001.1: `sib pair` prints a fresh token and leaves existing sessions valid", () => {
    withDatabaseFile((path) => {
      const clock = new FakeClock();
      const server = runtimeFor(path, clock);
      const first = server.store.issuePairingToken();
      const session = server.store.pair(first.token);

      const output: string[] = [];
      pairCommand(runtimeFor(path, clock), (text) => output.push(text));

      const printed = /http:\/\/192\.168\.1\.20:8787\/pair\?token=([A-Za-z0-9_-]{43})/.exec(
        output.join("\n"),
      );
      expect(printed?.[1]).toBeDefined();
      expect(printed?.[1]).not.toBe(first.token);
      expect(server.store.isValidSession(session?.sessionId ?? "")).toBe(true);
      expect(server.store.pair(printed?.[1] ?? "")).not.toBeNull();
      server.db.close();
    });
  });

  it("AC-001.6: `sib forget-devices` signs every device out and cancels the pending token", () => {
    withDatabaseFile((path) => {
      const clock = new FakeClock();
      const server = runtimeFor(path, clock);
      const { token } = server.store.issuePairingToken();
      const session = server.store.pair(token);
      const pending = server.store.issuePairingToken();
      expect(server.store.isValidSession(session?.sessionId ?? "")).toBe(true);

      const output: string[] = [];
      forgetDevicesCommand(runtimeFor(path, clock), (text) => output.push(text));

      expect(output.join("\n")).toContain("signed out");
      expect(server.store.isValidSession(session?.sessionId ?? "")).toBe(false);
      expect(server.store.pair(pending.token)).toBeNull();
      server.db.close();
    });
  });
});
