import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { summarizeDevice } from "../src/server/auth/device.js";
import { AuthStore, MAX_DEVICES_PER_TOKEN } from "../src/server/auth/store.js";
import {
  listLinkedDevices,
  parseDevicesOption,
  printNewPairingToken,
} from "../src/server/commands.js";
import { migrate, openDatabase } from "../src/server/db.js";
import { devicesCommand, forgetDevicesCommand, pairCommand } from "../src/server/main.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";
import { loadRuntime } from "../src/server/runtime.js";

import { KEY, MODEL_ID } from "./support/fake-digitalocean.js";
import { FakeClock } from "./helpers.js";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

describe("AC-032.3: a short summary of a device, never the raw user agent", () => {
  it.each([
    [IPHONE, "iPhone · Safari"],
    [ANDROID, "Android · Chrome"],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1",
      "iPhone · Chrome",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0",
      "Windows · Edge",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0",
      "Mac · Firefox",
    ],
    ["curl/8.5.0", "Unknown device"],
    [undefined, "Unknown device"],
    ["", "Unknown device"],
  ])("%s", (agent, expected) => {
    expect(summarizeDevice(agent)).toBe(expected);
  });

  it("is a few words whatever the input", () => {
    expect(summarizeDevice("x".repeat(100_000)).length).toBeLessThan(40);
  });
});

describe("migration 0020: devices you can tell apart (NFR-003)", () => {
  it("adds two columns and keeps a seeded pairing and session as they were", () => {
    const db = openDatabase(":memory:");
    migrate(
      db,
      MIGRATIONS.filter((migration) => migration.id <= 19),
    );
    db.exec(`
      INSERT INTO pairing (token_hash, created_at, expires_at, sessions_created) VALUES ('aa', 1, 2, 2);
      INSERT INTO sessions (id_hash, created_at, expires_at, last_seen_at) VALUES ('bb', 1, 99, 5);
    `);
    const before = {
      pairing: db.prepare("SELECT * FROM pairing").all(),
      sessions: db.prepare("SELECT * FROM sessions").all(),
    };
    expect(migrate(db, MIGRATIONS)).toEqual([20]);
    expect(db.prepare("SELECT * FROM pairing").all()).toEqual(
      before.pairing.map((row) => ({ ...(row as object), max_sessions: 3 })),
    );
    expect(db.prepare("SELECT * FROM sessions").all()).toEqual(
      before.sessions.map((row) => ({ ...(row as object), device: null })),
    );
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(() =>
      db
        .prepare(
          "INSERT INTO pairing (token_hash, created_at, expires_at, max_sessions) VALUES ('c', 1, 2, 4)",
        )
        .run(),
    ).toThrow();
    expect(migrate(db, MIGRATIONS)).toEqual([]);
    db.close();
  });
});

describe("AC-032.3: a pairing link for fewer devices", () => {
  let clock: FakeClock;
  let store: AuthStore;
  beforeEach(() => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    clock = new FakeClock();
    store = new AuthStore(db, clock.now);
  });

  it("links the number of devices it was made for, 3 by default", () => {
    const one = store.issuePairingToken(1).token;
    expect(store.pair(one, "iPhone · Safari")).not.toBeNull();
    expect(store.pair(one)).toBeNull();
    const two = store.issuePairingToken(2).token;
    expect(store.pair(two)).not.toBeNull();
    expect(store.pair(two)).not.toBeNull();
    expect(store.pair(two)).toBeNull();
    const standard = store.issuePairingToken().token;
    for (let device = 0; device < MAX_DEVICES_PER_TOKEN; device += 1) {
      expect(store.pair(standard)).not.toBeNull();
    }
    expect(store.pair(standard)).toBeNull();
  });

  it("refuses a number outside 1 to 3", () => {
    for (const bad of [0, 4, -1, 1.5, Number.NaN]) {
      expect(() => store.issuePairingToken(bad)).toThrow(RangeError);
    }
  });

  it("parses --devices N and --devices=N, 1 to 3", () => {
    expect(parseDevicesOption([])).toBeUndefined();
    expect(parseDevicesOption(["--devices", "2"])).toBe(2);
    expect(parseDevicesOption(["--devices=3"])).toBe(3);
    for (const bad of [
      ["--devices"],
      ["--devices", "0"],
      ["--devices", "4"],
      ["--devices=x"],
      ["--device", "1"],
      ["2"],
    ]) {
      expect(parseDevicesOption(bad), bad.join(" ")).toBe("invalid");
    }
  });

  it("the banner says how many devices the link is for", () => {
    const lines: string[] = [];
    printNewPairingToken(
      {
        store,
        port: 8787,
        lanAddress: undefined,
        publicOrigins: [],
        hostedOrigin: "https://sib.example.com",
        devices: 1,
      },
      (text) => lines.push(text),
    );
    expect(lines.join("\n")).toContain("one device.");
    lines.length = 0;
    printNewPairingToken({ store, port: 8787, lanAddress: undefined, publicOrigins: [] }, (text) =>
      lines.push(text),
    );
    expect(lines.join("\n")).toContain("up to 3 devices.");
  });
});

describe("AC-032.3: sib devices", () => {
  it("lists linked devices with their times and a summary, and never a token or a session id", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    const clock = new FakeClock(); // 22 Oct 2026, 08:00 UTC
    const store = new AuthStore(db, clock.now);
    const first = store.issuePairingToken(2);
    const phone = store.pair(first.token, summarizeDevice(IPHONE));
    const second = store.pair(first.token, summarizeDevice(ANDROID));
    clock.advance(26 * 60 * 60 * 1000);
    store.isValidSession(second!.sessionId);
    const lines: string[] = [];
    listLinkedDevices(store, (text) => lines.push(text));
    const text = lines.join("\n");
    expect(lines[0]).toContain("Linked devices (2)");
    expect(text).toContain("#1  iPhone · Safari");
    expect(text).toContain("#2  Android · Chrome");
    expect(text).toContain("linked 2026-10-22 10:00:00");
    expect(text).toContain("last seen 2026-10-22");
    expect(text).toContain("last seen 2026-10-23");
    expect(text).not.toContain(first.token);
    expect(text).not.toContain(phone!.sessionId);
    expect(text).not.toContain(second!.sessionId);
    expect(text).not.toContain("Mozilla");
    store.forgetDevices();
    const none: string[] = [];
    listLinkedDevices(store, (line) => none.push(line));
    expect(none).toEqual(["No device is linked."]);
    db.close();
  });
});

describe("AC-032.3: the commands need little of the hosted settings", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sib-devices-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const env = (extra: Record<string, string> = {}) => ({
    SIB_DATA_DIR: join(dir, "data"),
    SIB_MODE: "hosted",
    ...extra,
  });

  it("forget-devices and devices work with only SIB_MODE=hosted: no origin, no model, no key", () => {
    const runtime = loadRuntime(env(), undefined, { scope: "mode" });
    runtime.store.pair(runtime.store.issuePairingToken(1).token, "iPhone · Safari");
    const lines: string[] = [];
    // The command closes the database it was given, so each gets its own runtime.
    devicesCommand(runtime, (line) => lines.push(line));
    expect(lines.join("\n")).toContain("iPhone · Safari");
    const again = loadRuntime(env(), undefined, { scope: "mode" });
    const revoked: string[] = [];
    forgetDevicesCommand(again, (line) => revoked.push(line));
    expect(revoked.join("\n")).toContain("signed out");
    const after = loadRuntime(env(), undefined, { scope: "mode" });
    expect(after.store.linkedDevices()).toEqual([]);
    after.db.close();
  });

  it("still refuses an unknown SIB_MODE, and a full start still needs everything", () => {
    expect(() => loadRuntime(env({ SIB_MODE: "prod" }), undefined, { scope: "mode" })).toThrow(
      "SIB_MODE must be home or hosted",
    );
    expect(() => loadRuntime(env())).toThrow("SIB_PUBLIC_ORIGIN");
    expect(() => loadRuntime(env({ SIB_PUBLIC_ORIGIN: "https://sib.example.com" }))).toThrow(
      "SIB_DO_MODEL",
    );
  });

  it("sib pair needs the public origin only, makes a one-device link and prints the fragment link", () => {
    expect(() => loadRuntime(env(), undefined, { scope: "pair" })).toThrow("SIB_PUBLIC_ORIGIN");
    const runtime = loadRuntime(env({ SIB_PUBLIC_ORIGIN: "https://sib.example.com" }), undefined, {
      scope: "pair",
    });
    const lines: string[] = [];
    pairCommand(runtime, (text) => lines.push(text));
    expect(lines.join("\n")).toMatch(/https:\/\/sib\.example\.com\/pair#t=/);
    expect(lines.join("\n")).toContain("one device.");
    const check = loadRuntime(env(), undefined, { scope: "mode" });
    expect(
      check.db.prepare("SELECT max_sessions FROM pairing WHERE revoked_at IS NULL").all(),
    ).toEqual([{ max_sessions: 1 }]);
    check.db.close();
    // --devices 2 makes a link for two.
    const second = loadRuntime(env({ SIB_PUBLIC_ORIGIN: "https://sib.example.com" }), undefined, {
      scope: "pair",
    });
    pairCommand(second, () => undefined, 2);
    const verify = loadRuntime(env(), undefined, { scope: "mode" });
    expect(
      verify.db.prepare("SELECT max_sessions FROM pairing WHERE revoked_at IS NULL").all(),
    ).toEqual([{ max_sessions: 2 }]);
    verify.db.close();
  });

  it("home mode keeps three devices per link", () => {
    const runtime = loadRuntime({ SIB_DATA_DIR: join(dir, "data") }, undefined, { scope: "pair" });
    pairCommand(runtime, () => undefined);
    const verify = loadRuntime({ SIB_DATA_DIR: join(dir, "data") });
    expect(
      verify.db.prepare("SELECT max_sessions FROM pairing WHERE revoked_at IS NULL").all(),
    ).toEqual([{ max_sessions: 3 }]);
    verify.db.close();
  });

  it("the full settings still need the key and the model, which the short scopes never print", () => {
    const failure = (() => {
      try {
        loadRuntime(env({ SIB_PUBLIC_ORIGIN: "https://sib.example.com", SIB_DO_MODEL: MODEL_ID }));
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(failure).toContain("SIB_DO_INFERENCE_KEY is required");
    expect(failure).not.toContain(KEY);
  });
});
