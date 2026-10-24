import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import type { NetworkInterfaceInfo } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildAllowlist,
  describeAllowlist,
  type InterfaceMap,
} from "../src/server/auth/allowlist.js";
import { migrate, openDatabase } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";
import { DATABASE_FILE, resolveDataDir } from "../src/server/data-dir.js";
import { listenLoopbackAndLan, pickLanAddress } from "../src/server/network.js";
import { CONFIG_DIR, DEFAULT_PORT, loadServerConfig, readJsonFile } from "../src/server/config.js";

import { FAKE_INTERFACES, appRoutes, closeAllHarnesses, createHarness } from "./helpers.js";

afterEach(closeAllHarnesses);

function nic(
  address: string,
  internal = false,
  family: "IPv4" | "IPv6" = "IPv4",
): NetworkInterfaceInfo {
  return { address, netmask: "", family, mac: "", internal, cidr: null } as NetworkInterfaceInfo;
}

describe("pickLanAddress", () => {
  it("prefers 192.168/16, then 10/8, then 172.16/12", () => {
    const interfaces: InterfaceMap = {
      vpn0: [nic("172.17.0.1")],
      wifi: [nic("10.1.2.3"), nic("192.168.0.9")],
    };
    expect(pickLanAddress(interfaces)).toBe("192.168.0.9");
    expect(pickLanAddress({ vpn0: interfaces["vpn0"], other: [nic("10.1.2.3")] })).toBe("10.1.2.3");
    expect(pickLanAddress({ vpn0: interfaces["vpn0"] })).toBe("172.17.0.1");
  });

  it("never picks loopback, public, link-local, tailnet or IPv6 addresses", () => {
    expect(
      pickLanAddress({
        lo: [nic("127.0.0.1", true)],
        wan: [nic("84.12.3.4")],
        ll: [nic("169.254.1.1")],
        ts: [nic("100.101.102.103")],
        v6: [nic("fd00::1", false, "IPv6")],
      }),
    ).toBeUndefined();
  });

  it("skips docker, bridge and veth interfaces", () => {
    expect(
      pickLanAddress({
        docker0: [nic("192.168.200.1")],
        "br-1a2b3c": [nic("192.168.201.1")],
        veth9f: [nic("192.168.202.1")],
        eth0: [nic("10.0.0.7")],
      }),
    ).toBe("10.0.0.7");
  });

  it("takes SIB_LAN_ADDRESS when it is a private or loopback IPv4 address", () => {
    for (const good of ["192.168.50.2", "10.0.0.4", "172.16.0.9", "172.31.255.1", "127.0.0.2"]) {
      expect(pickLanAddress({}, good)).toBe(good);
    }
  });

  it.each([
    "0.0.0.0",
    "255.255.255.255",
    "8.8.8.8",
    "84.12.3.4",
    "100.101.102.103",
    "169.254.1.1",
    "172.32.0.1",
    "::",
    "fd00::1",
    "example.com",
    "192.168.1",
  ])("rejects SIB_LAN_ADDRESS=%s", (bad) => {
    expect(() => pickLanAddress({}, bad)).toThrow("SIB_LAN_ADDRESS");
  });
});

describe("buildAllowlist", () => {
  it("lists localhost, loopback, every interface address, allowed hosts and public origins", () => {
    const allowlist = buildAllowlist({
      port: 8787,
      interfaces: {
        ...FAKE_INTERFACES,
        v6: [nic("fd00::5", false, "IPv6"), nic("fe80::1%eth0", false, "IPv6")],
      },
      allowedHosts: ["192.168.1.99", "box.lan:9000", "fd00::9"],
      publicOrigins: ["https://m.tail.ts.net", "http://plain.lan:8080"],
    });
    expect([...allowlist.hosts].sort()).toEqual(
      [
        "localhost:8787",
        "127.0.0.1:8787",
        "192.168.1.20:8787",
        "[fd00::5]:8787",
        "192.168.1.99:8787",
        "box.lan:9000",
        "[fd00::9]:8787",
        "m.tail.ts.net",
        "plain.lan:8080",
      ].sort(),
    );
    expect(allowlist.origins.has("https://m.tail.ts.net")).toBe(true);
    expect(allowlist.origins.has("http://localhost:8787")).toBe(true);
    expect(allowlist.origins.has("https://localhost:8787")).toBe(false);
    expect([...allowlist.secureHosts]).toEqual(["m.tail.ts.net"]);
    expect(describeAllowlist(allowlist)).toContain("localhost:8787");
  });

  it("also accepts the bare host when the app listens on port 80", () => {
    const allowlist = buildAllowlist({
      port: 80,
      interfaces: {},
      allowedHosts: [],
      publicOrigins: [],
    });
    expect(allowlist.hosts.has("localhost")).toBe(true);
    expect(allowlist.origins.has("http://localhost")).toBe(true);
  });
});

describe("server config", () => {
  function withConfig<T>(content: unknown, run: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "sib-server-config-"));
    if (content !== undefined) {
      writeFileSync(join(dir, "server.json"), JSON.stringify(content));
    }
    writeFileSync(
      join(dir, "server.example.json"),
      JSON.stringify({ publicOrigins: [], allowedHosts: [] }),
    );
    try {
      return run(`${dir}/`);
    } finally {
      rmSync(dir, { recursive: true });
    }
  }

  it("the committed example has no public origins and no extra hosts", () => {
    expect(readJsonFile(`${CONFIG_DIR}server.example.json`)).toEqual({
      port: 8787,
      publicOrigins: [],
      allowedHosts: [],
    });
  });

  it("falls back to the example when server.json is absent", () => {
    expect(withConfig(undefined, (dir) => loadServerConfig(dir))).toEqual({
      port: 8787,
      publicOrigins: [],
      allowedHosts: [],
    });
  });

  it("reads the port from server.json and defaults it to 8787", () => {
    expect(withConfig({ port: 9100 }, (dir) => loadServerConfig(dir)).port).toBe(9100);
    expect(withConfig({}, (dir) => loadServerConfig(dir)).port).toBe(DEFAULT_PORT);
  });

  it("normalises public origins and keeps allowed hosts", () => {
    const config = withConfig(
      {
        publicOrigins: ["HTTPS://Bookie.Tail1234.ts.net/", "http://box.lan:8080"],
        allowedHosts: ["192.168.1.5", "box.lan:9000"],
      },
      (dir) => loadServerConfig(dir),
    );
    expect(config.publicOrigins).toEqual(["https://bookie.tail1234.ts.net", "http://box.lan:8080"]);
    expect(config.allowedHosts).toEqual(["192.168.1.5", "box.lan:9000"]);
  });

  it.each([
    ["a path", { publicOrigins: ["https://m.ts.net/app"] }],
    ["a query", { publicOrigins: ["https://m.ts.net/?x=1"] }],
    ["credentials", { publicOrigins: ["https://user:pw@m.ts.net"] }],
    ["another scheme", { publicOrigins: ["ftp://m.ts.net"] }],
    ["a bare host as origin", { publicOrigins: ["m.ts.net"] }],
    ["a scheme in allowedHosts", { allowedHosts: ["http://box.lan"] }],
    ["a path in allowedHosts", { allowedHosts: ["box.lan/x"] }],
    ["an unknown key", { publicOrigin: [] }],
    ["port 0", { port: 0 }],
    ["a port above 65535", { port: 70000 }],
    ["a port as text", { port: "8787" }],
  ])("rejects %s", (_label, content) => {
    expect(() => withConfig(content, (dir) => loadServerConfig(dir))).toThrow(
      "Invalid server config",
    );
  });
});

describe("resolveDataDir", () => {
  it("uses SIB_DATA_DIR, creates it owner-only, and names the database file", () => {
    const parent = mkdtempSync(join(tmpdir(), "sib-data-"));
    try {
      const dir = resolveDataDir({ SIB_DATA_DIR: join(parent, "nested", "data") });
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(DATABASE_FILE).toBe("sib.db");
    } finally {
      rmSync(parent, { recursive: true });
    }
  });

  it("tightens an existing folder that other users can read", () => {
    const parent = mkdtempSync(join(tmpdir(), "sib-data-"));
    try {
      const dir = join(parent, "shared");
      mkdirSync(dir, { mode: 0o755 });
      chmodSync(dir, 0o755);
      expect(statSync(dir).mode & 0o777).toBe(0o755);
      expect(resolveDataDir({ SIB_DATA_DIR: dir })).toBe(dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(parent, { recursive: true });
    }
  });

  it("keeps the database and its WAL and SHM files owner-only, whatever the umask", () => {
    const parent = mkdtempSync(join(tmpdir(), "sib-data-"));
    const previousUmask = process.umask(0o022);
    try {
      const path = join(parent, DATABASE_FILE);
      const db = openDatabase(path);
      migrate(db, MIGRATIONS);
      db.prepare(
        "INSERT INTO pairing (token_hash, created_at, expires_at) VALUES ('h', 1, 2)",
      ).run();
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        expect(existsSync(file)).toBe(true);
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
      db.close();
    } finally {
      process.umask(previousUmask);
      rmSync(parent, { recursive: true });
    }
  });

  it("tightens a database file that was created group-readable", () => {
    const parent = mkdtempSync(join(tmpdir(), "sib-data-"));
    try {
      const path = join(parent, DATABASE_FILE);
      writeFileSync(path, "", { mode: 0o644 });
      chmodSync(path, 0o644);
      openDatabase(path).close();
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(parent, { recursive: true });
    }
  });

  it("NFR-002: refuses a data folder inside a git working tree that git would not ignore", () => {
    const repo = mkdtempSync(join(tmpdir(), "sib-repo-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      expect(() => resolveDataDir({ SIB_DATA_DIR: join(repo, "mydata") })).toThrow(
        /could be committed/,
      );
      writeFileSync(join(repo, ".gitignore"), "mydata/\n");
      expect(resolveDataDir({ SIB_DATA_DIR: join(repo, "mydata") })).toBe(join(repo, "mydata"));
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  it("defaults to ~/.should-i-bother when SIB_DATA_DIR is unset", () => {
    const home = mkdtempSync(join(tmpdir(), "sib-home-"));
    const previous = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      expect(resolveDataDir({})).toBe(join(home, ".should-i-bother"));
    } finally {
      process.env["HOME"] = previous;
      rmSync(home, { recursive: true });
    }
  });
});

function get(
  address: string,
  port: number,
  path: string,
  headers: Record<string, string> = {},
  localAddress?: string,
): Promise<{ status: number; location: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: address,
        port,
        path,
        headers,
        agent: false,
        ...(localAddress === undefined ? {} : { localAddress }),
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, location: res.headers.location });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("listenLoopbackAndLan (NFR-001)", () => {
  it("serves on 127.0.0.1 and the LAN address and nowhere else", async () => {
    const harness = await createHarness({ features: appRoutes });
    // 127.0.0.2 stands in for the LAN address: it is a distinct local address.
    await listenLoopbackAndLan(harness.app, { port: 0, lanAddress: "127.0.0.2" });
    const address = harness.app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      // The harness allowlist is built for port 8787, so use that Host value on the real sockets.
      const host = { host: "localhost:8787" };
      expect((await get("127.0.0.1", port, "/healthz", host)).status).toBe(401);
      expect((await get("127.0.0.2", port, "/healthz", host)).status).toBe(401);
      expect((await get("127.0.0.2", port, "/healthz", { host: "evil.example" })).status).toBe(421);
      await expect(get("127.0.0.3", port, "/healthz")).rejects.toMatchObject({
        code: "ECONNREFUSED",
      });
    } finally {
      await harness.close();
    }
  });

  it("pairs over the LAN listener with the real client address", async () => {
    const harness = await createHarness({ features: appRoutes });
    await listenLoopbackAndLan(harness.app, { port: 0, lanAddress: "127.0.0.2" });
    const address = harness.app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    // The allowlist of the harness uses port 8787, so reuse its Host value on the real socket.
    const host = "localhost:8787";
    const { token } = harness.store.issuePairingToken();
    try {
      const response = await get("127.0.0.2", port, `/pair?token=${token}`, { host }, "127.0.0.9");
      expect(response).toEqual({ status: 303, location: "/" });
      expect(harness.printed[0]).toContain("from 127.0.0.9");
    } finally {
      await harness.close();
    }
  });

  it("listens on loopback only when there is no LAN address", async () => {
    const harness = await createHarness();
    await listenLoopbackAndLan(harness.app, { port: 0, lanAddress: undefined });
    const address = harness.app.server.address();
    expect(typeof address === "object" && address?.address).toBe("127.0.0.1");
    await harness.close();
  });

  it("fails and closes when the LAN address cannot be bound", async () => {
    const harness = await createHarness();
    await expect(
      listenLoopbackAndLan(harness.app, { port: 0, lanAddress: "203.0.113.77" }),
    ).rejects.toThrow();
    expect(harness.app.server.listening).toBe(false);
  });
});
